-- ============================================================
-- MeetingBrand — 005 integrations (PHASE 2)              *** NOT APPLIED YET ***
-- Do NOT run this on the project until the first platform adapter ships
-- (PLAN §5 item 17: supabase/functions/oauth-zoom, sync-zoom, push-zoom).
-- Requires 001-core.sql, 002-brand.sql, 004-deletion.sql (schema priv).
-- ------------------------------------------------------------
-- Source: /Users/motty/branded-background/PLAN-integrations.md §1-2 and PLAN §2.3.
-- Model:
--   integrations           : one row per (org, platform) connection; status machine
--   priv.integration_tokens: refresh/access tokens, envelope-encrypted, service role only
--   employees              : directory rows synced from the platform (key: org+platform+ext_id)
--   pushes                 : PushJob state machine per (employee, background, platform)
-- Security (PLAN §2.4):
--   integrations: members read; NO client write policies (Edge Functions write with service role)
--   employees   : admins read; admins may update only `active` and `assigned_bg` (trigger-guarded)
--   pushes      : admins read; everything else service role
--   priv.*      : no RLS exposure, schema revoked from public (PS priv.owner_keys pattern)
-- ============================================================

-- ---------- integrations ----------
create table if not exists public.integrations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  platform       text not null check (platform in ('zoom','teams','meet','zoho')),
  status         text not null default 'disconnected'
                   check (status in ('connected','needs_reconnect','disconnected','error')),
  account_ext_id text,
  scopes         text[] not null default '{}',
  connected_by   uuid references auth.users(id) on delete set null,
  connected_at   timestamptz,
  expires_at     timestamptz,
  last_sync_at   timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, platform)
);
create index if not exists integrations_org_idx on public.integrations (org_id);

drop trigger if exists integrations_touch on public.integrations;
create trigger integrations_touch before update on public.integrations
  for each row execute function public.touch_updated_at();

-- ---------- priv.integration_tokens (service role only) ----------
create table if not exists priv.integration_tokens (
  integration_id    uuid primary key references public.integrations(id) on delete cascade,
  refresh_token_enc bytea,
  access_token_enc  bytea,
  access_expires_at timestamptz,
  rotated_at        timestamptz,
  created_at        timestamptz not null default now()
);

-- ---------- employees (platform directory) ----------
create table if not exists public.employees (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  platform    text not null check (platform in ('zoom','teams','meet','zoho','csv')),
  ext_id      text not null,
  email       text,
  name        text,
  title       text,
  dept        text,
  active      boolean not null default false,
  assigned_bg uuid[] not null default '{}',
  synced_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, platform, ext_id)
);
create index if not exists employees_org_idx   on public.employees (org_id);
create index if not exists employees_email_idx on public.employees (org_id, lower(email));

drop trigger if exists employees_touch on public.employees;
create trigger employees_touch before update on public.employees
  for each row execute function public.touch_updated_at();

-- admins may flip `active` and `assigned_bg`; every other column is server-owned
create or replace function public.guard_employee_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if public.is_trusted() then return new; end if;
  if new.id       is distinct from old.id
  or new.org_id   is distinct from old.org_id
  or new.platform is distinct from old.platform
  or new.ext_id   is distinct from old.ext_id
  or new.email    is distinct from old.email
  or new.name     is distinct from old.name
  or new.title    is distinct from old.title
  or new.dept     is distinct from old.dept
  or new.synced_at is distinct from old.synced_at then
    raise exception 'only active / assigned_bg are editable from the client';
  end if;
  -- every assigned background must belong to this org (the push function trusts this list)
  if exists (select 1 from unnest(new.assigned_bg) as u(bg_id)
             where not exists (select 1 from public.backgrounds b
                               where b.id = u.bg_id and b.org_id = new.org_id)) then
    raise exception 'assigned_bg may only reference backgrounds of this workspace';
  end if;
  return new;
end $$;

drop trigger if exists employees_guard_columns on public.employees;
create trigger employees_guard_columns
  before update on public.employees
  for each row execute function public.guard_employee_columns();

-- ---------- pushes (PushJob state machine, PLAN-integrations §2) ----------
create table if not exists public.pushes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  background_id   uuid not null references public.backgrounds(id) on delete cascade,
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
create index if not exists pushes_org_idx      on public.pushes (org_id, state);
create index if not exists pushes_employee_idx on public.pushes (employee_id);

drop trigger if exists pushes_touch on public.pushes;
create trigger pushes_touch before update on public.pushes
  for each row execute function public.touch_updated_at();

-- ---------- Row Level Security ----------
alter table public.integrations enable row level security;
alter table public.employees    enable row level security;
alter table public.pushes       enable row level security;
-- priv.integration_tokens: schema already revoked from public in 004; belt and braces:
alter table priv.integration_tokens enable row level security;

-- integrations: members read; no client writes
drop policy if exists integrations_select on public.integrations;
create policy integrations_select on public.integrations
  for select using (org_id = public.my_org());

-- employees: admins read; admins update (columns guarded by trigger); no insert/delete
drop policy if exists employees_admin_select on public.employees;
create policy employees_admin_select on public.employees
  for select using (org_id = public.my_org() and public.my_role() = 'admin');
drop policy if exists employees_admin_update on public.employees;
create policy employees_admin_update on public.employees
  for update using (org_id = public.my_org() and public.my_role() = 'admin')
  with check (org_id = public.my_org());

-- pushes: admins read; everything else service role
drop policy if exists pushes_admin_select on public.pushes;
create policy pushes_admin_select on public.pushes
  for select using (org_id = public.my_org() and public.my_role() = 'admin');
