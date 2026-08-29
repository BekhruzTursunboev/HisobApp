// Pull the webfonts down and inline them into the app.
//   npm run fonts
//
// Google Fonts is blocked in mainland China, and the stylesheet is
// render-blocking — so on campus wifi the app would stall before painting,
// then fall back to system fonts anyway. Inlining as data: URIs removes the
// last external request the app makes: it now works behind the Great
// Firewall, on a plane, and as a bare file:// copy.
//
// Re-run this only when the font stack changes.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(root, "src", "app.html");

// A modern UA makes Google serve woff2. Anything older gets ttf, which is
// three times the size.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// Instrument Sans is variable, so one file covers 400-700.
// DM Mono is not, so its weights are listed individually.
const FAMILIES = [
  "Instrument+Sans:wght@400..700",
  "DM+Mono:wght@400;500"
];

const KEEP = new Set(["latin", "latin-ext"]);   // enough for English and Uzbek

const url =
  "https://fonts.googleapis.com/css2?" +
  FAMILIES.map((f) => "family=" + f).join("&") +
  "&display=swap";

console.log("fetching stylesheet...");
const css = await fetch(url, { headers: { "User-Agent": UA } }).then((r) => {
  if (!r.ok) throw new Error("Google Fonts returned " + r.status);
  return r.text();
});

// Each @font-face is preceded by a `/* subset */` comment.
const blocks = [];
const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
let m;
while ((m = re.exec(css))) blocks.push({ subset: m[1], text: m[2] });

console.log(`  ${blocks.length} faces offered, keeping ${[...KEEP].join(" + ")}`);

let total = 0;
const out = [];

for (const b of blocks) {
  if (!KEEP.has(b.subset)) continue;

  const src = b.text.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/);
  if (!src) continue;

  const bin = Buffer.from(await fetch(src[1]).then((r) => r.arrayBuffer()));
  total += bin.length;

  const family = (b.text.match(/font-family:\s*'([^']+)'/) || [, "?"])[1];
  const weight = (b.text.match(/font-weight:\s*([^;]+);/) || [, "400"])[1].trim();
  console.log(`  ${family.padEnd(17)} ${weight.padEnd(9)} ${b.subset.padEnd(10)} ${(bin.length / 1024).toFixed(1)} KB`);

  out.push(
    b.text.replace(
      /src:\s*url\([^)]+\)\s*format\('woff2'\)/,
      `src: url(data:font/woff2;base64,${bin.toString("base64")}) format('woff2')`
    )
  );
}

if (!out.length) throw new Error("no faces captured — the stylesheet format changed");

const banner =
  "  /* ═══════ fonts, inlined ═══════\n" +
  "     Google Fonts is blocked in mainland China and the stylesheet blocks\n" +
  "     rendering. Embedded here so the app has zero external requests.\n" +
  "     Regenerate with: npm run fonts */\n";

const faces = banner + out.map((f) => "  " + f.replace(/\n\s*/g, " ")).join("\n") + "\n\n";

let app = readFileSync(APP, "utf8").replace(/\r\n/g, "\n");

// drop the <link>, and any previously inlined block
app = app.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n/, "");
app = app.replace(/  \/\* ═══════ fonts, inlined ═══════[\s\S]*?\n\n(?=  :root)/, "");
app = app.replace("<style>\n", "<style>\n" + faces);

writeFileSync(APP, app);

console.log(`\n  ${(total / 1024).toFixed(1)} KB of fonts inlined`);
console.log("  src/app.html now makes no external requests");
