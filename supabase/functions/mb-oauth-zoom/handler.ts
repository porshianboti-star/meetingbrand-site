// mb-oauth-zoom — Zoom OAuth for MeetingBrand (admin-managed General App).
//
//   GET  ?action=start      Bearer <user access token> → {url}  (admin of the org only)
//                           state = HMAC-signed JSON {org_id,user_id,nonce,ts}, 10-minute TTL
//   GET  /callback?code&state  (NO Supabase JWT — Zoom's redirect; verify_jwt=false in config.toml)
//                           The registered redirect URL is a PATH (<SUPABASE_URL>/functions/v1/mb-oauth-zoom/callback):
//                           Zoom staff confirm query parameters inside redirect URLs are not supported
//                           (devforum.zoom.us/t/13765). ?action=callback is still accepted (see resolveAction).
//                           → verify the state signature/TTL ONLY → 302 MB_APP_URL#integrations=zoom&status=pending&code=…&state=…
//                             or  MB_APP_URL#integrations=zoom&status=error&reason=<reason>
//                           The callback never exchanges the code and never touches the DB: an
//                           unauthenticated redirect cannot prove WHICH browser/user finished the
//                           consent, so binding tokens to state.org_id here would let anyone who
//                           holds a valid state (the admin who minted it) trick a *different* Zoom
//                           admin into connecting THEIR Zoom tenant to the attacker's org
//                           (OAuth login-CSRF). Only the session that started the flow may finish it.
//   POST ?action=finish     Bearer <user access token>  {"code":"…","state":"…"}
//                           → caller must be an admin AND match state.user_id / state.org_id
//                           → exchange code → GET /users/me → upsert mb.integrations
//                           → encrypted tokens into priv.integration_tokens (RPC integration_token_set)
//                           → 200 {status:"connected", platform:"zoom", account_ext_id, scopes}
//
// 503 {error:"not_configured",missing:[…]} until ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET / MB_TOKEN_KEY /
// MB_APP_URL exist. Never crashes: every failure is a JSON error or an error redirect.
// Order matters: start/finish authenticate the caller (401/403) BEFORE looking at the Zoom secrets, so an
// unauthenticated probe learns nothing about the deployment and a signed-in admin gets the precise 503.
// The callback needs only MB_TOKEN_KEY + MB_APP_URL (it never calls Zoom).

import { appEnv, notConfiguredBody, supabaseEnv, zoomEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { deriveKeys, encryptToHex, signState, stateForPlatform, STATE_TTL_MS, verifyState } from "../_shared/crypto.ts";
import { authorizeUrl, exchangeCode, REFRESH_TOKEN_LIFETIME_MS, vaultSet, ZoomApi, ZoomError } from "../_shared/zoom.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Error reasons that can appear in …#integrations=zoom&status=error&reason=… (callback redirect). */
export const CALLBACK_REASONS = [
  "denied", // the admin declined on Zoom's consent screen (or Zoom sent ?error=…)
  "missing_params", // no code / no state
  "state_malformed",
  "state_bad_signature",
  "state_expired", // > 10 minutes between start and callback
  "state_future",
] as const;

/** JSON error codes the POST ?action=finish step can answer with (besides 401/403/503 from the shared helpers). */
export const FINISH_ERRORS = [
  "bad_request", // code / state missing or not strings
  "state_malformed",
  "state_bad_signature",
  "state_expired",
  "state_future",
  "state_mismatch", // the state was minted for another user or another org — not the caller's flow
  "exchange_failed", // Zoom refused the code (redirect URI mismatch, reused code, wrong secret…)
  "zoom_me_failed", // GET /users/me failed after the exchange
  "no_refresh_token",
  "db_error",
] as const;

/** Zoom authorization codes: opaque, short; refuse anything that is not a plain token before it reaches the token endpoint. */
const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,1024}$/;
/** state = b64url.b64url */
const STATE_RE = /^[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{16,128}$/;

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return serveFn("mb-oauth-zoom", async (req, { log }) => {
    if (req.method !== "GET" && req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "use GET ?action=start | GET ?action=callback | POST ?action=finish");
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
      const zEnv = zoomEnv();
      if (!zEnv.ok) return json(req, 503, notConfiguredBody(zEnv.missing));
      const keys = await deriveKeys(zEnv.env.tokenKeyB64);
      const state = await signState(keys, { org_id: admin.org_id, user_id: user.id, ts: now(), platform: "zoom" });
      log.info("start", { org_id: admin.org_id, user_id: user.id });
      return json(req, 200, {
        url: authorizeUrl(zEnv.env, state),
        expires_in: Math.floor(STATE_TTL_MS / 1000),
        redirect_uri: zEnv.env.redirectUri,
        finish_url: `${sbEnv.env.url}/functions/v1/mb-oauth-zoom?action=finish`,
      });
    }

    // --------------------------------------------------------------- callback
    // Unauthenticated (Zoom's browser redirect). Validates the state and hands code+state to the
    // app, which finishes with the user's own session (POST ?action=finish). No DB, no Zoom calls.
    if (action === "callback") {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "callback is GET");
      const aEnv = appEnv();
      if (!aEnv.ok) return json(req, 503, notConfiguredBody(aEnv.missing)); // nowhere to redirect / no key to verify
      const keys = await deriveKeys(aEnv.env.tokenKeyB64);
      const appBase = aEnv.env.appUrl.split("#")[0];
      const redirect = (params: Record<string, string>) => {
        const frag = new URLSearchParams({ integrations: "zoom", ...params }).toString();
        return new Response(null, { status: 302, headers: { Location: `${appBase}#${frag}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      };
      const fail = (reason: (typeof CALLBACK_REASONS)[number], fields: Record<string, unknown> = {}) => {
        log.warn("callback_failed", { reason, ...fields });
        return redirect({ status: "error", reason });
      };

      const zoomErr = url.searchParams.get("error");
      if (zoomErr) return fail("denied", { zoom_error: zoomErr.slice(0, 64) });
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
      const zEnv = zoomEnv();
      if (!zEnv.ok) return json(req, 503, notConfiguredBody(zEnv.missing));
      const keys = await deriveKeys(zEnv.env.tokenKeyB64);

      const body = await readJson<{ code?: unknown; state?: unknown }>(req);
      const code = typeof body.code === "string" ? body.code : "";
      const stateToken = typeof body.state === "string" ? body.state : "";
      if (!CODE_RE.test(code) || !STATE_RE.test(stateToken)) throw new HttpError(400, "bad_request", "code and state are required");

      const verdict = await verifyState(keys, stateToken, now());
      if (!verdict.ok) throw new HttpError(400, `state_${verdict.reason}`, `OAuth state ${verdict.reason.replace("_", " ")} — start the connection again`);
      // The flow is bound to the session that started it: same user, same org, still an admin.
      if (verdict.state.user_id !== user.id || verdict.state.org_id !== admin.org_id || !stateForPlatform(verdict.state, "zoom")) {
        log.warn("finish_state_mismatch", { org_id: admin.org_id, user_id: user.id, state_org: verdict.state.org_id, state_user: verdict.state.user_id, state_platform: verdict.state.platform ?? null });
        throw new HttpError(403, "state_mismatch", "this Zoom authorization was started by a different user, workspace or connector — start the connection again");
      }
      const org_id = admin.org_id;
      const user_id = user.id;

      const tok = await exchangeCode(zEnv.env, code, fetchImpl);
      if (!tok.ok) {
        log.warn("exchange_failed", { org_id, kind: tok.kind, status: tok.status, detail: tok.detail });
        throw new HttpError(502, "exchange_failed", `Zoom refused the authorization code (${tok.detail}) — check the redirect URL and try again`);
      }
      if (!tok.tokens.refresh_token) throw new HttpError(502, "no_refresh_token", "Zoom returned no refresh token — check the app type (General App, admin-managed)");

      const api = new ZoomApi(tok.tokens.access_token, { fetchImpl, log });
      let me;
      try {
        me = await api.me();
      } catch (e) {
        const detail = e instanceof ZoomError ? e.cls.detail : "unexpected error";
        log.warn("zoom_me_failed", { org_id, detail });
        throw new HttpError(502, "zoom_me_failed", `GET /users/me failed after the exchange (${detail})`);
      }
      if (!me?.account_id) throw new HttpError(502, "zoom_me_failed", "no account_id in /users/me");

      const t = now();
      const scopes = (tok.tokens.scope ?? "").split(/[\s,]+/).filter(Boolean);
      const { data: integ, error: upErr } = await sb
        .from("integrations")
        .upsert(
          {
            org_id,
            platform: "zoom",
            status: "connected",
            account_ext_id: me.account_id,
            scopes,
            connected_by: user_id,
            connected_at: new Date(t).toISOString(),
            expires_at: new Date(t + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
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
        const [refreshHex, accessHex] = await Promise.all([
          encryptToHex(keys, tok.tokens.refresh_token),
          encryptToHex(keys, tok.tokens.access_token),
        ]);
        await vaultSet(sb, integ.id, refreshHex, accessHex, new Date(t + tok.tokens.expires_in * 1000));
      } catch (e) {
        // tokens could not be stored → the row must not claim "connected"
        await sb.from("integrations").update({ status: "error", last_error: "token vault write failed" }).eq("id", integ.id);
        log.error("vault_write_failed", { org_id, message: e instanceof Error ? e.message : String(e) });
        throw new HttpError(500, "db_error", "could not store the Zoom tokens (is 005-integrations.sql applied?)");
      }

      await recordEvent(sb, "integration_connected", user_id, { platform: "zoom", org_id, scopes: scopes.length });
      log.info("connected", { org_id, user_id, integration_id: integ.id, account_id: me.account_id, scopes: scopes.length, zoom_user_id: me.id });
      return json(req, 200, { platform: "zoom", status: "connected", account_ext_id: me.account_id, scopes, expires_at: new Date(t + REFRESH_TOKEN_LIFETIME_MS).toISOString() });
    }

    throw new HttpError(400, "bad_action", "action must be start, callback or finish");
  });
}

/**
 * Action = last path segment (`/mb-oauth-zoom/start|callback|finish`) or `?action=…`; a bare request that
 * carries Zoom's `code`/`state`/`error` is the callback (Zoom appends its own query to the registered path).
 */
export function resolveAction(url: URL): string {
  const seg = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (seg === "start" || seg === "callback" || seg === "finish") return seg;
  const q = url.searchParams.get("action") ?? "";
  if (q) return q;
  if (url.searchParams.has("code") || url.searchParams.has("state") || url.searchParams.has("error")) return "callback";
  return "";
}

export const handler = makeHandler();
