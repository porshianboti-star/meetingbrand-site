// mb-sync-google — pull the Google Workspace directory (Admin SDK) into mb.employees (platform 'meet').
//
//   POST  Bearer <user access token>   (admin of the org)
//   → access token from priv.integration_tokens (refresh when < 5 min left; Google refresh tokens do not rotate)
//   → GET https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500
//         &query=isSuspended=false&projection=full   (follow nextPageToken, cap 2000)
//     title / department come from organizations[] (primary entry first)
//   → upsert mb.employees on (org_id, 'meet', ext_id=<Directory user id>) → integrations.last_sync_at
//   → 200 {imported, updated, total, stale, truncated, synced_at}
//
// invalid_grant on refresh (revoked / Testing-mode expiry) → status needs_reconnect + 409.
// 403 "Not Authorized" = the connecting account lacks the Users › Read admin privilege → 409 google_blocked.

import { googleEnv, notConfiguredBody, supabaseEnv } from "../_shared/env.ts";
import { HttpError, json, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { deriveKeys } from "../_shared/crypto.ts";
import { DirectoryApi, getGoogleAccessToken, googleErrorToHttp, isGoogleReconnectFailure, toEmployee } from "../_shared/google.ts";
import { loadIntegration, requireConnected, requireSyncSpacing, upsertEmployees } from "../_shared/platform.ts";
import { markNeedsReconnect } from "../_shared/zoom.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return serveFn("mb-sync-google", async (req, { log }) => {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));

    const user = await requireUser(req, sbEnv.env, fetchImpl);
    const sb = serviceClient(sbEnv.env, fetchImpl);
    const admin = await requireOrgAdmin(sb, user);
    const env = googleEnv();
    if (!env.ok) return json(req, 503, notConfiguredBody(env.missing));

    const integ = requireConnected(await loadIntegration(sb, admin.org_id, "meet"), "meet", "mb-oauth-google?action=start");
    requireSyncSpacing(integ, now());
    const keys = await deriveKeys(env.env.tokenKeyB64);

    let users;
    let truncated = false;
    try {
      const token = await getGoogleAccessToken({ sb, keys, env: env.env, fetchImpl, log, now }, integ);
      const api = new DirectoryApi(token, { fetchImpl, log });
      const r = await api.listUsers((n) => log.info("directory_page", { page: n }));
      users = r.users;
      truncated = r.truncated;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (isGoogleReconnectFailure(e)) await markNeedsReconnect(sb, integ.id, detail);
      else await sb.from("integrations").update({ last_error: detail.slice(0, 500) }).eq("id", integ.id);
      throw googleErrorToHttp(e, log);
    }

    const people = users.map(toEmployee).filter((p): p is NonNullable<typeof p> => !!p);
    const syncedAt = new Date(now()).toISOString();
    const summary = await upsertEmployees(sb, admin.org_id, "meet", people, syncedAt, integ.id);

    await sb.from("integrations").update({ last_sync_at: syncedAt, last_error: null, status: "connected" }).eq("id", integ.id);
    await recordEvent(sb, "integration_synced", user.id, { platform: "meet", org_id: admin.org_id, ...summary, truncated });
    log.info("synced", { org_id: admin.org_id, ...summary, truncated });
    return json(req, 200, { ...summary, truncated });
  });
}

export const handler = makeHandler();
