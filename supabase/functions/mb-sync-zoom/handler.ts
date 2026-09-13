// mb-sync-zoom — pull the Zoom user directory into mb.employees.
//
//   POST  Bearer <user access token>   body (optional) {"enrich_titles": true}
//   → admin of the org → GET /users?status=active&page_size=300 (all pages)
//   → GET /users/{id} for job_title (≤4 in flight, 429-aware; enrich_titles=false skips it)
//   → upsert mb.employees on (org_id, platform, ext_id) → integrations.last_sync_at
//   → 200 {imported, updated, total, stale, synced_at}
//
// Rows that vanished from Zoom are NOT deleted (the admin's active/assigned_bg choices survive);
// they are reported as `stale` (synced_at older than this run).

import { notConfiguredBody, supabaseEnv, zoomEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { deriveKeys } from "../_shared/crypto.ts";
import {
  getAccessToken,
  isReconnectFailure,
  listEmployees,
  loadZoomIntegration,
  markNeedsReconnect,
  ZoomApi,
  zoomErrorToHttp,
} from "../_shared/zoom.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const UPSERT_CHUNK = 500;

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return serveFn("mb-sync-zoom", async (req, { log }) => {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));

    const user = await requireUser(req, sbEnv.env, fetchImpl);
    const sb = serviceClient(sbEnv.env, fetchImpl);
    const admin = await requireOrgAdmin(sb, user);
    // Zoom secrets are checked only after the caller is known: unauthenticated probes get 401, admins get the precise 503.
    const zEnv = zoomEnv();
    if (!zEnv.ok) return json(req, 503, notConfiguredBody(zEnv.missing));
    const body = await readJson<{ enrich_titles?: boolean }>(req);

    const integ = await loadZoomIntegration(sb, admin.org_id);
    if (!integ || integ.status === "disconnected") throw new HttpError(409, "not_connected", "connect Zoom first (mb-oauth-zoom?action=start)");
    if (integ.status === "needs_reconnect") throw new HttpError(409, "needs_reconnect", "the Zoom authorization expired or was revoked — reconnect");

    const keys = await deriveKeys(zEnv.env.tokenKeyB64);
    let people;
    try {
      const token = await getAccessToken({ sb, keys, env: zEnv.env, fetchImpl, log, now }, integ);
      const api = new ZoomApi(token, { fetchImpl, log });
      people = await listEmployees(api, { concurrency: 4, enrichTitles: body.enrich_titles ?? true, log });
    } catch (e) {
      if (isReconnectFailure(e)) await markNeedsReconnect(sb, integ.id, e instanceof Error ? e.message : String(e));
      else await sb.from("integrations").update({ last_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).eq("id", integ.id);
      throw zoomErrorToHttp(e, log);
    }

    const { data: existing, error: exErr } = await sb.from("employees").select("ext_id").eq("org_id", admin.org_id).eq("platform", "zoom");
    if (exErr) throw new HttpError(500, "db_error", `employees lookup failed: ${exErr.message}`);
    const known = new Set((existing ?? []).map((r: { ext_id: string }) => r.ext_id));

    const syncedAt = new Date(now()).toISOString();
    const seen = new Set<string>();
    const rows = [];
    for (const p of people) {
      if (!p.ext_id || seen.has(p.ext_id)) continue;
      seen.add(p.ext_id);
      rows.push({
        org_id: admin.org_id,
        platform: "zoom",
        ext_id: p.ext_id,
        email: p.email,
        name: p.name,
        title: p.title,
        dept: p.dept,
        synced_at: syncedAt,
      });
    }
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const { error } = await sb.from("employees").upsert(chunk, { onConflict: "org_id,platform,ext_id" });
      if (error) {
        await sb.from("integrations").update({ last_error: `sync write failed: ${error.message}`.slice(0, 500) }).eq("id", integ.id);
        throw new HttpError(500, "db_error", `employees upsert failed: ${error.message}`, { written: i });
      }
    }

    const imported = rows.filter((r) => !known.has(r.ext_id)).length;
    const updated = rows.length - imported;
    let stale = 0;
    for (const id of known) if (!seen.has(id)) stale++;

    await sb.from("integrations").update({ last_sync_at: syncedAt, last_error: null, status: "connected" }).eq("id", integ.id);
    await recordEvent(sb, "integration_synced", user.id, { platform: "zoom", org_id: admin.org_id, imported, updated, total: rows.length, stale });
    log.info("synced", { org_id: admin.org_id, imported, updated, total: rows.length, stale, titles: body.enrich_titles ?? true });
    return json(req, 200, { imported, updated, total: rows.length, stale, synced_at: syncedAt });
  });
}

export const handler = makeHandler();
