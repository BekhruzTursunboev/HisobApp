import { sql, authenticate, isUuid, handler, send, fail } from "../lib/db.js";

const CATEGORIES = new Set([
  "food", "coffee", "groceries", "transport", "phone", "study",
  "gym", "clothes", "fun", "health", "home", "other"
]);

const MAX_CHANGES = 500;

/**
 * POST /api/sync  { since?, changes? }
 *
 * One round trip does both directions:
 *   push — `changes` are rows this device created, edited or deleted
 *          while it may have been offline
 *   pull — everything on the server updated since the `since` cursor
 *
 * Conflicts resolve last-write-wins on updated_at. Deletes are soft, so
 * a device that was offline during a delete still learns about it.
 * Entry ids are generated on the client, which makes a retried push
 * idempotent rather than duplicating rows.
 */
export default handler(async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "method", "Use POST.");

  const user = await authenticate(req);
  if (!user) return fail(res, 401, "unauthorized", "Unknown or missing device key.");

  const body = req.body || {};
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) {
    return fail(res, 413, "too_many", `Send at most ${MAX_CHANGES} changes per sync.`);
  }

  // ── validate everything before touching the database ──
  const clean = [];
  for (const c of changes) {
    if (!c || !isUuid(c.id)) return fail(res, 400, "bad_id", "Every change needs a uuid id.");

    if (c.deleted) {
      clean.push({ id: c.id, deleted: true });
      continue;
    }

    const amount = Number(c.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e8) {
      return fail(res, 400, "bad_amount", `Bad amount on entry ${c.id}.`);
    }
    if (!CATEGORIES.has(c.category)) {
      return fail(res, 400, "bad_category", `Unknown category on entry ${c.id}.`);
    }
    const ways = Number(c.ways);
    if (!Number.isInteger(ways) || ways < 1 || ways > 20) {
      return fail(res, 400, "bad_ways", `Bad split count on entry ${c.id}.`);
    }
    const spentAt = new Date(c.spentAt);
    if (Number.isNaN(spentAt.getTime())) {
      return fail(res, 400, "bad_date", `Bad date on entry ${c.id}.`);
    }
    if (c.note != null && (typeof c.note !== "string" || c.note.length > 80)) {
      return fail(res, 400, "bad_note", `Note too long on entry ${c.id}.`);
    }

    clean.push({
      id: c.id,
      amount: amount.toFixed(2),
      category: c.category,
      ways,
      paidByMe: c.paidByMe !== false,
      spentAt: spentAt.toISOString(),
      note: c.note ? c.note.trim().slice(0, 80) || null : null,
      deleted: false
    });
  }

  // ── push ──
  for (const c of clean) {
    if (c.deleted) {
      await sql`
        update entries
           set deleted_at = now(), updated_at = now()
         where id = ${c.id} and user_id = ${user.id} and deleted_at is null
      `;
    } else {
      await sql`
        insert into entries (id, user_id, amount, category, ways, paid_by_me, spent_at, note, updated_at)
             values (${c.id}, ${user.id}, ${c.amount}, ${c.category}, ${c.ways},
                     ${c.paidByMe}, ${c.spentAt}, ${c.note}, now())
        on conflict (id) do update
                set amount     = excluded.amount,
                    category   = excluded.category,
                    ways       = excluded.ways,
                    paid_by_me = excluded.paid_by_me,
                    spent_at   = excluded.spent_at,
                    note       = excluded.note,
                    updated_at = now(),
                    deleted_at = null
              where entries.user_id = ${user.id}
      `;
    }
  }

  // ── pull ──
  // Pass the cursor straight through to Postgres. Parsing it with `new Date()`
  // would round it to milliseconds and undo the precision the watermark below
  // works to preserve — the row it points at would then match `>` again and be
  // resent on every single sync, forever.
  //
  // Both shapes are accepted: what Postgres emits (2026-08-29 10:04:29.559123+00)
  // and what a client might send (2026-08-29T10:04:29.559Z). Anything else
  // starts from the beginning of time rather than erroring, so a corrupted
  // cursor costs one full resync instead of breaking sync entirely.
  const CURSOR =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?(\d{2})?)?$/;
  const raw = typeof body.since === "string" ? body.since.trim() : "";
  const cursor = CURSOR.test(raw) ? raw : "1970-01-01T00:00:00Z";

  const rows = await sql`
      select id, amount, category, ways, paid_by_me, spent_at, note,
             updated_at,
             -- as text, so the microseconds survive. The driver hands back a
             -- JS Date, which only has milliseconds, and a cursor truncated
             -- to ms sits behind the row it came from and matches it again.
             updated_at::text as cursor_at,
             deleted_at
        from entries
       where user_id = ${user.id}
         and updated_at > ${cursor}
    order by updated_at asc
       limit 2000
  `;

  // The cursor is a watermark over the data, never a clock reading.
  //
  // Taking it from `new Date()` was wrong twice over. The function host and
  // the database disagree by up to a second, and Node only has millisecond
  // precision against Postgres's microseconds — so the cursor could land
  // ahead of a row that was already written, and that row would never be
  // sent again. Worse, rows are capped at 2000 per pull: a clock cursor
  // jumps past everything beyond the cap, losing it permanently.
  //
  // Rows come back ordered by updated_at ascending, so the last one is
  // exactly how far this client has now seen. With nothing new, the client's
  // own cursor still stands.
  const watermark = rows.length ? rows[rows.length - 1].cursor_at : cursor;

  send(res, 200, {
    serverTime: watermark,
    more: rows.length === 2000,   // hit the cap: sync again to get the rest
    entries: rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      category: r.category,
      ways: r.ways,
      paidByMe: r.paid_by_me,
      spentAt: r.spent_at,
      note: r.note,
      updatedAt: r.updated_at,
      deleted: r.deleted_at !== null
    }))
  });
});
