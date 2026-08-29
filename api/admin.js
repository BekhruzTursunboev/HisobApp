import { sql, handler, send, fail, safeEqual } from "../lib/db.js";

/**
 * GET /api/admin   Authorization: Bearer <ADMIN_TOKEN>
 *
 * Operator view. Aggregates and per-user *activity* only — never the content
 * of anyone's entries. No amounts, no notes, no categories attributable to a
 * person. Two reasons: "the founder reads my spending" is how a campus app
 * dies by word of mouth, and retention is the number that actually decides
 * anything at this stage anyway.
 *
 * Guarded by a single long random token in ADMIN_TOKEN. Not user accounts —
 * there is one operator, and a 32-byte secret compared in constant time is
 * both stronger and less code than a login.
 */
export default handler(async (req, res) => {
  if (req.method !== "GET") return fail(res, 405, "method", "Use GET.");

  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected.length < 24) {
    return fail(res, 503, "no_token",
      "ADMIN_TOKEN is not set, or is too short to be safe. Set a 32-byte random value.");
  }

  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given || !safeEqual(given, expected)) {
    return fail(res, 401, "unauthorized", "Bad admin token.");
  }

  // ── headline counts ──
  const [totals] = await sql`
    select
      (select count(*)::int from users)                                          as users,
      (select count(*)::int from users where created_at > now() - interval '7 days')  as users_7d,
      (select count(*)::int from users where last_seen_at > now() - interval '1 day') as active_1d,
      (select count(*)::int from users where last_seen_at > now() - interval '7 days')as active_7d,
      (select count(*)::int from entries where deleted_at is null)                as entries,
      (select count(*)::int from entries
         where deleted_at is null and spent_at > now() - interval '7 days')       as entries_7d,
      (select count(*)::int from splits)                                          as splits,
      (select count(*)::int from split_claims)                                    as claims
  `;

  // ── the only metric that matters yet: do they come back ──
  //
  // "Retained" means seen at least a day after signing up. Anyone who opened
  // it once and never returned is the number to watch.
  const [retention] = await sql`
    select
      count(*) filter (where age > interval '1 day')::int  as cohort_1d,
      count(*) filter (where age > interval '7 days')::int as cohort_7d,
      count(*) filter (where age > interval '1 day'  and span > interval '1 day')::int  as kept_1d,
      count(*) filter (where age > interval '7 days' and span > interval '7 days')::int as kept_7d
    from (
      select now() - created_at as age, last_seen_at - created_at as span
      from users
    ) u
  `;

  // ── feature adoption, aggregate only ──
  const [features] = await sql`
    select
      count(distinct user_id)::int                                        as with_entries,
      count(distinct user_id) filter (where ways > 1)::int                as split_bills,
      count(distinct user_id) filter (where paid_by_me = false)::int      as owed_someone,
      count(distinct user_id) filter (where note is not null)::int        as write_notes
    from entries where deleted_at is null
  `;

  // ── daily signups and entries, last 30 days ──
  const daily = await sql`
    with days as (
      select generate_series(
        (now() - interval '29 days')::date, now()::date, interval '1 day'
      )::date as day
    )
    select
      d.day::text                                                            as day,
      (select count(*)::int from users u  where u.created_at::date = d.day)  as signups,
      (select count(*)::int from entries e
        where e.spent_at::date = d.day and e.deleted_at is null)             as entries
    from days d order by d.day asc
  `;

  // ── who is active. Activity, never content. ──
  const people = await sql`
      select
        left(u.id::text, 8)                                        as ref,
        u.display_name                                             as name,
        u.created_at,
        u.last_seen_at,
        count(e.id) filter (where e.deleted_at is null)::int        as entries,
        count(distinct e.spent_at::date)
          filter (where e.deleted_at is null)::int                  as active_days,
        max(e.spent_at)                                            as last_entry,
        bool_or(e.ways > 1)                                        as uses_splits,
        bool_or(e.note is not null)                                as uses_notes
      from users u
      left join entries e on e.user_id = u.id
  group by u.id
  order by u.last_seen_at desc
     limit 200
  `;

  send(res, 200, {
    generatedAt: new Date().toISOString(),
    totals,
    retention: {
      ...retention,
      rate_1d: retention.cohort_1d ? retention.kept_1d / retention.cohort_1d : null,
      rate_7d: retention.cohort_7d ? retention.kept_7d / retention.cohort_7d : null
    },
    features,
    daily,
    people: people.map((p) => ({
      ref: p.ref,
      name: p.name,
      createdAt: p.created_at,
      lastSeenAt: p.last_seen_at,
      entries: p.entries,
      activeDays: p.active_days,
      lastEntry: p.last_entry,
      usesSplits: p.uses_splits === true,
      usesNotes: p.uses_notes === true
    }))
  });
});
