-- ============================================================
-- MeetingBrand — 004 deletion: self-serve account deletion + owner back office
-- Requires 001-core.sql, 002-brand.sql, 003-events.sql.
-- Also hosts signup_export(k) (owner-key gated; see the 2026-09-09 review note in 003).
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres). Idempotent.
-- ------------------------------------------------------------
-- Lineage: ProSignature supabase-account-deletion.sql (2026-07-21), verbatim
-- semantics with orgs/profiles names, and ONE deliberate change: the owner RPCs
-- are granted to `authenticated` only (PS grants them to anon — anyone on the
-- internet could brute-force the owner key; ps-auth gotchas).
-- Service-key-free: everything runs as SECURITY DEFINER inside Postgres, so no
-- service_role key is ever needed in the web tier. Google verification and the
-- privacy page (/privacy/ "Self-serve deletion") point at delete_my_account().
-- The priv.owner_keys row is inserted BY HAND (SETUP.md) and never committed.
-- Storage note: deleting rows cascades DB references; the physical objects under
-- <org_id>/ in the buckets are removed by the owner from Dashboard → Storage (or
-- by a phase-2 Edge Function with the service role) — same as ProSignature.
-- ============================================================

create schema if not exists priv;
revoke all on schema priv from public;

create table if not exists priv.owner_keys (
  key        text primary key,
  label      text,
  created_at timestamptz not null default now()
);
-- belt and braces on top of the schema revoke: no policies, so only the table
-- owner (postgres — i.e. the SECURITY DEFINER RPCs below and the SQL editor) can read it
alter table priv.owner_keys enable row level security;

create or replace function priv.check_owner_key(k text) returns void
language plpgsql stable security definer set search_path = priv, public as $$
begin
  if k is null or not exists (select 1 from priv.owner_keys where key = k) then
    raise exception 'forbidden';
  end if;
end $$;
revoke all on function priv.check_owner_key(text) from public, anon, authenticated;

-- ---------- self-serve deletion (called by the logged-in user) ----------
create or replace function public.delete_my_account()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select org_id into v_org from public.profiles where id = v_uid;
  update public.events set user_id = null where user_id = v_uid;   -- keep the funnel, drop the identity
  delete from auth.users where id = v_uid;   -- cascades: profiles, backgrounds (owner), invites (created_by)
  if v_org is not null and not exists
     (select 1 from public.profiles where org_id = v_org) then
    delete from public.orgs where id = v_org;  -- cascades: brands, brand_assets, backgrounds, invites
  end if;
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------- owner: list all orgs ----------
-- Shape kept close to PS owner_list_accounts so the back office swaps only
-- `signatures` → `backgrounds` (company = orgs.name).
create or replace function public.owner_list_accounts(k text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform priv.check_owner_key(k);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'company', o.name, 'domain', o.domain, 'plan', o.plan,
      'created_at', o.created_at,
      'backgrounds', (select count(*) from public.backgrounds b where b.org_id = o.id),
      'brand_source', (select br.source from public.brands br
                       where br.org_id = o.id and br.is_active limit 1),
      'users', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', p.id, 'email', p.email,
                 'role', p.role, 'name', p.full_name, 'created_at', p.created_at))
               from public.profiles p where p.org_id = o.id),
               '[]'::jsonb)
    ) order by o.created_at desc)
    from public.orgs o), '[]'::jsonb);
end $$;
revoke all on function public.owner_list_accounts(text) from public, anon;
grant execute on function public.owner_list_accounts(text) to authenticated;

-- ---------- owner: delete a whole tenant ----------
create or replace function public.owner_delete_account(k text, acc uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform priv.check_owner_key(k);
  select count(*) into n from public.profiles where org_id = acc;
  update public.events set user_id = null
   where user_id in (select id from public.profiles where org_id = acc);
  delete from auth.users
   where id in (select id from public.profiles where org_id = acc);
  delete from public.orgs where id = acc;
  return n;
end $$;
revoke all on function public.owner_delete_account(text, uuid) from public, anon;
grant execute on function public.owner_delete_account(text, uuid) to authenticated;

-- ---------- owner: signup_export(k) — the Sheet/CEO export with the QA filter baked in ----------
-- One row per org (its first admin). Column names follow CompanyCard's PROJECT.md
-- (admin_email, company_name, domain, plan, created_at, …) so the sheet agent needs
-- only `cards` → `backgrounds`. Lists customer emails, therefore owner-key gated
-- like the other owner RPCs (was authenticated-only before the 2026-09-09 review:
-- any throwaway signup could dump every customer). Call:
--   POST /rest/v1/rpc/signup_export  {"k": "<owner key>"}  with a signed-in session.
create or replace function public.signup_export(k text)
returns table (
  admin_email  text,
  company_name text,
  domain       text,
  plan         text,
  created_at   timestamptz,
  backgrounds  bigint,
  team_members bigint,
  brand_source text
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform priv.check_owner_key(k);
  return query
  with test_domains(d) as (values
    ('prosignature-test.co'), ('example.com'), ('google.com'), ('nike.com'),
    ('prosignature.com'), ('compamy-card.com'), ('meetingbrand.com')),
  test_emails(e) as (values
    ('porshianboti@gmail.com'), ('motty@aijustlearn.com')),
  first_admin as (
    select distinct on (p.org_id) p.org_id, p.email
    from public.profiles p
    where p.role = 'admin'
    order by p.org_id, p.created_at
  )
  select fa.email,
         o.name,
         o.domain,
         o.plan,
         o.created_at,
         (select count(*) from public.backgrounds b where b.org_id = o.id),
         (select count(*) from public.profiles   p where p.org_id = o.id),
         (select br.source from public.brands br where br.org_id = o.id and br.is_active limit 1)
  from public.orgs o
  join first_admin fa on fa.org_id = o.id
  where split_part(lower(coalesce(fa.email, '')), '@', 2) not in (select d from test_domains)
    and lower(coalesce(fa.email, '')) not in (select e from test_emails)
  order by o.created_at desc;
end $$;
revoke all on function public.signup_export(text) from public, anon;
grant execute on function public.signup_export(text) to authenticated;
-- the pre-review, ungated zero-argument version must not survive on a project that ran the old 003
drop function if exists public.signup_export();

-- ---------- owner: set a tenant's plan (the only client-reachable path past guard_org_plan) ----------
-- Until a payment processor + Edge Function webhook exist, the owner flips plans here
-- after a manual payment. Runs as postgres → is_trusted() → the plan guard allows it.
create or replace function public.owner_set_plan(k text, acc uuid, p_plan text)
returns text
language plpgsql security definer set search_path = public as $$
begin
  perform priv.check_owner_key(k);
  if p_plan not in ('free','pro','business') then raise exception 'unknown plan'; end if;
  update public.orgs set plan = p_plan where id = acc;
  if not found then raise exception 'workspace not found'; end if;
  return p_plan;
end $$;
revoke all on function public.owner_set_plan(text, uuid, text) from public, anon;
grant execute on function public.owner_set_plan(text, uuid, text) to authenticated;
