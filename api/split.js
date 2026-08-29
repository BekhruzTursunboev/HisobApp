import { sql, authenticate, isUuid, handler, send, fail } from "../lib/db.js";

/**
 * The shared bill — the one thing that genuinely cannot work on a single
 * device, and the reason this app has a server at all.
 *
 *   POST /api/split                     create a bill, get a link to send
 *   GET  /api/split?id=<uuid>           open the link (no account needed to look)
 *   POST /api/split?id=<uuid>&do=claim  confirm or decline your share
 *
 * The split id is the capability: anyone holding the link can view the
 * bill. That is deliberate — you send it to your friends in a group
 * chat. Nothing sensitive lives here beyond one amount and a note, and
 * confirming a share still requires an account.
 */
export default handler(async (req, res) => {
  if (req.method === "GET") return view(req, res);
  if (req.method === "POST") {
    return req.query.do === "claim" ? claim(req, res) : create(req, res);
  }
  return fail(res, 405, "method", "Use GET or POST.");
});

async function create(req, res) {
  const user = await authenticate(req);
  if (!user) return fail(res, 401, "unauthorized", "Unknown or missing device key.");

  const { total, ways, note, entryId } = req.body || {};

  const amount = Number(total);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e8) {
    return fail(res, 400, "bad_total", "total must be a positive amount.");
  }
  const n = Number(ways);
  if (!Number.isInteger(n) || n < 2 || n > 20) {
    return fail(res, 400, "bad_ways", "ways must be between 2 and 20.");
  }
  if (note != null && (typeof note !== "string" || note.length > 120)) {
    return fail(res, 400, "bad_note", "note must be 120 characters or fewer.");
  }
  if (entryId != null && !isUuid(entryId)) {
    return fail(res, 400, "bad_entry", "entryId must be a uuid.");
  }

  const rows = await sql`
    insert into splits (entry_id, owner_id, total, ways, note)
         values (${entryId || null}, ${user.id}, ${amount.toFixed(2)}, ${n}, ${note || null})
      returning id, total, ways, note, created_at
  `;

  send(res, 201, { split: shape(rows[0], user.display_name, []) });
}

async function view(req, res) {
  const id = req.query.id;
  if (!isUuid(id)) return fail(res, 400, "bad_id", "id must be a uuid.");

  const rows = await sql`
    select s.id, s.total, s.ways, s.note, s.created_at, u.display_name as owner_name
      from splits s
      join users  u on u.id = s.owner_id
     where s.id = ${id}
  `;
  if (!rows[0]) return fail(res, 404, "not_found", "That split link is not valid.");

  const claims = await sql`
      select c.status, c.claimed_at, u.display_name
        from split_claims c
   left join users u on u.id = c.user_id
       where c.split_id = ${id}
    order by c.claimed_at asc
  `;

  send(res, 200, { split: shape(rows[0], rows[0].owner_name, claims) });
}

async function claim(req, res) {
  const user = await authenticate(req);
  if (!user) return fail(res, 401, "unauthorized", "Open the app once to create an account, then try again.");

  const id = req.query.id;
  if (!isUuid(id)) return fail(res, 400, "bad_id", "id must be a uuid.");

  const status = req.body && req.body.status;
  if (!["confirmed", "settled", "declined"].includes(status)) {
    return fail(res, 400, "bad_status", "status must be confirmed, settled or declined.");
  }

  const exists = await sql`select owner_id from splits where id = ${id}`;
  if (!exists[0]) return fail(res, 404, "not_found", "That split link is not valid.");
  if (exists[0].owner_id === user.id) {
    return fail(res, 409, "own_split", "You created this bill — you can't claim a share of it.");
  }

  await sql`
    insert into split_claims (split_id, user_id, status)
         values (${id}, ${user.id}, ${status})
    on conflict (split_id, user_id) do update
            set status = excluded.status, claimed_at = now()
  `;

  send(res, 200, { ok: true, status });
}

function shape(row, ownerName, claims) {
  const total = Number(row.total);
  return {
    id: row.id,
    total,
    ways: row.ways,
    share: Math.round((total / row.ways) * 100) / 100,
    note: row.note,
    ownerName: ownerName || null,
    createdAt: row.created_at,
    claims: claims.map((c) => ({
      name: c.display_name || "someone",
      status: c.status,
      at: c.claimed_at
    }))
  };
}
