-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../010-agent.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- ============================================================
-- MeetingBrand — 010 agent: enrollment keys, agents (device tokens), agent reports (PLAN-active-push §2)
-- Requires 001-core.sql (orgs, my_org(), my_role(), is_trusted()), 005-integrations.sql (employees, pushes,
--          guard_push_consistency), 004-deletion.sql (org cascade). Idempotent.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres) — or the Management API (shared project).
-- ------------------------------------------------------------
-- Why: the MeetingBrand Agent (a Go binary IT installs once through Intune/Jamf) drops <GUID>.png +
-- <GUID>_thumb.png into each employee's new-Teams Uploads folder and reports back. It has no user session:
--   * the admin mints an ORG ENROLLMENT KEY in the product ('mbk_' + 32 url-safe chars, shown ONCE; only its
--     sha256 is stored — enrollment_keys.key_hash — and never readable from the client);
--   * the agent posts the key to the Edge Function mb-agent (/enroll) and receives a DEVICE TOKEN
--     ('mbd_' + 40 url-safe chars, sha256 stored — agents.token_hash — 90-day expiry, rotated by /assignments
--     when less than 30 days remain);
--   * every later call (/assignments, /report, /heartbeat) carries the device token; the function writes with
--     the service role. Clients never insert/update these tables: only the SECURITY DEFINER RPCs below.
-- Model:
--   enrollment_keys : one row per key; revoked_at ends it; uses/last_used_at + a 1-minute window for the
--                     /enroll rate limit (≤ 60 per key per minute, enrollment_key_use())
--   agents          : one row per (org, device); employee_id null = enrolled but not matched to a person
--                     ("unmatched" — the admin binds it later with bind_agent()); revoked_at → 410 to the agent
--   agent_reports   : append-only evidence per action (written / verified / restart_needed / removed / blocked / error)
--   pushes          : the agent's deliveries are pushes rows with platform 'teams', idempotency_key
--                     '<org>:<employee>:<background>:teams' (+ agent_id); the guard now lets a 'teams' push target an
--                     employee row of ANY platform (the roster may come from CSV / Zoom / Meet — the agent matched the
--                     person by e-mail, and the Teams client on that machine is what receives the file)
-- Security:
--   * RLS on all three; admins of the org SELECT enrollment_keys and agents WITHOUT the hash columns (column-level
--     grants: key_hash / token_hash are never granted to authenticated — PostgREST's select=* therefore fails on the
--     base tables; the product reads enrollment_keys_view / agents_view, or names the columns); agent_reports is
--     service-role only
--   * no client INSERT/UPDATE/DELETE anywhere — create_enrollment_key / revoke_enrollment_key / revoke_agent /
--     bind_agent are SECURITY DEFINER and check my_role() = 'admin' + my_org() themselves
--   * enrollment_key_use(): SECURITY INVOKER, EXECUTE granted to service_role only (the only API role with
--     privileges on the table) — one round trip that finds the key by hash, checks revocation and the rate window
--   * a re-enrollment of a revoked device with a still-valid key un-revokes it (the admin holds both levers:
--     revoke the key too to keep a device out for good)
-- ============================================================

-- ---------- enrollment_keys ----------
create table if not exists mb.enrollment_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references mb.orgs(id) on delete cascade,
  key_hash     text not null unique,        -- hex sha256 of the plaintext 'mbk_…' key (plaintext shown once, never stored)
  label        text check (label is null or char_length(label) <= 80),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz,
  uses         int not null default 0,
  window_start timestamptz,                 -- /enroll rate window (1 minute), maintained by enrollment_key_use()
  window_uses  int not null default 0
);
create index if not exists enrollment_keys_org_idx on mb.enrollment_keys (org_id);

-- ---------- agents ----------
create table if not exists mb.agents (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references mb.orgs(id) on delete cascade,
  employee_id      uuid references mb.employees(id) on delete set null,   -- null = unmatched (admin binds later)
  device_id        text not null check (char_length(device_id) between 1 and 128),
  os               text not null check (os in ('windows','macos')),
  hostname         text check (hostname is null or char_length(hostname) <= 200),
  local_identity   text check (local_identity is null or char_length(local_identity) <= 320),
  version          text check (version is null or char_length(version) <= 40),
  token_hash       text unique,             -- hex sha256 of the 'mbd_…' device token
  token_expires_at timestamptz,
  enrolled_at      timestamptz not null default now(),
  last_seen_at     timestamptz,
  revoked_at       timestamptz,
  unique (org_id, device_id)
);
create index if not exists agents_org_idx      on mb.agents (org_id);
create index if not exists agents_employee_idx on mb.agents (employee_id);

-- an agent may only be bound to an employee of ITS OWN org (even by the service role)
create or replace function mb.guard_agent_consistency()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if new.employee_id is not null and not exists
     (select 1 from mb.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'agents.employee_id must be an employee of this org';
  end if;
  return new;
end $$;
drop trigger if exists agents_guard_consistency on mb.agents;
create trigger agents_guard_consistency
  before insert or update of org_id, employee_id on mb.agents
  for each row execute function mb.guard_agent_consistency();

-- ---------- agent_reports ----------
create table if not exists mb.agent_reports (
  id         bigserial primary key,
  agent_id   uuid not null references mb.agents(id) on delete cascade,
  push_id    uuid references mb.pushes(id) on delete set null,
  state      text not null check (state in ('written','verified','restart_needed','removed','blocked','error')),
  evidence   jsonb check (evidence is null or octet_length(evidence::text) <= 8192),
  created_at timestamptz not null default now()
);
create index if not exists agent_reports_agent_idx on mb.agent_reports (agent_id, created_at desc);
create index if not exists agent_reports_push_idx  on mb.agent_reports (push_id);

-- ---------- pushes: the agent's deliveries ----------
alter table mb.pushes
  add column if not exists agent_id uuid references mb.agents(id) on delete set null;

-- 005's guard required employees.platform = pushes.platform. A 'teams' push may now target an employee row of
-- any platform (the agent matched the person by e-mail; the roster source is irrelevant to the Teams client).
create or replace function mb.guard_push_consistency()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if not exists (select 1 from mb.employees e
                 where e.id = new.employee_id and e.org_id = new.org_id
                   and (e.platform = new.platform or new.platform = 'teams')) then
    raise exception 'pushes.employee_id must be an employee of this org on this platform';
  end if;
  if not exists (select 1 from mb.backgrounds b
                 where b.id = new.background_id and b.org_id = new.org_id) then
    raise exception 'pushes.background_id must be a background of this org';
  end if;
  return new;
end $$;

-- ---------- Row Level Security + privileges ----------
alter table mb.enrollment_keys enable row level security;
alter table mb.agents          enable row level security;
alter table mb.agent_reports   enable row level security;

-- the schema's default privileges granted everything to anon/authenticated at CREATE — take it all back,
-- then hand admins a column-level SELECT that never includes the hashes
revoke all on mb.enrollment_keys from anon, authenticated;
revoke all on mb.agents          from anon, authenticated;
revoke all on mb.agent_reports   from anon, authenticated;
revoke all on sequence mb.agent_reports_id_seq from anon, authenticated;
grant select (id, org_id, label, created_by, created_at, revoked_at, last_used_at, uses)
  on mb.enrollment_keys to authenticated;
grant select (id, org_id, employee_id, device_id, os, hostname, local_identity, version,
              token_expires_at, enrolled_at, last_seen_at, revoked_at)
  on mb.agents to authenticated;
grant select, insert, update, delete on mb.enrollment_keys, mb.agents, mb.agent_reports to service_role;
grant usage, select on sequence mb.agent_reports_id_seq to service_role;

drop policy if exists enrollment_keys_admin_select on mb.enrollment_keys;
create policy enrollment_keys_admin_select on mb.enrollment_keys
  for select using (org_id = mb.my_org() and mb.my_role() = 'admin');
drop policy if exists agents_admin_select on mb.agents;
create policy agents_admin_select on mb.agents
  for select using (org_id = mb.my_org() and mb.my_role() = 'admin');
-- agent_reports: no policies → service role only

-- PostgREST expands select=* into EVERY column, so on the base tables an admin must list columns explicitly
-- (select=id,label,…) or read these views, which carry exactly the granted columns. security_invoker: the base
-- table's RLS (org + admin) and column grants apply to the caller, not to the view owner.
create or replace view mb.enrollment_keys_view with (security_invoker = true) as
  select id, org_id, label, created_by, created_at, revoked_at, last_used_at, uses
  from mb.enrollment_keys;
create or replace view mb.agents_view with (security_invoker = true) as
  select id, org_id, employee_id, device_id, os, hostname, local_identity, version,
         token_expires_at, enrolled_at, last_seen_at, revoked_at
  from mb.agents;
revoke all on mb.enrollment_keys_view, mb.agents_view from anon, authenticated, service_role;
grant select on mb.enrollment_keys_view, mb.agents_view to authenticated, service_role;

-- ---------- admin RPCs (SECURITY DEFINER; the only client write path) ----------
-- create_enrollment_key(p_label) → {"id","key","label","created_at"}: the plaintext key is in this reply ONLY.
create or replace function mb.create_enrollment_key(p_label text default null)
returns jsonb
language plpgsql security definer set search_path = mb, public as $$
declare
  v_org    uuid := mb.my_org();
  v_label  text;
  v_key    text;
  v_id     uuid;
  v_active int;
begin
  if v_org is null then raise exception 'not authenticated'; end if;
  if mb.my_role() <> 'admin' then raise exception 'admin only'; end if;
  v_label := nullif(left(btrim(coalesce(p_label, '')), 80), '');
  select count(*) into v_active from mb.enrollment_keys where org_id = v_org and revoked_at is null;
  if v_active >= 20 then raise exception 'at most 20 active enrollment keys per workspace — revoke one first'; end if;
  -- 24 random bytes → 32 base64 chars (no padding), made url-safe
  v_key := 'mbk_' || translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  insert into mb.enrollment_keys (org_id, key_hash, label, created_by)
  values (v_org, encode(extensions.digest(v_key, 'sha256'), 'hex'), v_label, auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_key, 'label', v_label, 'created_at', now());
end $$;
revoke all on function mb.create_enrollment_key(text) from public, anon;
grant execute on function mb.create_enrollment_key(text) to authenticated;

create or replace function mb.revoke_enrollment_key(p_id uuid)
returns boolean
language plpgsql security definer set search_path = mb, public as $$
declare v_org uuid := mb.my_org();
begin
  if v_org is null then raise exception 'not authenticated'; end if;
  if mb.my_role() <> 'admin' then raise exception 'admin only'; end if;
  update mb.enrollment_keys set revoked_at = now()
   where id = p_id and org_id = v_org and revoked_at is null;
  return found;
end $$;
revoke all on function mb.revoke_enrollment_key(uuid) from public, anon;
grant execute on function mb.revoke_enrollment_key(uuid) to authenticated;

-- revoke_agent: the device token keeps its hash so the agent's next call answers 410 (and removes our files)
create or replace function mb.revoke_agent(p_id uuid)
returns boolean
language plpgsql security definer set search_path = mb, public as $$
declare v_org uuid := mb.my_org();
begin
  if v_org is null then raise exception 'not authenticated'; end if;
  if mb.my_role() <> 'admin' then raise exception 'admin only'; end if;
  update mb.agents set revoked_at = now()
   where id = p_id and org_id = v_org and revoked_at is null;
  if not found then return false; end if;
  -- the chips stay honest: what this device wrote is gone once it polls (410 + remove list); no report follows
  update mb.pushes set state = 'failed',
         error = 'device revoked — the agent removes the file on its next poll'
   where agent_id = p_id and org_id = v_org and platform = 'teams'
     and state in ('queued','pushing','pushed','awaiting_client','available','selected','blocked');
  return true;
end $$;
revoke all on function mb.revoke_agent(uuid) from public, anon;
grant execute on function mb.revoke_agent(uuid) to authenticated;

-- bind_agent: attach an unmatched agent to a person of this org (p_employee_id null = unbind)
create or replace function mb.bind_agent(p_agent_id uuid, p_employee_id uuid)
returns boolean
language plpgsql security definer set search_path = mb, public as $$
declare v_org uuid := mb.my_org();
begin
  if v_org is null then raise exception 'not authenticated'; end if;
  if mb.my_role() <> 'admin' then raise exception 'admin only'; end if;
  if p_employee_id is not null and not exists
     (select 1 from mb.employees e where e.id = p_employee_id and e.org_id = v_org) then
    raise exception 'employee must belong to this workspace';
  end if;
  update mb.agents set employee_id = p_employee_id
   where id = p_agent_id and org_id = v_org;
  return found;
end $$;
revoke all on function mb.bind_agent(uuid, uuid) from public, anon;
grant execute on function mb.bind_agent(uuid, uuid) to authenticated;

-- ---------- service-role RPC: find + count an enrollment key in one round trip ----------
-- No row → the key does not exist (the caller answers 401 without saying which). revoked → 410.
-- limited → more than p_limit enrollments in the current 1-minute window → 429. Otherwise uses/last_used_at advance.
-- SECURITY INVOKER: runs as service_role, the only API role holding privileges on enrollment_keys.
create or replace function mb.enrollment_key_use(p_key_hash text, p_limit int default 60)
returns table (key_id uuid, key_org_id uuid, revoked boolean, limited boolean)
language plpgsql set search_path = mb, public as $$
declare
  r mb.enrollment_keys%rowtype;
begin
  select * into r from mb.enrollment_keys k where k.key_hash = p_key_hash for update;
  if not found then return; end if;
  if r.revoked_at is not null then
    return query select r.id, r.org_id, true, false;
    return;
  end if;
  if r.window_start is null or r.window_start < now() - interval '1 minute' then
    r.window_start := now();
    r.window_uses := 0;
  end if;
  if r.window_uses >= greatest(1, coalesce(p_limit, 60)) then
    return query select r.id, r.org_id, false, true;
    return;
  end if;
  update mb.enrollment_keys
     set window_start = r.window_start, window_uses = r.window_uses + 1,
         uses = mb.enrollment_keys.uses + 1, last_used_at = now()
   where id = r.id;
  return query select r.id, r.org_id, false, false;
end $$;
revoke all on function mb.enrollment_key_use(text, int) from public, anon, authenticated;
grant execute on function mb.enrollment_key_use(text, int) to service_role;
