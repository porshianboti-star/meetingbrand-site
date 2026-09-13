// deno test -A tests/  — the four Edge Function handlers end-to-end against a routed fake fetch
// (GoTrue /auth/v1/user, PostgREST /rest/v1/*, Storage /storage/v1/*, zoom.us + api.zoom.us).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { b64url, decryptFromHex, deriveKeys, encryptToHex, signState } from "../_shared/crypto.ts";
import { makeHandler as oauthHandler } from "../mb-oauth-zoom/handler.ts";
import { makeHandler as syncHandler } from "../mb-sync-zoom/handler.ts";
import { makeHandler as pushHandler } from "../mb-push-zoom/handler.ts";
import { makeHandler as integrationsHandler } from "../mb-integrations/handler.ts";

// ------------------------------------------------------------------ env helpers
const SB_URL = "https://ohobtgbyrlczfdztzvqi.supabase.co";
const TOKEN_KEY = b64url(crypto.getRandomValues(new Uint8Array(32)));
const APP_URL = "https://meetingbrand.com/app/";
const NAMES = ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL", "ZOOM_REDIRECT_URI"];
function configure(all = true) {
  Deno.env.set("SUPABASE_URL", SB_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  for (const n of NAMES) Deno.env.delete(n);
  if (all) {
    Deno.env.set("ZOOM_CLIENT_ID", "zoom-cid");
    Deno.env.set("ZOOM_CLIENT_SECRET", "zoom-secret");
    Deno.env.set("MB_TOKEN_KEY", TOKEN_KEY);
    Deno.env.set("MB_APP_URL", APP_URL);
  }
}

// ------------------------------------------------------------------ fake backend
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INTEG = "33333333-3333-4333-8333-333333333333";
const BG = "44444444-4444-4444-8444-444444444444";
const ASSET = "55555555-5555-4555-8555-555555555555";
const EMP = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;

interface Seen {
  method: string;
  path: string; // pathname + search
  body: string;
  headers: Headers;
}
type Route = { method: string; test: (u: URL) => boolean; reply: (req: Request, u: URL, body: string) => Response | Promise<Response> };
const j = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function router(routes: Route[]) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    const u = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text().catch(() => "");
    seen.push({ method: req.method, path: u.pathname + u.search, body, headers: req.headers });
    const r = routes.find((r) => r.method === req.method && r.test(u));
    if (!r) return j(599, { error: "unrouted", method: req.method, path: u.pathname + u.search });
    return await r.reply(req, u, body);
  };
  return { fetchImpl, seen, calls: (method: string, path: string | RegExp) => seen.filter((s) => s.method === method && (typeof path === "string" ? s.path.startsWith(path) : path.test(s.path))) };
}

const rest = (table: string) => (u: URL) => u.pathname === `/rest/v1/${table}`;
const rpc = (name: string) => (u: URL) => u.pathname === `/rest/v1/rpc/${name}`;
const gotrueUser = (): Route => ({ method: "GET", test: (u) => u.pathname === "/auth/v1/user", reply: (req) => (req.headers.get("authorization") === "Bearer user-jwt" ? j(200, { id: USER, email: "admin@acme.com" }) : j(401, { message: "bad jwt" })) });
const profile = (role = "admin"): Route => ({ method: "GET", test: rest("profiles"), reply: () => j(200, [{ org_id: ORG, role }]) });
const integrationRow = (status = "connected"): Route => ({ method: "GET", test: rest("integrations"), reply: () => j(200, [{ id: INTEG, org_id: ORG, platform: "zoom", status, account_ext_id: "acc-1", scopes: ["a"], connected_by: USER, connected_at: null, expires_at: null, last_sync_at: null, last_error: null, updated_at: null }]) });
const patchOk = (table: string): Route => ({ method: "PATCH", test: rest(table), reply: () => new Response(null, { status: 204 }) });
const eventsOk: Route = { method: "POST", test: rest("events"), reply: () => new Response(null, { status: 201 }) };
async function vaultGetRoute(accessLeftMs = 3600_000): Promise<Route> {
  const keys = await deriveKeys(TOKEN_KEY);
  const row = { refresh_token_hex: await encryptToHex(keys, "refresh-OLD"), access_token_hex: await encryptToHex(keys, "access-OLD"), access_expires_at: new Date(Date.now() + accessLeftMs).toISOString(), rotated_at: null };
  return { method: "POST", test: rpc("integration_token_get"), reply: () => j(200, [row]) };
}

const authed = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { authorization: "Bearer user-jwt", origin: "https://meetingbrand.com", "content-type": "application/json", ...(init.headers ?? {}) } });

// ------------------------------------------------------------------ cross-cutting: CORS, 503, 405, 401
const ALL = [
  { name: "mb-oauth-zoom", mk: oauthHandler, url: `${SB_URL}/functions/v1/mb-oauth-zoom?action=start`, good: "GET", bad: "POST" },
  { name: "mb-sync-zoom", mk: syncHandler, url: `${SB_URL}/functions/v1/mb-sync-zoom`, good: "POST", bad: "GET" },
  { name: "mb-push-zoom", mk: pushHandler, url: `${SB_URL}/functions/v1/mb-push-zoom`, good: "POST", bad: "GET" },
  { name: "mb-integrations", mk: integrationsHandler, url: `${SB_URL}/functions/v1/mb-integrations`, good: "GET", bad: "DELETE" },
];

for (const fn of ALL) {
  Deno.test(`${fn.name}: CORS preflight for allowed origins only`, async () => {
    const h = fn.mk({ fetchImpl: () => Promise.reject(new Error("no network")) });
    for (const origin of ["https://meetingbrand.com", "http://localhost:8787"]) {
      const r = await h(new Request(fn.url, { method: "OPTIONS", headers: { origin } }));
      assertEquals(r.status, 204);
      assertEquals(r.headers.get("access-control-allow-origin"), origin);
      assertStringIncludes(r.headers.get("access-control-allow-headers") ?? "", "authorization");
    }
    const evil = await h(new Request(fn.url, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    assertEquals(evil.headers.get("access-control-allow-origin"), null);
  });

  Deno.test(`${fn.name}: secrets missing — unauthenticated callers still get 401 (auth runs first); a signed-in admin gets the precise 503`, async () => {
    configure(false);
    const fake = router([
      gotrueUser(), profile("admin"),
      // an empty workspace (only the Integrations read model reads these)
      { method: "GET", test: rest("integrations"), reply: () => j(200, []) },
      { method: "HEAD", test: rest("employees"), reply: () => new Response(null, { status: 200, headers: { "content-range": "*/0" } }) },
      { method: "GET", test: rest("pushes"), reply: () => j(200, []) },
    ]);
    const h = fn.mk({ fetchImpl: fake.fetchImpl });
    const noAuth = await h(new Request(fn.url, { method: fn.good, headers: { "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(noAuth.status, 401, "a missing secret must not turn an unauthenticated probe into a 503 (deployment disclosure)");
    const badJwt = await h(new Request(fn.url, { method: fn.good, headers: { authorization: "Bearer forged", "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(badJwt.status, 401);

    const r = await h(authed(fn.url, { method: fn.good }));
    assertEquals(r.headers.get("access-control-allow-origin"), "https://meetingbrand.com");
    assert(r.headers.get("x-request-id"));
    const b = await r.json();
    if (fn.name === "mb-integrations") {
      // the read model must render "not configured" instead of failing — the tab shows it before the owner registers the Zoom app
      assertEquals(r.status, 200);
      assertEquals(b.connect.zoom.configured, false);
      assertEquals(b.connect.zoom.missing, ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
      assertEquals(b.integrations.length, 4);
      assertEquals(b.integrations.find((x: { platform: string }) => x.platform === "zoom").status, "disconnected");
    } else {
      assertEquals(r.status, 503);
      assertEquals(b.error, "not_configured");
      assertEquals(b.missing, ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
    }
    assertEquals(fake.calls("POST", "/rest/v1/").length, 0, "nothing is written while unconfigured");
    for (const c of fake.seen) assert(!/zoom\.us/.test(c.path) && !c.headers.get("host")?.includes("zoom"), "no Zoom call while unconfigured");
  });

  if (fn.name !== "mb-integrations") {
    Deno.test(`${fn.name}: only ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET missing → 503 lists exactly those two`, async () => {
      configure();
      Deno.env.delete("ZOOM_CLIENT_ID");
      Deno.env.delete("ZOOM_CLIENT_SECRET");
      const fake = router([gotrueUser(), profile("admin")]);
      const r = await fn.mk({ fetchImpl: fake.fetchImpl })(authed(fn.url, { method: fn.good }));
      assertEquals(r.status, 503);
      assertEquals((await r.json()).missing, ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"]);
    });
  }

  Deno.test(`${fn.name}: 405 on the wrong method, 401 without a Bearer, 401 on a rejected JWT`, async () => {
    configure();
    const fake = router([{ method: "GET", test: (u) => u.pathname === "/auth/v1/user", reply: () => j(401, { message: "invalid JWT" }) }]);
    const h = fn.mk({ fetchImpl: fake.fetchImpl });
    assertEquals((await h(new Request(fn.url, { method: fn.bad }))).status, 405);
    const noAuth = await h(new Request(fn.url, { method: fn.good, headers: { "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(noAuth.status, 401);
    assertEquals((await noAuth.json()).error, "unauthorized");
    assertEquals(fake.seen.length, 0, "no upstream call without a token");
    const badJwt = await h(new Request(fn.url, { method: fn.good, headers: { authorization: "Bearer forged", "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(badJwt.status, 401);
    const anonAsBearer = await h(new Request(fn.url, { method: fn.good, headers: { authorization: "Bearer anon-key", "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(anonAsBearer.status, 401, "the anon key is not a user session");
  });
}

// ------------------------------------------------------------------ mb-oauth-zoom
Deno.test("oauth start: admin gets a Zoom authorize URL whose state verifies; member gets 403", async () => {
  configure();
  const fake = router([gotrueUser(), profile("admin")]);
  const r = await oauthHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-zoom?action=start`));
  assertEquals(r.status, 200);
  const b = await r.json();
  const u = new URL(b.url);
  assertEquals(u.origin + u.pathname, "https://zoom.us/oauth/authorize");
  assertEquals(u.searchParams.get("client_id"), "zoom-cid");
  assertEquals(u.searchParams.get("redirect_uri"), `${SB_URL}/functions/v1/mb-oauth-zoom/callback`, "a PATH — Zoom drops query params from redirect URLs");
  const keys = await deriveKeys(TOKEN_KEY);
  const { verifyState } = await import("../_shared/crypto.ts");
  const v = await verifyState(keys, u.searchParams.get("state")!);
  assert(v.ok && v.state.org_id === ORG && v.state.user_id === USER);
  const prof = fake.calls("GET", "/rest/v1/profiles")[0];
  assertEquals(prof.headers.get("accept-profile"), "mb", "service client is bound to schema mb");
  assertEquals(prof.headers.get("authorization"), "Bearer service-key");

  const member = router([gotrueUser(), profile("member")]);
  const r2 = await oauthHandler({ fetchImpl: member.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-zoom?action=start`));
  assertEquals(r2.status, 403);
});

Deno.test("oauth callback: denied / bad state / expired state → error redirects into the app (no JWT needed)", async () => {
  configure();
  const h = oauthHandler({ fetchImpl: () => Promise.reject(new Error("no network")) });
  // Zoom appends ?code&state (or ?error) to the registered PATH /mb-oauth-zoom/callback
  const cb = `${SB_URL}/functions/v1/mb-oauth-zoom/callback?`;
  const loc = async (u: string) => {
    const r = await h(new Request(u));
    assertEquals(r.status, 302);
    return r.headers.get("location")!;
  };
  assertEquals(await loc(`${cb}&error=access_denied`), `${APP_URL}#integrations=zoom&status=error&reason=denied`);
  assertEquals(await loc(`${cb}&code=abc`), `${APP_URL}#integrations=zoom&status=error&reason=missing_params`);
  assertEquals(await loc(`${cb}&code=abc&state=garbage`), `${APP_URL}#integrations=zoom&status=error&reason=state_malformed`);
  // legacy ?action=callback and a bare request that carries Zoom's params are accepted too
  assertEquals(await loc(`${SB_URL}/functions/v1/mb-oauth-zoom?action=callback&error=access_denied`), `${APP_URL}#integrations=zoom&status=error&reason=denied`);
  assertEquals(await loc(`${SB_URL}/functions/v1/mb-oauth-zoom?error=access_denied`), `${APP_URL}#integrations=zoom&status=error&reason=denied`);
  const keys = await deriveKeys(TOKEN_KEY);
  const old = await signState(keys, { org_id: ORG, user_id: USER, ts: Date.now() - 11 * 60_000 });
  assertEquals(await loc(`${cb}&code=abcdefgh1234&state=${encodeURIComponent(old)}`), `${APP_URL}#integrations=zoom&status=error&reason=state_expired`);
  const otherKey = await deriveKeys(b64url(crypto.getRandomValues(new Uint8Array(32))));
  const forged = await signState(otherKey, { org_id: ORG, user_id: USER });
  assertEquals(await loc(`${cb}&code=abcdefgh1234&state=${encodeURIComponent(forged)}`), `${APP_URL}#integrations=zoom&status=error&reason=state_bad_signature`);
});

Deno.test("oauth callback: needs only MB_TOKEN_KEY + MB_APP_URL (no Zoom credentials); with neither it answers 503, never 500", async () => {
  configure();
  Deno.env.delete("ZOOM_CLIENT_ID");
  Deno.env.delete("ZOOM_CLIENT_SECRET");
  const h = oauthHandler({ fetchImpl: () => Promise.reject(new Error("no network")) });
  const r = await h(new Request(`${SB_URL}/functions/v1/mb-oauth-zoom?action=callback&code=x&state=y`));
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), `${APP_URL}#integrations=zoom&status=error&reason=state_malformed`);
  configure(false);
  const r2 = await h(new Request(`${SB_URL}/functions/v1/mb-oauth-zoom?action=callback&code=x&state=y`));
  assertEquals(r2.status, 503);
  assertEquals((await r2.json()).missing, ["MB_TOKEN_KEY", "MB_APP_URL"]);
});

Deno.test("oauth callback: a valid state is NOT exchanged there — it redirects the browser to the app as status=pending with code+state (no DB, no Zoom)", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const fake = router([]);
  const r = await oauthHandler({ fetchImpl: fake.fetchImpl })(new Request(`${SB_URL}/functions/v1/mb-oauth-zoom/callback?code=the-code-1234&state=${encodeURIComponent(state)}`));
  assertEquals(r.status, 302);
  const loc = new URL(r.headers.get("location")!);
  assertEquals(loc.origin + loc.pathname, APP_URL.replace(/#.*$/, ""));
  const frag = new URLSearchParams(loc.hash.slice(1));
  assertEquals(frag.get("integrations"), "zoom");
  assertEquals(frag.get("status"), "pending");
  assertEquals(frag.get("code"), "the-code-1234");
  assertEquals(frag.get("state"), state);
  assertEquals(fake.seen.length, 0, "the unauthenticated callback must not touch Zoom or the DB");
  assertEquals(r.headers.get("referrer-policy"), "no-referrer");
});

function finishRoutes(profileRole = "admin"): Route[] {
  return [
    gotrueUser(),
    profile(profileRole),
    { method: "POST", test: (u) => u.hostname === "zoom.us" && u.pathname === "/oauth/token", reply: (req, _u, body) => {
      assertEquals(req.headers.get("authorization"), "Basic " + btoa("zoom-cid:zoom-secret"));
      const p = new URLSearchParams(body);
      assertEquals(p.get("grant_type"), "authorization_code");
      assertEquals(p.get("code"), "the-code-1234");
      assertEquals(p.get("redirect_uri"), `${SB_URL}/functions/v1/mb-oauth-zoom/callback`);
      return j(200, { access_token: "acc-1", token_type: "bearer", refresh_token: "ref-1", expires_in: 3600, scope: "user:read:list_users:admin user:write:virtual_background_files:admin" });
    } },
    { method: "GET", test: (u) => u.hostname === "api.zoom.us" && u.pathname === "/v2/users/me", reply: (req) => (req.headers.get("authorization") === "Bearer acc-1" ? j(200, { id: "zu-1", account_id: "zacc-9", email: "admin@acme.com" }) : j(401, { code: 124 })) },
    { method: "POST", test: rest("integrations"), reply: () => j(201, { id: INTEG }) },
    { method: "POST", test: rpc("integration_token_set"), reply: () => new Response(null, { status: 204 }) },
    eventsOk,
  ];
}
const finishReq = (code: string, state: string) => authed(`${SB_URL}/functions/v1/mb-oauth-zoom?action=finish`, { method: "POST", body: JSON.stringify({ code, state }) });

Deno.test("oauth finish: the session that started the flow exchanges the code, upserts mb.integrations, stores encrypted tokens", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const fake = router(finishRoutes());
  const t0 = Date.now();
  const r = await oauthHandler({ fetchImpl: fake.fetchImpl, now: () => t0 })(finishReq("the-code-1234", state));
  const rText = await r.text();
  assertEquals(r.status, 200, rText);
  const b = JSON.parse(rText);
  assertEquals(b.status, "connected");
  assertEquals(b.account_ext_id, "zacc-9");

  const up = fake.calls("POST", "/rest/v1/integrations")[0];
  assertStringIncludes(up.path, "on_conflict=org_id%2Cplatform");
  assertStringIncludes(up.headers.get("prefer") ?? "", "merge-duplicates");
  const row = JSON.parse(up.body);
  assertEquals(row.org_id, ORG, "bound to the CALLER's org (from profiles), which must equal the state's");
  assertEquals(row.status, "connected");
  assertEquals(row.account_ext_id, "zacc-9");
  assertEquals(row.connected_by, USER);
  assertEquals(row.scopes, ["user:read:list_users:admin", "user:write:virtual_background_files:admin"]);
  assertEquals(row.expires_at, new Date(t0 + 90 * 86400_000).toISOString(), "refresh token lifetime = 90 days");

  const set = JSON.parse(fake.calls("POST", "/rest/v1/rpc/integration_token_set")[0].body);
  assertEquals(set.p_integration_id, INTEG);
  assertEquals(await decryptFromHex(keys, set.p_refresh_hex), "ref-1");
  assertEquals(await decryptFromHex(keys, set.p_access_hex), "acc-1");
  assertEquals(set.p_access_expires_at, new Date(t0 + 3600_000).toISOString());
  // plaintext tokens never travel to our DB, and never come back to the browser
  for (const s of fake.seen.filter((s) => s.path.startsWith("/rest/"))) {
    assert(!s.body.includes("ref-1") && !s.body.includes("acc-1"), `plaintext token in ${s.path}`);
  }
  assert(!rText.includes("ref-1") && !rText.includes("acc-1"));
});

Deno.test("oauth finish: login-CSRF — a state minted by another user/org is refused before the code is exchanged", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const attacker = "99999999-9999-4999-8999-999999999999";
  const otherOrg = "88888888-8888-4888-8888-888888888888";
  for (const st of [{ org_id: otherOrg, user_id: attacker }, { org_id: ORG, user_id: attacker }, { org_id: otherOrg, user_id: USER }]) {
    const state = await signState(keys, st);
    const fake = router(finishRoutes("admin"));
    const r = await oauthHandler({ fetchImpl: fake.fetchImpl })(finishReq("the-code-1234", state));
    assertEquals(r.status, 403, JSON.stringify(st));
    assertEquals((await r.json()).error, "state_mismatch");
    assertEquals(fake.calls("POST", /oauth\/token/).length, 0, "code is never exchanged");
    assertEquals(fake.calls("POST", "/rest/v1/integrations").length, 0, "nothing is bound");
  }
});

Deno.test("oauth finish: bad / expired / forged state → 400 state_*; missing fields → 400; no exchange", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const h = (routes: Route[]) => oauthHandler({ fetchImpl: router(routes).fetchImpl });
  const code = async (state: string) => (await (await h(finishRoutes())(finishReq("the-code-1234", state))).json()).error;
  assertEquals(await code("garbage"), "bad_request");
  assertEquals(await code(await signState(keys, { org_id: ORG, user_id: USER, ts: Date.now() - 11 * 60_000 })), "state_expired");
  const otherKey = await deriveKeys(b64url(crypto.getRandomValues(new Uint8Array(32))));
  assertEquals(await code(await signState(otherKey, { org_id: ORG, user_id: USER })), "state_bad_signature");
  const fake = router(finishRoutes());
  const r = await oauthHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-zoom?action=finish`, { method: "POST", body: "{}" }));
  assertEquals(r.status, 400);
  assertEquals(fake.calls("POST", /oauth\/token/).length, 0);
  // finish is POST only; callback and start are GET only
  assertEquals((await oauthHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-zoom?action=finish`))).status, 405);
  assertEquals((await oauthHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-zoom?action=callback`, { method: "POST" }))).status, 405);
});

Deno.test("oauth finish: a user who lost admin since `start` is refused", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const fake = router(finishRoutes("member"));
  const r = await oauthHandler({ fetchImpl: fake.fetchImpl })(finishReq("the-code-1234", state));
  assertEquals(r.status, 403);
  assertEquals(fake.calls("POST", /oauth\/token/).length, 0, "code is never exchanged");
});

// ------------------------------------------------------------------ mb-sync-zoom
Deno.test("sync: pulls all pages + titles, upserts mb.employees on (org,platform,ext_id), reports imported/updated/stale", async () => {
  configure();
  const fake = router([
    gotrueUser(),
    profile("admin"),
    integrationRow("connected"),
    await vaultGetRoute(),
    { method: "GET", test: (u) => u.pathname === "/v2/users", reply: (_r, u) => (u.searchParams.get("next_page_token") ? j(200, { users: [{ id: "z3", email: "C@acme.com", first_name: "Cy" }] }) : j(200, { users: [{ id: "z1", email: "a@acme.com", display_name: "Ann" }, { id: "z2", email: "b@acme.com", first_name: "Bo", last_name: "Li" }], next_page_token: "p2" })) },
    { method: "GET", test: (u) => /^\/v2\/users\/z\d$/.test(u.pathname), reply: (_r, u) => j(200, { id: u.pathname.split("/").pop(), job_title: "Eng", dept: "R&D" }) },
    { method: "GET", test: rest("employees"), reply: () => j(200, [{ ext_id: "z1" }, { ext_id: "gone" }]) },
    { method: "POST", test: rest("employees"), reply: () => new Response(null, { status: 201 }) },
    patchOk("integrations"),
    eventsOk,
  ]);
  const r = await syncHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-zoom`, { method: "POST", body: "{}" }));
  const rText = await r.text();
  assertEquals(r.status, 200, rText);
  const b = JSON.parse(rText);
  assertEquals({ imported: b.imported, updated: b.updated, total: b.total, stale: b.stale }, { imported: 2, updated: 1, total: 3, stale: 1 });
  const up = fake.calls("POST", "/rest/v1/employees")[0];
  assertStringIncludes(up.path, "on_conflict=org_id%2Cplatform%2Cext_id");
  const rows = JSON.parse(up.body);
  assertEquals(rows.length, 3);
  assertEquals(rows[0], { org_id: ORG, platform: "zoom", ext_id: "z1", email: "a@acme.com", name: "Ann", title: "Eng", dept: "R&D", synced_at: rows[0].synced_at });
  assertEquals(rows[2].email, "c@acme.com", "emails normalised to lower case");
  assertEquals(rows[1].name, "Bo Li");
  const last = JSON.parse(fake.calls("PATCH", "/rest/v1/integrations").at(-1)!.body);
  assertEquals(last.last_sync_at, b.synced_at);
  assertEquals(last.last_error, null);
});

Deno.test("sync: 409 not_connected / needs_reconnect before touching Zoom", async () => {
  configure();
  for (const [status, code] of [["disconnected", "not_connected"], ["needs_reconnect", "needs_reconnect"]] as const) {
    const fake = router([gotrueUser(), profile("admin"), integrationRow(status)]);
    const r = await syncHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-zoom`, { method: "POST" }));
    assertEquals(r.status, 409);
    assertEquals((await r.json()).error, code);
    assertEquals(fake.calls("GET", "/v2/").length, 0);
  }
  const none = router([gotrueUser(), profile("admin"), { method: "GET", test: rest("integrations"), reply: () => j(200, []) }]);
  assertEquals((await syncHandler({ fetchImpl: none.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-zoom`, { method: "POST" }))).status, 409);
});

Deno.test("sync: a dead refresh token flips the row to needs_reconnect and answers 409", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const enc = { refresh_token_hex: await encryptToHex(keys, "refresh-OLD"), access_token_hex: await encryptToHex(keys, "access-OLD"), access_expires_at: new Date().toISOString(), rotated_at: null };
  const fake2 = router([
    gotrueUser(), profile("admin"), integrationRow("connected"),
    { method: "POST", test: rpc("integration_token_get"), reply: () => j(200, [enc]) },
    { method: "POST", test: rpc("integration_token_begin_refresh"), reply: () => j(200, [{ acquired: true, row_exists: true, ...enc }]) },
    { method: "POST", test: (u) => u.hostname === "zoom.us" && u.pathname === "/oauth/token", reply: () => j(400, { error: "invalid_grant", reason: "Invalid Token!" }) },
    { method: "POST", test: rpc("integration_token_delete"), reply: () => new Response(null, { status: 204 }) },
    patchOk("integrations"),
  ]);
  const r = await syncHandler({ fetchImpl: fake2.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-zoom`, { method: "POST" }));
  const rText = await r.text();
  assertEquals(r.status, 409, rText);
  assertEquals(JSON.parse(rText).error, "needs_reconnect");
  assertEquals(fake2.calls("POST", "/rest/v1/rpc/integration_token_delete").length, 1);
  const patches = fake2.calls("PATCH", "/rest/v1/integrations").map((c) => JSON.parse(c.body));
  assert(patches.some((p) => p.status === "needs_reconnect"), JSON.stringify(patches));
});

// ------------------------------------------------------------------ mb-push-zoom
Deno.test("push: validation — bad ids 400, >50 employees 400 too_many", async () => {
  configure();
  const fake = router([gotrueUser(), profile("admin")]);
  const h = pushHandler({ fetchImpl: fake.fetchImpl });
  const url = `${SB_URL}/functions/v1/mb-push-zoom`;
  assertEquals((await h(authed(url, { method: "POST", body: JSON.stringify({ background_id: "nope", employee_ids: [EMP(1)] }) }))).status, 400);
  assertEquals((await h(authed(url, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [] }) }))).status, 400);
  assertEquals((await h(authed(url, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [EMP(1), EMP(1)] }) }))).status, 400);
  assertEquals((await h(authed(url, { method: "POST", body: "{not json" }))).status, 400);
  const many = await h(authed(url, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: Array.from({ length: 51 }, (_, i) => EMP(i)) }) }));
  assertEquals(many.status, 400);
  assertEquals((await many.json()).error, "too_many");
});

Deno.test("push: downloads the export once, preflights once, pushes sequentially with 200 ms spacing; maps pushed / retry / blocked(+free old files) / unknown", async () => {
  configure();
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const uploads: string[] = [];
  const pushPatches: Array<{ id: string; body: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  let pushRowSeq = 0;
  const fake = router([
    gotrueUser(), profile("admin"), integrationRow("connected"), await vaultGetRoute(), eventsOk,
    { method: "GET", test: rest("backgrounds"), reply: (_r, u) => { assertStringIncludes(u.search, `org_id=eq.${ORG}`); return j(200, [{ id: BG, label: "Office Blue", slug: "abc123", export_asset_id: ASSET }]); } },
    { method: "GET", test: rest("brand_assets"), reply: () => j(200, [{ id: ASSET, bucket: "mb-exports", storage_path: `${ORG}/export/deadbeef.png`, mime: "image/png", bytes: png.length, sha256: "deadbeef" }]) },
    { method: "GET", test: (u) => u.pathname === `/storage/v1/object/mb-exports/${ORG}/export/deadbeef.png`, reply: () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }) },
    { method: "GET", test: rest("employees"), reply: () => j(200, [{ id: EMP(1), ext_id: "z1", email: "a@acme.com", name: "Ann", active: true }, { id: EMP(2), ext_id: "z2", email: "b@acme.com", name: "Bo", active: true }, { id: EMP(3), ext_id: "z3", email: "c@acme.com", name: "Cy", active: true }]) },
    { method: "GET", test: (u) => u.pathname === "/v2/accounts/me/settings", reply: () => j(200, { in_meeting: { virtual_background: true } }) },
    { method: "GET", test: rest("pushes"), reply: (_r, u) => {
      if (u.search.includes("idempotency_key=eq.")) return j(200, []); // nothing pushed before
      if (u.search.includes("remote_file_id=not.is.null")) return j(200, [{ id: "push-old", remote_file_id: "old-file-7" }]); // our earlier file for z3
      return j(200, []);
    } },
    { method: "POST", test: rest("pushes"), reply: () => j(201, { id: `push-${++pushRowSeq}` }) },
    { method: "PATCH", test: rest("pushes"), reply: (_r, u, body) => { const q = decodeURIComponent(u.search); pushPatches.push({ id: /id=eq\.([^&]+)/.exec(q)?.[1] ?? /id=in\.\(([^)]+)\)/.exec(q)?.[1] ?? "?", body: JSON.parse(body) }); return new Response(null, { status: 204 }); } },
    { method: "POST", test: (u) => /^\/v2\/users\/z\d\/settings\/virtual_backgrounds$/.test(u.pathname), reply: async (req, u) => {
      const who = u.pathname.split("/")[3];
      uploads.push(who);
      const form = await req.formData();
      const f = form.get("file") as File;
      assertEquals(f.name, "MeetingBrand - Office Blue.png");
      assertEquals(f.size, png.length);
      if (who === "z2") return j(429, { code: 429, message: "Too many requests" }, { "retry-after": "1" });
      if (who === "z3" && uploads.filter((x) => x === "z3").length === 1) return j(400, { code: 300, message: "You have reached the maximum number of virtual background files." });
      return j(201, { id: `file-${who}`, name: f.name, size: f.size, type: "image/png", is_default: false });
    } },
    { method: "DELETE", test: (u) => u.pathname === "/v2/users/z3/settings/virtual_backgrounds", reply: (_r, u) => { assertEquals(u.searchParams.get("file_ids"), "old-file-7"); return new Response(null, { status: 204 }); } },
  ]);
  const r = await pushHandler({ fetchImpl: fake.fetchImpl, sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); } })(
    authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [EMP(1), EMP(2), EMP(3), EMP(9)] }) }),
  );
  const rText = await r.text();
  assertEquals(r.status, 200, rText);
  const b = JSON.parse(rText);
  assertEquals(b.counts, { pushed: 2, already_pushed: 0, in_progress: 0, blocked: 0, failed: 0, retry: 1, needs_reconnect: 0, unknown_employee: 1 });
  assertEquals(b.results.map((x: { employee_id: string; outcome: string }) => [x.employee_id, x.outcome]), [[EMP(1), "pushed"], [EMP(2), "retry"], [EMP(3), "pushed"], [EMP(9), "unknown_employee"]]);
  assertEquals(b.results[0].remote_file_id, "file-z1");
  assertEquals(b.results[0].state, "awaiting_client");
  assertEquals(b.results[2].freed_files, 1);
  assertEquals(b.preflight.enabled, true);
  assertEquals(b.file, { name: "MeetingBrand - Office Blue.png", bytes: png.length, mime: "image/png" });
  assertStringIncludes(b.next_step, "picks");

  assertEquals(fake.calls("GET", "/storage/v1/object/").length, 1, "export downloaded once");
  assertEquals(fake.calls("GET", "/v2/accounts/").length, 1, "preflight once");
  assertEquals(fake.calls("GET", "/v2/accounts/")[0].path, "/v2/accounts/me/settings", "`me`, never our own account id (404 code 2001 unless master account)");
  assertEquals(uploads, ["z1", "z2", "z2", "z3", "z3"], "sequential; z2 re-sent once after 429; z3 retried after freeing space");
  assertEquals(sleeps.filter((s) => s === 200).length, 3, "200 ms after every Zoom call that has another id behind it (none after the last)");
  assertEquals(sleeps.filter((s) => s === 1000).length, 2, "429 Retry-After honoured: once inside the re-send, once before the next employee");
  const states = pushPatches.map((p) => [p.id, p.body.state]);
  assertEquals(states, [["push-1", "awaiting_client"], ["push-2", "queued"], ["push-old", "failed"], ["push-3", "awaiting_client"]]);
  assertEquals(pushPatches[0].body.remote_file_id, "file-z1");
  assertEquals((pushPatches[0].body.evidence as { sha256: string }).sha256, "deadbeef");
  assertStringIncludes(String(pushPatches[1].body.error), "429");
  const inserts = fake.calls("POST", "/rest/v1/pushes").map((c) => JSON.parse(c.body));
  assertEquals(inserts.map((i) => i.idempotency_key), [`${ORG}:${EMP(1)}:${BG}`, `${ORG}:${EMP(2)}:${BG}`, `${ORG}:${EMP(3)}:${BG}`]);
  assert(inserts.every((i) => i.state === "pushing" && i.platform === "zoom" && i.attempts === 1));
  for (const s of fake.seen) assert(!s.body.includes("access-OLD"), "access token never written anywhere");
});

Deno.test("push: idempotent — an already delivered pair is skipped without calling Zoom; disabled account → blocked rows", async () => {
  configure();
  const base = async (): Promise<Route[]> => [
    gotrueUser(), profile("admin"), integrationRow("connected"), await vaultGetRoute(), eventsOk,
    { method: "GET", test: rest("backgrounds"), reply: () => j(200, [{ id: BG, label: "L", slug: "s", export_asset_id: ASSET }]) },
    { method: "GET", test: rest("brand_assets"), reply: () => j(200, [{ id: ASSET, bucket: "mb-exports", storage_path: `${ORG}/export/x.jpg`, mime: null, bytes: 3, sha256: null }]) },
    { method: "GET", test: (u) => u.pathname.startsWith("/storage/v1/object/mb-exports/"), reply: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }) },
    { method: "GET", test: rest("employees"), reply: () => j(200, [{ id: EMP(1), ext_id: "z1", email: null, name: null, active: true }]) },
  ];
  const done = router([...(await base()),
    { method: "GET", test: (u) => u.pathname === "/v2/accounts/me/settings", reply: () => j(200, { in_meeting: { virtual_background: true } }) },
    { method: "GET", test: rest("pushes"), reply: () => j(200, [{ id: "push-9", state: "awaiting_client", attempts: 1, remote_file_id: "file-9", updated_at: new Date().toISOString() }]) },
  ]);
  const r1 = await pushHandler({ fetchImpl: done.fetchImpl, sleepImpl: () => Promise.resolve() })(authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [EMP(1)] }) }));
  const r1Text = await r1.text();
  assertEquals(r1.status, 200, r1Text);
  assertEquals(JSON.parse(r1Text).results[0].outcome, "already_pushed");
  assertEquals(done.calls("POST", /virtual_backgrounds/).length, 0);

  const off = router([...(await base()),
    { method: "GET", test: (u) => u.pathname === "/v2/accounts/me/settings", reply: () => j(200, { in_meeting: { virtual_background: false } }) },
    { method: "GET", test: rest("pushes"), reply: () => j(200, []) },
    { method: "POST", test: rest("pushes"), reply: () => new Response(null, { status: 201 }) },
  ]);
  const r2 = await pushHandler({ fetchImpl: off.fetchImpl, sleepImpl: () => Promise.resolve() })(authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [EMP(1)] }) }));
  const b2 = await r2.json();
  assertEquals(b2.results[0].outcome, "blocked");
  assertEquals(b2.preflight.enabled, false);
  assertEquals(JSON.parse(off.calls("POST", "/rest/v1/pushes")[0].body).state, "blocked");
  assertEquals(off.calls("POST", /virtual_backgrounds/).length, 0);
});

Deno.test("push: a Zoom DAILY rate limit stops the loop — one upload attempt, the rest queued without calling Zoom", async () => {
  configure();
  const png = new Uint8Array([137, 80, 78, 71]);
  const uploads: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  let seq = 0;
  const fake = router([
    gotrueUser(), profile("admin"), integrationRow("connected"), await vaultGetRoute(), eventsOk,
    { method: "GET", test: rest("backgrounds"), reply: () => j(200, [{ id: BG, label: "Office Blue", slug: "abc123", export_asset_id: ASSET }]) },
    { method: "GET", test: rest("brand_assets"), reply: () => j(200, [{ id: ASSET, bucket: "mb-exports", storage_path: `${ORG}/export/x.png`, mime: "image/png", bytes: png.length, sha256: "x" }]) },
    { method: "GET", test: (u) => u.pathname.startsWith("/storage/v1/object/mb-exports/"), reply: () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }) },
    { method: "GET", test: rest("employees"), reply: () => j(200, [1, 2, 3].map((n) => ({ id: EMP(n), ext_id: `z${n}`, email: null, name: null, active: true }))) },
    { method: "GET", test: (u) => u.pathname === "/v2/accounts/me/settings", reply: () => j(200, { in_meeting: { virtual_background: true } }) },
    { method: "GET", test: rest("pushes"), reply: () => j(200, []) },
    { method: "POST", test: rest("pushes"), reply: (_r, _u, body) => { upserts.push(JSON.parse(body)); return j(201, { id: `push-${++seq}` }); } },
    patchOk("pushes"), patchOk("integrations"),
    { method: "POST", test: (u) => /\/settings\/virtual_backgrounds$/.test(u.pathname), reply: (_r, u) => {
      uploads.push(u.pathname.split("/")[3]);
      return j(429, { code: 429, message: "You have reached the maximum daily rate limit for this API." }, { "x-ratelimit-type": "Daily-limit", "x-ratelimit-category": "Medium", "retry-after": "2026-09-14T00:00:00Z" });
    } },
  ]);
  const sleeps: number[] = [];
  const r = await pushHandler({ fetchImpl: fake.fetchImpl, sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); } })(
    authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [EMP(1), EMP(2), EMP(3)] }) }),
  );
  const b = JSON.parse(await r.text());
  assertEquals(r.status, 200);
  assertEquals(uploads, ["z1"], "exactly one attempt: a daily 429 is never re-sent and stops the loop");
  assertEquals(b.results.map((x: { outcome: string; state: string }) => [x.outcome, x.state]), [["retry", "queued"], ["retry", "queued"], ["retry", "queued"]]);
  assertStringIncludes(b.results[0].error, "2026-09-14T00:00:00.000Z");
  assertStringIncludes(b.results[1].error, "daily rate limit");
  assertEquals(upserts.map((u) => u.state), ["pushing", "queued", "queued"], "z2/z3 get a queued row so the tab shows them");
  assertEquals(sleeps.filter((ms) => ms >= 1000).length, 0, "no in-request waiting for a limit that resets at midnight UTC");
});

Deno.test("push: 404 for a foreign background, 409 when it has no export", async () => {
  configure();
  const mk = (bgRows: unknown[]) => router([gotrueUser(), profile("admin"), integrationRow("connected"), { method: "GET", test: rest("backgrounds"), reply: () => j(200, bgRows) }]);
  const body = JSON.stringify({ background_id: BG, employee_ids: [EMP(1)] });
  const r404 = await pushHandler({ fetchImpl: mk([]).fetchImpl })(authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body }));
  assertEquals(r404.status, 404);
  const r409 = await pushHandler({ fetchImpl: mk([{ id: BG, label: "x", slug: "s", export_asset_id: null }]).fetchImpl })(authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body }));
  assertEquals(r409.status, 409);
  assertEquals((await r409.json()).error, "no_export");
});

Deno.test("push: an export row whose storage_path escapes the org folder is refused before any download (path traversal via '..')", async () => {
  configure();
  const OTHER = "77777777-7777-4777-8777-777777777777";
  const bad = [`${ORG}/../${OTHER}/export/x.png`, `${ORG}/export/../../${OTHER}/export/x.png`, `${ORG}//export/x.png`, `${ORG}/export/x.png?y=1`, `${ORG}/export/x.png#f`, `${ORG}/export/%2e%2e/x.png`, `${OTHER}/export/x.png`, `${ORG}`];
  for (const storage_path of bad) {
    const fake = router([
      gotrueUser(), profile("admin"), integrationRow("connected"),
      { method: "GET", test: rest("backgrounds"), reply: () => j(200, [{ id: BG, label: "L", slug: "s", export_asset_id: ASSET }]) },
      { method: "GET", test: rest("brand_assets"), reply: () => j(200, [{ id: ASSET, bucket: "mb-exports", storage_path, mime: "image/png", bytes: 3, sha256: null }]) },
      { method: "GET", test: (u) => u.pathname.startsWith("/storage/v1/"), reply: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }) },
    ]);
    const r = await pushHandler({ fetchImpl: fake.fetchImpl, sleepImpl: () => Promise.resolve() })(authed(`${SB_URL}/functions/v1/mb-push-zoom`, { method: "POST", body: JSON.stringify({ background_id: BG, employee_ids: [EMP(1)] }) }));
    assertEquals(r.status, 409, storage_path);
    assertEquals((await r.json()).error, "bad_export_path", storage_path);
    assertEquals(fake.calls("GET", "/storage/v1/").length, 0, `no download for ${storage_path}`);
  }
});

// ------------------------------------------------------------------ mb-integrations
Deno.test("integrations GET: every platform row with counts; member may read", async () => {
  configure();
  const fake = router([
    gotrueUser(), profile("member"), integrationRow("connected"),
    { method: "HEAD", test: rest("employees"), reply: (_r, u) => new Response(null, { status: 200, headers: { "content-range": u.search.includes("active=eq.true") ? "*/2" : "*/5" } }) },
    { method: "HEAD", test: rest("pushes"), reply: (_r, u) => new Response(null, { status: 200, headers: { "content-range": u.search.includes("state=eq.awaiting_client") ? "*/3" : "*/0" } }) },
    { method: "GET", test: rest("pushes"), reply: () => j(200, [{ id: "p1", employee_id: EMP(1), background_id: BG, platform: "zoom", state: "awaiting_client", error: null, remote_file_id: "f", attempts: 1, updated_at: "2026-09-10T00:00:00Z", created_at: "2026-09-10T00:00:00Z" }]) },
  ]);
  const r = await integrationsHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`));
  const rText = await r.text();
  assertEquals(r.status, 200, rText);
  const b = JSON.parse(rText);
  assertEquals(b.org_id, ORG);
  assertEquals(b.role, "member");
  assertEquals(b.connect.zoom.start_url, `${SB_URL}/functions/v1/mb-oauth-zoom?action=start`);
  assertEquals(b.integrations.map((i: { platform: string; status: string }) => [i.platform, i.status]), [["zoom", "connected"], ["teams", "disconnected"], ["meet", "disconnected"], ["zoho", "disconnected"]]);
  assertEquals(b.integrations[0].employees, { total: 5, active: 2 });
  assertEquals(b.integrations[0].pushes.by_state, { awaiting_client: 3 });
  assertEquals(b.integrations[0].available, true);
  assertEquals(b.integrations[1].available, false);
  assertEquals(b.last_pushes.length, 1);
});

Deno.test("integrations POST disconnect: revokes at Zoom, deletes the vault row, marks disconnected; member 403; purge deletes rows", async () => {
  configure();
  const mk = async () => router([
    gotrueUser(), profile("admin"), integrationRow("connected"), await vaultGetRoute(), eventsOk,
    { method: "POST", test: (u) => u.hostname === "zoom.us" && u.pathname === "/oauth/revoke", reply: (req, u) => { assertEquals(u.searchParams.get("token"), "access-OLD"); assertEquals(req.headers.get("authorization"), "Basic " + btoa("zoom-cid:zoom-secret")); return j(200, { status: "success" }); } },
    { method: "POST", test: rpc("integration_token_delete"), reply: () => new Response(null, { status: 204 }) },
    patchOk("integrations"),
    { method: "DELETE", test: rest("pushes"), reply: () => new Response(null, { status: 204, headers: { "content-range": "*/4" } }) },
    { method: "DELETE", test: rest("employees"), reply: () => new Response(null, { status: 204, headers: { "content-range": "*/7" } }) },
  ]);
  const fake = await mk();
  const r = await integrationsHandler({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "zoom", action: "disconnect" }) }));
  const rText = await r.text();
  assertEquals(r.status, 200, rText);
  assertEquals(JSON.parse(rText), { platform: "zoom", status: "disconnected", revoked: true, purged: { employees: 0, pushes: 0 } });
  assertEquals(fake.calls("POST", "/rest/v1/rpc/integration_token_delete").length, 1);
  assertEquals(JSON.parse(fake.calls("PATCH", "/rest/v1/integrations")[0].body).status, "disconnected");
  assertEquals(fake.calls("DELETE", "/rest/v1/").length, 0);

  const purge = await mk();
  const r2 = await integrationsHandler({ fetchImpl: purge.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "zoom", action: "disconnect", purge: true }) }));
  assertEquals((await r2.json()).purged, { employees: 7, pushes: 4 });

  const member = router([gotrueUser(), profile("member")]);
  assertEquals((await integrationsHandler({ fetchImpl: member.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "zoom", action: "disconnect" }) }))).status, 403);
  const teams = router([gotrueUser(), profile("admin")]);
  assertEquals((await integrationsHandler({ fetchImpl: teams.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "teams", action: "disconnect" }) }))).status, 501);
  const bad = router([gotrueUser(), profile("admin")]);
  assertEquals((await integrationsHandler({ fetchImpl: bad.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "slack", action: "disconnect" }) }))).status, 400);
});
