-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../008-employees-csv.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- ============================================================
-- MeetingBrand — 008 employees CSV: the client-side fallback of the My-team import
-- Requires 005-integrations.sql (employees, guard_employee_columns, my_org(), my_role(), is_trusted()). Idempotent.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres).
-- ------------------------------------------------------------
-- Why: the My-team tab (product v86) lets an admin upload a CSV (name, email, title, department) when no
-- meeting platform is connected yet. Those rows are typed by the customer, not synced from a directory, so
-- 005's rule "every column except active/assigned_bg is server-owned" does not apply to them:
--   * employees_admin_insert_csv: an ADMIN of the org may INSERT rows with platform = 'csv' only
--     (org_id = my_org(), ext_id/email/name/title/dept from the file; synced_at stays null).
--   * guard_employee_columns: for platform = 'csv' the admin may also change email / name / title / dept
--     (a re-upload of the same CSV = upsert on (org_id, platform, ext_id)); id / org_id / platform / ext_id /
--     synced_at / created_at stay immutable for everyone, and assigned_bg is still checked against the org.
--   * platform-synced rows (zoom / teams / meet / zoho) are exactly as strict as before.
-- No DELETE policy: the CSV rows are removed by delete_my_account (org cascade) or by the service role.
-- ============================================================

drop policy if exists employees_admin_insert_csv on mb.employees;
create policy employees_admin_insert_csv on mb.employees
  for insert with check (
    org_id = mb.my_org()
    and mb.my_role() = 'admin'
    and platform = 'csv'
  );

create or replace function mb.guard_employee_columns()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if mb.is_trusted() then return new; end if;
  if new.id         is distinct from old.id
  or new.org_id     is distinct from old.org_id
  or new.platform   is distinct from old.platform
  or new.ext_id     is distinct from old.ext_id
  or new.synced_at  is distinct from old.synced_at
  or new.created_at is distinct from old.created_at then
    raise exception 'id / org / platform / ext_id / synced_at / created_at are immutable from the client';
  end if;
  -- directory-synced rows: the platform owns the person's details (008: CSV rows are the customer's own text)
  if old.platform <> 'csv' and (
     new.email      is distinct from old.email
  or new.name       is distinct from old.name
  or new.title      is distinct from old.title
  or new.dept       is distinct from old.dept) then
    raise exception 'only active / assigned_bg are editable from the client for a synced directory row';
  end if;
  -- every assigned background must belong to this org (the push function trusts this list)
  if exists (select 1 from unnest(new.assigned_bg) as u(bg_id)
             where not exists (select 1 from mb.backgrounds b
                               where b.id = u.bg_id and b.org_id = new.org_id)) then
    raise exception 'assigned_bg may only reference backgrounds of this workspace';
  end if;
  return new;
end $$;
