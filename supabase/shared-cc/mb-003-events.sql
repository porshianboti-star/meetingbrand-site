-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../00N-*.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- ============================================================
-- MeetingBrand — 003 events: first-party funnel events + the two CEO RPCs
-- Requires 001-core.sql (orgs, profiles, brands from 002 are used by signup_export).
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres). Idempotent.
-- ------------------------------------------------------------
-- Lineage: CompanyCard's live `events` table + `funnel_stats(p_days)` RPC, which
-- were created by hand in the SQL editor and never committed (cc-track gotchas).
-- Consumer contract (must not change):
--   /Users/motty/cc-work/app/analytics.html:71-95 →
--     POST /rest/v1/rpc/funnel_stats {"p_days": N} → [{event, total, uniques}]
--   ceo-daily-metrics SKILL.md:225 → the same curl with the anon key
-- Security:
--   * INSERT only, for anon + authenticated, CHECK product = 'meetingbrand'
--     (and a client can only stamp its own user_id)
--   * id / created_at / product are stamped by a BEFORE INSERT trigger for
--     untrusted callers — a client cannot future-date rows into every
--     funnel_stats window or pre-burn sequence ids (review 2026-09-09)
--   * NO SELECT policy — reads go through funnel_stats / signup_export
--   * signup_export lives in 004 (owner-key gated): it lists customer emails,
--     so `authenticated` — anyone with a throwaway signup — must not reach it
-- QA convention (PLAN §4): test sessions use session_id prefixed 'qa-'; those rows
-- are stored but excluded from funnel_stats, so the D-117 class of "QA row became
-- a first" does not recur. signup_export carries the SKILL.md:13 QA filter.
-- ============================================================

create table if not exists mb.events (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  product    text not null default 'meetingbrand',
  event      text not null check (char_length(event) between 1 and 64),
  session_id text check (session_id is null or char_length(session_id) <= 128),
  user_id    uuid,                            -- no FK: rows outlive accounts (anonymised on deletion, see 004)
  path       text check (path is null or char_length(path) <= 512),
  props      jsonb check (props is null or octet_length(props::text) <= 4096)
);
create index if not exists events_created_idx on mb.events (created_at);
create index if not exists events_event_idx   on mb.events (product, event, created_at);

alter table mb.events enable row level security;

drop policy if exists events_insert on mb.events;
create policy events_insert on mb.events
  for insert to anon, authenticated
  with check (
    product = 'meetingbrand'
    and (user_id is null or user_id = auth.uid())
  );
-- (no select / update / delete policies: the anon key can only append)

-- server-stamped columns: whatever the client sent for id / created_at / product is ignored
create or replace function mb.events_stamp()
returns trigger language plpgsql set search_path = mb, public as $$
begin
  if not mb.is_trusted() then
    new.id         := nextval(pg_get_serial_sequence('mb.events', 'id'));
    new.created_at := now();
    new.product    := 'meetingbrand';
  end if;
  return new;
end $$;
drop trigger if exists events_stamp on mb.events;
create trigger events_stamp before insert on mb.events
  for each row execute function mb.events_stamp();
grant usage on all sequences in schema public to anon, authenticated;   -- events_id_seq (bigserial) for the client's insert

-- ---------- funnel_stats(p_days) — exactly as analytics.html consumes it ----------
-- uniques = distinct visitors: signed-in actions count by user, else by session.
create or replace function mb.funnel_stats(p_days int)
returns table (event text, total bigint, uniques bigint)
language sql stable security definer set search_path = mb, public as $$
  select e.event,
         count(*)                                                  as total,
         count(distinct coalesce(e.user_id::text, e.session_id))  as uniques
  from mb.events e
  where e.product = 'meetingbrand'
    and e.created_at > now() - (greatest(coalesce(p_days, 1), 1) * interval '1 day')
    and coalesce(e.session_id, '') not like 'qa-%'
  group by e.event
  order by e.event
$$;
grant execute on function mb.funnel_stats(int) to anon, authenticated;

-- ---------- signup_export ----------
-- Defined in 004-deletion.sql as signup_export(k text), gated by priv.owner_keys.
