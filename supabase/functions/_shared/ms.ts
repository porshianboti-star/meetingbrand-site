// _shared/ms.ts — Microsoft Entra admin consent + client-credentials tokens + Graph directory.
//
// Verified facts (PLAN-integrations.md §3.2, 2026-09-04):
//   Consent  : the tenant admin visits the admin-consent endpoint of a MULTITENANT app registration
//              GET https://login.microsoftonline.com/common/adminconsent?client_id&state&redirect_uri
//              → Microsoft redirects to redirect_uri?tenant=<tid>&state=<state>&admin_consent=True
//              (or ?error=…&error_description=…). Consent persists until the admin deletes the
//              enterprise app; no Microsoft review, works for any customer immediately (only an
//              "unverified publisher" label until publisher verification).
//   Tokens   : app-only, client credentials per tenant — POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//              client_id&client_secret&grant_type=client_credentials&scope=https://graph.microsoft.com/.default
//              → {token_type, expires_in (~3600), access_token}. NO refresh token exists in this grant:
//              nothing goes to the vault; mb.integrations stores only the tenant id (account_ext_id).
//              Consent missing/revoked → AADSTS65001 / 650052 / 700016 (invalid_client for an unknown app in
//              that tenant) → needs_reconnect (the admin runs the consent again).
//   Directory: GET https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,
//              jobTitle,department,accountEnabled&$top=999&$filter=accountEnabled eq true
//              paginate @odata.nextLink (opaque absolute URL — follow it verbatim, do not re-add params).
//              `department` and `jobTitle` are NOT in the default property set; they come back only
//              because they are $select-ed — no per-user second call is needed with this $select
//              (a second call GET /users/{id}?$select=… would be needed only for properties Graph
//              refuses in list calls, e.g. some extension attributes; not our case).
//              Application permission User.Read.All (admin-consented) is enough for this query.
//              Errors: {error:{code,message}} — InvalidAuthenticationToken (401) → token problem,
//              Authorization_RequestDenied (403) → permission missing / consent revoked, 429 → Retry-After seconds.
//              https://learn.microsoft.com/en-us/graph/api/user-list
//   Hard cap : 2000 users per sync (3 pages of 999) — beyond that the sync reports `truncated:true`.

import type { MsEnv } from "./env.ts";
import { HttpError, sleep, type Logger } from "./http.ts";
import { clean, cleanEmail, type Employee } from "./platform.ts";

export const MS_LOGIN_BASE = "https://login.microsoftonline.com";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const MS_SCOPES = ["User.Read.All"] as const; // what the app registration must carry (application permission)
export const USERS_SELECT = "id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled";
export const PAGE_SIZE = 999;
export const MAX_USERS = 2000;

/** Tenant id (GUID) or a verified domain name — what Microsoft returns as ?tenant= after consent. */
export const TENANT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

// ---------------------------------------------------------------- consent URL

/** The admin-consent URL the app opens in a new tab. `state` is our HMAC-signed token. */
export function adminConsentUrl(env: Pick<MsEnv, "clientId" | "redirectUri">, state: string): string {
  const u = new URL(`${MS_LOGIN_BASE}/common/adminconsent`);
  u.searchParams.set("client_id", env.clientId);
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", env.redirectUri);
  return u.toString();
}

// ---------------------------------------------------------------- errors

export type MsErrorKind = "retry" | "needs_reconnect" | "blocked" | "failed";
export interface MsErrorClass {
  kind: MsErrorKind;
  code: string;
  detail: string;
  retryAfterMs?: number;
}
export class MsError extends Error {
  constructor(public cls: MsErrorClass, public status: number) {
    super(`${cls.kind}/${cls.code}: ${cls.detail}`);
  }
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
  error_codes?: number[];
}

/** Classify a token-endpoint failure. AADSTS codes come from `error_codes` and the description text. */
export function classifyTokenError(status: number, body: TokenErrorBody | null): MsErrorClass {
  const err = String(body?.error ?? "");
  const desc = String(body?.error_description ?? "").split(/\r?\n/)[0].slice(0, 300);
  const codes = Array.isArray(body?.error_codes) ? body!.error_codes!.map(String) : [];
  const detail = `entra token ${status} ${err}${desc ? `: ${desc}` : ""}`.trim();
  if (status === 429 || status >= 500 || status === 0) return { kind: "retry", code: "entra_unavailable", detail };
  // consent absent / revoked / app not in the tenant → the admin must consent again
  const consentCodes = ["65001", "650052", "700016", "7000215", "90002", "50020"];
  if (codes.some((c) => consentCodes.includes(c)) || /AADSTS(65001|650052|700016|90002)/.test(desc) || err === "invalid_grant") {
    // 7000215 = invalid client secret: OUR credentials, not the tenant's consent
    if (codes.includes("7000215") || /AADSTS7000215/.test(desc)) return { kind: "failed", code: "bad_client_secret", detail: `${detail} (check MS_CLIENT_SECRET)` };
    if (codes.includes("700016") || /AADSTS700016/.test(desc)) return { kind: "needs_reconnect", code: "app_not_in_tenant", detail: `${detail} (admin consent missing or removed)` };
    return { kind: "needs_reconnect", code: "consent_missing", detail };
  }
  if (err === "invalid_client" || err === "unauthorized_client") return { kind: "failed", code: "bad_client", detail: `${detail} (check MS_CLIENT_ID / MS_CLIENT_SECRET)` };
  if (err === "invalid_request" && /tenant/i.test(desc)) return { kind: "needs_reconnect", code: "bad_tenant", detail };
  return { kind: "failed", code: "entra_error", detail };
}

/** Classify a Graph failure. */
export function classifyGraphError(status: number, body: unknown, retryAfter: string | null): MsErrorClass {
  const e = ((body ?? {}) as { error?: { code?: string; message?: string } }).error ?? {};
  const code = String(e.code ?? "");
  const msg = String(e.message ?? "").slice(0, 300);
  const detail = `graph ${status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`;
  if (status === 429) {
    const secs = Number(retryAfter);
    return { kind: "retry", code: "rate_limited", detail, retryAfterMs: Number.isFinite(secs) ? Math.min(secs, 60) * 1000 : 2000 };
  }
  if (status >= 500 || status === 0) return { kind: "retry", code: "graph_unavailable", detail };
  if (status === 401 || code === "InvalidAuthenticationToken") return { kind: "needs_reconnect", code: "token_invalid", detail };
  if (status === 403 || code === "Authorization_RequestDenied") return { kind: "needs_reconnect", code: "missing_permission", detail: `${detail} (User.Read.All application permission not consented)` };
  if (status === 400 && /filter|select|top/i.test(msg)) return { kind: "failed", code: "bad_query", detail };
  return { kind: "failed", code: "graph_error", detail };
}

// ---------------------------------------------------------------- client-credentials token

export type MsTokenOutcome = { ok: true; accessToken: string; expiresIn: number } | { ok: false; cls: MsErrorClass; status: number };

/** Mint an app-only Graph token for one tenant. Nothing is cached or stored (1 h lifetime, cheap). */
export async function clientCredentialsToken(env: Pick<MsEnv, "clientId" | "clientSecret">, tenant: string, fetchImpl: typeof fetch = fetch): Promise<MsTokenOutcome> {
  if (!TENANT_RE.test(tenant)) return { ok: false, cls: { kind: "needs_reconnect", code: "bad_tenant", detail: "tenant must be a GUID or a domain" }, status: 0 };
  let res: Response;
  try {
    res = await fetchImpl(`${MS_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, grant_type: "client_credentials", scope: GRAPH_SCOPE }).toString(),
    });
  } catch (e) {
    return { ok: false, cls: { kind: "retry", code: "entra_unavailable", detail: `entra unreachable: ${e instanceof Error ? e.message : String(e)}` }, status: 0 };
  }
  const text = await res.text();
  let body: (TokenErrorBody & { access_token?: string; expires_in?: number }) | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.status === 200 && body?.access_token) return { ok: true, accessToken: body.access_token, expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600 };
  return { ok: false, cls: classifyTokenError(res.status, body), status: res.status };
}

// ---------------------------------------------------------------- Graph directory

export interface GraphUser {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  accountEnabled?: boolean | null;
}

export interface GraphApiOptions {
  fetchImpl?: typeof fetch;
  log?: Logger;
  maxRetries?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  maxUsers?: number;
}

export class GraphApi {
  private fetchImpl: typeof fetch;
  private log?: Logger;
  private maxRetries: number;
  private sleepImpl: (ms: number) => Promise<void>;
  private maxUsers: number;
  constructor(private accessToken: string, opts: GraphApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.maxUsers = opts.maxUsers ?? MAX_USERS;
  }

  /**
   * GET with 429/5xx retries. `url` is absolute (nextLink) or a path under GRAPH_BASE. An absolute URL must stay on
   * graph.microsoft.com: the Bearer token goes into the request, so a nextLink pointing anywhere else is refused.
   */
  async get(url: string): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
    const full = /^https?:/i.test(url) ? url : `${GRAPH_BASE}${url}`;
    if (!full.startsWith("https://graph.microsoft.com/")) {
      return { status: 0, body: { error: { code: "bad_next_link", message: "refusing to send the Graph token to a host other than graph.microsoft.com" } }, retryAfter: null };
    }
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(full, { headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", ConsistencyLevel: "eventual" } });
      } catch (e) {
        if (attempt <= this.maxRetries) {
          await this.sleepImpl(500 * attempt);
          continue;
        }
        return { status: 0, body: { error: { code: "network", message: e instanceof Error ? e.message : String(e) } }, retryAfter: null };
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
        this.log?.warn("graph_retry", { status: res.status, attempt, wait_ms: wait });
        await this.sleepImpl(wait);
        continue;
      }
      return { status: res.status, body, retryAfter };
    }
  }

  /** Every enabled user (all pages, ≤ maxUsers). Returns {users, truncated}. */
  async listUsers(onPage?: (n: number) => void): Promise<{ users: GraphUser[]; truncated: boolean }> {
    const out: GraphUser[] = [];
    const qs = new URLSearchParams({ "$select": USERS_SELECT, "$top": String(PAGE_SIZE), "$filter": "accountEnabled eq true" });
    let next: string | null = `/users?${qs}`;
    let pages = 0;
    let truncated = false;
    while (next) {
      const r = await this.get(next);
      if (r.status !== 200 || !r.body) throw new MsError(classifyGraphError(r.status, r.body, r.retryAfter), r.status);
      const b = r.body as { value?: GraphUser[]; "@odata.nextLink"?: string };
      out.push(...(b.value ?? []));
      pages++;
      onPage?.(pages);
      next = b["@odata.nextLink"] || null;
      if (next && out.length >= this.maxUsers) {
        truncated = true;
        this.log?.warn("graph_users_truncated", { fetched: out.length, cap: this.maxUsers });
        break;
      }
      if (pages > 50) break; // safety valve
    }
    return { users: out.slice(0, this.maxUsers), truncated: truncated || out.length > this.maxUsers };
  }

  /**
   * The tenant behind this token: its id (GUID), display name and verified domain names (lower-case). This is what
   * mb-oauth-ms binds — never the tenant string the client sent. Throws MsError when Graph refuses.
   */
  async organization(): Promise<GraphOrganization> {
    const r = await this.get("/organization?$select=id,displayName,verifiedDomains");
    if (r.status !== 200 || !r.body) throw new MsError(classifyGraphError(r.status, r.body, r.retryAfter), r.status);
    const b = r.body as { value?: Array<{ id?: string; displayName?: string; verifiedDomains?: Array<{ name?: string; isVerified?: boolean }> }> };
    const o = b.value?.[0];
    const id = typeof o?.id === "string" ? o.id.trim().toLowerCase() : "";
    if (!TENANT_GUID_RE.test(id)) throw new MsError({ kind: "failed", code: "graph_error", detail: "graph /organization returned no tenant id" }, r.status);
    const domains = (Array.isArray(o?.verifiedDomains) ? o!.verifiedDomains! : [])
      .filter((d) => d && typeof d.name === "string" && d.isVerified !== false)
      .map((d) => d.name!.trim().toLowerCase())
      .filter((n) => n.length > 0 && n.length <= 253);
    return { id, displayName: clean(o?.displayName) ?? null, domains: [...new Set(domains)] };
  }

  /** The tenant's organisation display name (used at connect time for a friendlier label). Null on any failure. */
  async organizationName(): Promise<string | null> {
    try {
      return (await this.organization()).displayName;
    } catch {
      return null;
    }
  }
}

export interface GraphOrganization {
  id: string; // tenant id, lower-case GUID
  displayName: string | null;
  domains: string[]; // verified domain names, lower-case (contoso.com, contoso.onmicrosoft.com, …)
}
export const TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Graph user → employee row. Disabled accounts are skipped upstream by $filter; guests are kept (they have a UPN). */
export function toEmployee(u: GraphUser): Employee | null {
  if (!u?.id) return null;
  const upn = clean(u.userPrincipalName, 320);
  return {
    ext_id: u.id,
    email: cleanEmail(u.mail) ?? cleanEmail(upn),
    name: clean(u.displayName) ?? (upn ? upn.split("@")[0] : null),
    title: clean(u.jobTitle),
    dept: clean(u.department),
  };
}

/** Translate a thrown Graph/Entra failure into the uniform JSON error (mirrors zoomErrorToHttp). */
export function msErrorToHttp(e: unknown, log?: Logger): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof MsError) {
    switch (e.cls.kind) {
      case "retry":
        return new HttpError(503, "ms_retry_later", e.cls.detail, { retry_after_ms: e.cls.retryAfterMs ?? 2000 });
      case "needs_reconnect":
        return new HttpError(409, "needs_reconnect", e.cls.detail, { code: e.cls.code });
      case "blocked":
        return new HttpError(409, "ms_blocked", e.cls.detail, { code: e.cls.code });
      default:
        return new HttpError(502, "ms_error", e.cls.detail, { code: e.cls.code });
    }
  }
  log?.error("internal_failure", { name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
  return new HttpError(500, "internal", "unexpected error while talking to Microsoft; see request id", { cause: e instanceof Error ? e.name : "Error" });
}

export function isMsReconnectFailure(e: unknown): boolean {
  return e instanceof MsError && e.cls.kind === "needs_reconnect";
}
