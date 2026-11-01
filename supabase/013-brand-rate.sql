-- ============================================================
-- MeetingBrand — standalone-project layout (schema public); the applied twin is shared-cc/mb-013-brand-rate.sql
-- ============================================================
-- MeetingBrand — 013 brand-rate: the per-caller minute window of the mb-brand Edge Function (BRIEFS-EN.md C3, 2026-11-01).
-- Requires 001-core.sql (schema mb). Idempotent. Applied via the Management API together with the deployed function.
-- ------------------------------------------------------------
-- The function (supabase/functions/mb-brand) fetches a customer's public website server-side. Its in-memory window is per
-- isolate, so the authoritative 20/min per caller lives here. The key is an HMAC of the caller's address — the address itself
-- is never stored. Rows older than an hour are swept opportunistically (10 % of calls) by the function itself.
-- Security: no client role can read or write the table or call the RPC — service_role only (the Edge Function's key).
-- ============================================================

create table if not exists public.brand_rate (
  key    text        not null check (char_length(key) between 8 and 64),
  minute timestamptz not null,
  hits   int         not null default 0,
  primary key (key, minute)
);
create index if not exists brand_rate_minute_idx on public.brand_rate (minute);   -- the sweep deletes by minute
alter table public.brand_rate enable row level security;
-- the schema's default privileges granted everything to anon/authenticated at CREATE — take it all back
revoke all on public.brand_rate from public, anon, authenticated;

create or replace function public.brand_rate_hit(p_key text, p_limit int default 20)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_key is null or char_length(p_key) < 8 or char_length(p_key) > 64 then return false; end if;
  insert into public.brand_rate as r (key, minute, hits)
    values (p_key, date_trunc('minute', now()), 1)
    on conflict (key, minute) do update set hits = r.hits + 1
    returning r.hits into n;
  if random() < 0.10 then
    delete from public.brand_rate where minute < now() - interval '1 hour';   -- review: bounded growth even under a flood of fresh keys
  end if;
  return n <= greatest(coalesce(p_limit, 20), 1);
end $$;
revoke all on function public.brand_rate_hit(text, int) from public, anon, authenticated;
grant execute on function public.brand_rate_hit(text, int) to service_role;
