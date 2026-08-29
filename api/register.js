import { sql, hashDeviceKey, isDeviceKey, handler, send, fail } from "../lib/db.js";

/**
 * POST /api/register  { deviceKey }
 *
 * The device invents its own key once, keeps it forever, and calls this
 * to claim an account. Idempotent: calling it again with the same key
 * returns the same user instead of erroring, so a retry after a dropped
 * connection is harmless.
 */
export default handler(async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "method", "Use POST.");

  const { deviceKey, displayName } = req.body || {};
  if (!isDeviceKey(deviceKey)) {
    return fail(res, 400, "bad_key", "deviceKey must be 32–128 url-safe characters.");
  }

  const name =
    typeof displayName === "string" && displayName.trim()
      ? displayName.trim().slice(0, 40)
      : null;

  const rows = await sql`
    insert into users (device_hash, display_name)
         values (${hashDeviceKey(deviceKey)}, ${name})
    on conflict (device_hash) do update
            set last_seen_at = now()
      returning id, display_name, created_at
  `;

  send(res, 200, { user: rows[0] });
});
