// mb-integrations — the Integrations tab's read model + disconnect.
//
//   GET   Bearer <user access token>  (any member of the org)
//         → {org_id, connect: {zoom|teams|meet: {configured, missing, start_url, redirect_uri, delivery, sync_url,
//            push_url|pack_url}}, integrations: [{platform, status, …, employees:{total,active}, pushes:{by_state}}],
//            last_pushes: [...20], employees: {total, active, by_platform}}
//         Works BEFORE any platform secrets exist (the My-team tab must render "Coming soon" rather than fail):
//         connect.<p>.configured=false + missing=[…] until that platform's client id/secret + MB_TOKEN_KEY / MB_APP_URL are set.
//         `delivery` is the one honest sentence per platform (PLAN §3) the product shows next to "Delivered".
//         Backward compatible: connect.zoom keeps its v1 keys; integrations still lists the 4 platform rows.
//   POST  Bearer <user access token>  (admin)  {"platform":"zoom"|"teams"|"meet","action":"disconnect","purge":false}
//         zoom → revoke at https://zoom.us/oauth/revoke (best effort) → delete priv.integration_tokens row
//         meet → revoke at https://oauth2.googleapis.com/revoke (best effort) → delete the vault row
//         teams → nothing to revoke here (client-credentials; the admin removes the enterprise app in Entra) → row only
//         → integrations.status = disconnected. purge=true also deletes the org's employees + pushes of that platform
//           (PLAN §8 item 5 "disconnect must delete data"); default keeps them so a reconnect resumes.

import { defaultGoogleRedirectUri, defaultMsRedirectUri, defaultRedirectUri, googleEnv, msEnv, notConfiguredBody, supabaseEnv, zoomEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireOrgMember, requireUser, serviceClient } from "../_shared/auth.ts";
import { decryptFromHex, deriveKeys } from "../_shared/crypto.ts";
import { revokeToken, vaultDelete, vaultGet } from "../_shared/zoom.ts";
import { revokeToken as revokeGoogleToken } from "../_shared/google.ts";
import { DELIVERY, type DirectoryPlatform } from "../_shared/platform.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
}

const PLATFORMS = ["zoom", "teams", "meet", "zoho"] as const;
/** Platforms with a built connector (directory import + delivery). Zoho stays 501 (PLAN §3.4: no push, no admin API). */
const CONNECTABLE: readonly DirectoryPlatform[] = ["zoom", "teams", "meet"];
const PUSH_STATES = ["queued", "pushing", "pushed", "awaiting_client", "available", "selected", "blocked", "failed"] as const;

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return serveFn("mb-integrations", async (req, { log }) => {
    if (req.method !== "GET" && req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use GET or POST");

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));
    const zEnv = zoomEnv(); // may be not-ok: GET still answers, POST disconnect still clears the vault row
    const mEnv = msEnv();
    const gEnv = googleEnv();

    const user = await requireUser(req, sbEnv.env, fetchImpl);
    const sb = serviceClient(sbEnv.env, fetchImpl);

    // ------------------------------------------------------------------ GET
    if (req.method === "GET") {
      const member = await requireOrgMember(sb, user);
      const orgId = member.org_id;

      const { data: integs, error: iErr } = await sb
        .from("integrations")
        .select("id, platform, status, account_ext_id, scopes, connected_by, connected_at, expires_at, last_sync_at, last_error, updated_at")
        .eq("org_id", orgId);
      if (iErr) throw new HttpError(500, "db_error", `integrations lookup failed: ${iErr.message}`);

      const count = async (table: string, filters: Record<string, unknown>) => {
        let q = sb.from(table).select("id", { count: "exact", head: true }).eq("org_id", orgId);
        for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
        const { count: n, error } = await q;
        if (error) log.warn("count_failed", { table, message: error.message });
        return n ?? 0;
      };

      const rows = [];
      for (const platform of PLATFORMS) {
        const it = (integs ?? []).find((r: { platform: string }) => r.platform === platform);
        const [total, active] = await Promise.all([count("employees", { platform }), count("employees", { platform, active: true })]);
        const by_state: Record<string, number> = {};
        if (it) {
          await Promise.all(PUSH_STATES.map(async (s) => {
            const n = await count("pushes", { platform, state: s });
            if (n) by_state[s] = n;
          }));
        }
        rows.push({
          platform,
          status: it?.status ?? "disconnected",
          available: platform === "zoom", // the only platform with a real upload API today (kept for v1 clients)
          directory: (CONNECTABLE as readonly string[]).includes(platform), // employee import is built
          push_api: platform === "zoom", // true API push; teams/meet deliver through mb-export-pack runbooks
          account_ext_id: it?.account_ext_id ?? null,
          scopes: it?.scopes ?? [],
          connected_by: it?.connected_by ?? null,
          connected_at: it?.connected_at ?? null,
          expires_at: it?.expires_at ?? null,
          last_sync_at: it?.last_sync_at ?? null,
          last_error: it?.last_error ?? null,
          employees: { total, active },
          pushes: { by_state },
        });
      }

      const { data: lastPushes, error: pErr } = await sb
        .from("pushes")
        .select("id, employee_id, background_id, platform, state, error, remote_file_id, attempts, updated_at, created_at")
        .eq("org_id", orgId)
        .order("updated_at", { ascending: false })
        .limit(20);
      if (pErr) log.warn("last_pushes_failed", { message: pErr.message });

      const fn = (name: string) => `${sbEnv.env.url}/functions/v1/${name}`;
      const byPlatform: Record<string, { total: number; active: number }> = {};
      for (const r of rows) byPlatform[r.platform] = r.employees;
      const totals = rows.reduce((a, r) => ({ total: a.total + r.employees.total, active: a.active + r.employees.active }), { total: 0, active: 0 });

      return json(req, 200, {
        org_id: orgId,
        role: member.role,
        connect: {
          zoom: {
            configured: zEnv.ok,
            missing: zEnv.ok ? [] : zEnv.missing,
            start_url: `${fn("mb-oauth-zoom")}?action=start`,
            redirect_uri: defaultRedirectUri(),
            finish_url: `${fn("mb-oauth-zoom")}?action=finish`,
            sync_url: fn("mb-sync-zoom"),
            push_url: fn("mb-push-zoom"),
            delivery: DELIVERY.zoom,
            push_api: true,
          },
          teams: {
            configured: mEnv.ok,
            missing: mEnv.ok ? [] : mEnv.missing,
            start_url: `${fn("mb-oauth-ms")}?action=start`,
            redirect_uri: defaultMsRedirectUri(),
            finish_url: `${fn("mb-oauth-ms")}?action=finish`,
            sync_url: fn("mb-sync-ms"),
            pack_url: fn("mb-export-pack"),
            delivery: DELIVERY.teams,
            push_api: false,
          },
          meet: {
            configured: gEnv.ok,
            missing: gEnv.ok ? [] : gEnv.missing,
            start_url: `${fn("mb-oauth-google")}?action=start`,
            redirect_uri: defaultGoogleRedirectUri(),
            finish_url: `${fn("mb-oauth-google")}?action=finish`,
            sync_url: fn("mb-sync-google"),
            pack_url: fn("mb-export-pack"),
            delivery: DELIVERY.meet,
            push_api: false,
          },
        },
        integrations: rows,
        employees: { ...totals, by_platform: byPlatform },
        last_pushes: lastPushes ?? [],
      });
    }

    // ----------------------------------------------------------------- POST
    const admin = await requireOrgAdmin(sb, user);
    const body = await readJson<{ platform?: unknown; action?: unknown; purge?: unknown }>(req);
    const platform = typeof body.platform === "string" ? body.platform : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!(PLATFORMS as readonly string[]).includes(platform)) throw new HttpError(400, "unsupported_platform", `platform must be one of ${PLATFORMS.join(", ")}`);
    if (!(CONNECTABLE as readonly string[]).includes(platform)) throw new HttpError(501, "not_implemented", `${platform} integration is not built yet`);
    if (action !== "disconnect") throw new HttpError(400, "bad_action", "action must be disconnect");
    const purge = body.purge === true;

    const { data: integ, error: lErr } = await sb.from("integrations").select("id, status").eq("org_id", admin.org_id).eq("platform", platform).maybeSingle();
    if (lErr) throw new HttpError(500, "db_error", `integrations lookup failed: ${lErr.message}`);
    if (!integ) throw new HttpError(404, "not_connected", `${platform} is not connected for this workspace`);

    // revoke upstream (best effort — the vault row is deleted regardless; skipped when the secrets are gone).
    // teams: nothing to revoke — there is no stored token; consent is removed by the admin in Entra (README-INTEGRATIONS).
    let revoked = false;
    try {
      if (platform === "zoom") {
        const vault = zEnv.ok ? await vaultGet(sb, integ.id) : null;
        if (!zEnv.ok) log.warn("revoke_skipped", { reason: "not_configured", missing: zEnv.missing });
        if (zEnv.ok && (vault?.access_token_hex || vault?.refresh_token_hex)) {
          const keys = await deriveKeys(zEnv.env.tokenKeyB64);
          const hex = vault.access_token_hex ?? vault.refresh_token_hex!;
          const token = await decryptFromHex(keys, hex);
          const r = await revokeToken(zEnv.env, token, fetchImpl);
          revoked = r.ok;
          if (!r.ok) log.warn("revoke_failed", { status: r.status });
        }
      } else if (platform === "meet") {
        const vault = gEnv.ok ? await vaultGet(sb, integ.id) : null;
        if (!gEnv.ok) log.warn("revoke_skipped", { reason: "not_configured", missing: gEnv.missing });
        if (gEnv.ok && (vault?.refresh_token_hex || vault?.access_token_hex)) {
          const keys = await deriveKeys(gEnv.env.tokenKeyB64);
          const hex = vault.refresh_token_hex ?? vault.access_token_hex!; // revoking the refresh token kills every access token too
          const token = await decryptFromHex(keys, hex);
          const r = await revokeGoogleToken(token, fetchImpl);
          revoked = r.ok;
          if (!r.ok) log.warn("revoke_failed", { status: r.status });
        }
      }
    } catch (e) {
      log.warn("revoke_skipped", { message: e instanceof Error ? e.message : String(e) });
    }

    await vaultDelete(sb, integ.id);
    const { error: uErr } = await sb.from("integrations").update({ status: "disconnected", scopes: [], expires_at: null, last_error: null }).eq("id", integ.id);
    if (uErr) throw new HttpError(500, "db_error", `could not mark disconnected: ${uErr.message}`);

    const purged = { employees: 0, pushes: 0 };
    if (purge) {
      const { count: pc } = await sb.from("pushes").delete({ count: "exact" }).eq("org_id", admin.org_id).eq("platform", platform);
      const { count: ec } = await sb.from("employees").delete({ count: "exact" }).eq("org_id", admin.org_id).eq("platform", platform);
      purged.pushes = pc ?? 0;
      purged.employees = ec ?? 0;
    }

    await recordEvent(sb, "integration_disconnected", user.id, { platform, org_id: admin.org_id, revoked, purge });
    log.info("disconnected", { org_id: admin.org_id, platform, integration_id: integ.id, revoked, purge, ...purged });
    return json(req, 200, { platform, status: "disconnected", revoked, purged });
  });
}

export const handler = makeHandler();
