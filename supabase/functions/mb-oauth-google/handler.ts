// mb-oauth-google — Google Workspace OAuth for MeetingBrand (Meet directory via the Admin SDK).
//
//   GET  ?action=start      Bearer <user access token> → {url}  (admin of the org only)
//                           url = https://accounts.google.com/o/oauth2/v2/auth … access_type=offline&prompt=consent
//                           scope = openid email https://www.googleapis.com/auth/admin.directory.user.readonly
//                           state = HMAC-signed JSON {org_id,user_id,nonce,ts}, 10-minute TTL (crypto.ts)
//   GET  /callback?code&state   (NO Supabase JWT — Google's redirect; the registered redirect URI is this PATH)
//                           → verify the state signature/TTL ONLY → 302 MB_APP_URL#integrations=meet&status=pending&code=…&state=…
//                             or MB_APP_URL#integrations=meet&status=error&reason=<reason>
//                           No DB, no Google calls (login-CSRF: only the session that started may finish).
//   POST ?action=finish     Bearer <user access token>  {"code":"…","state":"…"}
//                           → caller must be an admin AND match state.user_id / state.org_id
//                           → exchange code → refresh + access token AES-256-GCM encrypted into priv.integration_tokens
//                           → account_ext_id = the Workspace domain (`hd` claim of the id_token; no hd → 409 not_workspace)
//                           → 200 {status:"connected", platform:"meet", account_ext_id, scopes}
//
// 503 {error:"not_configured",missing:[…]} until GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / MB_TOKEN_KEY / MB_APP_URL exist;
// auth (401/403) runs before the config check. The callback needs only MB_TOKEN_KEY + MB_APP_URL.

import { appEnv, googleEnv, notConfiguredBody, supabaseEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { deriveKeys, encryptToHex, signState, stateForPlatform, STATE_TTL_MS, verifyState } from "../_shared/crypto.ts";
import { authorizeUrl, DIRECTORY_SCOPE, exchangeCode, GOOGLE_SCOPES, idTokenClaims } from "../_shared/google.ts";
import { vaultSet } from "../_shared/zoom.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const CALLBACK_REASONS = ["denied", "missing_params", "state_malformed", "state_bad_signature", "state_expired", "state_future"] as const;
export const FINISH_ERRORS = ["bad_request", "state_malformed", "state_bad_signature", "state_expired", "state_future", "state_mismatch", "exchange_failed", "no_refresh_token", "scope_not_granted", "not_workspace", "db_error"] as const;

/** Google authorization codes: "4/0A…" — opaque, URL-safe-ish; refuse anything else before the token endpoint. */
const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,1024}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{16,128}$/;
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return serveFn("mb-oauth-google", async (req, { log }) => {
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
      const env = googleEnv();
      if (!env.ok) return json(req, 503, notConfiguredBody(env.missing));
      const keys = await deriveKeys(env.env.tokenKeyB64);
      const state = await signState(keys, { org_id: admin.org_id, user_id: user.id, ts: now(), platform: "meet" });
      log.info("start", { org_id: admin.org_id, user_id: user.id });
      return json(req, 200, {
        platform: "meet",
        url: authorizeUrl(env.env, state),
        expires_in: Math.floor(STATE_TTL_MS / 1000),
        redirect_uri: env.env.redirectUri,
        finish_url: `${sbEnv.env.url}/functions/v1/mb-oauth-google?action=finish`,
        scopes: GOOGLE_SCOPES,
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
        const frag = new URLSearchParams({ integrations: "meet", ...params }).toString();
        return new Response(null, { status: 302, headers: { Location: `${appBase}#${frag}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      };
      const fail = (reason: (typeof CALLBACK_REASONS)[number], fields: Record<string, unknown> = {}) => {
        log.warn("callback_failed", { reason, ...fields });
        return redirect({ status: "error", reason });
      };

      const gErr = url.searchParams.get("error");
      if (gErr) return fail("denied", { google_error: gErr.slice(0, 64) });
      const code = url.searchParams.get("code") ?? "";
      const stateToken = url.searchParams.get("state") ?? "";
      if (!code || !stateToken) return fail("missing_params");
      if (!CODE_RE.test(code) || !STATE_RE.test(stateToken)) return fail("state_malformed");

      const verdict = await verifyState(keys, stateToken, now());
      if (!verdict.ok) return fail(`state_${verdict.reason}` as (typeof CALLBACK_REASONS)[number]);

      log.info("callback_pending", { org_id: verdict.state.org_id, user_id: verdict.state.user_id });
      return redirect({ status: "pending", code, state: stateToken });
    }

    // ----------------------------------------------------------------- finish
    if (action === "finish") {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "finish is POST");
      const user = await requireUser(req, sbEnv.env, fetchImpl);
      const sb = serviceClient(sbEnv.env, fetchImpl);
      const admin = await requireOrgAdmin(sb, user);
      const env = googleEnv();
      if (!env.ok) return json(req, 503, notConfiguredBody(env.missing));
      const keys = await deriveKeys(env.env.tokenKeyB64);

      const body = await readJson<{ code?: unknown; state?: unknown }>(req);
      const code = typeof body.code === "string" ? body.code : "";
      const stateToken = typeof body.state === "string" ? body.state : "";
      if (!CODE_RE.test(code) || !STATE_RE.test(stateToken)) throw new HttpError(400, "bad_request", "code and state are required");

      const verdict = await verifyState(keys, stateToken, now());
      if (!verdict.ok) throw new HttpError(400, `state_${verdict.reason}`, `OAuth state ${verdict.reason.replace("_", " ")} — start the connection again`);
      if (verdict.state.user_id !== user.id || verdict.state.org_id !== admin.org_id || !stateForPlatform(verdict.state, "meet")) {
        log.warn("finish_state_mismatch", { org_id: admin.org_id, user_id: user.id, state_org: verdict.state.org_id, state_user: verdict.state.user_id, state_platform: verdict.state.platform ?? null });
        throw new HttpError(403, "state_mismatch", "this Google authorization was started by a different user, workspace or connector — start the connection again");
      }
      const org_id = admin.org_id;

      const tok = await exchangeCode(env.env, code, fetchImpl);
      if (!tok.ok) {
        log.warn("exchange_failed", { org_id, kind: tok.kind, status: tok.status, detail: tok.detail });
        throw new HttpError(502, "exchange_failed", `Google refused the authorization code (${tok.detail}) — check the redirect URI and try again`);
      }
      if (!tok.tokens.refresh_token) throw new HttpError(502, "no_refresh_token", "Google returned no refresh token — the consent must use access_type=offline&prompt=consent");
      const granted = (tok.tokens.scope ?? "").split(/[\s,]+/).filter(Boolean);
      if (!granted.includes(DIRECTORY_SCOPE)) {
        // the admin unticked the directory checkbox on the consent screen — nothing to sync with
        throw new HttpError(409, "scope_not_granted", "the Google consent did not include the directory (users.readonly) scope — connect again and keep every box ticked", { granted });
      }
      const claims = idTokenClaims(tok.tokens.id_token);
      // `hd` is set only for Google Workspace / Cloud-organisation accounts. A consumer account with a custom-domain
      // e-mail has no hd, so the e-mail domain is NOT a substitute (it would bind a "workspace" that has no directory).
      const domain = claims.hd;
      if (!domain || CONSUMER_DOMAINS.has(domain)) {
        throw new HttpError(409, "not_workspace", "the Google account that consented is not part of a Google Workspace domain — a Workspace admin must connect", { email_domain: domain ?? (claims.email ? claims.email.split("@")[1] : null) });
      }

      const t = now();
      const { data: integ, error: upErr } = await sb
        .from("integrations")
        .upsert(
          {
            org_id,
            platform: "meet",
            status: "connected",
            account_ext_id: domain,
            scopes: granted,
            connected_by: user.id,
            connected_at: new Date(t).toISOString(),
            expires_at: null, // Google refresh tokens live until revoked (or 7 days while the consent screen is in Testing)
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

      try {
        const [refreshHex, accessHex] = await Promise.all([encryptToHex(keys, tok.tokens.refresh_token), encryptToHex(keys, tok.tokens.access_token)]);
        await vaultSet(sb, integ.id, refreshHex, accessHex, new Date(t + tok.tokens.expires_in * 1000));
      } catch (e) {
        await sb.from("integrations").update({ status: "error", last_error: "token vault write failed" }).eq("id", integ.id);
        log.error("vault_write_failed", { org_id, message: e instanceof Error ? e.message : String(e) });
        throw new HttpError(500, "db_error", "could not store the Google tokens (is 005-integrations.sql applied?)");
      }

      await recordEvent(sb, "integration_connected", user.id, { platform: "meet", org_id, scopes: granted.length });
      log.info("connected", { org_id, user_id: user.id, integration_id: integ.id, domain, scopes: granted.length });
      return json(req, 200, { platform: "meet", status: "connected", account_ext_id: domain, scopes: granted, expires_at: null });
    }

    throw new HttpError(400, "bad_action", "action must be start, callback or finish");
  });
}

export function resolveAction(url: URL): string {
  const seg = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (seg === "start" || seg === "callback" || seg === "finish") return seg;
  const q = url.searchParams.get("action") ?? "";
  if (q) return q;
  if (url.searchParams.has("code") || url.searchParams.has("state") || url.searchParams.has("error")) return "callback";
  return "";
}

export const handler = makeHandler();
