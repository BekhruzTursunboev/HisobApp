// Apply db/schema.sql to the database in DATABASE_URL.
//   npm run db:push
//
// Safe to run repeatedly — every statement in the schema is idempotent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";
import "../lib/env.js";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is not set.");
  console.error("Copy .env.example to .env.local, paste your Neon string, then run again.");
  process.exit(1);
}

const schema = readFileSync(join(here, "..", "db", "schema.sql"), "utf8");

// Strip `--` comments first, then split. Splitting on semicolons alone merges
// two commands whenever a trailing comment follows the semicolon, and Postgres
// refuses more than one command in a prepared statement.
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") quoted = !quoted;
        else if (!quoted && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const statements = stripComments(schema)
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const sql = neon(url);

console.log(`Applying ${statements.length} statements…\n`);

for (const [i, statement] of statements.entries()) {
  const label = statement.split("\n").find((l) => l.trim() && !l.trim().startsWith("--")) || "";
  try {
    await sql.query(statement);
    console.log(`  ${String(i + 1).padStart(2)}. ok   ${label.trim().slice(0, 68)}`);
  } catch (err) {
    console.error(`  ${String(i + 1).padStart(2)}. FAIL ${label.trim().slice(0, 68)}`);
    console.error(`      ${err.message}`);
    process.exit(1);
  }
}

console.log("\nSchema applied.");
