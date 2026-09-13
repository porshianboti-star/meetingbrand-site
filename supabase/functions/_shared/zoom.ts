// _shared/zoom.ts — Zoom OAuth + REST adapter for MeetingBrand.
//
// Verified facts (PLAN-integrations.md §3.1, 2026-09-04):
//   OAuth   : GET https://zoom.us/oauth/authorize?response_type=code&client_id&redirect_uri&state
//             POST https://zoom.us/oauth/token  (Authorization: Basic base64(client_id:client_secret))
//               grant_type=authorization_code&code&redirect_uri | grant_type=refresh_token&refresh_token
//             access token 1 h; refresh token 90 days and ROTATES on every refresh (store the new one!)
//             POST https://zoom.us/oauth/revoke?token=… (Basic auth) on disconnect
//   Directory: GET /users?status=active&page_size=300 (next_page_token); GET /users/{id} → job_title
//   Preflight: GET /accounts/me/settings → in_meeting.virtual_background (boolean). `me` = the account
//              that authorised us; an explicit account id only works for sub-accounts of a master
//              (partner) account and answers 404 code 2001 otherwise. Paid accounts only (code 200).
//   Upload   : POST /users/{userId}/settings/virtual_backgrounds  multipart field `file`  → 201
//              jpg/jpeg/png/gif ≤ 15 MB, max 10 files per user; response {id,is_default,name,size,type}
//              (type is "image"|"video"); 400 code 120 = no file / >15 MB / 10-file cap / wrong format
//              no activate endpoint; is_default is read-only (employee picks once after re-login)
//   Delete   : DELETE /users/{userId}/settings/virtual_backgrounds?file_ids=a,b → 204; 400 code 300
//   Errors   : REST → {code, message}; 124 = expired/invalid access token (HTTP 400 OR 401);
//              4711 = token lacks scope; 1001 = user does not exist (404); OAuth → {error, reason}
//   429      : X-RateLimit-Type: QPS (per-second, no Retry-After → back off ~1 s and re-send) or
//              Daily-limit (Retry-After = ISO time the day resets → STOP, nothing succeeds until then)
//              Verified against the OpenAPI spec embedded in developers.zoom.us/docs/api/{users,accounts}/ (2026-09-13)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import type { ZoomEnv } from "./env.ts";
import { decryptFromHex, encryptToHex, type VaultKeys } from "./crypto.ts";
import { HttpError, sleep, type Logger } from "./http.ts";

export const ZOOM_OAUTH_BASE = "https://zoom.us/oauth";
export const ZOOM_API_BASE = "https://api.zoom.us/v2";
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_USER = 10;
export const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh when < 5 min left
export const ALLOWED_UPLOAD_MIME = new Set(["image/png", "image/jpeg", "image/gif"]);

// ---------------------------------------------------------------- types

export interface ZoomTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in: number; // seconds
  scope?: string;
  api_url?: string;
}

export interface ZoomMe {
  id: string;
  account_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
}

export interface ZoomUserRow {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  dept?: string;
  status?: string;
  type?: number;
  last_client_version?: string;
  job_title?: string;
}

export interface ZoomEmployee {
  ext_id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  dept: string | null;
  last_client_version: string | null;
}

export interface ZoomResult<T = unknown> {
  status: number;
  body: T | null; // parsed JSON when present
  text: string; // raw body (for non-JSON)
  retryAfterMs: number | null; // capped at 60 s (see retryAfterMs)
  rateLimit: { type: "qps" | "daily" | null; resetAt: string | null }; // from X-RateLimit-Type / Retry-After on 429
}

/** Push-state class for a Zoom failure. */
export type ZoomErrorKind = "retry" | "needs_reconnect" | "blocked" | "failed";
export interface ZoomErrorClass {
  kind: ZoomErrorKind;
  code: string; // short machine reason
  detail: string; // human text (safe to store in pushes.error)
  retryAfterMs?: number;
}

export class ZoomError extends Error {
  constructor(public cls: ZoomErrorClass, public status: number) {
    super(`${cls.kind}/${cls.code}: ${cls.detail}`);
  }
}

// ---------------------------------------------------------------- OAuth URL + token endpoints

export function authorizeUrl(env: Pick<ZoomEnv, "clientId" | "redirectUri">, state: string): string {
  const u = new URL(`${ZOOM_OAUTH_BASE}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.clientId);
  u.searchParams.set("redirect_uri", env.redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

function basicAuth(env: Pick<ZoomEnv, "clientId" | "clientSecret">): string {
  return "Basic " + btoa(`${env.clientId}:${env.clientSecret}`);
}

async function parse(res: Response): Promise<ZoomResult> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return {
    status: res.status,
    body,
    text,
    retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
    rateLimit: rateLimitInfo(res.headers),
  };
}

/** Zoom's 429 headers: X-RateLimit-Type is `QPS` or `Daily-limit`; Retry-After (ISO 8601) only on daily. */
export function rateLimitInfo(headers: Headers): ZoomResult["rateLimit"] {
  const t = (headers.get("x-ratelimit-type") ?? "").toLowerCase();
  const type = t.includes("daily") ? "daily" : t.includes("qps") || t.includes("second") ? "qps" : null;
  const ra = headers.get("retry-after");
  const resetAt = ra && Number.isFinite(Date.parse(ra)) ? new Date(Date.parse(ra)).toISOString() : null;
  return { type, resetAt };
}

export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 60)) * 1000;
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60_000));
  return null;
}

export type TokenOutcome =
  | { ok: true; tokens: ZoomTokenResponse }
  | { ok: false; kind: "needs_reconnect" | "retry" | "failed"; detail: string; status: number };

async function tokenCall(env: ZoomEnv, params: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${ZOOM_OAUTH_BASE}/token`, {
      method: "POST",
      headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    return { ok: false, kind: "retry", detail: `zoom oauth unreachable: ${e instanceof Error ? e.message : String(e)}`, status: 0 };
  }
  const r = await parse(res);
  const b = (r.body ?? {}) as Partial<ZoomTokenResponse> & { error?: string; reason?: string };
  if (r.status === 200 && b.access_token && typeof b.expires_in === "number") return { ok: true, tokens: b as ZoomTokenResponse };
  const err = String(b.error ?? "");
  const detail = `zoom oauth ${r.status} ${err}${b.reason ? `: ${b.reason}` : ""}`.trim();
  if (r.status === 429 || r.status >= 500) return { ok: false, kind: "retry", detail, status: r.status };
  // invalid_client = OUR credentials are wrong (Zoom answers 401 here too) — not the customer's grant
  if (err === "invalid_client") return { ok: false, kind: "failed", detail: `${detail} (check ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET)`, status: r.status };
  if (err === "invalid_grant" || err === "invalid_token" || r.status === 401) return { ok: false, kind: "needs_reconnect", detail, status: r.status };
  return { ok: false, kind: "failed", detail, status: r.status };
}

/** authorization_code → tokens. redirect_uri must equal the one used in authorizeUrl. */
export function exchangeCode(env: ZoomEnv, code: string, fetchImpl: typeof fetch = fetch): Promise<TokenOutcome> {
  return tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: env.redirectUri }, fetchImpl);
}

/** refresh_token → tokens (Zoom returns a NEW refresh token; the old one is dead after this). */
export function refreshTokens(env: ZoomEnv, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenOutcome> {
  return tokenCall(env, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/** Best-effort revoke on disconnect. Never throws. */
export async function revokeToken(env: ZoomEnv, token: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(`${ZOOM_OAUTH_BASE}/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
    });
    await res.text().catch(() => "");
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Zoom access tokens are JWTs; `aid` is the account id. Null when the token is opaque/malformed. */
export function accountIdFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const std = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(std + "=".repeat((4 - (std.length % 4)) % 4)));
    return typeof payload?.aid === "string" && payload.aid ? payload.aid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- error mapping

/** Map a Zoom REST failure to a push state. See PLAN §2 PushJob machine. */
export function classifyZoomError(r: { status: number; body: unknown; retryAfterMs?: number | null; rateLimit?: ZoomResult["rateLimit"] }): ZoomErrorClass {
  const b = (r.body ?? {}) as { code?: number | string; message?: string; error?: string; reason?: string };
  const code = b.code !== undefined ? String(b.code) : "";
  const msg = String(b.message ?? b.reason ?? b.error ?? "").trim();
  const text = `${code} ${msg}`.toLowerCase();
  const detail = `zoom ${r.status}${code ? ` code ${code}` : ""}${msg ? `: ${msg}` : ""}`;

  if (r.status === 429) {
    // Daily limit: every further call today fails too → the caller must stop, not sleep-and-retry.
    if (r.rateLimit?.type === "daily" || /daily/.test(text)) {
      const resets = r.rateLimit?.resetAt ? ` (resets ${r.rateLimit.resetAt})` : "";
      return { kind: "retry", code: "daily_limit", detail: `${detail}${resets}`, retryAfterMs: r.retryAfterMs ?? 60_000 };
    }
    return { kind: "retry", code: "rate_limited", detail, retryAfterMs: r.retryAfterMs ?? 1000 };
  }
  if (r.status >= 500 || r.status === 0) return { kind: "retry", code: "zoom_unavailable", detail };
  if (r.status === 401 || b.error === "invalid_grant" || b.error === "invalid_token" || code === "124") {
    return { kind: "needs_reconnect", code: "token_invalid", detail };
  }
  // 4700/4711: token lacks the scope → the app was re-scoped; admin must re-authorize
  if (code === "4700" || code === "4711" || /does not contain scopes|invalid access token/.test(text)) {
    return { kind: "needs_reconnect", code: "missing_scope", detail };
  }
  if (r.status === 404 || code === "1001" || code === "1010" || /user (does not|doesn't) exist|not found/.test(text)) {
    return { kind: "failed", code: "user_not_found", detail };
  }
  // upload 400 code 120 also covers "File size cannot exceed 15M", "Only jpg/jpeg, gif or png image
  // file can be uploaded" and "No file uploaded" — permanent for THIS file, not a library problem
  if (r.status === 400 && /file size|cannot exceed|exceeds? 15|no file uploaded|only jpg|jpeg, gif or png|image file can be uploaded|invalid file|unsupported|format/.test(text)) {
    return { kind: "failed", code: "bad_file", detail };
  }
  // library full — Zoom counts cloud files, max 10 per user ("A maximum of 10 files are allowed for a user")
  if (/maximum of 10|10 files|maximum number|limit|maximum|too many|full/.test(text)) {
    return { kind: "blocked", code: "library_full_or_limit", detail };
  }
  // feature disabled / plan / permission
  if (r.status === 403 || /virtual background.*(disabled|not enabled|turned off)|not (enabled|available|allowed)|paid account|permission|licen[cs]e|plan/.test(text)) {
    return { kind: "blocked", code: "feature_unavailable", detail };
  }
  if (/invalid file|unsupported|format|type/.test(text) && r.status === 400) {
    return { kind: "failed", code: "bad_file", detail };
  }
  return { kind: "failed", code: "zoom_error", detail };
}

// ---------------------------------------------------------------- REST client

export interface ZoomApiOptions {
  fetchImpl?: typeof fetch;
  log?: Logger;
  maxRetries?: number; // on 429 / 5xx for idempotent GETs
  sleepImpl?: (ms: number) => Promise<void>;
}

export class ZoomApi {
  private fetchImpl: typeof fetch;
  private log?: Logger;
  private maxRetries: number;
  private sleepImpl: (ms: number) => Promise<void>;
  constructor(private accessToken: string, opts: ZoomApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  /** Raw request; retries 429 (Retry-After) and 5xx only when `idempotent`. */
  async request(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; idempotent?: boolean } = {}): Promise<ZoomResult> {
    const url = path.startsWith("http") ? path : `${ZOOM_API_BASE}${path}`;
    const idempotent = init.idempotent ?? method === "GET";
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", ...(init.headers ?? {}) },
          body: init.body,
        });
      } catch (e) {
        if (idempotent && attempt <= this.maxRetries) {
          await this.sleepImpl(500 * attempt);
          continue;
        }
        return { status: 0, body: null, text: e instanceof Error ? e.message : String(e), retryAfterMs: null, rateLimit: { type: null, resetAt: null } };
      }
      const r = await parse(res);
      // 429 = rejected before any effect, so even a POST may be re-sent — but only once, and never
      // waiting more than 10 s, so a 50-employee push stays inside the Edge Function wall clock.
      const retryable = (r.status === 429 && r.rateLimit.type !== "daily") || (idempotent && r.status >= 500);
      const budget = idempotent ? this.maxRetries : Math.min(this.maxRetries, 1);
      if (retryable && attempt <= budget) {
        const wait = Math.min(r.status === 429 ? (r.retryAfterMs ?? 1000 * attempt) : 500 * attempt, 10_000);
        this.log?.warn("zoom_retry", { path: path.split("?")[0], status: r.status, attempt, wait_ms: wait });
        await this.sleepImpl(wait);
        continue;
      }
      return r;
    }
  }

  /**
   * Who authorised us. GET /users/me needs user:read:user:admin; when the app lacks it, Zoom's
   * access token (a JWT) still carries the account id as `aid`, which is all the connect flow needs.
   */
  async me(): Promise<ZoomMe> {
    const r = await this.request("GET", "/users/me");
    if (r.status === 200 && r.body) return r.body as ZoomMe;
    const cls = classifyZoomError(r);
    const aid = accountIdFromToken(this.accessToken);
    if (aid && cls.code === "missing_scope") {
      this.log?.warn("me_scope_missing", { detail: cls.detail, hint: "add scope user:read:user:admin; using aid from the token" });
      return { id: "", account_id: aid, email: "" };
    }
    throw new ZoomError(cls, r.status);
  }

  /** All active users, every page. */
  async listUsers(pageSize = 300, onPage?: (n: number) => void): Promise<ZoomUserRow[]> {
    const out: ZoomUserRow[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ status: "active", page_size: String(pageSize) });
      if (token) qs.set("next_page_token", token);
      const r = await this.request("GET", `/users?${qs}`);
      if (r.status !== 200 || !r.body) throw new ZoomError(classifyZoomError(r), r.status);
      const b = r.body as { users?: ZoomUserRow[]; next_page_token?: string };
      out.push(...(b.users ?? []));
      token = b.next_page_token || undefined;
      pages++;
      onPage?.(pages);
      if (pages > 200) break; // 60k users — safety valve
    } while (token);
    return out;
  }

  async getUser(id: string): Promise<ZoomUserRow | null> {
    const r = await this.request("GET", `/users/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.body) throw new ZoomError(classifyZoomError(r), r.status);
    return r.body as ZoomUserRow;
  }

  /**
   * Preflight: is virtual background enabled at account level? null = could not determine (scope/plan).
   * Always `/accounts/me/settings`: `me` is the authorising account. Passing our own account id answers
   * 404 code 2001 ("Account does not exist") unless we are a master account addressing a sub-account.
   */
  async accountVirtualBackgroundEnabled(): Promise<{ enabled: boolean | null; detail: string }> {
    const r = await this.request("GET", "/accounts/me/settings");
    if (r.status === 200 && r.body) {
      const b = r.body as { in_meeting?: { virtual_background?: boolean } };
      const v = b.in_meeting?.virtual_background;
      if (typeof v === "boolean") return { enabled: v, detail: v ? "account virtual background enabled" : "account virtual background disabled" };
      return { enabled: null, detail: "in_meeting.virtual_background not present in settings" };
    }
    const cls = classifyZoomError(r);
    // a dead token is fatal for the whole push; a missing account:read:settings:admin scope only
    // means we cannot pre-check — the upload itself will tell us
    if (cls.kind === "needs_reconnect" && cls.code === "token_invalid") throw new ZoomError(cls, r.status);
    return { enabled: null, detail: `preflight skipped: ${cls.detail}` };
  }

  /** Upload one file to a user's virtual-background library → 201 {id,is_default,name,size,type:"image"|"video"}. */
  async uploadVirtualBackground(userId: string, fileBytes: Uint8Array, filename: string, mime: string): Promise<{ id: string; name?: string; size?: number; type?: string; is_default?: boolean }> {
    if (!ALLOWED_UPLOAD_MIME.has(mime)) throw new ZoomError({ kind: "failed", code: "bad_file", detail: `unsupported mime ${mime}` }, 0);
    if (fileBytes.byteLength > MAX_UPLOAD_BYTES) throw new ZoomError({ kind: "failed", code: "bad_file", detail: `file is ${fileBytes.byteLength} bytes; Zoom max is 15 MB` }, 0);
    const form = new FormData();
    form.append("file", new Blob([fileBytes as BlobPart], { type: mime }), filename);
    const r = await this.request("POST", `/users/${encodeURIComponent(userId)}/settings/virtual_backgrounds`, { body: form, idempotent: false });
    if ((r.status === 201 || r.status === 200) && r.body && typeof (r.body as { id?: unknown }).id === "string") {
      return r.body as { id: string; name?: string; size?: number; type?: string; is_default?: boolean };
    }
    throw new ZoomError(classifyZoomError(r), r.status);
  }

  async deleteVirtualBackgrounds(userId: string, fileIds: string[]): Promise<void> {
    if (!fileIds.length) return;
    const r = await this.request("DELETE", `/users/${encodeURIComponent(userId)}/settings/virtual_backgrounds?file_ids=${encodeURIComponent(fileIds.join(","))}`, { idempotent: true });
    if (r.status !== 204 && r.status !== 200) throw new ZoomError(classifyZoomError(r), r.status);
  }

  /** Files currently in the user's library (verification / 10-file accounting). */
  async userVirtualBackgroundFiles(userId: string): Promise<Array<{ id: string; name?: string; is_default?: boolean }>> {
    const r = await this.request("GET", `/users/${encodeURIComponent(userId)}/settings`);
    if (r.status !== 200 || !r.body) throw new ZoomError(classifyZoomError(r), r.status);
    const b = r.body as { in_meeting?: { virtual_background_settings?: { files?: Array<{ id: string; name?: string; is_default?: boolean }> } } };
    return b.in_meeting?.virtual_background_settings?.files ?? [];
  }
}

// ---------------------------------------------------------------- directory with job titles

export function toEmployee(u: ZoomUserRow): ZoomEmployee {
  const name = (u.display_name?.trim() || [u.first_name, u.last_name].filter(Boolean).join(" ").trim()) || null;
  return {
    ext_id: u.id,
    email: u.email?.trim().toLowerCase() || null,
    name,
    title: u.job_title?.trim() || null,
    dept: u.dept?.trim() || null,
    last_client_version: u.last_client_version ?? null,
  };
}

/** Pull every active user, then enrich job_title with ≤ `concurrency` parallel GET /users/{id}. */
export async function listEmployees(api: ZoomApi, opts: { concurrency?: number; enrichTitles?: boolean; log?: Logger } = {}): Promise<ZoomEmployee[]> {
  const rows = await api.listUsers();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 4));
  if (opts.enrichTitles ?? true) {
    let next = 0;
    let failures = 0;
    let stop = false; // set when the token lacks user:read:user:admin — titles are optional, the sync is not
    const worker = async () => {
      while (!stop && next < rows.length) {
        const i = next++;
        try {
          const full = await api.getUser(rows[i].id);
          if (full) rows[i] = { ...rows[i], ...full };
        } catch (e) {
          failures++;
          if (e instanceof ZoomError && e.cls.kind === "needs_reconnect") {
            if (e.cls.code === "token_invalid") throw e; // dead token: abort the whole sync
            if (!stop) opts.log?.warn("title_enrich_scope_missing", { detail: e.cls.detail, hint: "add scope user:read:user:admin to the Zoom app for job titles" });
            stop = true;
            continue;
          }
          opts.log?.warn("title_enrich_failed", { ext_id: rows[i].id, message: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (failures) opts.log?.warn("title_enrich_partial", { failures, total: rows.length });
  }
  return rows.map(toEmployee);
}

// ---------------------------------------------------------------- token vault + single-flight refresh

export interface IntegrationRow {
  id: string;
  org_id: string;
  platform: string;
  status: string;
  account_ext_id: string | null;
}

export interface VaultRow {
  refresh_token_hex: string | null;
  access_token_hex: string | null;
  access_expires_at: string | null;
  rotated_at: string | null;
}

export interface TokenDeps {
  sb: SupabaseClient; // service role, schema mb
  keys: VaultKeys;
  env: ZoomEnv;
  fetchImpl?: typeof fetch;
  log?: Logger;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export class NeedsReconnect extends Error {
  constructor(public detail: string) {
    super(detail);
  }
}

export async function vaultGet(sb: SupabaseClient, integrationId: string): Promise<VaultRow | null> {
  const { data, error } = await sb.rpc("integration_token_get", { p_integration_id: integrationId });
  if (error) throw new Error(`integration_token_get: ${error.message}`);
  const rows = (data ?? []) as VaultRow[];
  return rows[0] ?? null;
}

export async function vaultSet(sb: SupabaseClient, integrationId: string, refreshHex: string | null, accessHex: string, accessExpiresAt: Date): Promise<void> {
  const { error } = await sb.rpc("integration_token_set", {
    p_integration_id: integrationId,
    p_refresh_hex: refreshHex,
    p_access_hex: accessHex,
    p_access_expires_at: accessExpiresAt.toISOString(),
  });
  if (error) throw new Error(`integration_token_set: ${error.message}`);
}

export async function vaultDelete(sb: SupabaseClient, integrationId: string): Promise<void> {
  const { error } = await sb.rpc("integration_token_delete", { p_integration_id: integrationId });
  if (error) throw new Error(`integration_token_delete: ${error.message}`);
}

/**
 * Single-flight lease (006-token-lease.sql): `select … for update skip locked` + a 30 s lease column.
 * Returns {acquired:false} when another request holds the lease. If the RPC is not installed
 * (005 applied without 006) we fall back to "no lease" and log it — refresh still works, but two
 * concurrent refreshes could race (Zoom would then invalidate one of the rotated tokens).
 */
async function vaultBeginRefresh(sb: SupabaseClient, integrationId: string, leaseSeconds: number, log?: Logger): Promise<{ acquired: boolean; exists: boolean; row: VaultRow | null; leased: boolean }> {
  const { data, error } = await sb.rpc("integration_token_begin_refresh", { p_integration_id: integrationId, p_lease_seconds: leaseSeconds });
  if (error) {
    log?.warn("lease_rpc_unavailable", { message: error.message });
    const row = await vaultGet(sb, integrationId);
    return { acquired: !!row, exists: !!row, row, leased: false };
  }
  const r = ((data ?? []) as Array<{ acquired: boolean; row_exists: boolean } & VaultRow>)[0];
  if (!r) return { acquired: false, exists: false, row: null, leased: true };
  return { acquired: !!r.acquired, exists: !!r.row_exists, row: r.acquired ? r : null, leased: true };
}

async function vaultEndRefresh(sb: SupabaseClient, integrationId: string): Promise<void> {
  const { error } = await sb.rpc("integration_token_end_refresh", { p_integration_id: integrationId });
  if (error && !/PGRST202|not find/.test(error.message)) throw new Error(`integration_token_end_refresh: ${error.message}`);
}

export async function markNeedsReconnect(sb: SupabaseClient, integrationId: string, detail: string): Promise<void> {
  await sb.from("integrations").update({ status: "needs_reconnect", last_error: detail.slice(0, 500) }).eq("id", integrationId);
}

/**
 * Valid Zoom access token for an integration. Refreshes when < 5 min remain, rotating the stored
 * refresh token. On invalid_grant → integration.status = needs_reconnect, vault row deleted,
 * throws NeedsReconnect.
 */
export async function getAccessToken(deps: TokenDeps, integration: Pick<IntegrationRow, "id">): Promise<string> {
  const now = deps.now ?? Date.now;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const fresh = (row: VaultRow | null) =>
    !!row?.access_token_hex && !!row.access_expires_at && Date.parse(row.access_expires_at) - now() > ACCESS_REFRESH_SKEW_MS;

  const current = await vaultGet(deps.sb, integration.id);
  if (!current?.refresh_token_hex) throw new NeedsReconnect("no stored refresh token — reconnect Zoom");
  if (fresh(current)) return decryptFromHex(deps.keys, current.access_token_hex!);

  const lease = await vaultBeginRefresh(deps.sb, integration.id, 30, deps.log);
  if (!lease.exists) throw new NeedsReconnect("no stored refresh token — reconnect Zoom");
  if (!lease.acquired) {
    // someone else is refreshing: wait for their write (≤ 15 s)
    for (let i = 0; i < 30; i++) {
      await sleepImpl(500);
      const row = await vaultGet(deps.sb, integration.id);
      if (fresh(row)) return decryptFromHex(deps.keys, row!.access_token_hex!);
      if (!row?.refresh_token_hex) throw new NeedsReconnect("refresh failed in a concurrent request — reconnect Zoom");
    }
    throw new ZoomError({ kind: "retry", code: "refresh_in_progress", detail: "token refresh in progress; retry shortly" }, 0);
  }
  // Re-check under the lease: a concurrent refresh may have finished between get and lease.
  if (fresh(lease.row)) {
    if (lease.leased) await vaultEndRefresh(deps.sb, integration.id);
    return decryptFromHex(deps.keys, lease.row!.access_token_hex!);
  }
  const refreshToken = await decryptFromHex(deps.keys, lease.row!.refresh_token_hex!);
  const out = await refreshTokens(deps.env, refreshToken, deps.fetchImpl ?? fetch);
  if (!out.ok) {
    if (out.kind === "needs_reconnect") {
      deps.log?.warn("refresh_invalid_grant", { integration_id: integration.id, status: out.status });
      await vaultDelete(deps.sb, integration.id);
      await markNeedsReconnect(deps.sb, integration.id, out.detail);
      throw new NeedsReconnect(out.detail);
    }
    if (lease.leased) await vaultEndRefresh(deps.sb, integration.id);
    throw new ZoomError({ kind: out.kind, code: "refresh_failed", detail: out.detail }, out.status);
  }
  const t = out.tokens;
  const accessExp = new Date(now() + t.expires_in * 1000);
  const [refreshHex, accessHex] = await Promise.all([
    t.refresh_token ? encryptToHex(deps.keys, t.refresh_token) : Promise.resolve<string | null>(null),
    encryptToHex(deps.keys, t.access_token),
  ]);
  await vaultSet(deps.sb, integration.id, refreshHex, accessHex, accessExp); // also clears the lease (006)
  const patch: Record<string, unknown> = { status: "connected", last_error: null };
  if (t.refresh_token) patch.expires_at = new Date(now() + REFRESH_TOKEN_LIFETIME_MS).toISOString();
  if (t.scope) patch.scopes = t.scope.split(/[\s,]+/).filter(Boolean);
  await deps.sb.from("integrations").update(patch).eq("id", integration.id);
  deps.log?.info("token_refreshed", { integration_id: integration.id, rotated: !!t.refresh_token, expires_in: t.expires_in });
  return t.access_token;
}

/** Load the org's Zoom integration row, or null. */
export async function loadZoomIntegration(sb: SupabaseClient, orgId: string): Promise<IntegrationRow | null> {
  const { data, error } = await sb.from("integrations").select("id, org_id, platform, status, account_ext_id").eq("org_id", orgId).eq("platform", "zoom").maybeSingle();
  if (error) throw new Error(`integrations lookup: ${error.message}`);
  return (data as IntegrationRow | null) ?? null;
}

// ---------------------------------------------------------------- failures → HTTP (for the handlers)

/** Translate a thrown Zoom/vault failure into the uniform JSON error the handlers return. */
export function zoomErrorToHttp(e: unknown, log?: Logger): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof NeedsReconnect) return new HttpError(409, "needs_reconnect", e.detail);
  if (e instanceof ZoomError) {
    switch (e.cls.kind) {
      case "retry":
        return new HttpError(503, "zoom_retry_later", e.cls.detail, { retry_after_ms: e.cls.retryAfterMs ?? 2000 });
      case "needs_reconnect":
        return new HttpError(409, "needs_reconnect", e.cls.detail);
      case "blocked":
        return new HttpError(409, "zoom_blocked", e.cls.detail, { code: e.cls.code });
      default:
        return new HttpError(502, "zoom_error", e.cls.detail, { code: e.cls.code });
    }
  }
  // Anything else is an internal failure (vault RPC, DB, crypto): never echo its message to the
  // caller — it can name schemas/functions/keys. Log the real message under the request id instead.
  log?.error("internal_failure", { name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
  return new HttpError(500, "internal", "unexpected error while talking to Zoom; see request id", { cause: e instanceof Error ? e.name : "Error" });
}

/** True when the failure means the stored Zoom authorization is dead (handlers then flip the row). */
export function isReconnectFailure(e: unknown): boolean {
  return e instanceof NeedsReconnect || (e instanceof ZoomError && e.cls.kind === "needs_reconnect");
}

/** Filename Zoom will show in the picker: ASCII-safe, ≤ 60 chars, with the right extension. */
export function backgroundFilename(label: string | null | undefined, mime: string): string {
  const ext = mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : "jpg";
  const base = (label ?? "").normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  return `MeetingBrand${base ? ` - ${base}` : ""}.${ext}`;
}

/** Upload mime from the stored asset row, else from the storage_path extension; null when Zoom would refuse it. */
export function mimeFromPath(path: string, declared?: string | null): string | null {
  if (declared && ALLOWED_UPLOAD_MIME.has(declared)) return declared;
  const m = /\.([a-z0-9]+)$/i.exec(path);
  switch ((m?.[1] ?? "").toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    default: return null;
  }
}
