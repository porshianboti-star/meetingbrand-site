// mb-oauth-ms — Microsoft Entra admin consent for MeetingBrand (Teams directory via Graph).
//
//   GET  ?action=start      Bearer <user access token> → {url}  (admin of the org only)
//                           url = https://login.microsoftonline.com/common/adminconsent?client_id&state&redirect_uri
//                           state = HMAC-signed JSON {org_id,user_id,nonce,ts}, 10-minute TTL (crypto.ts)
//   GET  /callback?tenant&state&admin_consent=True   (NO Supabase JWT — Microsoft's redirect)
//                           → verify the state signature/TTL ONLY → 302 MB_APP_URL#integrations=teams&status=pending&tenant=…&state=…
//                             or MB_APP_URL#integrations=teams&status=error&reason=<reason>
//                           Never touches the DB: an unauthenticated redirect cannot prove which browser finished
//                           the consent (login-CSRF, same reasoning as mb-oauth-zoom). Only the session that
//                           started the flow may finish it.
//   POST ?action=finish     Bearer <user access token>  {"tenant":"…","state":"…"}
//                           → caller must be an admin AND match state.user_id / state.org_id (+ state.platform = teams)
//                           → mint a client-credentials token for that tenant (proves the consent exists)
//                           → GET /organization (REQUIRED): the tenant id + verified domains come from Graph, never from the body
//                           → TENANT BINDING (security review 2026-09-16): the admin-consent redirect carries no proof of who
//                             consented and any tenant that ever consented answers the client-credentials call, so without
//                             these checks an admin of org A could type tenant B's id (or contoso.com) and import B's directory:
//                               1. the body's tenant must be that tenant's GUID or one of its verified domains (409 tenant_mismatch)
//                               2. the caller's sign-in e-mail domain must be a verified domain of the tenant (403 tenant_not_yours)
//                               3. one tenant ↔ one workspace: another org already bound to it → 409 tenant_already_connected
//                             (2) is as strong as the product's e-mail trust — SETUP.md runs Confirm-email OFF; the real proof
//                             would be an OIDC sign-in of the finishing admin (id_token.tid) — noted in README-INTEGRATIONS.md.
//                           → upsert mb.integrations {platform:'teams', status:'connected', account_ext_id:<tenant GUID>, scopes:['User.Read.All']}
//                           NOTHING goes to priv.integration_tokens: client-credentials tokens are minted per call
//                           from MS_CLIENT_ID/MS_CLIENT_SECRET + the tenant id; there is no refresh token to vault.
//
// 503 {error:"not_configured",missing:[…]} until MS_CLIENT_ID / MS_CLIENT_SECRET / MB_TOKEN_KEY / MB_APP_URL exist.
// Order matters: start/finish authenticate the caller (401/403) BEFORE looking at the secrets.
// The callback needs only MB_TOKEN_KEY + MB_APP_URL (it never calls Microsoft).

import { appEnv, msEnv, notConfiguredBody, supabaseEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { deriveKeys, signState, stateForPlatform, STATE_TTL_MS, verifyState } from "../_shared/crypto.ts";
import { adminConsentUrl, clientCredentialsToken, GraphApi, MS_SCOPES, msErrorToHttp, TENANT_RE } from "../_shared/ms.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const CALLBACK_REASONS = ["denied", "missing_params", "consent_not_granted", "state_malformed", "state_bad_signature", "state_expired", "state_future"] as const;
export const FINISH_ERRORS = ["bad_request", "state_malformed", "state_bad_signature", "state_expired", "state_future", "state_mismatch", "consent_missing", "entra_error", "tenant_mismatch", "tenant_not_yours", "tenant_already_connected", "db_error"] as const;

const STATE_RE = /^[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{16,128}$/;

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return serveFn("mb-oauth-ms", async (req, { log }) => {
    if (req.method !== "GET" && req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "use GET ?action=start | GET /callback | POST ?action=finish");
    }
    const url = new URL(req.url);
    const action = resolveAction(url);

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));

    // ------------------------------------------------------------------ start
    if (action === "start") {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "start is GET");
      const user = await requireUser(req, sbEnv.env, fetchImpl);
      const sb = serviceClient(sbEnv.env, fetchImpl);
      const admin = await requireOrgAdmin(sb, user);
      const env = msEnv();
      if (!env.ok) return json(req, 503, notConfiguredBody(env.missing));
      const keys = await deriveKeys(env.env.tokenKeyB64);
      const state = await signState(keys, { org_id: admin.org_id, user_id: user.id, ts: now(), platform: "teams" });
      log.info("start", { org_id: admin.org_id, user_id: user.id });
      return json(req, 200, {
        platform: "teams",
        url: adminConsentUrl(env.env, state),
        expires_in: Math.floor(STATE_TTL_MS / 1000),
        redirect_uri: env.env.redirectUri,
        finish_url: `${sbEnv.env.url}/functions/v1/mb-oauth-ms?action=finish`,
        scopes: MS_SCOPES,
      });
    }

    // --------------------------------------------------------------- callback
    if (action === "callback") {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "callback is GET");
      const aEnv = appEnv();
      if (!aEnv.ok) return json(req, 503, notConfiguredBody(aEnv.missing));
      const keys = await deriveKeys(aEnv.env.tokenKeyB64);
      const appBase = aEnv.env.appUrl.split("#")[0];
      const redirect = (params: Record<string, string>) => {
        const frag = new URLSearchParams({ integrations: "teams", ...params }).toString();
        return new Response(null, { status: 302, headers: { Location: `${appBase}#${frag}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      };
      const fail = (reason: (typeof CALLBACK_REASONS)[number], fields: Record<string, unknown> = {}) => {
        log.warn("callback_failed", { reason, ...fields });
        return redirect({ status: "error", reason });
      };

      const msErr = url.searchParams.get("error");
      if (msErr) return fail("denied", { ms_error: msErr.slice(0, 64), description: (url.searchParams.get("error_description") ?? "").slice(0, 120) });
      const tenant = (url.searchParams.get("tenant") ?? "").trim().toLowerCase();
      const stateToken = url.searchParams.get("state") ?? "";
      if (!tenant || !stateToken) return fail("missing_params");
      if (!TENANT_RE.test(tenant) || !STATE_RE.test(stateToken)) return fail("state_malformed");
      if (!/^true$/i.test(url.searchParams.get("admin_consent") ?? "")) return fail("consent_not_granted");

      const verdict = await verifyState(keys, stateToken, now());
      if (!verdict.ok) return fail(`state_${verdict.reason}` as (typeof CALLBACK_REASONS)[number]);

      log.info("callback_pending", { org_id: verdict.state.org_id, user_id: verdict.state.user_id, tenant });
      return redirect({ status: "pending", tenant, state: stateToken });
    }

    // ----------------------------------------------------------------- finish
    if (action === "finish") {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "finish is POST");
      const user = await requireUser(req, sbEnv.env, fetchImpl);
      const sb = serviceClient(sbEnv.env, fetchImpl);
      const admin = await requireOrgAdmin(sb, user);
      const env = msEnv();
      if (!env.ok) return json(req, 503, notConfiguredBody(env.missing));
      const keys = await deriveKeys(env.env.tokenKeyB64);

      const body = await readJson<{ tenant?: unknown; state?: unknown }>(req);
      const tenant = typeof body.tenant === "string" ? body.tenant.trim().toLowerCase() : "";
      const stateToken = typeof body.state === "string" ? body.state : "";
      if (!TENANT_RE.test(tenant) || !STATE_RE.test(stateToken)) throw new HttpError(400, "bad_request", "tenant and state are required");

      const verdict = await verifyState(keys, stateToken, now());
      if (!verdict.ok) throw new HttpError(400, `state_${verdict.reason}`, `consent state ${verdict.reason.replace("_", " ")} — start the connection again`);
      if (verdict.state.user_id !== user.id || verdict.state.org_id !== admin.org_id || !stateForPlatform(verdict.state, "teams")) {
        log.warn("finish_state_mismatch", { org_id: admin.org_id, user_id: user.id, state_org: verdict.state.org_id, state_user: verdict.state.user_id, state_platform: verdict.state.platform ?? null });
        throw new HttpError(403, "state_mismatch", "this Microsoft consent was started by a different user, workspace or connector — start the connection again");
      }
      const org_id = admin.org_id;

      // Prove the consent: an app-only token for this tenant exists only after the admin consented.
      const tok = await clientCredentialsToken(env.env, tenant, fetchImpl);
      if (!tok.ok) {
        log.warn("finish_token_failed", { org_id, tenant, kind: tok.cls.kind, code: tok.cls.code, status: tok.status, detail: tok.cls.detail });
        if (tok.cls.kind === "needs_reconnect") throw new HttpError(409, "consent_missing", `Microsoft has no consent for MeetingBrand in tenant ${tenant} (${tok.cls.detail}) — run the consent again`);
        if (tok.cls.kind === "retry") throw new HttpError(503, "ms_retry_later", tok.cls.detail, { retry_after_ms: 2000 });
        throw new HttpError(502, "entra_error", tok.cls.detail, { code: tok.cls.code });
      }
      const api = new GraphApi(tok.accessToken, { fetchImpl, log });

      // Which tenant is this really? Graph answers with the token — the body's `tenant` is only a lookup hint.
      let tenantOrg;
      try {
        tenantOrg = await api.organization();
      } catch (e) {
        log.warn("finish_organization_failed", { org_id, tenant, message: e instanceof Error ? e.message : String(e) });
        throw msErrorToHttp(e, log);
      }
      const tenantId = tenantOrg.id;
      const orgName = tenantOrg.displayName;
      if (tenant !== tenantId && !tenantOrg.domains.includes(tenant)) {
        log.warn("finish_tenant_mismatch", { org_id, tenant, tenant_id: tenantId });
        throw new HttpError(409, "tenant_mismatch", "the tenant Microsoft answered for is not the one in the request — start the connection again");
      }
      // The finishing admin must belong to the tenant: their sign-in e-mail domain is one of its verified domains.
      const callerDomain = (user.email ?? "").split("@")[1]?.trim().toLowerCase() ?? "";
      if (!callerDomain || !tenantOrg.domains.includes(callerDomain)) {
        log.warn("finish_tenant_not_yours", { org_id, user_id: user.id, tenant_id: tenantId, caller_domain: callerDomain || null, verified_domains: tenantOrg.domains.length });
        throw new HttpError(
          403,
          "tenant_not_yours",
          `sign in to MeetingBrand with an e-mail address of the Microsoft tenant you are connecting (your address is not on one of its verified domains${callerDomain ? `: ${callerDomain}` : ""})`,
          { caller_domain: callerDomain || null },
        );
      }
      // One tenant ↔ one workspace: a tenant already bound to another org cannot be re-bound here.
      const { data: others, error: oErr } = await sb.from("integrations").select("org_id").eq("platform", "teams").eq("account_ext_id", tenantId).neq("org_id", org_id).limit(1);
      if (oErr) throw new HttpError(500, "db_error", `integrations lookup failed: ${oErr.message}`);
      if ((others ?? []).length) {
        log.warn("finish_tenant_already_connected", { org_id, tenant_id: tenantId });
        throw new HttpError(409, "tenant_already_connected", "this Microsoft tenant is already connected to another MeetingBrand workspace — disconnect it there first (or contact support)");
      }

      const t = now();
      const { data: integ, error: upErr } = await sb
        .from("integrations")
        .upsert(
          {
            org_id,
            platform: "teams",
            status: "connected",
            account_ext_id: tenantId,
            scopes: [...MS_SCOPES],
            connected_by: user.id,
            connected_at: new Date(t).toISOString(),
            expires_at: null, // consent does not expire; the admin removes the enterprise app to revoke
            last_error: null,
          },
          { onConflict: "org_id,platform" },
        )
        .select("id")
        .single();
      if (upErr || !integ?.id) {
        log.error("integrations_upsert_failed", { org_id, message: upErr?.message ?? "no integration id" });
        throw new HttpError(500, "db_error", "could not save the connection (is 005-integrations.sql applied?)");
      }

      await recordEvent(sb, "integration_connected", user.id, { platform: "teams", org_id, tenant_named: !!orgName });
      log.info("connected", { org_id, user_id: user.id, integration_id: integ.id, tenant: tenantId, org_name: orgName });
      return json(req, 200, { platform: "teams", status: "connected", account_ext_id: tenantId, tenant_name: orgName, scopes: MS_SCOPES, expires_at: null });
    }

    throw new HttpError(400, "bad_action", "action must be start, callback or finish");
  });
}

/** Action = last path segment or ?action=…; a bare request carrying Microsoft's tenant/state/error params is the callback. */
export function resolveAction(url: URL): string {
  const seg = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (seg === "start" || seg === "callback" || seg === "finish") return seg;
  const q = url.searchParams.get("action") ?? "";
  if (q) return q;
  if (url.searchParams.has("tenant") || url.searchParams.has("admin_consent") || url.searchParams.has("error")) return "callback";
  return "";
}

export const handler = makeHandler();
