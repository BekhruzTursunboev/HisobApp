// End-to-end test against a running dev server and the real database.
//   node scripts/serve.js &   then   node scripts/e2e.js
//
// Exercises the whole contract: register, push, pull, offline delete,
// idempotent retry, auth rejection, validation, and a shared bill.
// Cleans up everything it creates.

import { neon } from "@neondatabase/serverless";
import "../lib/env.js";

const BASE = process.env.BASE || "http://localhost:3000";
const sql = neon(process.env.DATABASE_URL);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ""}`); }
}

function key() {
  return "test-" + [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(path, { method = "POST", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

const alice = key();
const bob = key();
const mine = [];   // user ids this run created, so cleanup cannot touch another run

try {
  console.log("\n── register ──");
  const r1 = await call("/api/register", { body: { deviceKey: alice, displayName: "Alice" } });
  ok("register returns a user", r1.status === 200 && !!r1.json.user?.id, r1.json);
  const aliceId = r1.json.user.id;
  mine.push(aliceId);

  const r2 = await call("/api/register", { body: { deviceKey: alice } });
  ok("register is idempotent", r2.json.user?.id === aliceId, r2.json);

  const r3 = await call("/api/register", { body: { deviceKey: "short" } });
  ok("rejects a weak device key", r3.status === 400, r3.json);

  const rb = await call("/api/register", { body: { deviceKey: bob, displayName: "Bob" } });
  mine.push(rb.json.user.id);

  console.log("\n── auth ──");
  const noAuth = await call("/api/sync", { body: {} });
  ok("sync without a key is 401", noAuth.status === 401, noAuth.json);
  const badAuth = await call("/api/sync", { body: {}, token: key() });
  ok("sync with an unknown key is 401", badAuth.status === 401, badAuth.json);

  console.log("\n── push ──");
  const e1 = crypto.randomUUID(), e2 = crypto.randomUUID();
  const spentAt = new Date().toISOString();
  const push = await call("/api/sync", {
    token: alice,
    body: { changes: [
      { id: e1, amount: 42.5, category: "food", ways: 1, paidByMe: true, spentAt },
      { id: e2, amount: 200, category: "fun", ways: 4, paidByMe: true, spentAt }
    ] }
  });
  ok("push accepted", push.status === 200, push.json);
  ok("pull returns both rows", push.json.entries?.length === 2, push.json.entries?.length);
  ok("decimal survives the round trip", push.json.entries.find((e) => e.id === e1)?.amount === 42.5);
  ok("split count preserved", push.json.entries.find((e) => e.id === e2)?.ways === 4);
  ok("serverTime is a cursor", !!Date.parse(push.json.serverTime), push.json.serverTime);

  console.log("\n── idempotency ──");
  const again = await call("/api/sync", {
    token: alice,
    body: { changes: [{ id: e1, amount: 42.5, category: "food", ways: 1, paidByMe: true, spentAt }] }
  });
  ok("re-pushing the same id does not duplicate", again.status === 200);
  const [{ count }] = await sql`select count(*)::int as count from entries where user_id = ${aliceId}`;
  ok("still exactly 2 rows", count === 2, count);

  console.log("\n── cursor ──");
  const after = await call("/api/sync", { token: alice, body: { since: push.json.serverTime } });
  ok("nothing new after the cursor", after.json.entries?.length === 0, after.json.entries?.length);

  console.log("\n── isolation ──");
  const bobPull = await call("/api/sync", { token: bob, body: {} });
  ok("bob cannot see alice's entries", bobPull.json.entries?.length === 0, bobPull.json.entries?.length);
  const steal = await call("/api/sync", {
    token: bob,
    body: { changes: [{ id: e1, amount: 999, category: "fun", ways: 1, paidByMe: true, spentAt }] }
  });
  ok("bob's write cannot overwrite alice's row", steal.status === 200);
  const [row] = await sql`select amount, user_id from entries where id = ${e1}`;
  ok("alice's amount is untouched", Number(row.amount) === 42.5, Number(row.amount));
  ok("alice still owns the row", row.user_id === aliceId);

  console.log("\n── validation ──");
  const bad = [
    ["negative amount", { id: crypto.randomUUID(), amount: -5, category: "food", ways: 1, spentAt }],
    ["unknown category", { id: crypto.randomUUID(), amount: 5, category: "hacking", ways: 1, spentAt }],
    ["ways out of range", { id: crypto.randomUUID(), amount: 5, category: "food", ways: 99, spentAt }],
    ["bad date", { id: crypto.randomUUID(), amount: 5, category: "food", ways: 1, spentAt: "nope" }],
    ["non-uuid id", { id: "not-a-uuid", amount: 5, category: "food", ways: 1, spentAt }]
  ];
  for (const [label, change] of bad) {
    const r = await call("/api/sync", { token: alice, body: { changes: [change] } });
    ok(`rejects ${label}`, r.status === 400, r.status);
  }

  console.log("\n── soft delete ──");
  const del = await call("/api/sync", { token: alice, body: { changes: [{ id: e2, deleted: true }] } });
  ok("delete accepted", del.status === 200);
  const tomb = del.json.entries.find((e) => e.id === e2);
  ok("delete comes back as a tombstone", tomb?.deleted === true, tomb);
  const fresh = await call("/api/sync", { token: alice, body: {} });
  ok("a device syncing from zero learns of the delete",
     fresh.json.entries.find((e) => e.id === e2)?.deleted === true);

  console.log("\n── shared bill ──");
  const mk = await call("/api/split", {
    token: alice, body: { total: 200, ways: 4, note: "dinner" }
  });
  ok("split created", mk.status === 201 && !!mk.json.split?.id, mk.json);
  ok("share computed", mk.json.split.share === 50, mk.json.split?.share);
  const splitId = mk.json.split.id;

  const open = await call(`/api/split?id=${splitId}`, { method: "GET" });
  ok("anyone with the link can view it", open.status === 200, open.status);
  ok("owner name shown", open.json.split.ownerName === "Alice", open.json.split?.ownerName);

  const own = await call(`/api/split?id=${splitId}&do=claim`, {
    token: alice, body: { status: "confirmed" }
  });
  ok("owner cannot claim their own bill", own.status === 409, own.status);

  const claim = await call(`/api/split?id=${splitId}&do=claim`, {
    token: bob, body: { status: "confirmed" }
  });
  ok("bob can confirm his share", claim.status === 200, claim.json);

  const twice = await call(`/api/split?id=${splitId}&do=claim`, {
    token: bob, body: { status: "settled" }
  });
  ok("re-claiming updates instead of duplicating", twice.status === 200);

  const after2 = await call(`/api/split?id=${splitId}`, { method: "GET" });
  ok("exactly one claim recorded", after2.json.split.claims.length === 1, after2.json.split.claims);
  ok("claim shows the new status", after2.json.split.claims[0].status === "settled");

  const ghost = await call(`/api/split?id=${crypto.randomUUID()}`, { method: "GET" });
  ok("unknown split id is 404", ghost.status === 404, ghost.status);
  const badStatus = await call(`/api/split?id=${splitId}&do=claim`, {
    token: bob, body: { status: "whatever" }
  });
  ok("rejects an invalid claim status", badStatus.status === 400, badStatus.status);
} finally {
  console.log("\n── cleanup ──");
  const gone = mine.length
    ? await sql`delete from users where id = any(${mine}::uuid[]) returning id`
    : [];
  console.log(`  removed ${gone.length} test user(s) and everything they owned`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
