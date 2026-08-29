// Prove the database is reachable and the schema is really there.
//   npm run db:check
//
// Run this from campus wifi before you commit to Neon — if it hangs or
// fails here but works elsewhere, that answers the China latency question.

import { neon } from "@neondatabase/serverless";
import "../lib/env.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

const sql = neon(url);
const want = ["users", "entries", "splits", "split_claims"];

try {
  const t0 = Date.now();
  const [{ now, version }] = await sql`select now() as now, version() as version`;
  const ms = Date.now() - t0;

  console.log(`connected in ${ms} ms`);
  console.log(`server time  ${now.toISOString()}`);
  console.log(`postgres     ${version.split(" ").slice(0, 2).join(" ")}\n`);

  if (ms > 1500) {
    console.log(`⚠  ${ms} ms round trip is slow. If you are in China without a VPN,`);
    console.log("   test again from another network before you commit to this region.\n");
  }

  const rows = await sql`
    select table_name from information_schema.tables
     where table_schema = 'public'
  `;
  const have = new Set(rows.map((r) => r.table_name));

  let missing = 0;
  for (const t of want) {
    const ok = have.has(t);
    if (!ok) missing++;
    console.log(`  ${ok ? "ok  " : "MISS"} ${t}`);
  }

  if (missing) {
    console.log(`\n${missing} table(s) missing — run: npm run db:push`);
    process.exit(1);
  }

  const [{ count }] = await sql`select count(*)::int as count from entries`;
  console.log(`\nentries stored: ${count}`);
  console.log("Database is ready.");
} catch (err) {
  console.error("\nCould not reach the database.");
  console.error(err.message);
  console.error("\nCheck: is the password the NEW one after you reset it?");
  console.error("       is the host the -pooler one?");
  console.error("       does the string still end with ?sslmode=require ?");
  process.exit(1);
}
