-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../00N-*.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- ============================================================
-- MeetingBrand — 002 brand: brand kits, assets, backgrounds, storage buckets
-- Requires 001-core.sql (orgs, profiles, my_org(), my_role(), is_trusted()).
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres). Idempotent.
-- ------------------------------------------------------------
-- Lineage:
--   ProSignature accounts.brand jsonb (supabase-setup.sql:23) — normalised into
--     rows so the CEO can count logo hits / sources (PLAN §2.3 brands)
--   CompanyCard cards (supabase-setup.sql:34-45, 108-123) → backgrounds, minus the
--     table-wide anon SELECT (cards_public_read) — replaced by public_background(slug)
-- Rules:
--   * no data URIs in jsonb — every binary lives in Storage, referenced by brand_assets
--   * one ACTIVE brand per org (partial unique index); history rows keep is_active=false
--   * backgrounds are owner-scoped AND org-scoped (a member removed from the org
--     loses their rows); admins see/edit every background of their org;
--     anonymous readers only get the share page through public_background(p_slug)
--   * cross-org references are refused: brand_id must be a brand of the caller's
--     org, an admin cannot hand a background to a user of another org, and a
--     brand_assets.storage_path always starts with its own org_id/
-- Storage buckets (PLAN §2.5): brand-assets (private), exports (private),
--   previews (public read). Object path convention: '<org_id>/<kind>/<sha>.<ext>' —
--   policies key on (storage.foldername(name))[1] = my_org().
-- ============================================================

-- ---------- Tables ----------
create table if not exists mb.brands (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references mb.orgs(id) on delete cascade,
  domain        text,
  name          text,
  source        text check (source in ('library','site','favicon','fallback','blocked','upload')),  -- 'demo' kits are never persisted (hadBrand guard, PLAN §3)
  primary_hex   text,
  secondary_hex text,
  accents       jsonb,                       -- state.accents (MB:1481-1490), hex strings only
  logo_opts     jsonb,                       -- the candidate list; remote URLs only, never data: URIs
  fetch_ms      int,
  fetched_at    timestamptz,
  is_active     boolean not null default true,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists brands_org_idx on mb.brands (org_id);
-- one active kit per org; history kept
create unique index if not exists brands_one_active_idx on mb.brands (org_id) where is_active;

create table if not exists mb.brand_assets (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references mb.orgs(id) on delete cascade,
  brand_id     uuid references mb.brands(id) on delete set null,
  kind         text not null check (kind in ('logo','logo_clear','logo_upload','scene','export','preview')),
  bucket       text not null default 'mb-brand-assets' check (bucket in ('mb-brand-assets','mb-exports','mb-previews')),
  storage_path text not null,                -- '<org_id>/<kind>/<sha256>.<ext>' inside `bucket`
    check (split_part(storage_path, '/', 1) = org_id::text and char_length(storage_path) <= 512),
  mime         text,
  width        int,
  height       int,
  bytes        int,
  sha256       text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (bucket, storage_path)
);
create index if not exists brand_assets_org_idx   on mb.brand_assets (org_id);
create index if not exists brand_assets_brand_idx on mb.brand_assets (brand_id);

-- the chosen logo (circular reference, so added after brand_assets exists)
alter table mb.brands
  add column if not exists logo_asset_id uuid references mb.brand_assets(id) on delete set null;

create table if not exists mb.backgrounds (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references mb.orgs(id) on delete cascade,
  owner_id         uuid not null references auth.users(id) on delete cascade,
  brand_id         uuid references mb.brands(id) on delete set null,
  slug             text not null unique default encode(extensions.gen_random_bytes(6), 'hex')
    check (slug ~ '^[a-z0-9_-]{6,64}$'),
  label            text,
  look             text,                     -- template / scene id from v76
  state            jsonb not null default '{}'::jsonb,   -- per-scene adj + sign text + font (persistAdj, MB:1021)
  preview_asset_id uuid references mb.brand_assets(id) on delete set null,  -- 280x158, bucket previews
  export_asset_id  uuid references mb.brand_assets(id) on delete set null,  -- 1920x1080 PNG, bucket exports
  is_public        boolean not null default false,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index if not exists backgrounds_org_idx   on mb.backgrounds (org_id);
create index if not exists backgrounds_owner_idx on mb.backgrounds (owner_id);

-- ---------- updated_at ----------
create or replace function mb.touch_updated_at()
returns trigger language plpgsql set search_path = mb, public as
$$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists brands_touch on mb.brands;
create trigger brands_touch before update on mb.brands
  for each row execute function mb.touch_updated_at();
drop trigger if exists backgrounds_touch on mb.backgrounds;
create trigger backgrounds_touch before update on mb.backgrounds
  for each row execute function mb.touch_updated_at();

-- ---------- Row Level Security ----------
alter table mb.brands       enable row level security;
alter table mb.brand_assets enable row level security;
alter table mb.backgrounds  enable row level security;

-- brands: members read; admins write (WITH CHECK pins org_id to the caller's org)
drop policy if exists brands_select on mb.brands;
create policy brands_select on mb.brands
  for select using (org_id = mb.my_org());
drop policy if exists brands_insert_admin on mb.brands;
create policy brands_insert_admin on mb.brands
  for insert with check (org_id = mb.my_org() and mb.my_role() = 'admin');
drop policy if exists brands_update_admin on mb.brands;
create policy brands_update_admin on mb.brands
  for update using (org_id = mb.my_org() and mb.my_role() = 'admin')
  with check (org_id = mb.my_org());
drop policy if exists brands_delete_admin on mb.brands;
create policy brands_delete_admin on mb.brands
  for delete using (org_id = mb.my_org() and mb.my_role() = 'admin');

-- brand_assets: members read; admins write everything; a member may register the
-- scene/export/preview files of their own backgrounds (logo kinds stay admin-only)
drop policy if exists brand_assets_select on mb.brand_assets;
create policy brand_assets_select on mb.brand_assets
  for select using (org_id = mb.my_org());
drop policy if exists brand_assets_insert on mb.brand_assets;
create policy brand_assets_insert on mb.brand_assets
  for insert with check (
    org_id = mb.my_org()
    and created_by = auth.uid()
    and (mb.my_role() = 'admin' or kind in ('scene','export','preview'))
    and (brand_id is null or exists (select 1 from mb.brands x
                                     where x.id = brand_id and x.org_id = mb.my_org()))
  );
drop policy if exists brand_assets_update_admin on mb.brand_assets;
create policy brand_assets_update_admin on mb.brand_assets
  for update using (org_id = mb.my_org() and mb.my_role() = 'admin')
  with check (
    org_id = mb.my_org()
    and (brand_id is null or exists (select 1 from mb.brands x
                                     where x.id = brand_id and x.org_id = mb.my_org()))
  );
drop policy if exists brand_assets_delete on mb.brand_assets;
create policy brand_assets_delete on mb.brand_assets
  for delete using (
    org_id = mb.my_org()
    and (mb.my_role() = 'admin' or created_by = auth.uid())
  );

-- backgrounds: owner full control (inside their current org only — a removed member
-- keeps nothing); admin read/update/delete of own org; NO anon select
drop policy if exists backgrounds_owner_all on mb.backgrounds;
create policy backgrounds_owner_all on mb.backgrounds
  for all using (owner_id = auth.uid() and org_id = mb.my_org())
  with check (
    owner_id = auth.uid() and org_id = mb.my_org()
    and (brand_id is null or exists (select 1 from mb.brands x
                                     where x.id = brand_id and x.org_id = mb.my_org()))
  );
drop policy if exists backgrounds_admin_select on mb.backgrounds;
create policy backgrounds_admin_select on mb.backgrounds
  for select using (org_id = mb.my_org() and mb.my_role() = 'admin');
drop policy if exists backgrounds_admin_update on mb.backgrounds;
create policy backgrounds_admin_update on mb.backgrounds
  for update using (org_id = mb.my_org() and mb.my_role() = 'admin')
  with check (
    org_id = mb.my_org()
    and exists (select 1 from mb.profiles pp             -- owner stays a member of this org
                where pp.id = owner_id and pp.org_id = mb.my_org())
    and (brand_id is null or exists (select 1 from mb.brands x
                                     where x.id = brand_id and x.org_id = mb.my_org()))
  );
drop policy if exists backgrounds_admin_delete on mb.backgrounds;
create policy backgrounds_admin_delete on mb.backgrounds
  for delete using (org_id = mb.my_org() and mb.my_role() = 'admin');

-- ---------- Public share page lookup (by slug only; replaces CC cards_public_read) ----------
-- preview_path is relative to the public bucket `previews`:
--   <SUPABASE_URL>/storage/v1/object/public/previews/<preview_path>
create or replace function mb.public_background(p_slug text)
returns table (slug text, label text, look text, org_name text, preview_path text, updated_at timestamptz)
language sql stable security definer set search_path = mb, public as $$
  select b.slug, b.label, b.look, o.name, a.storage_path, b.updated_at
  from mb.backgrounds b
  join mb.orgs o on o.id = b.org_id
  left join mb.brand_assets a on a.id = b.preview_asset_id and a.bucket = 'mb-previews'
                                  and a.org_id = b.org_id
  where b.slug = p_slug and b.is_public
  limit 1
$$;
grant execute on function mb.public_background(text) to anon, authenticated;

-- ---------- Storage buckets ----------
-- 15 MB cap per object (PLAN-integrations §2 "assert ≤15 MB"); previews are public-read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('mb-brand-assets', 'mb-brand-assets', false, 15728640,
     array['image/png','image/jpeg','image/webp','image/svg+xml','image/gif']),
  ('mb-exports',      'mb-exports',      false, 15728640,
     array['image/png','image/jpeg','image/webp']),
  ('mb-previews',     'mb-previews',     true,  2097152,
     array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------- Storage policies (storage.objects already has RLS enabled) ----------
-- Path rule for every bucket: first folder = the caller's org id.

-- brand-assets: private, org-scoped read/write
drop policy if exists mb_mb_brand_assets_select on storage.objects;
create policy mb_mb_brand_assets_select on storage.objects
  for select to authenticated
  using (bucket_id = 'mb-brand-assets' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_brand_assets_insert on storage.objects;
create policy mb_mb_brand_assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mb-brand-assets' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_brand_assets_update on storage.objects;
create policy mb_mb_brand_assets_update on storage.objects
  for update to authenticated
  using (bucket_id = 'mb-brand-assets' and (storage.foldername(name))[1] = mb.my_org()::text)
  with check (bucket_id = 'mb-brand-assets' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_brand_assets_delete on storage.objects;
create policy mb_mb_brand_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'mb-brand-assets' and (storage.foldername(name))[1] = mb.my_org()::text);

-- exports: private, org-scoped; Edge Functions (service role) mint signed URLs later
drop policy if exists mb_mb_exports_select on storage.objects;
create policy mb_mb_exports_select on storage.objects
  for select to authenticated
  using (bucket_id = 'mb-exports' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_exports_insert on storage.objects;
create policy mb_mb_exports_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mb-exports' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_exports_update on storage.objects;
create policy mb_mb_exports_update on storage.objects
  for update to authenticated
  using (bucket_id = 'mb-exports' and (storage.foldername(name))[1] = mb.my_org()::text)
  with check (bucket_id = 'mb-exports' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_exports_delete on storage.objects;
create policy mb_mb_exports_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'mb-exports' and (storage.foldername(name))[1] = mb.my_org()::text);

-- previews: org-scoped write; direct object GETs are public because the BUCKET is
-- public (/storage/v1/object/public/previews/<path> needs no policy) — that is what
-- share pages / OG images use. There is deliberately NO anon SELECT policy: a
-- SELECT policy is what the Storage *list* endpoint consults, and `using (bucket_id
-- = 'mb-previews')` would let the anon key enumerate every org's <org>/<background>.jpg
-- and fetch the previews of private backgrounds. Paths are unguessable uuids.
drop policy if exists mb_mb_previews_public_read on storage.objects;
drop policy if exists mb_mb_previews_select on storage.objects;
create policy mb_mb_previews_select on storage.objects
  for select to authenticated
  using (bucket_id = 'mb-previews' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_previews_insert on storage.objects;
create policy mb_mb_previews_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mb-previews' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_previews_update on storage.objects;
create policy mb_mb_previews_update on storage.objects
  for update to authenticated
  using (bucket_id = 'mb-previews' and (storage.foldername(name))[1] = mb.my_org()::text)
  with check (bucket_id = 'mb-previews' and (storage.foldername(name))[1] = mb.my_org()::text);
drop policy if exists mb_mb_previews_delete on storage.objects;
create policy mb_mb_previews_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'mb-previews' and (storage.foldername(name))[1] = mb.my_org()::text);

-- ---------- 2026-09-10 post-E2E: client-friendly defaults (PostgREST inserts may omit org_id / owner_id) ----------
alter table mb.brands       alter column org_id   set default mb.my_org();
alter table mb.brand_assets alter column org_id   set default mb.my_org();
alter table mb.backgrounds  alter column org_id   set default mb.my_org();
alter table mb.backgrounds  alter column owner_id set default auth.uid();
