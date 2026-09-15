// _shared/env.ts — secrets + configuration for the MeetingBrand (mb-*) Edge Functions.
//
// Injected by Supabase automatically: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// Set by the orchestrator (`supabase secrets set … --project-ref ohobtgbyrlczfdztzvqi`):
//   ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET  — Zoom Marketplace app (General App, admin-managed)
//   MB_TOKEN_KEY                        — base64 of 32 random bytes (AES-256-GCM + HMAC root key)
//   MB_APP_URL                          — https://meetingbrand.com/app/ (OAuth callback redirects here)
//   ZOOM_REDIRECT_URI (optional)        — defaults to <SUPABASE_URL>/functions/v1/mb-oauth-zoom/callback
//                                         (a PATH, not ?action=callback: Zoom staff confirm query params in
//                                         redirect URLs are not supported — devforum.zoom.us/t/13765)
//   MS_CLIENT_ID, MS_CLIENT_SECRET      — Entra ID app registration (multitenant, Graph application permission
//                                         User.Read.All; README-INTEGRATIONS.md). Client-credentials only:
//                                         no refresh token is ever stored, tokens are minted per call per tenant.
//   MS_REDIRECT_URI (optional)          — defaults to <SUPABASE_URL>/functions/v1/mb-oauth-ms/callback
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — Google Cloud OAuth web client (scope admin.directory.user.readonly)
//   GOOGLE_REDIRECT_URI (optional)      — defaults to <SUPABASE_URL>/functions/v1/mb-oauth-google/callback
//
// Nothing here throws at import time: a missing secret is reported as a 503 {error:"not_configured",
// missing:[…]} by the caller (see `notConfigured`), never as a crash.

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** MeetingBrand's own secrets — needed by the unauthenticated OAuth callback and by the Integrations read model. */
export interface AppEnv {
  tokenKeyB64: string; // MB_TOKEN_KEY, base64 (32 bytes)
  appUrl: string; // MB_APP_URL
  redirectUri: string; // ZOOM_REDIRECT_URI or <SUPABASE_URL>/functions/v1/mb-oauth-zoom/callback
}

/** AppEnv + the Zoom Marketplace credentials (everything that talks to zoom.us). */
export interface ZoomEnv extends AppEnv {
  clientId: string;
  clientSecret: string;
}

/** Entra app credentials (Teams directory via Graph). */
export interface MsEnv extends AppEnv {
  clientId: string;
  clientSecret: string;
}
/** Google Cloud OAuth client (Meet directory via the Admin SDK). */
export interface GoogleEnv extends AppEnv {
  clientId: string;
  clientSecret: string;
}

export const APP_SECRET_NAMES = ["MB_TOKEN_KEY", "MB_APP_URL"] as const;
export const ZOOM_CREDENTIAL_NAMES = ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"] as const;
export const ZOOM_SECRET_NAMES = [...ZOOM_CREDENTIAL_NAMES, ...APP_SECRET_NAMES] as const;
export const MS_CREDENTIAL_NAMES = ["MS_CLIENT_ID", "MS_CLIENT_SECRET"] as const;
export const MS_SECRET_NAMES = [...MS_CREDENTIAL_NAMES, ...APP_SECRET_NAMES] as const;
export const GOOGLE_CREDENTIAL_NAMES = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
export const GOOGLE_SECRET_NAMES = [...GOOGLE_CREDENTIAL_NAMES, ...APP_SECRET_NAMES] as const;

/** Which secret names each platform's actions need (the not_configured `missing` list is drawn from these, in this order). */
export const PLATFORM_SECRET_NAMES = { zoom: ZOOM_SECRET_NAMES, teams: MS_SECRET_NAMES, meet: GOOGLE_SECRET_NAMES } as const;
export const SUPABASE_SECRET_NAMES = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

function read(name: string): string | undefined {
  try {
    const v = Deno.env.get(name);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined; // no --allow-env (tests) → treated as missing
  }
}

/** Names of the given secrets that are absent or blank. */
export function missingSecrets(names: readonly string[]): string[] {
  return names.filter((n) => !read(n));
}

/** Supabase runtime env — injected on the platform; missing only in a broken deploy. */
export function supabaseEnv(): { ok: true; env: SupabaseEnv } | { ok: false; missing: string[] } {
  const missing = missingSecrets(SUPABASE_SECRET_NAMES);
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    env: {
      url: read("SUPABASE_URL")!.replace(/\/+$/, ""),
      anonKey: read("SUPABASE_ANON_KEY")!,
      serviceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY")!,
    },
  };
}

/** Validate MB_TOKEN_KEY: base64 (std or url-safe) decoding to exactly 32 bytes. */
export function decodeTokenKey(b64: string): Uint8Array | null {
  try {
    const std = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
    const bin = atob(padded);
    if (bin.length !== 32) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The default Zoom redirect URI: a PATH under this project's functions gateway (see header). */
export function defaultRedirectUri(): string {
  const sb = read("SUPABASE_URL")?.replace(/\/+$/, "") ?? "";
  return read("ZOOM_REDIRECT_URI") ?? `${sb}/functions/v1/mb-oauth-zoom/callback`;
}

/** Default Entra admin-consent redirect URI (a PATH under the functions gateway, like Zoom's). */
export function defaultMsRedirectUri(): string {
  const sb = read("SUPABASE_URL")?.replace(/\/+$/, "") ?? "";
  return read("MS_REDIRECT_URI") ?? `${sb}/functions/v1/mb-oauth-ms/callback`;
}

/** Default Google OAuth redirect URI (must be registered verbatim on the OAuth client). */
export function defaultGoogleRedirectUri(): string {
  const sb = read("SUPABASE_URL")?.replace(/\/+$/, "") ?? "";
  return read("GOOGLE_REDIRECT_URI") ?? `${sb}/functions/v1/mb-oauth-google/callback`;
}

/** Validation problems for MB_TOKEN_KEY / MB_APP_URL (present but unusable), in the same "NAME (why)" shape as `missing`. */
function appEnvProblems(): string[] {
  const out: string[] = [];
  const key = read("MB_TOKEN_KEY");
  if (key && !decodeTokenKey(key)) out.push("MB_TOKEN_KEY (must be base64 of exactly 32 bytes)");
  const appUrl = read("MB_APP_URL");
  if (appUrl && !/^https?:\/\//.test(appUrl)) out.push("MB_APP_URL (must be an absolute http(s) URL)");
  return out;
}

/** MeetingBrand's own secrets (no Zoom credentials needed). `missing` lists every absent/invalid name. */
export function appEnv(): { ok: true; env: AppEnv } | { ok: false; missing: string[] } {
  const missing = [...missingSecrets(APP_SECRET_NAMES), ...appEnvProblems()];
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return { ok: true, env: { tokenKeyB64: read("MB_TOKEN_KEY")!, appUrl: read("MB_APP_URL")!, redirectUri: defaultRedirectUri() } };
}

/** Zoom + app secrets. `missing` lists every absent/invalid name so the owner fixes them in one go. */
export function zoomEnv(): { ok: true; env: ZoomEnv } | { ok: false; missing: string[] } {
  const missing = [...missingSecrets(ZOOM_SECRET_NAMES), ...appEnvProblems()];
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    env: {
      clientId: read("ZOOM_CLIENT_ID")!,
      clientSecret: read("ZOOM_CLIENT_SECRET")!,
      tokenKeyB64: read("MB_TOKEN_KEY")!,
      appUrl: read("MB_APP_URL")!,
      redirectUri: defaultRedirectUri(),
    },
  };
}

/** Entra + app secrets (Teams connector). `missing` lists every absent/invalid name. */
export function msEnv(): { ok: true; env: MsEnv } | { ok: false; missing: string[] } {
  const missing = [...missingSecrets(MS_SECRET_NAMES), ...appEnvProblems()];
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    env: {
      clientId: read("MS_CLIENT_ID")!,
      clientSecret: read("MS_CLIENT_SECRET")!,
      tokenKeyB64: read("MB_TOKEN_KEY")!,
      appUrl: read("MB_APP_URL")!,
      redirectUri: defaultMsRedirectUri(),
    },
  };
}

/** Google + app secrets (Meet connector). `missing` lists every absent/invalid name. */
export function googleEnv(): { ok: true; env: GoogleEnv } | { ok: false; missing: string[] } {
  const missing = [...missingSecrets(GOOGLE_SECRET_NAMES), ...appEnvProblems()];
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    env: {
      clientId: read("GOOGLE_CLIENT_ID")!,
      clientSecret: read("GOOGLE_CLIENT_SECRET")!,
      tokenKeyB64: read("MB_TOKEN_KEY")!,
      appUrl: read("MB_APP_URL")!,
      redirectUri: defaultGoogleRedirectUri(),
    },
  };
}

/** 503 body for a function that cannot run until secrets exist. */
export function notConfiguredBody(missing: string[]): { error: "not_configured"; missing: string[]; detail: string } {
  return {
    error: "not_configured",
    missing,
    detail: `Set the missing secrets with: supabase secrets set ${missing.map((m) => m.split(" ")[0] + "=…").join(" ")} --project-ref ohobtgbyrlczfdztzvqi`,
  };
}
