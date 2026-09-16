// _shared/platform.ts — what every connector shares: the integration row, the employee upsert,
// the honest per-platform delivery sentence, and the storage-path guard.
//
// The three directory connectors (Zoom, Teams/Graph, Meet/Admin SDK) all end in the same place:
// mb.employees rows keyed (org_id, platform, ext_id). Rows that vanished upstream are NOT deleted
// (the admin's active / assigned_bg choices survive) — they are reported as `stale`.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import { HttpError } from "./http.ts";

export type DirectoryPlatform = "zoom" | "teams" | "meet";
export const DIRECTORY_PLATFORMS: readonly DirectoryPlatform[] = ["zoom", "teams", "meet"] as const;

/** One directory person, platform-agnostic (what a sync writes). */
export interface Employee {
  ext_id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  dept: string | null;
}

export interface IntegrationRow {
  id: string;
  org_id: string;
  platform: string;
  status: string;
  account_ext_id: string | null;
  last_sync_at?: string | null;
}

/**
 * Verified delivery facts per platform (PLAN-integrations.md §3, 2026-09-04, re-checked by six adversarial
 * checks). These sentences are what the product shows next to "Delivered": never more than this.
 */
export const DELIVERY: Record<DirectoryPlatform, string> = {
  zoom:
    "MeetingBrand uploads the background into each employee's own Zoom virtual-background library by API; Zoom has no API to activate it, so the employee signs out/in and picks it once, then it stays.",
  teams:
    "Teams has no background API: MeetingBrand imports the directory from Microsoft Graph and hands you an Intune/Jamf script (or the MeetingBrand agent) that drops <GUID>.png + <GUID>_thumb.png into each employee's new-Teams gallery folder — the employee picks it once after restarting Teams; only a Teams Premium customization policy can force it.",
  meet:
    "Google Meet has no background API and does not remember a choice: MeetingBrand imports the directory from the Admin SDK and hands you a 1920×1080 JPEG plus the admin-console runbook (≤15 images per OU, Drive-hosted, up to 24 h to appear) — employees re-select it per browser; only the force-installed MeetingBrand Chrome extension applies it automatically.",
};

/** Load the org's integration row for one platform, or null. */
export async function loadIntegration(sb: SupabaseClient, orgId: string, platform: string): Promise<IntegrationRow | null> {
  const { data, error } = await sb.from("integrations").select("id, org_id, platform, status, account_ext_id, last_sync_at").eq("org_id", orgId).eq("platform", platform).maybeSingle();
  if (error) throw new Error(`integrations lookup: ${error.message}`);
  return (data as IntegrationRow | null) ?? null;
}

/** 409 unless the platform row exists and is usable. */
export function requireConnected(integ: IntegrationRow | null, platform: DirectoryPlatform, startHint: string): IntegrationRow {
  if (!integ || integ.status === "disconnected") throw new HttpError(409, "not_connected", `connect ${platform} first (${startHint})`);
  if (integ.status === "needs_reconnect") throw new HttpError(409, "needs_reconnect", `the ${platform} authorization expired or was revoked — reconnect`);
  return integ;
}

export const UPSERT_CHUNK = 500;

/** Minimum spacing between two directory syncs of one connection (Graph / Admin SDK quota is ours, not the customer's). */
export const SYNC_MIN_INTERVAL_MS = 30_000;

/** 429 sync_too_soon when the connection synced less than SYNC_MIN_INTERVAL_MS ago. */
export function requireSyncSpacing(integ: { last_sync_at?: string | null }, nowMs: number): void {
  const last = integ.last_sync_at ? Date.parse(integ.last_sync_at) : NaN;
  if (!Number.isFinite(last)) return;
  const wait = SYNC_MIN_INTERVAL_MS - (nowMs - last);
  if (wait > 0) throw new HttpError(429, "sync_too_soon", `this directory was synced ${Math.round((nowMs - last) / 1000)} s ago — try again in ${Math.ceil(wait / 1000)} s`, { retry_after_ms: wait });
}

export interface SyncSummary {
  imported: number;
  updated: number;
  total: number;
  stale: number;
  synced_at: string;
}

/** Normalise an upstream string field: trim, empty → null, cap at 200 chars. */
export function clean(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Lower-cased, trimmed e-mail or null when it does not look like one. */
export function cleanEmail(v: unknown): string | null {
  const t = clean(v, 320)?.toLowerCase() ?? null;
  return t && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

/**
 * Upsert the directory into mb.employees (org_id, platform, ext_id), chunked. Duplicated ext_ids are
 * collapsed (first wins). `known` = ext_ids that existed before → imported/updated/stale accounting.
 */
export async function upsertEmployees(
  sb: SupabaseClient,
  orgId: string,
  platform: DirectoryPlatform,
  people: Employee[],
  syncedAt: string,
  integrationId: string,
): Promise<SyncSummary> {
  const { data: existing, error: exErr } = await sb.from("employees").select("ext_id").eq("org_id", orgId).eq("platform", platform);
  if (exErr) throw new HttpError(500, "db_error", `employees lookup failed: ${exErr.message}`);
  const known = new Set((existing ?? []).map((r: { ext_id: string }) => r.ext_id));

  const seen = new Set<string>();
  const rows = [];
  for (const p of people) {
    if (!p.ext_id || seen.has(p.ext_id)) continue;
    seen.add(p.ext_id);
    rows.push({ org_id: orgId, platform, ext_id: p.ext_id, email: p.email, name: p.name, title: p.title, dept: p.dept, synced_at: syncedAt });
  }
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await sb.from("employees").upsert(chunk, { onConflict: "org_id,platform,ext_id" });
    if (error) {
      await sb.from("integrations").update({ last_error: `sync write failed: ${error.message}`.slice(0, 500) }).eq("id", integrationId);
      throw new HttpError(500, "db_error", `employees upsert failed: ${error.message}`, { written: i });
    }
  }
  const imported = rows.filter((r) => !known.has(r.ext_id)).length;
  let stale = 0;
  for (const id of known) if (!seen.has(id)) stale++;
  return { imported, updated: rows.length - imported, total: rows.length, stale, synced_at: syncedAt };
}

/**
 * The service role reads buckets with RLS bypassed, so the path itself is the only guard: it must be a
 * plain "<this org>/<segment>/…" path (no dot segments, no empty segments, safe chars only) — storage-js
 * does not encode the path, so "org/../other-org/x.png" would be normalised into another org's object.
 */
export function isSafeOrgStoragePath(path: unknown, orgId: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  const segs = path.split("/");
  if (segs.length < 2 || segs[0] !== orgId) return false;
  return segs.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
