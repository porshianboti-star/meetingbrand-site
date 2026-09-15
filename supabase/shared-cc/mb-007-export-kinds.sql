-- ============================================================
-- MeetingBrand on the SHARED CompanyCard Supabase project (free plan, ref ohobtgbyrlczfdztzvqi)
-- Everything lives in schema "mb". Only auth.users is shared with CompanyCard.
-- Generated from ../007-export-kinds.sql by transform (do not hand-edit; edit the source and re-run).
-- ============================================================
-- MeetingBrand — 007 export kinds: the client-rendered delivery assets for Teams and Meet
-- Requires 002-brand.sql (brand_assets, backgrounds). Idempotent.
-- Paste into: Supabase Dashboard → SQL Editor → Run (as postgres).
-- ------------------------------------------------------------
-- Why: Teams needs <GUID>.png (1920×1080) + <GUID>_thumb.png (280×158) in the new-Teams gallery
-- folder; the Meet admin console accepts JPEG only. No image library is guaranteed in the Edge
-- runtime, so the APP renders both files in the browser (canvas) and registers them here; the
-- Edge Function mb-export-pack only signs URLs for rows that exist (PLAN-integrations §3.2/§3.3).
--   brand_assets.kind  += 'thumb' (280×158 PNG, bucket exports), 'export_jpg' (1920×1080 JPEG, bucket exports)
--   backgrounds        += thumb_asset_id, export_jpg_asset_id (same shape as export_asset_id)
--   brand_assets_insert: a member may register thumb/export_jpg of their own backgrounds (like scene/export/preview)
-- ============================================================

alter table mb.brand_assets drop constraint if exists brand_assets_kind_check;
alter table mb.brand_assets add constraint brand_assets_kind_check
  check (kind in ('logo','logo_clear','logo_upload','scene','export','preview','thumb','export_jpg'));

alter table mb.backgrounds
  add column if not exists thumb_asset_id      uuid references mb.brand_assets(id) on delete set null,  -- 280x158 PNG (Teams tile), bucket exports
  add column if not exists export_jpg_asset_id uuid references mb.brand_assets(id) on delete set null;  -- 1920x1080 JPEG (Meet console), bucket exports

drop policy if exists brand_assets_insert on mb.brand_assets;
create policy brand_assets_insert on mb.brand_assets
  for insert with check (
    org_id = mb.my_org()
    and created_by = auth.uid()
    and (mb.my_role() = 'admin' or kind in ('scene','export','preview','thumb','export_jpg'))
    and (brand_id is null or exists (select 1 from mb.brands x
                                     where x.id = brand_id and x.org_id = mb.my_org()))
  );
