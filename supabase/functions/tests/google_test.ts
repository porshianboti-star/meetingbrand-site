// deno test -A tests/  — _shared/google.ts: authorize URL, token outcomes, Directory pagination + cap, employee mapping, vault refresh.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { authorizeUrl, classifyDirectoryError, DIRECTORY_SCOPE, DirectoryApi, exchangeCode, getGoogleAccessToken, GoogleError, googleErrorToHttp, idTokenClaims, MAX_USERS, refreshTokens, toEmployee } from "../_shared/google.ts";
import { b64url, decryptFromHex, deriveKeys, encryptToHex } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/auth.ts";
import { NeedsReconnect } from "../_shared/zoom.ts";

const j = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ENV = { clientId: "gcid", clientSecret: "gsec", tokenKeyB64: b64url(crypto.getRandomValues(new Uint8Array(32))), appUrl: "https://meetingbrand.com/app/", redirectUri: "https://x.supabase.co/functions/v1/mb-oauth-google/callback" };

Deno.test("authorizeUrl: offline access + forced consent + the directory scope + state", () => {
  const u = new URL(authorizeUrl(ENV, "st.ate"));
  assertEquals(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assertEquals(u.searchParams.get("client_id"), "gcid");
  assertEquals(u.searchParams.get("redirect_uri"), ENV.redirectUri);
  assertEquals(u.searchParams.get("response_type"), "code");
  assertEquals(u.searchParams.get("access_type"), "offline");
  assertEquals(u.searchParams.get("prompt"), "consent");
  assertEquals(u.searchParams.get("state"), "st.ate");
  const scopes = (u.searchParams.get("scope") ?? "").split(" ");
  assert(scopes.includes("openid") && scopes.includes("email") && scopes.includes(DIRECTORY_SCOPE));
});

Deno.test("exchangeCode / refreshTokens: form body, outcome classes", async () => {
  let last: URLSearchParams | null = null;
  const ok: typeof fetch = async (_i, init) => {
    last = new URLSearchParams(String(init?.body));
    return j(200, { access_token: "at", expires_in: 3600, refresh_token: "rt", scope: `openid email ${DIRECTORY_SCOPE}`, token_type: "Bearer" });
  };
  const r = await exchangeCode(ENV, "4/0Acode", ok);
  assert(r.ok && r.tokens.refresh_token === "rt");
  assertEquals(last!.get("grant_type"), "authorization_code");
  assertEquals(last!.get("redirect_uri"), ENV.redirectUri);
  assertEquals(last!.get("client_secret"), "gsec");
  const rr = await refreshTokens(ENV, "rt", ok);
  assert(rr.ok);
  assertEquals(last!.get("grant_type"), "refresh_token");

  const dead = await refreshTokens(ENV, "rt", async () => j(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
  assert(!dead.ok && dead.kind === "needs_reconnect");
  const mismatch = await exchangeCode(ENV, "c", async () => j(400, { error: "redirect_uri_mismatch" }));
  assert(!mismatch.ok && mismatch.kind === "failed");
  assertStringIncludes(mismatch.detail, "redirect URI");
  const ours = await exchangeCode(ENV, "c", async () => j(401, { error: "invalid_client" }));
  assert(!ours.ok && ours.kind === "failed");
  assertStringIncludes(ours.detail, "GOOGLE_CLIENT_ID");
  const down = await exchangeCode(ENV, "c", () => Promise.reject(new Error("dns")));
  assert(!down.ok && down.kind === "retry");
});

Deno.test("idTokenClaims: hd + email from an unverified id_token payload; garbage → nulls", () => {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub: "123", email: "Admin@Acme.com", hd: "Acme.com" })));
  assertEquals(idTokenClaims(`h.${payload}.s`), { email: "admin@acme.com", hd: "acme.com", sub: "123" });
  assertEquals(idTokenClaims("nope"), { email: null, hd: null, sub: null });
  assertEquals(idTokenClaims(undefined), { email: null, hd: null, sub: null });
});

function directoryPages(pageSizes: number[]) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assertEquals(new Headers(init?.headers).get("authorization"), "Bearer dir-token");
    const u = new URL(url);
    const page = Number((u.searchParams.get("pageToken") ?? "tok-0").slice(4));
    const n = pageSizes[page] ?? 0;
    const users = Array.from({ length: n }, (_, i) => ({ id: `g-${page}-${i}`, primaryEmail: `p${page}${i}@acme.com`, name: { fullName: `P ${page}-${i}` }, organizations: [{ title: "Eng", department: "R&D", primary: true }] }));
    const body: Record<string, unknown> = { users };
    if (page + 1 < pageSizes.length) body.nextPageToken = `tok-${page + 1}`;
    return j(200, body);
  };
  return { fetchImpl, calls };
}

Deno.test("DirectoryApi.listUsers: customer=my_customer, maxResults=500, isSuspended=false, projection=full; nextPageToken followed; cap 2000", async () => {
  const d = directoryPages([3, 2]);
  const api = new DirectoryApi("dir-token", { fetchImpl: d.fetchImpl });
  const r = await api.listUsers();
  assertEquals(r.users.length, 5);
  assertEquals(r.truncated, false);
  const first = new URL(d.calls[0]);
  assertEquals(first.origin + first.pathname, "https://admin.googleapis.com/admin/directory/v1/users");
  assertEquals(first.searchParams.get("customer"), "my_customer");
  assertEquals(first.searchParams.get("maxResults"), "500");
  assertEquals(first.searchParams.get("query"), "isSuspended=false");
  assertEquals(first.searchParams.get("projection"), "full");
  assertEquals(first.searchParams.get("pageToken"), null);
  assertEquals(new URL(d.calls[1]).searchParams.get("pageToken"), "tok-1");

  const big = directoryPages([500, 500, 500, 500, 500]);
  const capped = await new DirectoryApi("dir-token", { fetchImpl: big.fetchImpl }).listUsers();
  assertEquals(capped.users.length, MAX_USERS);
  assertEquals(capped.truncated, true);
  assertEquals(big.calls.length, 4, "the fifth page is never fetched");
});

Deno.test("DirectoryApi errors: 403 not-authorized → blocked (409 google_blocked); 401 → needs_reconnect; 429 → retry", async () => {
  const forbidden = new DirectoryApi("dir-token", { fetchImpl: async () => j(403, { error: { code: 403, message: "Not Authorized to access this resource/api", errors: [{ reason: "forbidden" }] } }) });
  const e = await assertRejects(() => forbidden.listUsers(), GoogleError);
  assertEquals(e.cls.kind, "blocked");
  const http = googleErrorToHttp(e);
  assertEquals(http.status, 409);
  assertEquals(http.code, "google_blocked");
  assertStringIncludes(http.detail ?? "", "Users");
  assertEquals(classifyDirectoryError(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } }, null).kind, "needs_reconnect");
  assertEquals(classifyDirectoryError(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }, "3").retryAfterMs, 3000);
  assertEquals(classifyDirectoryError(400, { error: { message: "Invalid Input: INVALID_OU_ID", errors: [{ reason: "invalid" }] } }, null).code, "not_workspace");
  assertEquals(googleErrorToHttp(new NeedsReconnect("revoked")).status, 409);
});

Deno.test("toEmployee: primary organizations[] entry wins; name fallbacks; suspended flag ignored (filtered upstream)", () => {
  assertEquals(toEmployee({ id: "1", primaryEmail: "Dana@Acme.com", name: { fullName: " Dana Levi " }, organizations: [{ title: "Old", department: "X", primary: false }, { title: "CTO", department: "R&D", primary: true }] }), {
    ext_id: "1",
    email: "dana@acme.com",
    name: "Dana Levi",
    title: "CTO",
    dept: "R&D",
  });
  assertEquals(toEmployee({ id: "2", primaryEmail: "bot@acme.com", name: { givenName: "Svc", familyName: "Bot" }, organizations: [{ title: "Ops" }] }), { ext_id: "2", email: "bot@acme.com", name: "Svc Bot", title: "Ops", dept: null });
  assertEquals(toEmployee({ id: "3", primaryEmail: "x@acme.com" }), { ext_id: "3", email: "x@acme.com", name: "x", title: null, dept: null });
  assertEquals(toEmployee({} as never), null);
});

Deno.test("getGoogleAccessToken: fresh → decrypt; stale → refresh, store access only (refresh token kept); invalid_grant → vault deleted + needs_reconnect", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const mk = (accessLeftMs: number, refreshReply: () => Response) => {
    const seen: Array<{ method: string; path: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input instanceof Request ? input : String(input), init);
      const u = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.text();
      seen.push({ method: req.method, path: u.pathname, body });
      if (u.pathname === "/rest/v1/rpc/integration_token_get") {
        return j(200, [{ refresh_token_hex: await encryptToHex(keys, "rt-OLD"), access_token_hex: await encryptToHex(keys, "at-OLD"), access_expires_at: new Date(Date.now() + accessLeftMs).toISOString(), rotated_at: null }]);
      }
      if (u.pathname.startsWith("/rest/v1/rpc/")) return new Response(null, { status: 204 });
      if (u.pathname === "/rest/v1/integrations") return new Response(null, { status: 204 });
      if (u.hostname === "oauth2.googleapis.com") return refreshReply();
      return j(599, { unrouted: u.pathname });
    };
    const sb = serviceClient({ url: "https://x.supabase.co", anonKey: "anon", serviceRoleKey: "service-key" }, fetchImpl);
    return { sb, seen, fetchImpl };
  };
  const fresh = mk(3600_000, () => j(500, {}));
  assertEquals(await getGoogleAccessToken({ sb: fresh.sb, keys, env: ENV, fetchImpl: fresh.fetchImpl }, { id: "i1" }), "at-OLD");
  assertEquals(fresh.seen.filter((s) => s.path === "/rest/v1/rpc/integration_token_set").length, 0, "no refresh while fresh");
  assertEquals(fresh.seen.filter((s) => s.path === "/token").length, 0);

  const stale = mk(60_000, () => j(200, { access_token: "at-NEW", expires_in: 3600, scope: DIRECTORY_SCOPE, token_type: "Bearer" }));
  assertEquals(await getGoogleAccessToken({ sb: stale.sb, keys, env: ENV, fetchImpl: stale.fetchImpl }, { id: "i1" }), "at-NEW");
  const refresh = stale.seen.find((s) => s.path === "/token")!;
  assertEquals(new URLSearchParams(refresh.body).get("grant_type"), "refresh_token");
  assertEquals(new URLSearchParams(refresh.body).get("refresh_token"), "rt-OLD");
  const set = stale.seen.find((s) => s.path === "/rest/v1/rpc/integration_token_set")!;
  const body = JSON.parse(set.body);
  assertEquals(body.p_refresh_hex, null, "Google refresh tokens do not rotate — the stored one is kept");
  assertEquals(await decryptFromHex(keys, body.p_access_hex), "at-NEW");
  for (const s of stale.seen.filter((s) => s.path.startsWith("/rest/"))) assert(!s.body.includes("at-NEW") && !s.body.includes("rt-OLD"), "plaintext token in the DB call");

  const dead = mk(60_000, () => j(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
  const e = await assertRejects(() => getGoogleAccessToken({ sb: dead.sb, keys, env: ENV, fetchImpl: dead.fetchImpl }, { id: "i1" }), NeedsReconnect);
  assertStringIncludes(e.detail, "invalid_grant");
  assertEquals(dead.seen.filter((s) => s.path === "/rest/v1/rpc/integration_token_delete").length, 1);
  const patch = dead.seen.find((s) => s.path === "/rest/v1/integrations" && s.method === "PATCH")!;
  assertEquals(JSON.parse(patch.body).status, "needs_reconnect");
});
