import { neon } from "@neondatabase/serverless";
import { createHash, timingSafeEqual } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and paste your Neon connection string."
  );
}

/**
 * Neon's HTTP driver. It speaks to Neon over a single HTTPS request per
 * query, which is what you want in a serverless function — there is no
 * TCP connection to leak between invocations and no pool to exhaust.
 *
 * Used as a tagged template, `sql` parameterises every interpolation,
 * so `sql`select * from users where id = ${id}`` is not string
 * concatenation and cannot be SQL-injected.
 */
export const sql = neon(process.env.DATABASE_URL);

/** Device keys are bearer secrets. Store the hash, never the key. */
export function hashDeviceKey(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

/** A device key must look like one before it ever reaches the database. */
export function isDeviceKey(v) {
  return typeof v === "string" && v.length >= 32 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v);
}

/**
 * Resolve the caller from their `Authorization: Bearer <deviceKey>` header.
 * Returns the user row, or null. Creating the account is a separate,
 * explicit call — this one never creates.
 */
export async function authenticate(req) {
  const header = req.headers.authorization || "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!isDeviceKey(key)) return null;

  const rows = await sql`
    update users
       set last_seen_at = now()
     where device_hash = ${hashDeviceKey(key)}
    returning id, display_name, created_at
  `;
  return rows[0] || null;
}

/** Constant-time compare for anything secret we ever compare in code. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Small helpers so every handler answers in the same shape. */
export function send(res, status, body) {
  res.status(status).json(body);
}

export function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/** Wrap a handler so an unexpected throw never leaks a stack trace. */
export function handler(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch (err) {
      console.error("[api]", err);
      if (!res.headersSent) fail(res, 500, "internal", "Something went wrong.");
    }
  };
}
