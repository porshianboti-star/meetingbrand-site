-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../012-zoom-app.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- ============================================================
-- MeetingBrand — 012 zoom app: the user-managed "MeetingBrand for Zoom" app enrolls like an agent (PLAN-active-push §1.2)
-- Requires 011-extension.sql (agents.os chrome|edge, meet pushes), 010-agent.sql, 005-integrations.sql. Idempotent.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres) — or the Management API (shared project).
-- ------------------------------------------------------------
-- Why: the Zoom Apps SDK page ("MeetingBrand for Zoom", hosted by the Edge Function mb-zoom-app) calls
-- zoomSdk.setVirtualBackground({fileUrl}) when the Zoom client opens it (Auto-open at meeting start, or from the
-- Apps panel). It is one more device that polls mb-agent — but it has NO org enrollment key: its identity is the
-- Zoom user id from the x-zoom-app-context header, which only the app's client secret can decrypt (mb-zoom-app
-- turns it into a short HMAC ticket; mb-agent /zoom/resolve exchanges the ticket for a device token when that
-- Zoom user is in the roster of a workspace whose Zoom integration is connected — employees.platform 'zoom',
-- ext_id = the Zoom user id written by mb-sync-zoom). So:
--   * agents.os gains 'zoom' (device_id = 'zoom:<random per Zoom client web view>', local_identity = the Zoom user id)
--   * a 'zoom' push may target an employee row of ANY platform (same rule as 'teams' and 'meet' — the person was
--     matched by Zoom user id; in practice the row IS the 'zoom' directory row)
--   * agent_reports.state gains 'denied' (the employee refused Zoom's own consent dialog for the background)
--   * revoke_agent() also fails the device's 'zoom' pushes
-- The Zoom App's pushes rows use idempotency_key '<org>:<employee>:<background>:zoom' — distinct from mb-push-zoom's
-- REST library upload rows ('<org>:<employee>:<background>', no suffix): the library upload and the in-client
-- activation are two deliveries of the same pair and stay two rows.
-- ============================================================

alter table mb.agents drop constraint if exists agents_os_check;
alter table mb.agents add constraint agents_os_check
  check (os in ('windows','macos','chrome','edge','zoom'));

alter table mb.agent_reports drop constraint if exists agent_reports_state_check;
alter table mb.agent_reports add constraint agent_reports_state_check
  check (state in ('written','verified','restart_needed','removed','blocked','error','applied','unavailable','denied'));

-- 010/011 let a 'teams' / 'meet' push target an employee of any platform; 'zoom' (the Zoom App) gets the same rule.
create or replace function mb.guard_push_consistency()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if not exists (select 1 from mb.employees e
                 where e.id = new.employee_id and e.org_id = new.org_id
                   and (e.platform = new.platform or new.platform in ('teams','meet','zoom'))) then
    raise exception 'pushes.employee_id must be an employee of this org on this platform';
  end if;
  if not exists (select 1 from mb.backgrounds b
                 where b.id = new.background_id and b.org_id = new.org_id) then
    raise exception 'pushes.background_id must be a background of this org';
  end if;
  return new;
end $$;

-- revoke_agent: teams, meet AND zoom pushes of the device fail (REST library uploads have agent_id null — untouched)
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
  update mb.pushes set state = 'failed',
         error = 'device revoked — the agent removes the file on its next poll'
   where agent_id = p_id and org_id = v_org and platform = 'teams'
     and state in ('queued','pushing','pushed','awaiting_client','available','selected','blocked');
  update mb.pushes set state = 'failed',
         error = 'device revoked — the extension stops applying the background on its next poll'
   where agent_id = p_id and org_id = v_org and platform = 'meet'
     and state in ('queued','pushing','pushed','awaiting_client','available','selected','blocked');
  update mb.pushes set state = 'failed',
         error = 'device revoked — the Zoom App stops setting the background on its next open'
   where agent_id = p_id and org_id = v_org and platform = 'zoom'
     and state in ('queued','pushing','pushed','awaiting_client','available','selected','blocked');
  return true;
end $$;
revoke all on function mb.revoke_agent(uuid) from public, anon;
grant execute on function mb.revoke_agent(uuid) to authenticated;
