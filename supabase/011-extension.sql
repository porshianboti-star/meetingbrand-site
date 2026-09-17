-- ============================================================
-- MeetingBrand — 011 extension: the Meet browser extension enrolls like an agent (PLAN-active-push §1.3 + §3)
-- Requires 010-agent.sql (enrollment_keys, agents, agent_reports, revoke_agent), 005-integrations.sql (pushes,
--          guard_push_consistency). Idempotent.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres) — or the Management API (shared project).
-- ------------------------------------------------------------
-- Why: the force-installed Chrome/Edge extension ("MeetingBrand for Google Meet") is one more device that
-- enrolls with the org key and polls mb-agent. It is a browser, not an OS install, so:
--   * agents.os gains 'chrome' | 'edge' (the extension's host browser; hostname stays null — a browser
--     has no hostname the extension may read)
--   * a 'meet' push may target an employee row of ANY platform (like 'teams' since 010): the extension matched
--     the person by e-mail; the roster source (CSV / Google directory / Zoom) is irrelevant to the browser
--     that composites the background
--   * agent_reports.state gains the extension's vocabulary: 'applied' (the composited stream is what Meet
--     sends — rung A), 'unavailable' (image cached on the device, not applied: toggle off, Meet's own effect
--     on, no WebGL/WASM, …) — 'error' is shared with the agent
--   * revoke_agent() also fails the device's 'meet' pushes, so the chips stay honest after a revoke
-- Nothing else changes: same key/token model, same RLS, same views.
-- ============================================================

alter table public.agents drop constraint if exists agents_os_check;
alter table public.agents add constraint agents_os_check
  check (os in ('windows','macos','chrome','edge'));

alter table public.agent_reports drop constraint if exists agent_reports_state_check;
alter table public.agent_reports add constraint agent_reports_state_check
  check (state in ('written','verified','restart_needed','removed','blocked','error','applied','unavailable'));

-- 010 let a 'teams' push target an employee of any platform; 'meet' (the extension) gets the same rule.
create or replace function public.guard_push_consistency()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.employees e
                 where e.id = new.employee_id and e.org_id = new.org_id
                   and (e.platform = new.platform or new.platform in ('teams','meet'))) then
    raise exception 'pushes.employee_id must be an employee of this org on this platform';
  end if;
  if not exists (select 1 from public.backgrounds b
                 where b.id = new.background_id and b.org_id = new.org_id) then
    raise exception 'pushes.background_id must be a background of this org';
  end if;
  return new;
end $$;

-- revoke_agent: the device token keeps its hash so the next call answers 410; teams AND meet pushes of the device fail
create or replace function public.revoke_agent(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.my_org();
begin
  if v_org is null then raise exception 'not authenticated'; end if;
  if public.my_role() <> 'admin' then raise exception 'admin only'; end if;
  update public.agents set revoked_at = now()
   where id = p_id and org_id = v_org and revoked_at is null;
  if not found then return false; end if;
  update public.pushes set state = 'failed',
         error = 'device revoked — the agent removes the file on its next poll'
   where agent_id = p_id and org_id = v_org and platform = 'teams'
     and state in ('queued','pushing','pushed','awaiting_client','available','selected','blocked');
  update public.pushes set state = 'failed',
         error = 'device revoked — the extension stops applying the background on its next poll'
   where agent_id = p_id and org_id = v_org and platform = 'meet'
     and state in ('queued','pushing','pushed','awaiting_client','available','selected','blocked');
  return true;
end $$;
revoke all on function public.revoke_agent(uuid) from public, anon;
grant execute on function public.revoke_agent(uuid) to authenticated;
