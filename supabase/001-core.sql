-- ============================================================
-- MeetingBrand — 001 core: tenants, users, invites, signup trigger, RLS
-- Project: meetingbrand (org "companycard", region eu-central-1 / Frankfurt)
-- Run order: 001 → 002 → 003 → 004 (005 is NOT applied yet).
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres). Idempotent.
-- ------------------------------------------------------------
-- Lineage (read-only donors):
--   CompanyCard  /Users/motty/cc-work/supabase-setup.sql          lines 19-181
--   ProSignature scratchpad/prosignature/supabase-setup.sql       lines 132-150
-- Model:
--   orgs      : one row per customer workspace (CC companies + PS accounts)
--   profiles  : one row per login user (→ auth.users), role = admin | member
--   invites   : admin-generated invite tokens (CC verbatim, + email match)
-- Security (RLS, enforced by the database):
--   * a user only ever sees rows of their OWN org (my_org())
--   * NO INSERT policy on orgs/profiles — rows are created only by the
--     SECURITY DEFINER signup trigger handle_new_user()
--   * profiles.org_id / role / id and orgs.plan are protected by BEFORE UPDATE
--     triggers (the hole both sisters carry: profiles_update_self lets a user
--     PATCH their own role/account_id — cc-auth gotchas, ps-auth gotchas)
--   * orgs.plan changes only with the service role (or an owner RPC in 004)
--   * profiles.email and orgs.domain are immutable from the client: they are the
--     trust anchors of org_for_domain / join_org_by_domain (security review
--     2026-09-09 — a patched email or domain could hijack a company's Join card)
--   * org_for_domain answers only for the caller's own verified email domain
--     (no domain → customer oracle for anyone who signs up with a throwaway mail)
-- Free-mail domains never become orgs.domain (PLAN §3 "Free-mail domain").
-- ============================================================

-- pgcrypto lives in schema "extensions" on Supabase (gen_random_bytes for 002).
create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  domain     text,                                   -- null for free-mail signups until they give a website
  plan       text not null default 'free' check (plan in ('free','pro','business')),
  settings   jsonb not null default '{}'::jsonb,     -- {domain_join:'invite'|'open', default_look, ...}
  created_at timestamptz not null default now()
);
-- NOT unique on purpose: two orgs may share a domain (PLAN §3 "Same domain signs up twice").
create index if not exists orgs_domain_idx on public.orgs (domain);

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid not null references public.orgs(id) on delete cascade,
  role       text not null check (role in ('admin','member')) default 'admin',
  full_name  text,
  title      text,
  email      text,
  created_at timestamptz not null default now()
);
create index if not exists profiles_org_idx on public.profiles (org_id);

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  token       uuid not null unique default gen_random_uuid(),
  email       text,                                  -- optional; when set, the signup email must match
  role        text not null check (role in ('admin','member')) default 'member',
  created_by  uuid not null references auth.users(id) on delete cascade default auth.uid(),
  accepted_by uuid references auth.users(id) on delete set null,   -- never block delete_my_account
  accepted_at timestamptz,
  expires_at  timestamptz not null default now() + interval '14 days',
  created_at  timestamptz not null default now()
);
create index if not exists invites_org_idx on public.invites (org_id);
-- idempotent repair of the FK for a project created before the review (no-op on a fresh one)
alter table public.invites drop constraint if exists invites_accepted_by_fkey;
alter table public.invites add constraint invites_accepted_by_fkey
  foreign key (accepted_by) references auth.users(id) on delete set null;

-- Free-mail providers: an org never gets one of these as its domain.
-- Mirrors the client GENERIC list (PLAN §3, PS app.html:1231 extended).
create table if not exists public.free_mail_domains (
  domain text primary key
);
insert into public.free_mail_domains (domain) values
  ('gmail.com'),('googlemail.com'),('outlook.com'),('hotmail.com'),('live.com'),
  ('yahoo.com'),('icloud.com'),('me.com'),('proton.me'),('protonmail.com'),
  ('aol.com'),('gmx.com'),('gmx.de'),('yandex.com'),('yandex.ru'),('mail.com'),
  ('msn.com'),('walla.co.il'),('walla.com'),('outlook.co.il'),('hotmail.co.il'),
  ('yahoo.co.uk'),('ymail.com'),('zoho.com'),('fastmail.com'),('hey.com')
on conflict (domain) do nothing;

-- ---------- Helper functions (used inside policies and triggers) ----------
create or replace function public.my_org() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from public.profiles where id = auth.uid() $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

-- "Trusted" = the service role, the postgres/SQL-editor user, or code running
-- inside one of our own SECURITY DEFINER RPCs (they execute as postgres).
-- auth.role() reads request.jwt.claim.role AND request.jwt.claims->>'role',
-- so it works on both the legacy and the current PostgREST claim formats.
create or replace function public.is_trusted() returns boolean
language sql stable set search_path = public as
$$ select current_user in ('postgres','service_role','supabase_admin')
       or coalesce(auth.role(), '') = 'service_role' $$;

create or replace function public.is_free_mail(p_domain text) returns boolean
language sql stable set search_path = public as
$$ select exists (select 1 from public.free_mail_domains where domain = lower(p_domain)) $$;

-- Normalise what a human typed into a bare host: "https://www.Acme.com/about" → "acme.com".
-- Returns null unless the result is a plausible hostname (labels of [a-z0-9-], at
-- least one dot, ≤ 253 chars) — orgs.domain never holds free text.
create or replace function public.clean_domain(p_raw text) returns text
language sql immutable set search_path = public as
$$
  select case
           when h ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
                and length(h) <= 253
           then h
         end
  from (
    select regexp_replace(
             regexp_replace(
               regexp_replace(lower(trim(coalesce(p_raw, ''))), '^[a-z]+://', ''),   -- scheme
               '^[^/]*@', ''),                                                       -- "user@" prefix
             '^www\.|[/?#:].*$', '', 'g') as h                                       -- www. prefix, path/port
  ) s
$$;

-- ---------- Column guards (BEFORE UPDATE) ----------
-- profiles: id never changes; org_id only by trusted code (join RPC / service role);
-- role only by trusted code or by an admin of the same org editing someone else.
create or replace function public.guard_profile_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if public.is_trusted() then
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'profiles.id is immutable';
  end if;
  if new.org_id is distinct from old.org_id then
    raise exception 'profiles.org_id cannot be changed from the client';
  end if;
  if new.email is distinct from old.email then
    raise exception 'profiles.email is set at signup and cannot be changed from the client';
  end if;
  if new.role is distinct from old.role then
    if not (public.my_role() = 'admin' and old.org_id = public.my_org() and old.id <> auth.uid()) then
      raise exception 'only an admin of the same org can change another member''s role';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_columns on public.profiles;
create trigger profiles_guard_columns
  before update on public.profiles
  for each row execute function public.guard_profile_columns();

-- orgs: plan is writable by the service role / owner RPC only (payment webhook later);
-- domain only through set_org_domain() (clean + free-mail check) — a direct PATCH
-- could make domain='gmail.com' and hijack every gmail signup's Join card.
create or replace function public.guard_org_plan()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.id is distinct from old.id then
    raise exception 'orgs.id is immutable';
  end if;
  if public.is_trusted() then
    return new;
  end if;
  if new.plan is distinct from old.plan then
    raise exception 'orgs.plan is set server-side only';
  end if;
  if new.domain is distinct from old.domain then
    raise exception 'orgs.domain changes only through set_org_domain()';
  end if;
  return new;
end $$;

drop trigger if exists orgs_guard_plan on public.orgs;
create trigger orgs_guard_plan
  before update on public.orgs
  for each row execute function public.guard_org_plan();

-- ---------- Row Level Security ----------
alter table public.orgs              enable row level security;
alter table public.profiles          enable row level security;
alter table public.invites           enable row level security;
alter table public.free_mail_domains enable row level security;

-- orgs: members read their own org; admin may rename / change settings / domain
drop policy if exists orgs_select on public.orgs;
create policy orgs_select on public.orgs
  for select using (id = public.my_org());
drop policy if exists orgs_update on public.orgs;
create policy orgs_update on public.orgs
  for update using (id = public.my_org() and public.my_role() = 'admin')
  with check (id = public.my_org() and public.my_role() = 'admin');

-- profiles: user sees own; admin sees all of own org
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    id = auth.uid()
    or (org_id = public.my_org() and public.my_role() = 'admin')
  );
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());              -- columns further restricted by profiles_guard_columns
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update using (org_id = public.my_org() and public.my_role() = 'admin')
  with check (org_id = public.my_org());
drop policy if exists profiles_delete_admin on public.profiles;
create policy profiles_delete_admin on public.profiles
  for delete using (
    org_id = public.my_org() and public.my_role() = 'admin' and id <> auth.uid()
  );

-- invites: only admins of the org manage them (CC invites_admin_all)
drop policy if exists invites_admin_all on public.invites;
create policy invites_admin_all on public.invites
  for all using (org_id = public.my_org() and public.my_role() = 'admin')
  with check (org_id = public.my_org() and public.my_role() = 'admin');

-- free_mail_domains: readable by everyone (the client may sync its GENERIC list), never writable
drop policy if exists free_mail_domains_read on public.free_mail_domains;
create policy free_mail_domains_read on public.free_mail_domains
  for select to anon, authenticated using (true);

-- ---------- Signup trigger ----------
-- Runs once per new auth user (email+password AND Google signInWithIdToken).
--   metadata.invite_token          → join the inviting org with the invite's role
--                                    (email must match invites.email when one was set)
--   otherwise                      → create an org; the user becomes its admin
--     domain  = the work-email domain (authoritative, from new.email), or the
--               metadata.domain the user typed when the email is free-mail;
--               free-mail domains never become orgs.domain
--     name    = metadata.company_name | Initcap(first label of domain) | 'My workspace'
-- Google signups carry no domain/company_name metadata (ps-auth gotchas) — the
-- email-derived domain covers them, so no placeholder rows as in ProSignature.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org         uuid;
  v_role        text := 'member';
  v_token       uuid;
  v_invite      public.invites%rowtype;
  v_email       text := lower(coalesce(new.email, ''));
  v_mail_domain text := nullif(split_part(lower(coalesce(new.email, '')), '@', 2), '');
  v_meta_domain text := public.clean_domain(new.raw_user_meta_data->>'domain');
  v_company     text := nullif(left(trim(coalesce(new.raw_user_meta_data->>'company_name', '')), 120), '');
  v_domain      text;
  v_full_name   text := left(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), 120);
begin
  if coalesce(new.raw_user_meta_data->>'invite_token', '') <> '' then
    begin
      v_token := (new.raw_user_meta_data->>'invite_token')::uuid;
    exception when others then
      raise exception 'Invite link is invalid or has expired';
    end;
    select * into v_invite from public.invites
      where token = v_token and accepted_at is null and expires_at > now()
      for update;                                   -- two signups racing on one token: second one fails
    if v_invite.id is null then
      raise exception 'Invite link is invalid or has expired';
    end if;
    if v_invite.email is not null and lower(v_invite.email) <> v_email then
      raise exception 'This invite was issued to a different email address';
    end if;
    v_org  := v_invite.org_id;
    v_role := v_invite.role;
    update public.invites
      set accepted_by = new.id, accepted_at = now() where id = v_invite.id;
  else
    if v_mail_domain is not null and not public.is_free_mail(v_mail_domain) then
      v_domain := v_mail_domain;
    elsif v_meta_domain is not null and not public.is_free_mail(v_meta_domain) then
      v_domain := v_meta_domain;
    else
      v_domain := null;
    end if;
    insert into public.orgs (name, domain)
      values (coalesce(v_company,
                       nullif(initcap(split_part(coalesce(v_domain, ''), '.', 1)), ''),
                       'My workspace'),
              v_domain)
      returning id into v_org;
    v_role := 'admin';
  end if;

  insert into public.profiles (id, org_id, role, full_name, email)
  values (new.id, v_org, v_role, v_full_name, new.email);
  return new;
end $$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Invite lookup for the gate (anonymous, by token only) ----------
create or replace function public.invite_info(p_token uuid)
returns table (org_name text, email text, role text)
language sql stable security definer set search_path = public as $$
  select o.name, i.email, i.role
  from public.invites i join public.orgs o on o.id = i.org_id
  where i.token = p_token and i.accepted_at is null and i.expires_at > now()
$$;
grant execute on function public.invite_info(uuid) to anon, authenticated;

-- ---------- set_org_domain: free-mail signups (and any admin) give a website ----------
-- Called by the client after signup when orgs.domain is null (gate step 2), or
-- from Settings. Normalises the input, refuses free-mail providers, and fixes the
-- placeholder name. Returns the stored domain, or null when nothing was stored.
create or replace function public.set_org_domain(p_domain text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid := public.my_org();
  v_domain text := public.clean_domain(p_domain);
  v_name   text;
begin
  if v_org is null then raise exception 'not authenticated'; end if;
  if public.my_role() <> 'admin' then raise exception 'admin only'; end if;
  if v_domain is null or public.is_free_mail(v_domain) then
    return null;
  end if;
  select name into v_name from public.orgs where id = v_org;
  update public.orgs
     set domain = v_domain,
         name   = case when v_name is null or v_name = 'My workspace'
                       then coalesce(nullif(initcap(split_part(v_domain, '.', 1)), ''), v_name)
                       else v_name end
   where id = v_org;
  return v_domain;
end $$;
revoke all on function public.set_org_domain(text) from public, anon;
grant execute on function public.set_org_domain(text) to authenticated;

-- ---------- org_for_domain: "N people from acme.com already use MeetingBrand" ----------
-- Only "verified" orgs are listed: an org counts for a domain when at least one
-- of its members signed up with an auth email on that domain (a gmail user who
-- typed domain=acme.com into their own org does not hijack acme's signup card).
-- Answers ONLY for the caller's own auth-email domain: that is the only domain
-- the caller could ever join, and it removes the "which companies use
-- MeetingBrand?" oracle. Free-mail domains never match. Excludes the caller's
-- own org. Authenticated only. Emails come from auth.users, never from the
-- client-editable profiles row.
create or replace function public.org_for_domain(p_domain text)
returns table (org_id uuid, name text, member_count bigint, domain_join text)
language sql stable security definer set search_path = public as $$
  with me as (
    select split_part(lower(coalesce(u.email, '')), '@', 2) as domain
    from auth.users u where u.id = auth.uid()
  )
  select o.id, o.name,
         (select count(*) from public.profiles p where p.org_id = o.id),
         coalesce(o.settings->>'domain_join', 'invite')
  from public.orgs o, me
  where o.domain is not null
    and o.domain = public.clean_domain(p_domain)
    and o.domain = me.domain
    and not public.is_free_mail(o.domain)
    and o.id is distinct from public.my_org()
    and exists (select 1 from public.profiles p join auth.users u on u.id = p.id
                where p.org_id = o.id
                  and split_part(lower(coalesce(u.email, '')), '@', 2) = o.domain)
  order by 3 desc, o.created_at
$$;
revoke all on function public.org_for_domain(text) from public, anon;
grant execute on function public.org_for_domain(text) to authenticated;

-- ---------- join_org_by_domain: the "Join" button of the same-domain card ----------
-- Moves a fresh signup (sole member of their auto-created org) into an existing
-- org of the same email domain, as a member, when that org opted in with
-- settings.domain_join = 'open'. The now-empty auto-created org is deleted.
-- profiles.org_id is otherwise immutable from the client (profiles_guard_columns).
create or replace function public.join_org_by_domain(p_org_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid         uuid := auth.uid();
  v_old_org     uuid := public.my_org();
  v_mail_domain text;
  v_target      public.orgs%rowtype;
begin
  if v_uid is null or v_old_org is null then raise exception 'not authenticated'; end if;
  -- the auth email is the trust anchor (profiles.email is a copy; guarded, but never rely on it)
  select split_part(lower(coalesce(u.email, '')), '@', 2) into v_mail_domain
    from auth.users u where u.id = v_uid;
  select * into v_target from public.orgs where id = p_org_id;
  if v_target.id is null then raise exception 'workspace not found'; end if;
  if v_target.id = v_old_org then return; end if;
  if v_target.domain is null or v_mail_domain is null or v_mail_domain = ''
     or v_target.domain <> v_mail_domain or public.is_free_mail(v_target.domain) then
    raise exception 'your email domain does not match this workspace';
  end if;
  if coalesce(v_target.settings->>'domain_join', 'invite') <> 'open' then
    raise exception 'this workspace requires an invite link';
  end if;
  if (select count(*) from public.profiles where org_id = v_old_org) <> 1 then
    raise exception 'leave your current workspace first';
  end if;
  update public.profiles set org_id = v_target.id, role = 'member' where id = v_uid;
  delete from public.orgs where id = v_old_org;   -- cascades brands/backgrounds/invites of the empty org
end $$;
revoke all on function public.join_org_by_domain(uuid) from public, anon;
grant execute on function public.join_org_by_domain(uuid) to authenticated;
