// mb-export-pack — the delivery pack for the platforms WITHOUT a push API (Teams, Meet).
//
//   POST  Bearer <user access token>  (admin)  {"background_id":"<uuid>", "platform":"teams"|"meet", "employee_ids":["<uuid>",…]?}
//   → the background must belong to the org
//   → signed URLs (1 h) for the org's export assets in the format the platform accepts
//   → a per-platform runbook JSON {steps:[…]} + (Teams) the Intune PowerShell and macOS shell script text
//   → 200 {platform, background, ready, missing, assets:{…signed}, employees:[…], runbook:{steps}, scripts?, expires_at, generated}
//
// WHAT IS SERVER-GENERATED vs CLIENT-GENERATED (read this before touching the app):
//   client (the app, canvas in the browser — no image library is guaranteed in the Deno runtime):
//     * the 1920×1080 PNG export           → brand_assets kind 'export'      → backgrounds.export_asset_id      (exists since v81)
//     * the 280×158 PNG thumb (Teams tile) → brand_assets kind 'thumb'       → backgrounds.thumb_asset_id       (007-export-kinds.sql)
//     * the 1920×1080 JPEG (Meet console)  → brand_assets kind 'export_jpg'  → backgrounds.export_jpg_asset_id  (007-export-kinds.sql)
//   server (this function): asset ownership + path checks, signed URLs, the GUID file names, the runbook text and
//     the two scripts. It never renders, resizes or re-encodes an image and never claims a file it cannot sign.
//   ready:false + missing:[…] tells the app which client-rendered asset is still absent (the app renders + uploads it,
//     updates the backgrounds row, then calls again). Never a 500 for a missing asset.
//
// PLATFORM TRUTH (PLAN-integrations §3.2/§3.3): Teams needs <GUID>.png + <GUID>_thumb.png inside the new-Teams
// Uploads folder + a Teams restart + VideoFiltersMode=AllFilters; the employee picks the tile once, then it stays.
// Meet accepts JPEG only, ≤15 images per OU through the admin console, no default and no memory — employees
// re-select per browser; only the force-installed extension applies it automatically. The runbook says exactly that.
//
// The signed URLs live for ONE HOUR: the scripts embed them, so run/upload within the hour or request a new pack
// (Intune-packaged deployments should download the two files and ship them inside the package instead).

import { notConfiguredBody, supabaseEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { DELIVERY, isSafeOrgStoragePath, UUID_RE } from "../_shared/platform.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const SIGNED_URL_TTL_S = 3600;
export const MAX_EMPLOYEES = 2000;
/** PostgREST filters travel in the URL and the gateway caps it around 16 KB → `in.(…)` lists are sent in chunks. */
export const IN_CHUNK = 100;
export const EXPORT_BUCKET = "mb-exports";
export const TEAMS_THUMB = { width: 280, height: 158 } as const;
export const EXPORT_SIZE = { width: 1920, height: 1080 } as const;
export const TEAMS_UPLOADS_WIN = String.raw`%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\Backgrounds\Uploads`;
export const TEAMS_UPLOADS_MAC = "~/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/Backgrounds/Uploads";

type PackPlatform = "teams" | "meet";

interface AssetRow {
  id: string;
  kind: string;
  bucket: string;
  storage_path: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

interface SignedAsset {
  asset_id: string;
  kind: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  url: string;
  filename: string;
}

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return serveFn("mb-export-pack", async (req, { log }) => {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));

    const user = await requireUser(req, sbEnv.env, fetchImpl);
    const sb = serviceClient(sbEnv.env, fetchImpl);
    const admin = await requireOrgAdmin(sb, user);
    const orgId = admin.org_id;

    // ---------------------------------------------------------------- input
    const body = await readJson<{ background_id?: unknown; platform?: unknown; employee_ids?: unknown }>(req);
    const backgroundId = typeof body.background_id === "string" ? body.background_id : "";
    if (!UUID_RE.test(backgroundId)) throw new HttpError(400, "bad_request", "background_id must be a uuid");
    const platform = typeof body.platform === "string" ? body.platform : "";
    if (platform !== "teams" && platform !== "meet") throw new HttpError(400, "unsupported_platform", "platform must be teams or meet (Zoom pushes by API: mb-push-zoom)");
    let employeeIds: string[] | null = null;
    if (body.employee_ids !== undefined) {
      if (!Array.isArray(body.employee_ids)) throw new HttpError(400, "bad_request", "employee_ids must be an array of uuids");
      employeeIds = [...new Set(body.employee_ids.filter((x): x is string => typeof x === "string"))];
      if (employeeIds.length !== body.employee_ids.length || employeeIds.some((id) => !UUID_RE.test(id))) throw new HttpError(400, "bad_request", "employee_ids must be unique uuids");
      if (employeeIds.length > MAX_EMPLOYEES) throw new HttpError(400, "too_many", `at most ${MAX_EMPLOYEES} employees per pack`, { max: MAX_EMPLOYEES, given: employeeIds.length });
    }

    // ---------------------------------------------------------------- background (+ the 007 columns, tolerated when absent)
    const { data: bg, error: bgErr } = await sb.from("backgrounds").select("id, label, slug, export_asset_id").eq("id", backgroundId).eq("org_id", orgId).maybeSingle();
    if (bgErr) throw new HttpError(500, "db_error", `backgrounds lookup failed: ${bgErr.message}`);
    if (!bg) throw new HttpError(404, "background_not_found", "no such background in this workspace");
    let thumbAssetId: string | null = null;
    let jpgAssetId: string | null = null;
    let schema007 = true;
    {
      const { data: extra, error: exErr } = await sb.from("backgrounds").select("thumb_asset_id, export_jpg_asset_id").eq("id", backgroundId).maybeSingle();
      if (exErr) {
        schema007 = false; // 007-export-kinds.sql not applied yet → thumb/jpg simply count as missing
        log.warn("schema_007_missing", { message: exErr.message });
      } else {
        thumbAssetId = (extra?.thumb_asset_id as string | null) ?? null;
        jpgAssetId = (extra?.export_jpg_asset_id as string | null) ?? null;
      }
    }

    const wanted: Array<{ key: "png" | "thumb" | "jpg"; id: string | null; kind: string; mime: string; what: string }> = platform === "teams"
      ? [
        { key: "png", id: bg.export_asset_id, kind: "export", mime: "image/png", what: "1920×1080 PNG export (backgrounds.export_asset_id)" },
        { key: "thumb", id: thumbAssetId, kind: "thumb", mime: "image/png", what: "280×158 PNG thumb (backgrounds.thumb_asset_id, client-rendered)" },
      ]
      : [{ key: "jpg", id: jpgAssetId, kind: "export_jpg", mime: "image/jpeg", what: "1920×1080 JPEG (backgrounds.export_jpg_asset_id, client-rendered)" }];

    const ids = wanted.map((w) => w.id).filter((x): x is string => !!x);
    let assetRows: AssetRow[] = [];
    if (ids.length) {
      const { data, error } = await sb.from("brand_assets").select("id, kind, bucket, storage_path, mime, width, height, bytes").in("id", ids).eq("org_id", orgId);
      if (error) throw new HttpError(500, "db_error", `brand_assets lookup failed: ${error.message}`);
      assetRows = (data ?? []) as AssetRow[];
    }

    const guid = backgroundId.toUpperCase();
    const label = tileLabel(bg.label ?? bg.slug);
    const expiresAt = new Date(now() + SIGNED_URL_TTL_S * 1000).toISOString();
    const assets: Record<string, SignedAsset> = {};
    const missing: Array<{ key: string; kind: string; reason: string; what: string }> = [];

    for (const w of wanted) {
      const row = w.id ? assetRows.find((a) => a.id === w.id) : undefined;
      if (!w.id || !row) {
        missing.push({ key: w.key, kind: w.kind, reason: !w.id ? "not_registered" : "asset_row_missing", what: w.what });
        continue;
      }
      if (row.bucket !== EXPORT_BUCKET || !isSafeOrgStoragePath(row.storage_path, orgId)) {
        log.warn("export_path_rejected", { org_id: orgId, asset_id: row.id, bucket: row.bucket });
        missing.push({ key: w.key, kind: w.kind, reason: "bad_bucket_or_path", what: `${w.what} — must live in ${EXPORT_BUCKET}/<org>/…; export again` });
        continue;
      }
      const mime = row.mime ?? mimeFromExt(row.storage_path);
      if (mime !== w.mime) {
        missing.push({ key: w.key, kind: w.kind, reason: "wrong_format", what: `${w.what} — found ${mime ?? "unknown"}, need ${w.mime}` });
        continue;
      }
      const { data: signed, error: sErr } = await sb.storage.from(EXPORT_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_S);
      if (sErr || !signed?.signedUrl) {
        log.warn("sign_failed", { asset_id: row.id, message: sErr?.message ?? "no url" });
        missing.push({ key: w.key, kind: w.kind, reason: "sign_failed", what: `${w.what} — the file is missing from storage; export again` });
        continue;
      }
      const ext = w.mime === "image/jpeg" ? "jpg" : "png";
      const filename = platform === "teams" ? (w.key === "thumb" ? `${guid}${label}_thumb.png` : `${guid}${label}.png`) : `${label}.${ext}`; // label already carries the "MeetingBrand - " prefix
      assets[w.key] = { asset_id: row.id, kind: row.kind, mime, width: row.width, height: row.height, bytes: row.bytes, url: signed.signedUrl, filename };
    }
    const ready = missing.length === 0;

    // ---------------------------------------------------------------- employees (who the pack targets)
    type EmpRow = { id: string; ext_id: string; email: string | null; name: string | null; title: string | null; dept: string | null; active: boolean };
    const employees: EmpRow[] = [];
    const empSelect = () => sb.from("employees").select("id, ext_id, email, name, title, dept, active").eq("org_id", orgId).eq("platform", platform);
    if (employeeIds) {
      for (let i = 0; i < employeeIds.length; i += IN_CHUNK) {
        const { data: empRows, error: empErr } = await empSelect().in("id", employeeIds.slice(i, i + IN_CHUNK)).limit(IN_CHUNK);
        if (empErr) throw new HttpError(500, "db_error", `employees lookup failed: ${empErr.message}`);
        employees.push(...((empRows ?? []) as EmpRow[]));
      }
    } else {
      const { data: empRows, error: empErr } = await empSelect().eq("active", true).limit(MAX_EMPLOYEES);
      if (empErr) throw new HttpError(500, "db_error", `employees lookup failed: ${empErr.message}`);
      employees.push(...((empRows ?? []) as EmpRow[]));
    }
    const unknown = employeeIds ? employeeIds.filter((id) => !employees.some((e) => e.id === id)) : [];

    // ---------------------------------------------------------------- runbook + scripts
    const pack = platform === "teams"
      ? teamsPack({ guid, label, png: assets.png?.url ?? "", thumb: assets.thumb?.url ?? "", expiresAt, employees })
      : meetPack({ label, jpg: assets.jpg?.url ?? "", filename: assets.jpg?.filename ?? "", expiresAt, employees });

    await recordEvent(sb, "export_pack", user.id, { platform, org_id: orgId, background_id: backgroundId, ready, employees: employees.length, missing: missing.map((m) => m.key) });
    log.info("pack", { org_id: orgId, platform, background_id: backgroundId, ready, missing: missing.map((m) => m.key), employees: employees.length, unknown: unknown.length, schema007 });
    return json(req, 200, {
      platform,
      background: { id: bg.id, label: bg.label, slug: bg.slug, guid: platform === "teams" ? guid : undefined },
      ready,
      missing,
      schema_007_applied: schema007,
      assets,
      expires_at: expiresAt,
      employees: employees.map((e) => ({ id: e.id, ext_id: e.ext_id, email: e.email, name: e.name, title: e.title, dept: e.dept, active: e.active })),
      unknown_employee_ids: unknown,
      delivery: DELIVERY[platform],
      generated: {
        server: ["asset ownership + bucket/path checks", "signed URLs (1 h)", "GUID file names", "runbook steps", ...(platform === "teams" ? ["Intune PowerShell script", "macOS shell script"] : [])],
        client: platform === "teams" ? ["1920×1080 PNG export (kind export)", "280×158 PNG thumb (kind thumb)"] : ["1920×1080 JPEG export (kind export_jpg)"],
      },
      ...pack,
    });
  });
}

/** Tile label appended after the GUID (text after the GUID becomes the Teams tile label): ASCII, no path chars, ≤ 40. */
export function tileLabel(label: string | null | undefined): string {
  const base = (label ?? "").normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|$`'{}]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return base ? `MeetingBrand - ${base}` : "MeetingBrand";
}

function mimeFromExt(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  switch ((m?.[1] ?? "").toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    default: return null;
  }
}

interface Emp {
  id: string;
  email: string | null;
  name: string | null;
}

export function teamsPack(p: { guid: string; label: string; png: string; thumb: string; expiresAt: string; employees: Emp[] }) {
  const pngName = `${p.guid}${p.label}.png`;
  const thumbName = `${p.guid}${p.label}_thumb.png`;
  const upns = p.employees.map((e) => e.email).filter((x): x is string => !!x);
  const ps1 = [
    `# MeetingBrand - Teams background drop (Windows). Generated ${new Date().toISOString().slice(0, 10)}; the download URLs expire at ${p.expiresAt}.`,
    `# Intune: Devices > Scripts and remediations > Platform scripts > Add (Windows 10 and later)`,
    `#   "Run this script using the logged on credentials": YES   (the folder is inside the user's profile)`,
    `#   "Run script in 64 bit PowerShell Host": YES   -> assign to the Entra user group of the employees below.`,
    `# Win32 app alternative: package the two files with this script; detection rule = file exists: "$Dir\\${pngName}".`,
    `# Requirements (cannot be set from here): new Teams client; meeting policy VideoFiltersMode = AllFilters; no Teams Premium "required background" policy on the user.`,
    `$ErrorActionPreference = "Stop"`,
    `$PngUrl   = "${p.png}"`,
    `$ThumbUrl = "${p.thumb}"`,
    `$Dir = Join-Path $env:LOCALAPPDATA "Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache\\Microsoft\\MSTeams\\Backgrounds\\Uploads"`,
    `New-Item -ItemType Directory -Force -Path $Dir | Out-Null`,
    `Invoke-WebRequest -UseBasicParsing -Uri $PngUrl   -OutFile (Join-Path $Dir "${pngName}")`,
    `Invoke-WebRequest -UseBasicParsing -Uri $ThumbUrl -OutFile (Join-Path $Dir "${thumbName}")`,
    `Write-Output "MeetingBrand: wrote ${pngName} + ${thumbName}. Quit and relaunch Teams, then pick the tile once under Video effects."`,
  ].join("\r\n");
  const sh = [
    `#!/bin/sh`,
    `# MeetingBrand - Teams background drop (macOS). The download URLs expire at ${p.expiresAt}.`,
    `# Intune: Devices > macOS > Shell scripts > Add; "Run script as signed-in user": YES.  Jamf: Policy > Scripts, run as the logged-in user.`,
    `# Requirements: new Teams (com.microsoft.teams2); meeting policy VideoFiltersMode = AllFilters; no Premium "required background" policy.`,
    `set -eu`,
    `PNG_URL='${p.png}'`,
    `THUMB_URL='${p.thumb}'`,
    `DIR="$HOME/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/Backgrounds/Uploads"`,
    `mkdir -p "$DIR"`,
    `curl -fsSL "$PNG_URL" -o "$DIR/${pngName}"`,
    `curl -fsSL "$THUMB_URL" -o "$DIR/${thumbName}"`,
    `echo "MeetingBrand: wrote ${pngName} + ${thumbName}. Quit and relaunch Teams, then pick the tile once under Video effects."`,
  ].join("\n");
  return {
    files: { png: pngName, thumb: thumbName, windows_folder: TEAMS_UPLOADS_WIN, macos_folder: TEAMS_UPLOADS_MAC },
    runbook: {
      platform: "teams",
      honest_limit: "Teams has no background API. This pack puts the tile into each employee's gallery; the employee picks it once after restarting Teams, and it then stays on that device. Only a Teams Premium customization policy (\"Set as required\") can force it.",
      steps: [
        { n: 1, title: "Pre-flight (Teams admin center)", detail: "Meeting policy for the target users: Video effects = All video effects (VideoFiltersMode=AllFilters). Users must be on the new Teams client and not under a Premium \"required background\" policy." },
        { n: 2, title: "Create the Intune platform script", detail: "Windows: paste scripts.windows_ps1 as a Platform script, \"Run using logged-on credentials: Yes\", 64-bit: Yes. macOS: paste scripts.macos_sh as a Shell script, \"Run as signed-in user: Yes\" (Jamf: same script as a policy run as the logged-in user)." },
        { n: 3, title: "Assign", detail: `Assign to an Entra user group containing the ${p.employees.length} employee(s) in this pack (${upns.length} with a UPN/e-mail).` },
        { n: 4, title: "Deploy within one hour", detail: `The two download URLs expire at ${p.expiresAt}. Deploying later? Download ${pngName} and ${thumbName} now and package them as a Win32 app / Jamf package with this script, or request a new pack.` },
        { n: 5, title: "Employee action (once)", detail: "Fully quit and relaunch Teams. In a meeting or pre-join screen: Video effects → the tile appears under Uploads → select it once. It persists in all meetings and calls on that device until changed." },
        { n: 6, title: "Force it (Teams Premium only)", detail: "Admin center → Meetings → Customization policies → upload the PNG (≤50 images) → \"Set as required\". Assignment: Grant-CsTeamsMeetingBrandingPolicy -Identity user@… -PolicyName …; upload itself is not scriptable." },
      ],
      employees: p.employees.map((e) => ({ id: e.id, email: e.email, name: e.name })),
    },
    scripts: { windows_ps1: ps1, macos_sh: sh },
  };
}

export function meetPack(p: { label: string; jpg: string; filename: string; expiresAt: string; employees: Emp[] }) {
  const depts = new Map<string, number>();
  for (const e of p.employees as Array<Emp & { dept?: string | null }>) depts.set(e.dept ?? "(no department)", (depts.get(e.dept ?? "(no department)") ?? 0) + 1);
  return {
    files: { jpg: p.filename, format: "JPEG 1920×1080 (PNG is not accepted by the Meet admin console)" },
    runbook: {
      platform: "meet",
      honest_limit: "Google Meet has no background API and does not remember a chosen background. This pack adds the image to the gallery for an OU or group; employees re-select it per browser/device. Only the force-installed MeetingBrand Chrome extension applies it automatically.",
      steps: [
        { n: 1, title: "Download the JPEG", detail: `Save ${p.filename || "the JPEG"} (URL expires at ${p.expiresAt}). It is exactly 1920×1080 — the maximum Google accepts; never upscale.` },
        { n: 2, title: "Host it in Drive", detail: "Upload to a shared drive and share \"Anyone with the link · Viewer\" (the admin console pulls the image from Drive)." },
        { n: 3, title: "Admin console", detail: "Apps → Google Workspace → Google Meet → Meet video settings → choose the OU or group → Visual effects → \"Custom images provided by you\" → add the Drive image and label it. Limit: 15 images per OU." },
        { n: 4, title: "Narrow the gallery (optional)", detail: "Untick \"custom images employees provide themselves\" and \"stock seasonal images\" so the branded image is the obvious choice." },
        { n: 5, title: "Wait", detail: "Up to 24 hours to propagate. There is no default and no lock." },
        { n: 6, title: "Employee action (every browser)", detail: "Before joining: Apply visual effects → Backgrounds → the branded image. Meet does not remember it across browsers/devices/incognito." },
        { n: 7, title: "True auto-apply", detail: "Force-install the MeetingBrand Chrome extension by extension ID (Admin console → Devices → Chrome → Apps & extensions → Users & browsers) once it ships; it composites the background itself." },
      ],
      targets: { employees: p.employees.length, by_department: Object.fromEntries(depts) },
      employees: p.employees.map((e) => ({ id: e.id, email: e.email, name: e.name })),
    },
  };
}

export const handler = makeHandler();
