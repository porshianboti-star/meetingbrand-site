// tests/_fake.ts — routed fake fetch shared by the connector handler tests (GoTrue, PostgREST, Storage, Microsoft, Google).
import { b64url } from "../_shared/crypto.ts";

export const SB_URL = "https://ohobtgbyrlczfdztzvqi.supabase.co";
export const TOKEN_KEY = b64url(crypto.getRandomValues(new Uint8Array(32)));
export const APP_URL = "https://meetingbrand.com/app/";
export const ALL_NAMES = [
  "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_REDIRECT_URI",
  "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_REDIRECT_URI",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
  "MB_TOKEN_KEY", "MB_APP_URL",
];

/** Supabase env always; platform credentials per flag. */
export function configure(opts: { zoom?: boolean; ms?: boolean; google?: boolean; app?: boolean } = { zoom: true, ms: true, google: true, app: true }) {
  Deno.env.set("SUPABASE_URL", SB_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  for (const n of ALL_NAMES) Deno.env.delete(n);
  if (opts.zoom) {
    Deno.env.set("ZOOM_CLIENT_ID", "zoom-cid");
    Deno.env.set("ZOOM_CLIENT_SECRET", "zoom-secret");
  }
  if (opts.ms) {
    Deno.env.set("MS_CLIENT_ID", "ms-cid");
    Deno.env.set("MS_CLIENT_SECRET", "ms-secret");
  }
  if (opts.google) {
    Deno.env.set("GOOGLE_CLIENT_ID", "g-cid");
    Deno.env.set("GOOGLE_CLIENT_SECRET", "g-secret");
  }
  if (opts.app ?? true) {
    Deno.env.set("MB_TOKEN_KEY", TOKEN_KEY);
    Deno.env.set("MB_APP_URL", APP_URL);
  }
}

export const ORG = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";
export const INTEG = "33333333-3333-4333-8333-333333333333";
export const BG = "44444444-4444-4444-8444-444444444444";
export const ASSET = "55555555-5555-4555-8555-555555555555";
export const THUMB = "56565656-5656-4556-8556-565656565656";
export const JPG = "57575757-5757-4557-8557-575757575757";
export const EMP = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
export const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";

export interface Seen {
  method: string;
  path: string;
  body: string;
  headers: Headers;
  url: URL;
}
export type Route = { method: string; test: (u: URL) => boolean; reply: (req: Request, u: URL, body: string) => Response | Promise<Response> };
export const j = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function router(routes: Route[]) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    const u = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text().catch(() => "");
    seen.push({ method: req.method, path: u.pathname + u.search, body, headers: req.headers, url: u });
    const r = routes.find((r) => r.method === req.method && r.test(u));
    if (!r) return j(599, { error: "unrouted", method: req.method, path: u.pathname + u.search });
    return await r.reply(req, u, body);
  };
  return { fetchImpl, seen, calls: (method: string, path: string | RegExp) => seen.filter((s) => s.method === method && (typeof path === "string" ? s.path.startsWith(path) : path.test(s.path))) };
}

export const rest = (table: string) => (u: URL) => u.pathname === `/rest/v1/${table}`;
export const rpc = (name: string) => (u: URL) => u.pathname === `/rest/v1/rpc/${name}`;
export const gotrueUser = (): Route => ({ method: "GET", test: (u) => u.pathname === "/auth/v1/user", reply: (req) => (req.headers.get("authorization") === "Bearer user-jwt" ? j(200, { id: USER, email: "admin@acme.com" }) : j(401, { message: "bad jwt" })) });
export const profile = (role = "admin"): Route => ({ method: "GET", test: rest("profiles"), reply: () => j(200, [{ org_id: ORG, role }]) });
export const integrationRow = (platform: string, status = "connected", extra: Record<string, unknown> = {}): Route => ({
  method: "GET",
  test: rest("integrations"),
  reply: (_r, u) => {
    const wanted = u.searchParams.get("platform") ?? "";
    const row = { id: INTEG, org_id: ORG, platform, status, account_ext_id: platform === "teams" ? TENANT : platform === "meet" ? "acme.com" : "acc-1", scopes: ["a"], connected_by: USER, connected_at: null, expires_at: null, last_sync_at: null, last_error: null, updated_at: null, ...extra };
    if (wanted && wanted !== `eq.${platform}`) return j(200, []);
    return j(200, [row]);
  },
});
export const patchOk = (table: string): Route => ({ method: "PATCH", test: rest(table), reply: () => new Response(null, { status: 204 }) });
export const eventsOk: Route = { method: "POST", test: rest("events"), reply: () => new Response(null, { status: 201 }) };
export const headCount = (table: string, n = 0): Route => ({ method: "HEAD", test: rest(table), reply: () => new Response(null, { status: 200, headers: { "content-range": `*/${n}` } }) });

export const authed = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { authorization: "Bearer user-jwt", origin: "https://meetingbrand.com", "content-type": "application/json", ...(init.headers ?? {}) } });
