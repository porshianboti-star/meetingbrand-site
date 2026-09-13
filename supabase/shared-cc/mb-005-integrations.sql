-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../00N-*.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- ============================================================
-- MeetingBrand — 005 integrations (PHASE 2): connections, token vault, employee directory, push jobs
-- Requires 001-core.sql (orgs, profiles, my_org(), my_role(), is_trusted()),
--          002-brand.sql (backgrounds, touch_updated_at()), 004-deletion.sql (schema priv).
-- Applied together with the first platform adapter (Edge Functions mb-oauth-zoom,
-- mb-sync-zoom, mb-push-zoom — PLAN §5 item 17). Zoom is the only platform with a
-- real upload API; the same rows serve Teams / Meet / Zoho later.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres). Idempotent.
-- ------------------------------------------------------------
-- Source: /Users/motty/branded-background/PLAN-integrations.md §1-2 (data model, PushJob
-- state machine, token vault) and §3.1 (Zoom: access 1 h, refresh 90 days and ROTATING on
-- every refresh → status needs_reconnect when it lapses).
-- Model:
--   integrations           : one row per (org, platform) connection; status machine
--   priv.integration_tokens: refresh/access tokens, envelope-encrypted, service role only
--   employees              : directory rows synced from the platform (key: org+platform+ext_id)
--   pushes                 : PushJob state machine per (employee, background, platform)
-- Security (PLAN §2 "Security/compliance items"):
--   integrations: members of the org read; NO client write policies — the Edge Functions
--                 write with the service role (RLS bypass); a browser never creates a connection
--   employees   : members of the org read (the People panel); admins may update ONLY
--                 `active` and `assigned_bg` (guard_employee_columns, the guard_profile_columns
--                 pattern); no client insert/delete — rows come from the directory sync
--   pushes      : members of the org read; every write is service role; a guard trigger
--                 refuses a push whose employee / background belong to another org
--   priv.*      : schema USAGE revoked from public (004) and not in PostgREST's exposed
--                 schemas — the vault is reachable only through the integration_token_*
--                 RPCs below, whose EXECUTE is granted to service_role alone
--   is_org_admin(p_org): the one-call admin check the Edge Functions run with the caller's JWT
-- ============================================================

-- ---------- integrations ----------
create table if not exists mb.integrations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references mb.orgs(id) on delete cascade,
  platform       text not null check (platform in ('zoom','teams','meet','zoho')),
  status         text not null default 'disconnected'
                   check (status in ('connected','needs_reconnect','disconnected','error')),
  account_ext_id text,                      -- Zoom: account_id from the token response
  scopes         text[] not null default '{}',
  connected_by   uuid references auth.users(id) on delete set null,
  connected_at   timestamptz,
  expires_at     timestamptz,               -- refresh-token expiry (Zoom: connected_at + 90 days, moves on every rotation)
  last_sync_at   timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, platform)
);
create index if not exists integrations_org_idx on mb.integrations (org_id);

drop trigger if exists integrations_touch on mb.integrations;
create trigger integrations_touch before update on mb.integrations
  for each row execute function mb.touch_updated_at();

-- ---------- priv.integration_tokens (service role only) ----------
create table if not exists priv.integration_tokens (
  integration_id    uuid primary key references mb.integrations(id) on delete cascade,
  refresh_token_enc bytea,
  access_token_enc  bytea,
  access_expires_at timestamptz,
  rotated_at        timestamptz,
  created_at        timestamptz not null default now()
);
-- schema priv: USAGE revoked from public in 004; belt and braces: RLS on, no policies
-- (only the owner — postgres — and BYPASSRLS roles see rows). service_role bypasses RLS
-- but still needs the privileges (nothing is granted to anon / authenticated, ever).
alter table priv.integration_tokens enable row level security;
grant usage on schema priv to service_role;
grant select, insert, update, delete on priv.integration_tokens to service_role;

-- ---------- employees (platform directory) ----------
create table if not exists mb.employees (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references mb.orgs(id) on delete cascade,
  platform    text not null check (platform in ('zoom','teams','meet','zoho','csv')),
  ext_id      text not null,
  email       text,
  name        text,
  title       text,
  dept        text,
  active      boolean not null default false,
  assigned_bg uuid[] not null default '{}'
    check (coalesce(array_length(assigned_bg, 1), 0) <= 10),   -- Zoom: max 10 files per user
  synced_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, platform, ext_id)
);
create index if not exists employees_org_idx   on mb.employees (org_id);
create index if not exists employees_email_idx on mb.employees (org_id, lower(email));

drop trigger if exists employees_touch on mb.employees;
create trigger employees_touch before update on mb.employees
  for each row execute function mb.touch_updated_at();

-- admins may flip `active` and `assigned_bg`; every other column is server-owned
-- (trigger order is alphabetical: employees_guard_columns runs before employees_touch)
create or replace function mb.guard_employee_columns()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if mb.is_trusted() then return new; end if;
  if new.id         is distinct from old.id
  or new.org_id     is distinct from old.org_id
  or new.platform   is distinct from old.platform
  or new.ext_id     is distinct from old.ext_id
  or new.email      is distinct from old.email
  or new.name       is distinct from old.name
  or new.title      is distinct from old.title
  or new.dept       is distinct from old.dept
  or new.synced_at  is distinct from old.synced_at
  or new.created_at is distinct from old.created_at then
    raise exception 'only active / assigned_bg are editable from the client';
  end if;
  -- every assigned background must belong to this org (the push function trusts this list)
  if exists (select 1 from unnest(new.assigned_bg) as u(bg_id)
             where not exists (select 1 from mb.backgrounds b
                               where b.id = u.bg_id and b.org_id = new.org_id)) then
    raise exception 'assigned_bg may only reference backgrounds of this workspace';
  end if;
  return new;
end $$;

drop trigger if exists employees_guard_columns on mb.employees;
create trigger employees_guard_columns
  before update on mb.employees
  for each row execute function mb.guard_employee_columns();

-- ---------- pushes (PushJob state machine, PLAN-integrations §2) ----------
create table if not exists mb.pushes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references mb.orgs(id) on delete cascade,
  employee_id     uuid not null references mb.employees(id) on delete cascade,
  background_id   uuid not null references mb.backgrounds(id) on delete cascade,
  platform        text not null check (platform in ('zoom','teams','meet','zoho')),
  state           text not null default 'queued'
                    check (state in ('queued','pushing','pushed','awaiting_client',
                                     'available','selected','blocked','failed')),
  idempotency_key text not null unique,     -- (employee, platform, asset sha256)
  remote_file_id  text,                     -- Zoom adapter owns remote file-id tracking
  evidence        jsonb,
  error           text,
  attempts        int not null default 0,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists pushes_org_idx      on mb.pushes (org_id, state);
create index if not exists pushes_employee_idx on mb.pushes (employee_id);

drop trigger if exists pushes_touch on mb.pushes;
create trigger pushes_touch before update on mb.pushes
  for each row execute function mb.touch_updated_at();

-- a push may only pair an employee and a background of ITS OWN org, on the employee's
-- platform — even the service role cannot hand one org's background to another org's user
create or replace function mb.guard_push_consistency()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if not exists (select 1 from mb.employees e
                 where e.id = new.employee_id and e.org_id = new.org_id and e.platform = new.platform) then
    raise exception 'pushes.employee_id must be an employee of this org on this platform';
  end if;
  if not exists (select 1 from mb.backgrounds b
                 where b.id = new.background_id and b.org_id = new.org_id) then
    raise exception 'pushes.background_id must be a background of this org';
  end if;
  return new;
end $$;

drop trigger if exists pushes_guard_consistency on mb.pushes;
create trigger pushes_guard_consistency
  before insert or update of org_id, employee_id, background_id, platform on mb.pushes
  for each row execute function mb.guard_push_consistency();

-- ---------- Row Level Security ----------
alter table mb.integrations enable row level security;
alter table mb.employees    enable row level security;
alter table mb.pushes       enable row level security;

-- integrations: members read; no client writes (no insert / update / delete policy)
drop policy if exists integrations_select on mb.integrations;
create policy integrations_select on mb.integrations
  for select using (org_id = mb.my_org());

-- employees: members read; admins update (columns guarded by trigger); no insert/delete
drop policy if exists employees_admin_select on mb.employees;    -- pre-review name, never applied
drop policy if exists employees_select on mb.employees;
create policy employees_select on mb.employees
  for select using (org_id = mb.my_org());
drop policy if exists employees_admin_update on mb.employees;
create policy employees_admin_update on mb.employees
  for update using (org_id = mb.my_org() and mb.my_role() = 'admin')
  with check (org_id = mb.my_org());

-- pushes: members read; everything else service role
drop policy if exists pushes_admin_select on mb.pushes;          -- pre-review name, never applied
drop policy if exists pushes_select on mb.pushes;
create policy pushes_select on mb.pushes
  for select using (org_id = mb.my_org());

-- ---------- is_org_admin(p_org): the Edge Functions' admin check ----------
-- Called with the caller's own JWT (anon key + Authorization: Bearer <access token>):
--   POST /rest/v1/rpc/is_org_admin {"p_org": "<uuid>"} → true only when the caller is an
-- admin of exactly that org. Reveals nothing about other orgs (false, never an error).
create or replace function mb.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = mb, public as
$$ select p_org is not null
      and exists (select 1 from mb.profiles
                  where id = auth.uid() and org_id = p_org and role = 'admin') $$;
revoke all on function mb.is_org_admin(uuid) from public, anon;
grant execute on function mb.is_org_admin(uuid) to authenticated, service_role;

-- ---------- token vault access (service_role only) ----------
-- PostgREST exposes public/graphql_public/mb, never priv, so the Edge Functions reach the
-- vault through these RPCs with the service-role key. SECURITY INVOKER on purpose: they run
-- as service_role, which is the only API role holding privileges on priv — even if EXECUTE
-- leaked, an anon/authenticated caller would still hit "permission denied for schema priv".
-- Ciphertext travels as hex text (encode/decode) so no driver has to guess the bytea format.
create or replace function mb.integration_token_get(p_integration_id uuid)
returns table (refresh_token_hex text, access_token_hex text, access_expires_at timestamptz, rotated_at timestamptz)
language sql stable set search_path = mb, public as $$
  select encode(t.refresh_token_enc, 'hex'), encode(t.access_token_enc, 'hex'),
         t.access_expires_at, t.rotated_at
  from priv.integration_tokens t
  where t.integration_id = p_integration_id
$$;
revoke all on function mb.integration_token_get(uuid) from public, anon, authenticated;
grant execute on function mb.integration_token_get(uuid) to service_role;

-- p_refresh_hex null = keep the stored refresh token (access-only refresh on platforms that
-- do not rotate); non-null = rotate (rotated_at := now()). Access token is always replaced.
create or replace function mb.integration_token_set(
  p_integration_id uuid, p_refresh_hex text, p_access_hex text, p_access_expires_at timestamptz)
returns void
language plpgsql set search_path = mb, public as $$
begin
  insert into priv.integration_tokens as t
    (integration_id, refresh_token_enc, access_token_enc, access_expires_at, rotated_at)
  values (p_integration_id, decode(p_refresh_hex, 'hex'), decode(p_access_hex, 'hex'),
          p_access_expires_at, case when p_refresh_hex is not null then now() end)
  on conflict (integration_id) do update
    set refresh_token_enc = coalesce(excluded.refresh_token_enc, t.refresh_token_enc),
        rotated_at        = case when excluded.refresh_token_enc is not null then now() else t.rotated_at end,
        access_token_enc  = excluded.access_token_enc,
        access_expires_at = excluded.access_expires_at;
end $$;
revoke all on function mb.integration_token_set(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function mb.integration_token_set(uuid, text, text, timestamptz) to service_role;

-- disconnect / delete-on-disconnect (PLAN §8 item 5): drop the vault row, keep the connection row
create or replace function mb.integration_token_delete(p_integration_id uuid)
returns void
language plpgsql set search_path = mb, public as $$
begin
  delete from priv.integration_tokens where integration_id = p_integration_id;
end $$;
revoke all on function mb.integration_token_delete(uuid) from public, anon, authenticated;
grant execute on function mb.integration_token_delete(uuid) to service_role;
