// mb-sync-ms — pull the Microsoft Entra user directory (Graph) into mb.employees (platform 'teams').
//
//   POST  Bearer <user access token>   (admin of the org)
//   → client-credentials token for the connected tenant (mb.integrations.account_ext_id) — minted per call,
//     never stored (no refresh token exists in this grant)
//   → GET https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,
//         department,accountEnabled&$top=999&$filter=accountEnabled eq true   (follow @odata.nextLink, cap 2000)
//     `jobTitle` and `department` are returned because they are $select-ed — no per-user second call.
//   → upsert mb.employees on (org_id, 'teams', ext_id=<Graph user id>) → integrations.last_sync_at
//   → 200 {imported, updated, total, stale, truncated, synced_at}
//
// Rows that vanished from Entra are NOT deleted (the admin's active/assigned_bg choices survive); they are `stale`.
// Consent revoked (AADSTS65001/700016, Graph 403 Authorization_RequestDenied) → status needs_reconnect + 409.

import { msEnv, notConfiguredBody, supabaseEnv } from "../_shared/env.ts";
import { HttpError, json, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { clientCredentialsToken, GraphApi, isMsReconnectFailure, MsError, msErrorToHttp, toEmployee } from "../_shared/ms.ts";
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

  return serveFn("mb-sync-ms", async (req, { log }) => {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));

    const user = await requireUser(req, sbEnv.env, fetchImpl);
    const sb = serviceClient(sbEnv.env, fetchImpl);
    const admin = await requireOrgAdmin(sb, user);
    // secrets are checked only after the caller is known: unauthenticated probes get 401, admins the precise 503
    const env = msEnv();
    if (!env.ok) return json(req, 503, notConfiguredBody(env.missing));

    const integ = requireConnected(await loadIntegration(sb, admin.org_id, "teams"), "teams", "mb-oauth-ms?action=start");
    if (!integ.account_ext_id) throw new HttpError(409, "needs_reconnect", "no tenant stored for this connection — reconnect Microsoft");
    requireSyncSpacing(integ, now());

    let users;
    let truncated = false;
    try {
      const tok = await clientCredentialsToken(env.env, integ.account_ext_id, fetchImpl);
      if (!tok.ok) throw new MsError(tok.cls, tok.status);
      const api = new GraphApi(tok.accessToken, { fetchImpl, log });
      const r = await api.listUsers((n) => log.info("graph_page", { page: n }));
      users = r.users;
      truncated = r.truncated;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (isMsReconnectFailure(e)) await markNeedsReconnect(sb, integ.id, detail);
      else await sb.from("integrations").update({ last_error: detail.slice(0, 500) }).eq("id", integ.id);
      throw msErrorToHttp(e, log);
    }

    const people = users.map(toEmployee).filter((p): p is NonNullable<typeof p> => !!p);
    const syncedAt = new Date(now()).toISOString();
    const summary = await upsertEmployees(sb, admin.org_id, "teams", people, syncedAt, integ.id);

    await sb.from("integrations").update({ last_sync_at: syncedAt, last_error: null, status: "connected" }).eq("id", integ.id);
    await recordEvent(sb, "integration_synced", user.id, { platform: "teams", org_id: admin.org_id, ...summary, truncated });
    log.info("synced", { org_id: admin.org_id, ...summary, truncated });
    return json(req, 200, { ...summary, truncated });
  });
}

export const handler = makeHandler();
