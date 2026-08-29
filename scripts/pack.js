// Build a clean folder to drag onto Netlify.
//   npm run pack
//
// Manual (drag-and-drop) deploys do not run `npm install` and do not respect
// .gitignore — so the folder you drop has to contain node_modules, and must
// NOT contain .env.local. Dragging the project root does both wrong: it ships
// your database password and 2 MB of files Netlify has no use for.
//
// This copies exactly what Netlify needs into deploy/, then refuses to finish
// if a credential made it in.

import { rmSync, mkdirSync, cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "deploy");

// rebuild first so public/ is never stale
execSync("node scripts/build.js", { cwd: root, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const INCLUDE = [
  "public",        // the site
  "netlify",       // function entry points
  "api",           // the handlers they wrap
  "lib",           // db client and helpers
  "node_modules",  // no npm install runs on a manual deploy
  "netlify.toml",
  "package.json"
];

for (const item of INCLUDE) {
  const from = join(root, item);
  if (!existsSync(from)) {
    console.error(`missing: ${item}`);
    process.exit(1);
  }
  cpSync(from, join(out, item), { recursive: true });
}

// ── refuse to ship a secret ──
//
// Two patterns, deliberately scoped differently. A Neon token is unmistakable,
// so it is hunted everywhere. A generic postgres URL is not — third-party
// packages carry `postgresql://user:password@host` in their own doc comments —
// so that one is only checked in code we wrote.
const TOKEN = /npg_[A-Za-z0-9]{6,}/;
const URL_WITH_PASSWORD = /postgresql:\/\/[a-z_]+:(?!PASSWORD)[^@\s'"`]+@/;

let files = 0, bytes = 0, leaks = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { walk(full); continue; }
    files++;
    bytes += st.size;
    if (st.size > 2_000_000) continue;                       // skip large binaries
    if (/\.(png|jpg|woff2?|ico|gz|map)$/i.test(name)) continue;

    let text;
    try { text = readFileSync(full, "utf8"); } catch { continue; }

    const rel = relative(out, full);
    const ours = !rel.startsWith("node_modules");

    if (TOKEN.test(text) || (ours && URL_WITH_PASSWORD.test(text))) {
      leaks.push(rel);
    }
  }
}
walk(out);

if (existsSync(join(out, ".env.local")) || existsSync(join(out, ".env"))) {
  leaks.push(".env file copied");
}

if (leaks.length) {
  console.error("\nREFUSING TO PACK — credential found in:");
  for (const l of leaks) console.error("  " + l);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}

console.log(`\n  deploy/  ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log("  no credential found\n");
console.log("  Drag the deploy/ folder onto the dropzone at the bottom of");
console.log("  your Netlify Deploys page. Set DATABASE_URL in the Netlify UI first.");
