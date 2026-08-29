-- Daily Spend — schema
-- Run once against your Neon database:
--   psql "$DATABASE_URL" -f db/schema.sql
-- Every statement is idempotent, so re-running it is safe.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────
-- users
--
-- No passwords. Each device generates a long random key, keeps it in
-- local storage, and sends it as a bearer token. We store only the
-- SHA-256 of that key, so a database leak does not hand anyone a
-- working credential.
-- ─────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  device_hash   text        not null unique,
  display_name  text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- entries — one row per spend
--
-- Money is numeric, never float: 0.1 + 0.2 must equal 0.3 exactly.
-- Deletes are soft so an offline device can learn about them on sync.
-- ─────────────────────────────────────────────────────────────
create table if not exists entries (
  id          uuid           primary key,               -- client-generated, so offline creates are idempotent
  user_id     uuid           not null references users(id) on delete cascade,
  amount      numeric(12, 2) not null check (amount > 0 and amount < 100000000),
  category    text           not null check (char_length(category) between 1 and 32),
  ways        smallint       not null default 1 check (ways between 1 and 20),
  paid_by_me  boolean        not null default true,
  spent_at    timestamptz    not null,
  updated_at  timestamptz    not null default now(),
  deleted_at  timestamptz
);

-- what it actually was. "food 45" means nothing three weeks later.
alter table entries add column if not exists note text
  check (note is null or char_length(note) <= 80);

create index if not exists entries_user_spent_idx   on entries (user_id, spent_at desc);
create index if not exists entries_user_updated_idx on entries (user_id, updated_at);

-- ─────────────────────────────────────────────────────────────
-- splits — a shared bill someone can open by link
--
-- This is the only reason the app needs a server at all: the other
-- person has to be able to see and confirm their share.
-- ─────────────────────────────────────────────────────────────
create table if not exists splits (
  id         uuid           primary key default gen_random_uuid(),
  entry_id   uuid           references entries(id) on delete set null,
  owner_id   uuid           not null references users(id) on delete cascade,
  total      numeric(12, 2) not null check (total > 0),
  ways       smallint       not null check (ways between 2 and 20),
  note       text           check (note is null or char_length(note) <= 120),
  created_at timestamptz    not null default now()
);

create index if not exists splits_owner_idx on splits (owner_id, created_at desc);

create table if not exists split_claims (
  id           uuid        primary key default gen_random_uuid(),
  split_id     uuid        not null references splits(id) on delete cascade,
  user_id      uuid        references users(id) on delete set null,
  status       text        not null default 'confirmed'
                           check (status in ('confirmed', 'settled', 'declined')),
  claimed_at   timestamptz not null default now(),
  unique (split_id, user_id)
);

create index if not exists split_claims_split_idx on split_claims (split_id);
