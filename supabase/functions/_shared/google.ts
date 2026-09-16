// _shared/google.ts — Google OAuth (Workspace admin) + Admin SDK Directory users for MeetingBrand.
//
// Verified facts (PLAN-integrations.md §3.3, 2026-09-04):
//   OAuth    : GET https://accounts.google.com/o/oauth2/v2/auth?client_id&redirect_uri&response_type=code
//              &scope=openid email https://www.googleapis.com/auth/admin.directory.user.readonly
//              &access_type=offline&prompt=consent&state   (offline+consent → a refresh token EVERY time)
//              POST https://oauth2.googleapis.com/token  grant_type=authorization_code|refresh_token
//              → {access_token, expires_in (3600), refresh_token?, scope, token_type, id_token?}
//              Google refresh tokens do NOT rotate (the same one stays valid until revoked / 6 months idle /
//              the app is in Testing mode → 7 days) → no single-flight lease is needed for refresh.
//              invalid_grant on refresh = revoked / expired / consent screen still in Testing → needs_reconnect.
//              POST https://oauth2.googleapis.com/revoke?token=… on disconnect (either token works).
//   Directory: GET https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500
//              &query=isSuspended=false&projection=full  (paginate nextPageToken; title/department in
//              organizations[] — the primary entry first, else the first one). The authorising admin must hold
//              the Users › Read privilege; otherwise 403 "Not Authorized to access this resource/api".
//              https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list
//   Scope    : admin.directory.user.readonly is SENSITIVE → Google verification (3–5 business days); until then
//              the consent screen warns and the OAuth client is capped at 100 users (README-INTEGRATIONS.md).
//   Hard cap : 2000 users per sync (4 pages of 500) — beyond that the sync reports `truncated:true`.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import type { GoogleEnv } from "./env.ts";
import { decryptFromHex, encryptToHex, type VaultKeys } from "./crypto.ts";
import { HttpError, sleep, type Logger } from "./http.ts";
import { clean, cleanEmail, type Employee } from "./platform.ts";
import { markNeedsReconnect, NeedsReconnect, vaultDelete, vaultGet, vaultSet } from "./zoom.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const DIRECTORY_BASE = "https://admin.googleapis.com/admin/directory/v1";
export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
export const GOOGLE_SCOPES = ["openid", "email", DIRECTORY_SCOPE] as const;
export const PAGE_SIZE = 500;
export const MAX_USERS = 2000;
export const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- types / errors

export type GoogleErrorKind = "retry" | "needs_reconnect" | "blocked" | "failed";
export interface GoogleErrorClass {
  kind: GoogleErrorKind;
  code: string;
  detail: string;
  retryAfterMs?: number;
}
export class GoogleError extends Error {
  constructor(public cls: GoogleErrorClass, public status: number) {
    super(`${cls.kind}/${cls.code}: ${cls.detail}`);
  }
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

// ---------------------------------------------------------------- OAuth

export function authorizeUrl(env: Pick<GoogleEnv, "clientId" | "redirectUri">, state: string): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", env.clientId);
  u.searchParams.set("redirect_uri", env.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export type GoogleTokenOutcome = { ok: true; tokens: GoogleTokenResponse } | { ok: false; kind: "needs_reconnect" | "retry" | "failed"; detail: string; status: number };

async function tokenCall(env: GoogleEnv, params: Record<string, string>, fetchImpl: typeof fetch): Promise<GoogleTokenOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, ...params }).toString(),
    });
  } catch (e) {
    return { ok: false, kind: "retry", detail: `google oauth unreachable: ${e instanceof Error ? e.message : String(e)}`, status: 0 };
  }
  const text = await res.text();
  let b: Partial<GoogleTokenResponse> & { error?: string; error_description?: string } = {};
  try {
    b = text ? JSON.parse(text) : {};
  } catch {
    b = {};
  }
  if (res.status === 200 && b.access_token && typeof b.expires_in === "number") return { ok: true, tokens: b as GoogleTokenResponse };
  const err = String(b.error ?? "");
  const detail = `google oauth ${res.status} ${err}${b.error_description ? `: ${String(b.error_description).slice(0, 200)}` : ""}`.trim();
  if (res.status === 429 || res.status >= 500) return { ok: false, kind: "retry", detail, status: res.status };
  if (err === "invalid_client" || err === "unauthorized_client") return { ok: false, kind: "failed", detail: `${detail} (check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)`, status: res.status };
  if (err === "redirect_uri_mismatch") return { ok: false, kind: "failed", detail: `${detail} (register the redirect URI on the OAuth client)`, status: res.status };
  if (err === "invalid_grant" || err === "invalid_token" || res.status === 401) return { ok: false, kind: "needs_reconnect", detail, status: res.status };
  return { ok: false, kind: "failed", detail, status: res.status };
}

export function exchangeCode(env: GoogleEnv, code: string, fetchImpl: typeof fetch = fetch): Promise<GoogleTokenOutcome> {
  return tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: env.redirectUri }, fetchImpl);
}

export function refreshTokens(env: GoogleEnv, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<GoogleTokenOutcome> {
  return tokenCall(env, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/** Best-effort revoke on disconnect. Never throws. The token goes in the form body (Google accepts both) so it never lands in a URL/log line. */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
    await res.text().catch(() => "");
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Unverified decode of the id_token payload — it arrived straight from Google's token endpoint over TLS, so it needs no signature check here. */
export function idTokenClaims(idToken: string | undefined): { email: string | null; hd: string | null; sub: string | null } {
  try {
    const parts = (idToken ?? "").split(".");
    if (parts.length !== 3) return { email: null, hd: null, sub: null };
    const std = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(std + "=".repeat((4 - (std.length % 4)) % 4)));
    return { email: cleanEmail(p?.email), hd: clean(p?.hd)?.toLowerCase() ?? null, sub: clean(p?.sub) };
  } catch {
    return { email: null, hd: null, sub: null };
  }
}

// ---------------------------------------------------------------- access token from the vault (no lease: Google refresh tokens do not rotate)

export interface GoogleTokenDeps {
  sb: SupabaseClient;
  keys: VaultKeys;
  env: GoogleEnv;
  fetchImpl?: typeof fetch;
  log?: Logger;
  now?: () => number;
}

export async function getGoogleAccessToken(deps: GoogleTokenDeps, integration: { id: string }): Promise<string> {
  const now = deps.now ?? Date.now;
  const row = await vaultGet(deps.sb, integration.id);
  if (!row?.refresh_token_hex) throw new NeedsReconnect("no stored refresh token — reconnect Google");
  if (row.access_token_hex && row.access_expires_at && Date.parse(row.access_expires_at) - now() > ACCESS_REFRESH_SKEW_MS) {
    return decryptFromHex(deps.keys, row.access_token_hex);
  }
  const refreshToken = await decryptFromHex(deps.keys, row.refresh_token_hex);
  const out = await refreshTokens(deps.env, refreshToken, deps.fetchImpl ?? fetch);
  if (!out.ok) {
    if (out.kind === "needs_reconnect") {
      deps.log?.warn("refresh_invalid_grant", { integration_id: integration.id, status: out.status });
      await vaultDelete(deps.sb, integration.id);
      await markNeedsReconnect(deps.sb, integration.id, out.detail);
      throw new NeedsReconnect(out.detail);
    }
    throw new GoogleError({ kind: out.kind, code: "refresh_failed", detail: out.detail }, out.status);
  }
  const t = out.tokens;
  const accessHex = await encryptToHex(deps.keys, t.access_token);
  // refresh hex null → the RPC keeps the stored refresh token (Google does not rotate it)
  await vaultSet(deps.sb, integration.id, t.refresh_token ? await encryptToHex(deps.keys, t.refresh_token) : null, accessHex, new Date(now() + t.expires_in * 1000));
  await deps.sb.from("integrations").update({ status: "connected", last_error: null }).eq("id", integration.id);
  deps.log?.info("token_refreshed", { integration_id: integration.id, expires_in: t.expires_in });
  return t.access_token;
}

// ---------------------------------------------------------------- Directory API

export interface DirectoryUser {
  id: string;
  primaryEmail?: string | null;
  name?: { fullName?: string | null; givenName?: string | null; familyName?: string | null } | null;
  suspended?: boolean | null;
  archived?: boolean | null;
  organizations?: Array<{ title?: string | null; department?: string | null; primary?: boolean | null }> | null;
}

export function classifyDirectoryError(status: number, body: unknown, retryAfter: string | null): GoogleErrorClass {
  const e = ((body ?? {}) as { error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> } }).error ?? {};
  const reason = String(e.errors?.[0]?.reason ?? e.status ?? "");
  const msg = String(e.message ?? "").slice(0, 300);
  const detail = `directory ${status}${reason ? ` ${reason}` : ""}${msg ? `: ${msg}` : ""}`;
  if (status === 429 || /rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(reason)) {
    const secs = Number(retryAfter);
    return { kind: "retry", code: "rate_limited", detail, retryAfterMs: Number.isFinite(secs) && secs > 0 ? Math.min(secs, 60) * 1000 : 2000 };
  }
  if (status >= 500 || status === 0) return { kind: "retry", code: "directory_unavailable", detail };
  if (status === 401 || /authError|UNAUTHENTICATED/i.test(reason)) return { kind: "needs_reconnect", code: "token_invalid", detail };
  if (status === 403) {
    // the admin who connected lacks the Users › Read privilege (or the scope was not granted) — reconnect as a proper admin
    if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason) || /insufficient/i.test(msg)) return { kind: "needs_reconnect", code: "missing_scope", detail };
    return { kind: "blocked", code: "not_authorized", detail: `${detail} (the connecting account needs the Users › Read admin privilege)` };
  }
  if (status === 400 && /invalid_customer|Invalid Input/i.test(`${reason} ${msg}`)) return { kind: "blocked", code: "not_workspace", detail: `${detail} (a Google Workspace domain is required; consumer Gmail has no directory)` };
  return { kind: "failed", code: "directory_error", detail };
}

export interface DirectoryApiOptions {
  fetchImpl?: typeof fetch;
  log?: Logger;
  maxRetries?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  maxUsers?: number;
}

export class DirectoryApi {
  private fetchImpl: typeof fetch;
  private log?: Logger;
  private maxRetries: number;
  private sleepImpl: (ms: number) => Promise<void>;
  private maxUsers: number;
  constructor(private accessToken: string, opts: DirectoryApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.maxUsers = opts.maxUsers ?? MAX_USERS;
  }

  async get(url: string): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
    const full = url.startsWith("http") ? url : `${DIRECTORY_BASE}${url}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(full, { headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } });
      } catch (e) {
        if (attempt <= this.maxRetries) {
          await this.sleepImpl(500 * attempt);
          continue;
        }
        return { status: 0, body: { error: { message: e instanceof Error ? e.message : String(e) } }, retryAfter: null };
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const retryAfter = res.headers.get("retry-after");
      if ((res.status === 429 || res.status >= 500) && attempt <= this.maxRetries) {
        const secs = Number(retryAfter);
        const wait = Math.min(Number.isFinite(secs) && secs > 0 ? secs * 1000 : 500 * attempt, 10_000);
        this.log?.warn("directory_retry", { status: res.status, attempt, wait_ms: wait });
        await this.sleepImpl(wait);
        continue;
      }
      return { status: res.status, body, retryAfter };
    }
  }

  /** Every non-suspended user of the customer (all pages, ≤ maxUsers). */
  async listUsers(onPage?: (n: number) => void): Promise<{ users: DirectoryUser[]; truncated: boolean }> {
    const out: DirectoryUser[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let truncated = false;
    do {
      const qs = new URLSearchParams({ customer: "my_customer", maxResults: String(PAGE_SIZE), query: "isSuspended=false", projection: "full", orderBy: "email" });
      if (pageToken) qs.set("pageToken", pageToken);
      const r = await this.get(`/users?${qs}`);
      if (r.status !== 200 || !r.body) throw new GoogleError(classifyDirectoryError(r.status, r.body, r.retryAfter), r.status);
      const b = r.body as { users?: DirectoryUser[]; nextPageToken?: string };
      out.push(...(b.users ?? []));
      pages++;
      onPage?.(pages);
      pageToken = b.nextPageToken || undefined;
      if (pageToken && out.length >= this.maxUsers) {
        truncated = true;
        this.log?.warn("directory_users_truncated", { fetched: out.length, cap: this.maxUsers });
        break;
      }
      if (pages > 50) break; // safety valve
    } while (pageToken);
    return { users: out.slice(0, this.maxUsers), truncated: truncated || out.length > this.maxUsers };
  }
}

/** Directory user → employee row; title/department from the primary organizations[] entry (else the first). */
export function toEmployee(u: DirectoryUser): Employee | null {
  if (!u?.id) return null;
  const orgs = Array.isArray(u.organizations) ? u.organizations : [];
  const org = orgs.find((o) => o?.primary) ?? orgs[0] ?? null;
  const email = cleanEmail(u.primaryEmail);
  const name = clean(u.name?.fullName) ?? clean([u.name?.givenName, u.name?.familyName].filter(Boolean).join(" ")) ?? (email ? email.split("@")[0] : null);
  return { ext_id: u.id, email, name, title: clean(org?.title), dept: clean(org?.department) };
}

/** Translate a thrown Google failure into the uniform JSON error (mirrors zoomErrorToHttp). */
export function googleErrorToHttp(e: unknown, log?: Logger): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof NeedsReconnect) return new HttpError(409, "needs_reconnect", e.detail);
  if (e instanceof GoogleError) {
    switch (e.cls.kind) {
      case "retry":
        return new HttpError(503, "google_retry_later", e.cls.detail, { retry_after_ms: e.cls.retryAfterMs ?? 2000 });
      case "needs_reconnect":
        return new HttpError(409, "needs_reconnect", e.cls.detail, { code: e.cls.code });
      case "blocked":
        return new HttpError(409, "google_blocked", e.cls.detail, { code: e.cls.code });
      default:
        return new HttpError(502, "google_error", e.cls.detail, { code: e.cls.code });
    }
  }
  log?.error("internal_failure", { name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
  return new HttpError(500, "internal", "unexpected error while talking to Google; see request id", { cause: e instanceof Error ? e.name : "Error" });
}

export function isGoogleReconnectFailure(e: unknown): boolean {
  return e instanceof NeedsReconnect || (e instanceof GoogleError && e.cls.kind === "needs_reconnect");
}
