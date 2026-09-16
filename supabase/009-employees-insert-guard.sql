-- ============================================================
-- MeetingBrand — 009 employees insert guard: the BEFORE INSERT twin of guard_employee_columns (security review 2026-09-16)
-- Requires 008-employees-csv.sql (employees_admin_insert_csv, is_trusted(), backgrounds). Idempotent.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres).
-- ------------------------------------------------------------
-- Why: 008 opened INSERT on mb.employees to admins (platform = 'csv' only, own org — the policy). The column guard
-- of 005/008 runs on UPDATE only, so a client INSERT could still:
--   * carry assigned_bg ids of ANOTHER workspace's backgrounds (the update guard forbids exactly that),
--   * set synced_at, making a hand-typed row look directory-synced,
--   * write unbounded text into ext_id / email / name / title / dept,
--   * grow without limit (no per-org cap on CSV rows).
-- The service role (the directory syncs) is untouched: is_trusted() short-circuits, exactly like the update guard.
-- Client rows are pinned to platform = 'csv' here as well (belt and braces with the policy), synced_at is forced
-- null, text columns are capped (ext_id/email 320, name/title/dept 200 — the same caps the Edge Functions use),
-- assigned_bg must reference this org's backgrounds, and one org keeps at most 5000 CSV rows.
-- ============================================================

create or replace function public.guard_employee_insert()
returns trigger language plpgsql set search_path = public as $$
declare
  v_csv_rows int;
begin
  if public.is_trusted() then return new; end if;
  if new.platform is distinct from 'csv' then
    raise exception 'only platform = ''csv'' rows can be inserted from the client';
  end if;
  new.synced_at := null;                       -- a typed row is never "synced"
  if length(coalesce(new.ext_id, '')) = 0 or length(new.ext_id) > 320
  or length(coalesce(new.email, '')) > 320
  or length(coalesce(new.name,  '')) > 200
  or length(coalesce(new.title, '')) > 200
  or length(coalesce(new.dept,  '')) > 200 then
    raise exception 'employee text fields exceed their limits (ext_id/email 320, name/title/dept 200)';
  end if;
  -- every assigned background must belong to this org (same rule as the update guard)
  if exists (select 1 from unnest(new.assigned_bg) as u(bg_id)
             where not exists (select 1 from public.backgrounds b
                               where b.id = u.bg_id and b.org_id = new.org_id)) then
    raise exception 'assigned_bg may only reference backgrounds of this workspace';
  end if;
  select count(*) into v_csv_rows from public.employees e where e.org_id = new.org_id and e.platform = 'csv';
  if v_csv_rows >= 5000 then
    raise exception 'at most 5000 CSV employees per workspace';
  end if;
  return new;
end $$;

drop trigger if exists employees_guard_insert on public.employees;
create trigger employees_guard_insert
  before insert on public.employees
  for each row execute function public.guard_employee_insert();
