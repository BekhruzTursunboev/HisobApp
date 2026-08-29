// Prove the Netlify entry points work before deploying.
//   npm run test:netlify
//
// Calls each function the way Netlify will — a real Request in, a real
// Response out — against the real database. Catches adapter bugs without
// needing a deploy or the Netlify CLI.

// env must load first: ES modules evaluate in import order, and the handlers
// read DATABASE_URL at module scope. On Netlify the platform supplies it, so
// this ordering only matters when running locally.
import "../lib/env.js";
import register from "../netlify/functions/register.mjs";
import sync from "../netlify/functions/sync.mjs";
import split from "../netlify/functions/split.mjs";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const mine = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ""}`); }
}

function key() {
  return "nl-" + [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the Request Netlify would hand the function. */
function req(path, { method = "POST", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://hisob.example${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
}

async function call(fn, path, opts) {
  const res = await fn(req(path, opts));
  let json = null;
  try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json, headers: res.headers };
}

const alice = key(), bob = key();

try {
  console.log("\n── adapter shape ──");
  const r1 = await call(register, "/api/register", { body: { deviceKey: alice, displayName: "NLAlice" } });
  ok("returns a real Response with a status", r1.status === 200, r1.status);
  ok("body parsed as JSON", !!r1.json?.user?.id, r1.json);
  ok("content-type set", (r1.headers.get("content-type") || "").includes("application/json"));
  ok("cache-control passed through", r1.headers.get("cache-control") === "no-store",
     r1.headers.get("cache-control"));
  mine.push(r1.json.user.id);

  const rb = await call(register, "/api/register", { body: { deviceKey: bob, displayName: "NLBob" } });
  mine.push(rb.json.user.id);

  console.log("\n── errors survive the translation ──");
  const bad = await call(register, "/api/register", { body: { deviceKey: "short" } });
  ok("400 reaches the client", bad.status === 400, bad.status);
  ok("error shape intact", bad.json?.error?.code === "bad_key", bad.json);

  const noAuth = await call(sync, "/api/sync", { body: {} });
  ok("401 without a key", noAuth.status === 401, noAuth.status);

  const wrongMethod = await call(register, "/api/register", { method: "GET" });
  ok("405 on the wrong method", wrongMethod.status === 405, wrongMethod.status);

  console.log("\n── a full sync round trip ──");
  const id = crypto.randomUUID();
  const spentAt = new Date().toISOString();
  const push = await call(sync, "/api/sync", {
    token: alice,
    body: { changes: [{ id, amount: 33.25, category: "coffee", ways: 2,
                        paidByMe: true, spentAt, note: "adapter test" }] }
  });
  ok("push accepted", push.status === 200, push.json);
  ok("entry returned", push.json.entries?.length === 1, push.json.entries?.length);
  ok("decimal intact", push.json.entries[0].amount === 33.25, push.json.entries[0]?.amount);
  ok("note intact", push.json.entries[0].note === "adapter test", push.json.entries[0]?.note);

  console.log("\n── query string reaches the handler ──");
  const mk = await call(split, "/api/split", { token: alice, body: { total: 90, ways: 3, note: "lunch" } });
  ok("split created", mk.status === 201, mk.json);
  const sid = mk.json.split.id;

  const view = await call(split, `/api/split?id=${sid}`, { method: "GET" });
  ok("GET with ?id= parsed", view.status === 200, view.status);
  ok("right split returned", view.json.split?.id === sid);

  const claim = await call(split, `/api/split?id=${sid}&do=claim`, {
    token: bob, body: { status: "confirmed" }
  });
  ok("two query params parsed", claim.status === 200, claim.json);

  const ghost = await call(split, `/api/split?id=${crypto.randomUUID()}`, { method: "GET" });
  ok("404 for an unknown split", ghost.status === 404, ghost.status);
} finally {
  console.log("\n── cleanup ──");
  const gone = mine.length
    ? await sql`delete from users where id = any(${mine}::uuid[]) returning id`
    : [];
  console.log(`  removed ${gone.length} test user(s)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
