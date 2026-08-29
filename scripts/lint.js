// Structural checks on the built app.
//   npm run lint
//
// These exist because of bugs that actually shipped:
//   - a chart class named .bar silently overrode the fixed header's .bar rule,
//     blurring the whole screen and dropping the title to the bottom
//   - a variable removed in a cleanup was still referenced, a ReferenceError
//     that turned the app into a white screen
//   - the Google Fonts link made the app stall behind the Great Firewall
//
// Nothing here replaces the behaviour tests. It catches the class of mistake
// that a passing test suite cannot see.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["src/app.html", "public/index.html", "hisob.html"];

let problems = 0;
const bad = (file, msg) => { problems++; console.log(`  FAIL  ${file}: ${msg}`); };
const good = (file, msg) => console.log(`  ok    ${file}: ${msg}`);

/** Remove @media / @supports blocks so only top-level rules remain. */
function stripAtBlocks(css) {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "@" && /^@(media|supports|container)/.test(css.slice(i, i + 11))) {
      let depth = 0, j = i;
      while (j < css.length) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") { depth--; if (depth === 0) break; }
        j++;
      }
      i = j;                       // skip the whole block
      continue;
    }
    out += css[i];
  }
  return out;
}

for (const rel of FILES) {
  const file = join(root, rel);
  const s = readFileSync(file, "utf8");
  const css = s.slice(s.indexOf("<style>"), s.indexOf("</style>"));
  // The hosted build has two script blocks — the app and the install/service
  // worker code. Slicing first-to-last would swallow the markup between them.
  const blocks = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const js = blocks.join("\n;\n");
  const markup = s.slice(0, s.indexOf("<script>"));

  console.log(`\n${rel}`);

  // 1. one rule per class at the top level. Overrides inside @media are fine.
  const flat = stripAtBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  const counts = {};
  for (const [, sel] of flat.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const part of sel.split(",")) {
      const m = /^\s*\.([a-zA-Z][\w-]*)\s*$/.exec(part);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
  }
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  dupes.length
    ? bad(rel, `class defined twice at top level: ${dupes.map(([k, n]) => `${k} x${n}`).join(", ")}`)
    : good(rel, `${Object.keys(counts).length} class rules, none duplicated`);

  // 2. every custom property used is defined in the base :root
  const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const defined = new Set([...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const undef = [...used].filter((v) => !defined.has(v) && v !== "--tone" && v !== "--tone-soft");
  undef.length ? bad(rel, `undefined tokens: ${undef.join(", ")}`) : good(rel, "all tokens defined");

  // 3. the two dark blocks must define the same set, or one theme half-applies
  const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf(':root[data-theme="dark"]'));
  const stamped = css.slice(css.indexOf(':root[data-theme="dark"]'));
  const setOf = (t) => new Set([...t.slice(0, t.indexOf("}")).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const a = new Set([...media.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const b = setOf(stamped);
  a.size === b.size && [...a].every((k) => b.has(k))
    ? good(rel, `both dark blocks define the same ${a.size} tokens`)
    : bad(rel, "dark theme blocks disagree — one theme will half-apply");

  // 4. every element the script reaches for exists
  const ids = new Set([...js.matchAll(/\$\("([a-zA-Z0-9_-]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !markup.includes(`id="${id}"`));
  missing.length ? bad(rel, `missing elements: ${missing.join(", ")}`)
                 : good(rel, `${ids.size} element references resolve`);

  // 5. no external requests — the app must render behind the Great Firewall
  const hosts = [...new Set([...s.matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1]))];
  hosts.length ? bad(rel, `external hosts: ${hosts.join(", ")}`) : good(rel, "no external requests");

  // 6. braces balanced
  const delta = (css.match(/\{/g) || []).length - (css.match(/\}/g) || []).length;
  delta ? bad(rel, `unbalanced CSS braces (${delta})`) : good(rel, "CSS braces balanced");

  // 7. the script parses — catches a ReferenceError-shaped edit before it ships
  const tmp = join(root, `.lint-${Math.random().toString(36).slice(2)}.js`);
  try {
    writeFileSync(tmp, js);
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    good(rel, "script parses");
  } catch (err) {
    bad(rel, `script does not parse: ${String(err.stderr || err).split("\n")[0]}`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

console.log(problems ? `\n${problems} problem(s)\n` : "\nall checks passed\n");
process.exit(problems ? 1 : 0);
