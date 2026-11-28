-- GeoZipTag entitlements, redeem codes, team memberships (contract GEOZIPTAG_ENTITLEMENT_SHAPE 0.1.1).
--
-- FILE ONLY. Review it, apply it to a branch database first, and apply it to the live project only on the
-- owner's word. Nothing in this repository applies it.
--
-- Own schema `geoziptag`. Every table has row level security ENABLED and NO policy at all (deny all), and
-- anon/authenticated/public have no privilege on the schema. Only the edge function's database role
-- (SUPABASE_DB_URL) reaches these tables; the REST API never exposes the schema.
-- Does not touch public.geoziptag_* (the existing team register).

create schema if not exists geoziptag;

-- One row per grant. A team plan is a row with subject_kind 'team' (subject_id = the register's team id).
-- The latest row (created_at, id) of a team is that team's plan.
create table geoziptag.redeem_codes (
  id               uuid primary key default gen_random_uuid(),
  label            text not null check (char_length(label) between 1 and 80),
  kind             text not null check (kind in ('coupon', 'trial')),
  days             integer not null check (days between 1 and 3650),
  valid_until      timestamptz,
  max_redemptions  integer not null check (max_redemptions >= 1),
  redeemed_count   integer not null default 0 check (redeemed_count >= 0 and redeemed_count <= max_redemptions),
  enabled          boolean not null default true,
  -- HMAC-SHA256(GEOZIPTAG_CODE_PEPPER, 'code|' || normalised code), lower-case hex. The readable code is never stored.
  code_hash        text not null unique,
  code_hint        text not null check (char_length(code_hint) <= 8),
  created_at       timestamptz not null default now(),
  created_by       text check (char_length(created_by) <= 80)
);

create table geoziptag.entitlements (
  id                uuid primary key default gen_random_uuid(),
  subject_kind      text not null check (subject_kind in ('install', 'team', 'account')),
  subject_id        text not null check (char_length(subject_id) between 1 and 80),
  plan              text not null check (plan in ('pro')),
  source            text not null check (source in ('paid', 'store', 'coupon', 'trial', 'team', 'admin')),
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  enabled           boolean not null default true,
  redeemed_code_id  uuid references geoziptag.redeem_codes (id),
  team_id           text check (char_length(team_id) <= 80),
  store             jsonb,
  note              text check (char_length(note) <= 280),
  created_at        timestamptz not null default now(),
  created_by        text check (char_length(created_by) <= 80),
  check (ends_at is null or ends_at >= starts_at),
  check (store is null or source = 'store')
);

create table geoziptag.redemptions (
  id               uuid primary key default gen_random_uuid(),
  code_id          uuid not null references geoziptag.redeem_codes (id),
  entitlement_id   uuid not null references geoziptag.entitlements (id),
  -- HMAC-SHA256(GEOZIPTAG_CODE_PEPPER, 'install|' || install id). No IP, no device detail.
  install_id_hash  text not null,
  redeemed_at      timestamptz not null default now(),
  unique (code_id, install_id_hash)
);

-- Signed-in team members only. account_id is the SoHum (Supabase Auth) user id: no name, no email.
create table geoziptag.team_members (
  id          uuid primary key default gen_random_uuid(),
  team_id     text not null check (char_length(team_id) between 1 and 80),
  account_id  uuid not null,
  status      text not null check (status in ('active', 'removed')),
  joined_at   timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  text check (char_length(removed_by) <= 80),
  unique (team_id, account_id)
);

-- Propose-then-confirm state. The service keeps its own; it does not trust the console's.
create table geoziptag.proposals (
  id             text primary key,
  action         text not null,
  actor          text not null,
  params         jsonb not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  confirmed_key  text,
  result         jsonb
);

create table geoziptag.idempotency (
  key         text not null,
  action      text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (key, action)
);

-- A repeated X-Request-Id inside the 5-minute window is a replay.
create table geoziptag.request_log (
  request_id  text primary key,
  seen_at     timestamptz not null default now()
);

-- Rate limits for the public calls. The bucket holds only keyed hashes, never an address or an id in the clear.
create table geoziptag.rate_counters (
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket, window_start)
);

-- Every admin call and every confirmed write. Never a readable code, never a full install id.
create table geoziptag.audit (
  id          bigint generated always as identity primary key,
  request_id  text not null,
  actor       text not null,
  role        text not null,
  action      text not null,
  phase       text not null,
  outcome     text not null,
  at          timestamptz not null default now(),
  detail      jsonb
);

create index entitlements_subject_idx on geoziptag.entitlements (subject_kind, subject_id);
create index entitlements_created_idx on geoziptag.entitlements (created_at desc, id desc);
create index redeem_codes_code_hash_idx on geoziptag.redeem_codes (code_hash);
create index redeem_codes_created_idx on geoziptag.redeem_codes (created_at desc, id desc);
create index redemptions_code_idx on geoziptag.redemptions (code_id, redeemed_at desc);
create index team_members_team_status_idx on geoziptag.team_members (team_id, status);
create index team_members_account_idx on geoziptag.team_members (account_id, status);
create index request_log_seen_idx on geoziptag.request_log (seen_at);
create index rate_counters_window_idx on geoziptag.rate_counters (window_start);
create index audit_at_idx on geoziptag.audit (at desc);

-- Deny all: RLS on, no policy on any table.
alter table geoziptag.entitlements   enable row level security;
alter table geoziptag.redeem_codes   enable row level security;
alter table geoziptag.redemptions    enable row level security;
alter table geoziptag.team_members   enable row level security;
alter table geoziptag.proposals      enable row level security;
alter table geoziptag.idempotency    enable row level security;
alter table geoziptag.request_log    enable row level security;
alter table geoziptag.rate_counters  enable row level security;
alter table geoziptag.audit          enable row level security;

revoke all on schema geoziptag from public;
revoke all on all tables in schema geoziptag from public;
revoke all on all sequences in schema geoziptag from public;

-- anon / authenticated exist on Supabase; the guard lets the same file run on a bare local Postgres.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema geoziptag from %I', r);
      execute format('revoke all on all tables in schema geoziptag from %I', r);
      execute format('revoke all on all sequences in schema geoziptag from %I', r);
      execute format('alter default privileges in schema geoziptag revoke all on tables from %I', r);
    end if;
  end loop;
end
$$;
