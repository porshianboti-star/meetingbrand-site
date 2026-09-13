-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../006-token-lease.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- MeetingBrand — 006 token lease: single-flight refresh for priv.integration_tokens
-- Requires 005-integrations.sql (priv.integration_tokens, integration_token_set/get/delete).
-- Applied together with the Zoom Edge Functions (mb-oauth-zoom, mb-sync-zoom, mb-push-zoom,
-- mb-integrations). Paste into: Supabase Dashboard → SQL Editor → Run (as postgres). Idempotent.
-- ------------------------------------------------------------
-- Why: Zoom ROTATES the refresh token on every refresh (PLAN-integrations §3.1). Two Edge
-- Function invocations refreshing the same integration at once would each get a new token
-- and the second write would kill the first — the org would drop to needs_reconnect for
-- nothing. `select … for update skip locked` serialises the *transaction*, but a PostgREST
-- RPC is one transaction and the Zoom round-trip happens outside it, so the lock alone is
-- not enough. The RPC therefore takes the row lock (skip locked → a concurrent caller gets
-- acquired=false instantly instead of blocking) AND stamps a short lease
-- (refresh_lease_until, ≤120 s) that survives the transaction. The lease is cleared by
-- integration_token_set (redefined below) or integration_token_end_refresh, and expires by
-- itself if the function died mid-refresh.
-- Callers (service_role only): _shared/zoom.ts getAccessToken().
-- ============================================================

alter table priv.integration_tokens
  add column if not exists refresh_lease_until timestamptz;

-- ---------- begin: try to take the lease ----------
-- acquired=true  → caller owns the refresh for p_lease_seconds and gets the current row
-- acquired=false → row_exists tells whether the vault row is there at all (false = reconnect)
create or replace function mb.integration_token_begin_refresh(p_integration_id uuid, p_lease_seconds int default 30)
returns table (acquired boolean, row_exists boolean,
               refresh_token_hex text, access_token_hex text,
               access_expires_at timestamptz, rotated_at timestamptz)
language plpgsql set search_path = mb, public as $$
declare
  r priv.integration_tokens%rowtype;
begin
  select * into r from priv.integration_tokens t
   where t.integration_id = p_integration_id
   for update skip locked;
  if not found then
    -- no row, or a concurrent transaction holds the row lock right now
    return query select false,
                        exists (select 1 from priv.integration_tokens t where t.integration_id = p_integration_id),
                        null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if r.refresh_lease_until is not null and r.refresh_lease_until > now() then
    return query select false, true, null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  update priv.integration_tokens
     set refresh_lease_until = now() + make_interval(secs => greatest(1, least(coalesce(p_lease_seconds, 30), 120)))
   where integration_id = p_integration_id;
  return query select true, true,
                      encode(r.refresh_token_enc, 'hex'), encode(r.access_token_enc, 'hex'),
                      r.access_expires_at, r.rotated_at;
end $$;
revoke all on function mb.integration_token_begin_refresh(uuid, int) from public, anon, authenticated;
grant execute on function mb.integration_token_begin_refresh(uuid, int) to service_role;

-- ---------- end: release the lease without writing tokens (refresh failed / not needed) ----------
create or replace function mb.integration_token_end_refresh(p_integration_id uuid)
returns void
language plpgsql set search_path = mb, public as $$
begin
  update priv.integration_tokens set refresh_lease_until = null where integration_id = p_integration_id;
end $$;
revoke all on function mb.integration_token_end_refresh(uuid) from public, anon, authenticated;
grant execute on function mb.integration_token_end_refresh(uuid) to service_role;

-- ---------- integration_token_set: same contract as 005, plus it clears the lease ----------
-- p_refresh_hex null = keep the stored refresh token; non-null = rotate (rotated_at := now()).
create or replace function mb.integration_token_set(
  p_integration_id uuid, p_refresh_hex text, p_access_hex text, p_access_expires_at timestamptz)
returns void
language plpgsql set search_path = mb, public as $$
begin
  insert into priv.integration_tokens as t
    (integration_id, refresh_token_enc, access_token_enc, access_expires_at, rotated_at, refresh_lease_until)
  values (p_integration_id, decode(p_refresh_hex, 'hex'), decode(p_access_hex, 'hex'),
          p_access_expires_at, case when p_refresh_hex is not null then now() end, null)
  on conflict (integration_id) do update
    set refresh_token_enc   = coalesce(excluded.refresh_token_enc, t.refresh_token_enc),
        rotated_at          = case when excluded.refresh_token_enc is not null then now() else t.rotated_at end,
        access_token_enc    = excluded.access_token_enc,
        access_expires_at   = excluded.access_expires_at,
        refresh_lease_until = null;
end $$;
revoke all on function mb.integration_token_set(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function mb.integration_token_set(uuid, text, text, timestamptz) to service_role;
