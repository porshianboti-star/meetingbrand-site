// deno test -A tests/  — the Teams (Graph) and Meet (Admin SDK) connectors, the 3-platform read model and the export pack,
// end-to-end against a routed fake fetch (GoTrue, PostgREST, Storage, login.microsoftonline.com, graph, accounts.google.com, admin.googleapis.com).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { b64url, decryptFromHex, deriveKeys, encryptToHex, signState, verifyState } from "../_shared/crypto.ts";
import { DELIVERY } from "../_shared/platform.ts";
import { makeHandler as oauthMs } from "../mb-oauth-ms/handler.ts";
import { makeHandler as syncMs } from "../mb-sync-ms/handler.ts";
import { makeHandler as oauthGoogle } from "../mb-oauth-google/handler.ts";
import { makeHandler as syncGoogle } from "../mb-sync-google/handler.ts";
import { makeHandler as exportPack } from "../mb-export-pack/handler.ts";
import { makeHandler as integrations } from "../mb-integrations/handler.ts";
import { APP_URL, ASSET, authed, BG, configure, EMP, eventsOk, gotrueUser, headCount, INTEG, integrationRow, j, JPG, ORG, patchOk, profile, rest, router, rpc, SB_URL, TENANT, THUMB, TOKEN_KEY, USER, type Route } from "./_fake.ts";

// ------------------------------------------------------------------ cross-cutting: CORS, auth-before-config, 405
const FNS = [
  { name: "mb-oauth-ms", mk: oauthMs, url: `${SB_URL}/functions/v1/mb-oauth-ms?action=start`, good: "GET", bad: "DELETE", missing: ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"] },
  { name: "mb-sync-ms", mk: syncMs, url: `${SB_URL}/functions/v1/mb-sync-ms`, good: "POST", bad: "GET", missing: ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"] },
  { name: "mb-oauth-google", mk: oauthGoogle, url: `${SB_URL}/functions/v1/mb-oauth-google?action=start`, good: "GET", bad: "DELETE", missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"] },
  { name: "mb-sync-google", mk: syncGoogle, url: `${SB_URL}/functions/v1/mb-sync-google`, good: "POST", bad: "GET", missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"] },
  { name: "mb-export-pack", mk: exportPack, url: `${SB_URL}/functions/v1/mb-export-pack`, good: "POST", bad: "GET", missing: [] },
];

for (const fn of FNS) {
  Deno.test(`${fn.name}: CORS preflight for allowed origins only; 405 on the wrong method`, async () => {
    const h = fn.mk({ fetchImpl: () => Promise.reject(new Error("no network")) });
    for (const origin of ["https://meetingbrand.com", "http://localhost:8787"]) {
      const r = await h(new Request(fn.url, { method: "OPTIONS", headers: { origin } }));
      assertEquals(r.status, 204);
      assertEquals(r.headers.get("access-control-allow-origin"), origin);
    }
    const evil = await h(new Request(fn.url, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    assertEquals(evil.headers.get("access-control-allow-origin"), null);
    configure();
    assertEquals((await h(new Request(fn.url, { method: fn.bad }))).status, 405);
  });

  Deno.test(`${fn.name}: secrets missing — unauthenticated callers still get 401 (auth runs first); a signed-in admin gets the precise 503`, async () => {
    configure({ app: false });
    const fake = router([gotrueUser(), profile("admin")]);
    const h = fn.mk({ fetchImpl: fake.fetchImpl });
    const noAuth = await h(new Request(fn.url, { method: fn.good, headers: { "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(noAuth.status, 401, "a missing secret must not turn an unauthenticated probe into a 503");
    assertEquals(fake.seen.length, 0, "no upstream call without a token");
    const badJwt = await h(new Request(fn.url, { method: fn.good, headers: { authorization: "Bearer forged", "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(badJwt.status, 401);
    const anon = await h(new Request(fn.url, { method: fn.good, headers: { authorization: "Bearer anon-key", "content-type": "application/json" }, body: fn.good === "POST" ? "{}" : undefined }));
    assertEquals(anon.status, 401, "the anon key is not a user session");

    const r = await h(authed(fn.url, { method: fn.good, body: fn.good === "POST" ? "{}" : undefined }));
    assert(r.headers.get("x-request-id"));
    const b = await r.json();
    if (fn.missing.length) {
      assertEquals(r.status, 503, JSON.stringify(b));
      assertEquals(b.error, "not_configured");
      assertEquals(b.missing, fn.missing);
      assertStringIncludes(b.detail, `supabase secrets set ${fn.missing[0]}=…`);
    } else {
      assertEquals(r.status, 400, "export-pack needs no platform secret: an empty body is a 400, not a 503");
    }
    assertEquals(fake.calls("POST", "/rest/v1/").length, 0, "nothing is written while unconfigured");
    for (const c of fake.seen) assert(!/microsoft|google/.test(c.url.hostname), "no platform call while unconfigured");
    const member = router([gotrueUser(), profile("member")]);
    assertEquals((await fn.mk({ fetchImpl: member.fetchImpl })(authed(fn.url, { method: fn.good, body: fn.good === "POST" ? "{}" : undefined }))).status, 403, "members cannot connect / sync / pack");
  });

  if (fn.missing.length) {
    Deno.test(`${fn.name}: only the platform's client id/secret missing → 503 lists exactly those two`, async () => {
      configure({ zoom: true, ms: !fn.name.includes("ms"), google: !fn.name.includes("google") });
      const fake = router([gotrueUser(), profile("admin")]);
      const r = await fn.mk({ fetchImpl: fake.fetchImpl })(authed(fn.url, { method: fn.good, body: fn.good === "POST" ? "{}" : undefined }));
      assertEquals(r.status, 503);
      assertEquals((await r.json()).missing, fn.missing.slice(0, 2));
    });
  }
}

// ------------------------------------------------------------------ mb-oauth-ms
Deno.test("oauth-ms start: admin gets the /common/adminconsent URL with a verifiable state and the PATH redirect", async () => {
  configure();
  const fake = router([gotrueUser(), profile("admin")]);
  const r = await oauthMs({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-ms?action=start`));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.platform, "teams");
  const u = new URL(b.url);
  assertEquals(u.origin + u.pathname, "https://login.microsoftonline.com/common/adminconsent");
  assertEquals(u.searchParams.get("client_id"), "ms-cid");
  assertEquals(u.searchParams.get("redirect_uri"), `${SB_URL}/functions/v1/mb-oauth-ms/callback`);
  assertEquals(b.redirect_uri, `${SB_URL}/functions/v1/mb-oauth-ms/callback`);
  assertEquals(b.finish_url, `${SB_URL}/functions/v1/mb-oauth-ms?action=finish`);
  assertEquals(b.scopes, ["User.Read.All"]);
  const v = await verifyState(await deriveKeys(TOKEN_KEY), u.searchParams.get("state")!);
  assert(v.ok && v.state.org_id === ORG && v.state.user_id === USER);
});

Deno.test("oauth-ms callback: tenant+state+admin_consent=True → pending redirect with tenant+state; denied / missing / consent=False / expired / forged → error reasons; no DB, no Microsoft", async () => {
  configure();
  const fake = router([]);
  const h = oauthMs({ fetchImpl: fake.fetchImpl });
  const cb = `${SB_URL}/functions/v1/mb-oauth-ms/callback?`;
  const loc = async (u: string) => {
    const r = await h(new Request(u));
    assertEquals(r.status, 302);
    assertEquals(r.headers.get("referrer-policy"), "no-referrer");
    return r.headers.get("location")!;
  };
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const ok = new URL(await loc(`${cb}tenant=${TENANT}&state=${encodeURIComponent(state)}&admin_consent=True`));
  assertEquals(ok.origin + ok.pathname, APP_URL);
  const frag = new URLSearchParams(ok.hash.slice(1));
  assertEquals(frag.get("integrations"), "teams");
  assertEquals(frag.get("status"), "pending");
  assertEquals(frag.get("tenant"), TENANT);
  assertEquals(frag.get("state"), state);

  assertEquals(await loc(`${cb}error=access_denied&error_description=AADSTS65004`), `${APP_URL}#integrations=teams&status=error&reason=denied`);
  assertEquals(await loc(`${cb}tenant=${TENANT}`), `${APP_URL}#integrations=teams&status=error&reason=missing_params`);
  assertEquals(await loc(`${cb}tenant=${TENANT}&state=${encodeURIComponent(state)}&admin_consent=False`), `${APP_URL}#integrations=teams&status=error&reason=consent_not_granted`);
  assertEquals(await loc(`${cb}tenant=..%2Fevil&state=${encodeURIComponent(state)}&admin_consent=True`), `${APP_URL}#integrations=teams&status=error&reason=state_malformed`);
  const old = await signState(keys, { org_id: ORG, user_id: USER, ts: Date.now() - 11 * 60_000 });
  assertEquals(await loc(`${cb}tenant=${TENANT}&state=${encodeURIComponent(old)}&admin_consent=True`), `${APP_URL}#integrations=teams&status=error&reason=state_expired`);
  const forged = await signState(await deriveKeys(b64url(crypto.getRandomValues(new Uint8Array(32)))), { org_id: ORG, user_id: USER });
  assertEquals(await loc(`${cb}tenant=${TENANT}&state=${encodeURIComponent(forged)}&admin_consent=True`), `${APP_URL}#integrations=teams&status=error&reason=state_bad_signature`);
  // bare ?tenant= (no path segment, no ?action) is recognised as the callback; needs only MB_TOKEN_KEY + MB_APP_URL
  configure({ zoom: false, ms: false, google: false, app: true });
  assertEquals(await loc(`${SB_URL}/functions/v1/mb-oauth-ms?tenant=${TENANT}&state=x&admin_consent=True`), `${APP_URL}#integrations=teams&status=error&reason=state_malformed`);
  configure({ app: false });
  const r503 = await h(new Request(`${cb}tenant=${TENANT}&state=x&admin_consent=True`));
  assertEquals(r503.status, 503);
  assertEquals((await r503.json()).missing, ["MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals(fake.seen.length, 0, "the unauthenticated callback must not touch Microsoft or the DB");
});

function msFinishRoutes(
  tokenReply: () => Response = () => j(200, { token_type: "Bearer", expires_in: 3599, access_token: "graph-token" }),
  opts: { tenantPath?: string; domains?: Array<{ name: string; isVerified?: boolean }>; boundElsewhere?: boolean } = {},
): Route[] {
  const domains = opts.domains ?? [{ name: "Acme.com", isVerified: true }, { name: "acme.onmicrosoft.com", isVerified: true }, { name: "pending.acme.com", isVerified: false }];
  return [
    gotrueUser(),
    profile("admin"),
    { method: "POST", test: (u) => u.hostname === "login.microsoftonline.com" && u.pathname === `/${opts.tenantPath ?? TENANT}/oauth2/v2.0/token`, reply: tokenReply },
    { method: "GET", test: (u) => u.hostname === "graph.microsoft.com" && u.pathname === "/v1.0/organization", reply: (req) => (req.headers.get("authorization") === "Bearer graph-token" ? j(200, { value: [{ id: TENANT.toUpperCase(), displayName: "Acme Ltd", verifiedDomains: domains }] }) : j(401, {})) },
    { method: "GET", test: rest("integrations"), reply: (_r, u) => {
      // the one-tenant-one-workspace lookup: platform=eq.teams & account_ext_id=eq.<guid> & org_id=neq.<mine>
      assertEquals(u.searchParams.get("platform"), "eq.teams");
      assertEquals(u.searchParams.get("account_ext_id"), `eq.${TENANT}`);
      assertEquals(u.searchParams.get("org_id"), `neq.${ORG}`);
      return j(200, opts.boundElsewhere ? [{ org_id: "88888888-8888-4888-8888-888888888888" }] : []);
    } },
    { method: "POST", test: rest("integrations"), reply: () => j(201, { id: INTEG }) },
    eventsOk,
  ];
}
const msFinish = (tenant: string, state: string) => authed(`${SB_URL}/functions/v1/mb-oauth-ms?action=finish`, { method: "POST", body: JSON.stringify({ tenant, state }) });

Deno.test("oauth-ms finish: proves the consent with a client-credentials token, upserts integrations (tenant only, NO vault row)", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const fake = router(msFinishRoutes());
  const t0 = Date.now();
  const r = await oauthMs({ fetchImpl: fake.fetchImpl, now: () => t0 })(msFinish(TENANT.toUpperCase(), state));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  const b = JSON.parse(text);
  assertEquals(b, { platform: "teams", status: "connected", account_ext_id: TENANT, tenant_name: "Acme Ltd", scopes: ["User.Read.All"], expires_at: null });
  const tok = fake.calls("POST", `/${TENANT}/oauth2/v2.0/token`)[0];
  const p = new URLSearchParams(tok.body);
  assertEquals(p.get("grant_type"), "client_credentials");
  assertEquals(p.get("scope"), "https://graph.microsoft.com/.default");
  const up = fake.calls("POST", "/rest/v1/integrations")[0];
  assertStringIncludes(up.path, "on_conflict=org_id%2Cplatform");
  const row = JSON.parse(up.body);
  assertEquals(row.platform, "teams");
  assertEquals(row.org_id, ORG);
  assertEquals(row.account_ext_id, TENANT, "the GUID Graph answered with, lower-cased");
  assertEquals(row.status, "connected");
  assertEquals(row.scopes, ["User.Read.All"]);
  assertEquals(row.connected_by, USER);
  assertEquals(fake.calls("POST", "/rest/v1/rpc/").length, 0, "client-credentials: nothing to vault");
  assert(!fake.seen.some((s) => s.path.startsWith("/rest/") && s.body.includes("graph-token")), "the Graph token never reaches the DB");

  // a verified domain name works as the lookup hint; what gets stored is still the GUID
  const byDomain = router(msFinishRoutes(undefined, { tenantPath: "acme.com" }));
  const rd = await oauthMs({ fetchImpl: byDomain.fetchImpl, now: () => t0 })(msFinish("ACME.com", state));
  assertEquals(rd.status, 200, await rd.clone().text());
  assertEquals(JSON.parse(byDomain.calls("POST", "/rest/v1/integrations")[0].body).account_ext_id, TENANT);
});

Deno.test("oauth-ms finish: tenant binding — an admin of org A cannot bind tenant B: caller domain not verified in the tenant → 403; tenant already bound to another workspace → 409; hint that is not the tenant → 409; Graph /organization refused → no row", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER, platform: "teams" });

  // 1. admin@acme.com (gotrueUser) finishing a tenant whose verified domains are contoso.* → 403 tenant_not_yours, nothing written
  const foreign = router(msFinishRoutes(undefined, { domains: [{ name: "contoso.com", isVerified: true }, { name: "contoso.onmicrosoft.com" }] }));
  const r1 = await oauthMs({ fetchImpl: foreign.fetchImpl })(msFinish(TENANT, state));
  assertEquals(r1.status, 403, await r1.clone().text());
  const b1 = await r1.json();
  assertEquals(b1.error, "tenant_not_yours");
  assertEquals(b1.caller_domain, "acme.com");
  assertEquals(foreign.calls("POST", "/rest/v1/integrations").length, 0);
  // an unverified domain entry does not count either
  const unverified = router(msFinishRoutes(undefined, { domains: [{ name: "acme.com", isVerified: false }, { name: "contoso.onmicrosoft.com" }] }));
  assertEquals((await oauthMs({ fetchImpl: unverified.fetchImpl })(msFinish(TENANT, state))).status, 403);

  // 2. the tenant is already bound to another workspace → 409 tenant_already_connected, nothing written
  const bound = router(msFinishRoutes(undefined, { boundElsewhere: true }));
  const r2 = await oauthMs({ fetchImpl: bound.fetchImpl })(msFinish(TENANT, state));
  assertEquals(r2.status, 409, await r2.clone().text());
  assertEquals((await r2.json()).error, "tenant_already_connected");
  assertEquals(bound.calls("POST", "/rest/v1/integrations").length, 0);

  // 3. the body's tenant is neither the GUID nor a verified domain of what Graph answered → 409 tenant_mismatch
  const alias = router(msFinishRoutes(undefined, { tenantPath: "evil.example" }));
  const r3 = await oauthMs({ fetchImpl: alias.fetchImpl })(msFinish("evil.example", state));
  assertEquals(r3.status, 409, await r3.clone().text());
  assertEquals((await r3.json()).error, "tenant_mismatch");
  assertEquals(alias.calls("POST", "/rest/v1/integrations").length, 0);

  // 4. Graph /organization refused (403) → 409 needs_reconnect-class error, no row: the tenant id is never taken from the body
  const noOrg = router([
    ...msFinishRoutes().filter((r) => !(r.method === "GET" && r.test(new URL("https://graph.microsoft.com/v1.0/organization")))),
    { method: "GET", test: (u) => u.hostname === "graph.microsoft.com" && u.pathname === "/v1.0/organization", reply: () => j(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } }) },
  ]);
  const r4 = await oauthMs({ fetchImpl: noOrg.fetchImpl })(msFinish(TENANT, state));
  assertEquals(r4.status, 409, await r4.clone().text());
  assertEquals(noOrg.calls("POST", "/rest/v1/integrations").length, 0);

  // 5. a state minted for another connector (zoom) cannot finish teams
  const zoomState = await signState(keys, { org_id: ORG, user_id: USER, platform: "zoom" });
  const cross = router(msFinishRoutes());
  const r5 = await oauthMs({ fetchImpl: cross.fetchImpl })(msFinish(TENANT, zoomState));
  assertEquals(r5.status, 403);
  assertEquals((await r5.json()).error, "state_mismatch");
  assertEquals(cross.calls("POST", /oauth2/).length, 0, "no Microsoft call for a foreign-connector state");
});

Deno.test("oauth-ms finish: no consent in the tenant → 409 consent_missing; state of another user/org → 403 before any Microsoft call; bad input → 400", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const noConsent = router(msFinishRoutes(() => j(400, { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented to use the application", error_codes: [65001] })));
  const r = await oauthMs({ fetchImpl: noConsent.fetchImpl })(msFinish(TENANT, state));
  assertEquals(r.status, 409);
  assertEquals((await r.json()).error, "consent_missing");
  assertEquals(noConsent.calls("POST", "/rest/v1/integrations").length, 0);

  const other = await signState(keys, { org_id: ORG, user_id: "99999999-9999-4999-8999-999999999999" });
  const fake = router(msFinishRoutes());
  const r2 = await oauthMs({ fetchImpl: fake.fetchImpl })(msFinish(TENANT, other));
  assertEquals(r2.status, 403);
  assertEquals((await r2.json()).error, "state_mismatch");
  assertEquals(fake.calls("POST", /oauth2/).length, 0);

  assertEquals((await oauthMs({ fetchImpl: fake.fetchImpl })(msFinish("not a tenant", state))).status, 400);
  assertEquals((await oauthMs({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-ms?action=finish`, { method: "POST", body: "{" }))).status, 400);
  const expired = await signState(keys, { org_id: ORG, user_id: USER, ts: Date.now() - 11 * 60_000 });
  const r3 = await oauthMs({ fetchImpl: fake.fetchImpl })(msFinish(TENANT, expired));
  assertEquals(r3.status, 400);
  assertEquals((await r3.json()).error, "state_expired");
});

// ------------------------------------------------------------------ mb-sync-ms
function graphUsers(pages: Array<Array<Record<string, unknown>>>): Route[] {
  return [
    { method: "POST", test: (u) => u.hostname === "login.microsoftonline.com", reply: () => j(200, { access_token: "graph-token", expires_in: 3599 }) },
    { method: "GET", test: (u) => u.hostname === "graph.microsoft.com" && u.pathname === "/v1.0/users", reply: (req, u) => {
      assertEquals(req.headers.get("authorization"), "Bearer graph-token");
      const page = Number(u.searchParams.get("page") ?? "0");
      const body: Record<string, unknown> = { value: pages[page] ?? [] };
      if (page + 1 < pages.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0/users?$skiptoken=t${page + 1}&page=${page + 1}`;
      return j(200, body);
    } },
  ];
}

Deno.test("sync-ms: token for the stored tenant → paginated Graph users → employees upsert with the mapped columns → {imported, updated, total, stale}", async () => {
  configure();
  const upserts: Array<Record<string, unknown>[]> = [];
  const fake = router([
    gotrueUser(), profile("admin"), integrationRow("teams"), eventsOk, patchOk("integrations"),
    ...graphUsers([
      [{ id: "g1", displayName: "Dana Levi", mail: "Dana@Acme.com", userPrincipalName: "dana@acme.com", jobTitle: "CTO", department: "R&D", accountEnabled: true }, { id: "g2", displayName: "Old Row", mail: "old@acme.com", userPrincipalName: "old@acme.com" }],
      [{ id: "g3", displayName: null, mail: null, userPrincipalName: "svc@acme.onmicrosoft.com", department: "IT" }, { id: "g1", displayName: "dup" }],
    ]),
    { method: "GET", test: rest("employees"), reply: () => j(200, [{ ext_id: "g2" }, { ext_id: "gone" }]) },
    { method: "POST", test: rest("employees"), reply: (_r, _u, body) => { upserts.push(JSON.parse(body)); return new Response(null, { status: 201 }); } },
  ]);
  const t0 = Date.parse("2026-09-15T10:00:00Z");
  const r = await syncMs({ fetchImpl: fake.fetchImpl, now: () => t0 })(authed(`${SB_URL}/functions/v1/mb-sync-ms`, { method: "POST", body: "{}" }));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  assertEquals(JSON.parse(text), { imported: 2, updated: 1, total: 3, stale: 1, truncated: false, synced_at: new Date(t0).toISOString() });
  const tok = fake.calls("POST", `/${TENANT}/oauth2/v2.0/token`);
  assertEquals(tok.length, 1, "one client-credentials token for the stored tenant");
  assertEquals(fake.calls("GET", "/v1.0/users").length, 2, "both pages");
  assertEquals(upserts.length, 1);
  const rows = upserts[0];
  assertStringIncludes(fake.calls("POST", "/rest/v1/employees")[0].path, "on_conflict=org_id%2Cplatform%2Cext_id");
  assertEquals(rows.map((x) => x.ext_id), ["g1", "g2", "g3"], "duplicate g1 collapsed");
  assertEquals(rows[0], { org_id: ORG, platform: "teams", ext_id: "g1", email: "dana@acme.com", name: "Dana Levi", title: "CTO", dept: "R&D", synced_at: new Date(t0).toISOString() });
  assertEquals(rows[2], { org_id: ORG, platform: "teams", ext_id: "g3", email: "svc@acme.onmicrosoft.com", name: "svc", title: null, dept: "IT", synced_at: new Date(t0).toISOString() });
  const patch = JSON.parse(fake.calls("PATCH", "/rest/v1/integrations")[0].body);
  assertEquals(patch.last_sync_at, new Date(t0).toISOString());
  assertEquals(patch.status, "connected");
});

Deno.test("sync-ms: not connected → 409; consent revoked (Graph 403) → integration flipped to needs_reconnect + 409; Graph 5xx after retries → 503", async () => {
  configure();
  const none = router([gotrueUser(), profile("admin"), { method: "GET", test: rest("integrations"), reply: () => j(200, []) }]);
  const r0 = await syncMs({ fetchImpl: none.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-ms`, { method: "POST" }));
  assertEquals(r0.status, 409);
  assertEquals((await r0.json()).error, "not_connected");

  const revoked = router([
    gotrueUser(), profile("admin"), integrationRow("teams"), patchOk("integrations"),
    { method: "POST", test: (u) => u.hostname === "login.microsoftonline.com", reply: () => j(400, { error: "unauthorized_client", error_description: "AADSTS700016: Application with identifier 'ms-cid' was not found in the directory 'Acme'", error_codes: [700016] }) },
  ]);
  const r1 = await syncMs({ fetchImpl: revoked.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-ms`, { method: "POST" }));
  assertEquals(r1.status, 409);
  const b1 = await r1.json();
  assertEquals(b1.error, "needs_reconnect");
  assertEquals(b1.code, "app_not_in_tenant");
  assertEquals(JSON.parse(revoked.calls("PATCH", "/rest/v1/integrations")[0].body).status, "needs_reconnect");
  assertEquals(revoked.calls("POST", "/rest/v1/employees").length, 0);

  const down = router([
    gotrueUser(), profile("admin"), integrationRow("teams"), patchOk("integrations"),
    { method: "POST", test: (u) => u.hostname === "login.microsoftonline.com", reply: () => j(200, { access_token: "graph-token", expires_in: 3599 }) },
    { method: "GET", test: (u) => u.hostname === "graph.microsoft.com", reply: () => j(503, { error: { code: "ServiceUnavailable", message: "x" } }, { "retry-after": "0" }) },
  ]);
  const r2 = await syncMs({ fetchImpl: down.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-ms`, { method: "POST" }));
  assertEquals(r2.status, 503);
  assertEquals((await r2.json()).error, "ms_retry_later");
});

// ------------------------------------------------------------------ mb-oauth-google
Deno.test("oauth-google start + callback: offline/consent authorize URL with a verifiable state; callback bounces code+state to the app", async () => {
  configure();
  const fake = router([gotrueUser(), profile("admin")]);
  const r = await oauthGoogle({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-oauth-google?action=start`));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.platform, "meet");
  const u = new URL(b.url);
  assertEquals(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assertEquals(u.searchParams.get("client_id"), "g-cid");
  assertEquals(u.searchParams.get("access_type"), "offline");
  assertEquals(u.searchParams.get("prompt"), "consent");
  assertEquals(u.searchParams.get("redirect_uri"), `${SB_URL}/functions/v1/mb-oauth-google/callback`);
  assertStringIncludes(u.searchParams.get("scope")!, "admin.directory.user.readonly");
  const state = u.searchParams.get("state")!;
  assert((await verifyState(await deriveKeys(TOKEN_KEY), state)).ok);

  const h = oauthGoogle({ fetchImpl: router([]).fetchImpl });
  const cb = await h(new Request(`${SB_URL}/functions/v1/mb-oauth-google/callback?code=4%2F0Acode-1234&state=${encodeURIComponent(state)}`));
  assertEquals(cb.status, 302);
  const frag = new URLSearchParams(new URL(cb.headers.get("location")!).hash.slice(1));
  assertEquals(frag.get("integrations"), "meet");
  assertEquals(frag.get("status"), "pending");
  assertEquals(frag.get("code"), "4/0Acode-1234");
  assertEquals(frag.get("state"), state);
  const denied = await h(new Request(`${SB_URL}/functions/v1/mb-oauth-google/callback?error=access_denied`));
  assertEquals(denied.headers.get("location"), `${APP_URL}#integrations=meet&status=error&reason=denied`);
});

function googleFinishRoutes(tokenReply?: () => Response): Route[] {
  const idToken = `h.${b64url(new TextEncoder().encode(JSON.stringify({ sub: "1", email: "admin@acme.com", hd: "acme.com" })))}.s`;
  return [
    gotrueUser(), profile("admin"),
    { method: "POST", test: (u) => u.hostname === "oauth2.googleapis.com" && u.pathname === "/token", reply: tokenReply ?? ((_r, _u, body) => {
      const p = new URLSearchParams(body);
      assertEquals(p.get("grant_type"), "authorization_code");
      assertEquals(p.get("code"), "4/0Acode-1234");
      assertEquals(p.get("client_id"), "g-cid");
      assertEquals(p.get("redirect_uri"), `${SB_URL}/functions/v1/mb-oauth-google/callback`);
      return j(200, { access_token: "g-at", expires_in: 3600, refresh_token: "g-rt", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/admin.directory.user.readonly", token_type: "Bearer", id_token: idToken });
    }) },
    { method: "POST", test: rest("integrations"), reply: () => j(201, { id: INTEG }) },
    { method: "POST", test: rpc("integration_token_set"), reply: () => new Response(null, { status: 204 }) },
    patchOk("integrations"),
    eventsOk,
  ];
}
const gFinish = (code: string, state: string) => authed(`${SB_URL}/functions/v1/mb-oauth-google?action=finish`, { method: "POST", body: JSON.stringify({ code, state }) });

Deno.test("oauth-google finish: exchanges the code, binds the Workspace domain, stores encrypted refresh+access tokens; refuses missing scope / consumer gmail / other user's state", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const state = await signState(keys, { org_id: ORG, user_id: USER });
  const fake = router(googleFinishRoutes());
  const t0 = Date.now();
  const r = await oauthGoogle({ fetchImpl: fake.fetchImpl, now: () => t0 })(gFinish("4/0Acode-1234", state));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  const b = JSON.parse(text);
  assertEquals(b.platform, "meet");
  assertEquals(b.status, "connected");
  assertEquals(b.account_ext_id, "acme.com");
  const row = JSON.parse(fake.calls("POST", "/rest/v1/integrations")[0].body);
  assertEquals(row.platform, "meet");
  assertEquals(row.account_ext_id, "acme.com");
  assertEquals(row.org_id, ORG);
  assert(row.scopes.includes("https://www.googleapis.com/auth/admin.directory.user.readonly"));
  const set = JSON.parse(fake.calls("POST", "/rest/v1/rpc/integration_token_set")[0].body);
  assertEquals(set.p_integration_id, INTEG);
  assertEquals(await decryptFromHex(keys, set.p_refresh_hex), "g-rt");
  assertEquals(await decryptFromHex(keys, set.p_access_hex), "g-at");
  assertEquals(set.p_access_expires_at, new Date(t0 + 3600_000).toISOString());
  for (const s of fake.seen.filter((s) => s.path.startsWith("/rest/"))) assert(!s.body.includes("g-rt") && !s.body.includes("g-at"), `plaintext token in ${s.path}`);
  assert(!text.includes("g-rt") && !text.includes("g-at"));

  const noScope = router(googleFinishRoutes(() => j(200, { access_token: "g-at", expires_in: 3600, refresh_token: "g-rt", scope: "openid email", id_token: "x" })));
  const r1 = await oauthGoogle({ fetchImpl: noScope.fetchImpl })(gFinish("4/0Acode-1234", state));
  assertEquals(r1.status, 409);
  assertEquals((await r1.json()).error, "scope_not_granted");
  assertEquals(noScope.calls("POST", "/rest/v1/integrations").length, 0);

  const gmailId = `h.${b64url(new TextEncoder().encode(JSON.stringify({ email: "someone@gmail.com" })))}.s`;
  const gmail = router(googleFinishRoutes(() => j(200, { access_token: "g-at", expires_in: 3600, refresh_token: "g-rt", scope: "openid email https://www.googleapis.com/auth/admin.directory.user.readonly", id_token: gmailId })));
  const r2 = await oauthGoogle({ fetchImpl: gmail.fetchImpl })(gFinish("4/0Acode-1234", state));
  assertEquals(r2.status, 409);
  assertEquals((await r2.json()).error, "not_workspace");
  // a consumer Google account signed up with a custom-domain e-mail has no `hd` → refused as well (no directory behind it)
  const noHdId = `h.${b64url(new TextEncoder().encode(JSON.stringify({ email: "owner@smallbiz.example" })))}.s`;
  const noHd = router(googleFinishRoutes(() => j(200, { access_token: "g-at", expires_in: 3600, refresh_token: "g-rt", scope: "openid email https://www.googleapis.com/auth/admin.directory.user.readonly", id_token: noHdId })));
  const r2b = await oauthGoogle({ fetchImpl: noHd.fetchImpl })(gFinish("4/0Acode-1234", state));
  assertEquals(r2b.status, 409);
  assertEquals((await r2b.json()).error, "not_workspace");
  assertEquals(noHd.calls("POST", "/rest/v1/integrations").length, 0);

  const noRefresh = router(googleFinishRoutes(() => j(200, { access_token: "g-at", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/admin.directory.user.readonly" })));
  assertEquals((await oauthGoogle({ fetchImpl: noRefresh.fetchImpl })(gFinish("4/0Acode-1234", state))).status, 502);

  const other = await signState(keys, { org_id: "88888888-8888-4888-8888-888888888888", user_id: USER });
  const csrf = router(googleFinishRoutes());
  const r3 = await oauthGoogle({ fetchImpl: csrf.fetchImpl })(gFinish("4/0Acode-1234", other));
  assertEquals(r3.status, 403);
  assertEquals(csrf.calls("POST", "/token").length, 0, "code never exchanged for a foreign state");
});

// ------------------------------------------------------------------ mb-sync-google
Deno.test("sync-google: vault access token → paginated Directory users → employees upsert (title/dept from organizations[]); 403 not-authorized → 409 google_blocked; invalid_grant → needs_reconnect", async () => {
  configure();
  const keys = await deriveKeys(TOKEN_KEY);
  const vault = { refresh_token_hex: await encryptToHex(keys, "g-rt"), access_token_hex: await encryptToHex(keys, "g-at"), access_expires_at: new Date(Date.now() + 3600_000).toISOString(), rotated_at: null };
  const upserts: Array<Record<string, unknown>[]> = [];
  const users = (page: number) => page === 0
    ? { users: [{ id: "u1", primaryEmail: "Dana@Acme.com", name: { fullName: "Dana Levi" }, organizations: [{ title: "CTO", department: "R&D", primary: true }] }], nextPageToken: "p2" }
    : { users: [{ id: "u2", primaryEmail: "bot@acme.com", name: { givenName: "Svc", familyName: "Bot" } }] };
  const fake = router([
    gotrueUser(), profile("admin"), integrationRow("meet"), eventsOk, patchOk("integrations"),
    { method: "POST", test: rpc("integration_token_get"), reply: () => j(200, [vault]) },
    { method: "GET", test: (u) => u.hostname === "admin.googleapis.com", reply: (req, u) => {
      assertEquals(req.headers.get("authorization"), "Bearer g-at");
      assertEquals(u.searchParams.get("customer"), "my_customer");
      return j(200, users(u.searchParams.get("pageToken") ? 1 : 0));
    } },
    { method: "GET", test: rest("employees"), reply: () => j(200, []) },
    { method: "POST", test: rest("employees"), reply: (_r, _u, body) => { upserts.push(JSON.parse(body)); return new Response(null, { status: 201 }); } },
  ]);
  const t0 = Date.parse("2026-09-15T10:00:00Z");
  const r = await syncGoogle({ fetchImpl: fake.fetchImpl, now: () => t0 })(authed(`${SB_URL}/functions/v1/mb-sync-google`, { method: "POST", body: "{}" }));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  assertEquals(JSON.parse(text), { imported: 2, updated: 0, total: 2, stale: 0, truncated: false, synced_at: new Date(t0).toISOString() });
  assertEquals(fake.calls("POST", "/token").length, 0, "fresh access token: no refresh");
  assertEquals(upserts[0], [
    { org_id: ORG, platform: "meet", ext_id: "u1", email: "dana@acme.com", name: "Dana Levi", title: "CTO", dept: "R&D", synced_at: new Date(t0).toISOString() },
    { org_id: ORG, platform: "meet", ext_id: "u2", email: "bot@acme.com", name: "Svc Bot", title: null, dept: null, synced_at: new Date(t0).toISOString() },
  ]);

  const forbidden = router([
    gotrueUser(), profile("admin"), integrationRow("meet"), patchOk("integrations"),
    { method: "POST", test: rpc("integration_token_get"), reply: () => j(200, [vault]) },
    { method: "GET", test: (u) => u.hostname === "admin.googleapis.com", reply: () => j(403, { error: { code: 403, message: "Not Authorized to access this resource/api", errors: [{ reason: "forbidden" }] } }) },
  ]);
  const r1 = await syncGoogle({ fetchImpl: forbidden.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-google`, { method: "POST" }));
  assertEquals(r1.status, 409);
  assertEquals((await r1.json()).error, "google_blocked");
  assertEquals(JSON.parse(forbidden.calls("PATCH", "/rest/v1/integrations")[0].body).status, undefined, "blocked ≠ needs_reconnect: only last_error is written");

  const stale = { ...vault, access_expires_at: new Date(Date.now() + 60_000).toISOString() };
  const dead = router([
    gotrueUser(), profile("admin"), integrationRow("meet"), patchOk("integrations"),
    { method: "POST", test: rpc("integration_token_get"), reply: () => j(200, [stale]) },
    { method: "POST", test: rpc("integration_token_delete"), reply: () => new Response(null, { status: 204 }) },
    { method: "POST", test: (u) => u.hostname === "oauth2.googleapis.com", reply: () => j(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }) },
  ]);
  const r2 = await syncGoogle({ fetchImpl: dead.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-sync-google`, { method: "POST" }));
  assertEquals(r2.status, 409);
  assertEquals((await r2.json()).error, "needs_reconnect");
  assertEquals(dead.calls("POST", "/rest/v1/rpc/integration_token_delete").length, 1);
  assert(dead.calls("PATCH", "/rest/v1/integrations").some((c) => JSON.parse(c.body).status === "needs_reconnect"));
});

// ------------------------------------------------------------------ mb-integrations: 3-platform read model + teams/meet disconnect
Deno.test("integrations GET: connect.{zoom,teams,meet} with honest missing lists + delivery sentences; integrations rows keep the v1 shape; employees totals", async () => {
  configure({ zoom: false, ms: false, google: false, app: false });
  const fake = router([
    gotrueUser(), profile("member"),
    { method: "GET", test: rest("integrations"), reply: () => j(200, [{ id: INTEG, platform: "teams", status: "connected", account_ext_id: TENANT, scopes: ["User.Read.All"], connected_by: USER, connected_at: null, expires_at: null, last_sync_at: null, last_error: null, updated_at: null }]) },
    { method: "HEAD", test: rest("employees"), reply: (_r, u) => new Response(null, { status: 200, headers: { "content-range": u.searchParams.get("platform") === "eq.teams" ? (u.searchParams.has("active") ? "*/3" : "*/5") : "*/0" } }) },
    headCount("pushes", 0),
    { method: "GET", test: rest("pushes"), reply: () => j(200, []) },
  ]);
  const r = await integrations({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  const b = JSON.parse(text);
  assertEquals(Object.keys(b.connect), ["zoom", "teams", "meet"]);
  assertEquals(b.connect.zoom.configured, false);
  assertEquals(b.connect.zoom.missing, ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals(b.connect.zoom.start_url, `${SB_URL}/functions/v1/mb-oauth-zoom?action=start`, "v1 key unchanged");
  assertEquals(b.connect.zoom.redirect_uri, `${SB_URL}/functions/v1/mb-oauth-zoom/callback`);
  assertEquals(b.connect.teams.missing, ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals(b.connect.teams.start_url, `${SB_URL}/functions/v1/mb-oauth-ms?action=start`);
  assertEquals(b.connect.teams.redirect_uri, `${SB_URL}/functions/v1/mb-oauth-ms/callback`);
  assertEquals(b.connect.teams.sync_url, `${SB_URL}/functions/v1/mb-sync-ms`);
  assertEquals(b.connect.teams.pack_url, `${SB_URL}/functions/v1/mb-export-pack`);
  assertEquals(b.connect.meet.missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals(b.connect.meet.start_url, `${SB_URL}/functions/v1/mb-oauth-google?action=start`);
  assertEquals(b.connect.meet.redirect_uri, `${SB_URL}/functions/v1/mb-oauth-google/callback`);
  for (const p of ["zoom", "teams", "meet"] as const) {
    assertEquals(b.connect[p].delivery, DELIVERY[p]);
    assertEquals(b.connect[p].push_api, p === "zoom");
  }
  assertStringIncludes(b.connect.teams.delivery, "no background API");
  assertStringIncludes(b.connect.meet.delivery, "does not remember");
  assertStringIncludes(b.connect.zoom.delivery, "no API to activate");
  assertEquals(b.integrations.length, 4, "v1 clients still get the four platform rows");
  const teams = b.integrations.find((x: { platform: string }) => x.platform === "teams");
  assertEquals(teams.status, "connected");
  assertEquals(teams.directory, true);
  assertEquals(teams.push_api, false);
  assertEquals(teams.available, false, "v1 key kept: Zoom is still the only API push");
  assertEquals(teams.employees, { total: 5, active: 3 });
  assertEquals(b.integrations.find((x: { platform: string }) => x.platform === "zoho").directory, false);
  assertEquals(b.employees, { total: 5, active: 3, by_platform: { zoom: { total: 0, active: 0 }, teams: { total: 5, active: 3 }, meet: { total: 0, active: 0 }, zoho: { total: 0, active: 0 } } });

  configure();
  const cfg = router([gotrueUser(), profile("admin"), { method: "GET", test: rest("integrations"), reply: () => j(200, []) }, headCount("employees"), headCount("pushes"), { method: "GET", test: rest("pushes"), reply: () => j(200, []) }]);
  const b2 = await (await integrations({ fetchImpl: cfg.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`))).json();
  for (const p of ["zoom", "teams", "meet"] as const) {
    assertEquals(b2.connect[p].configured, true, p);
    assertEquals(b2.connect[p].missing, []);
  }
});

Deno.test("integrations POST disconnect teams: no token to revoke, row marked disconnected (+purge); meet: revokes the refresh token at Google and deletes the vault row", async () => {
  configure();
  const teams = router([
    gotrueUser(), profile("admin"), integrationRow("teams"), eventsOk, patchOk("integrations"),
    { method: "POST", test: rpc("integration_token_delete"), reply: () => new Response(null, { status: 204 }) },
    { method: "DELETE", test: rest("pushes"), reply: () => new Response(null, { status: 204, headers: { "content-range": "*/2" } }) },
    { method: "DELETE", test: rest("employees"), reply: () => new Response(null, { status: 204, headers: { "content-range": "*/9" } }) },
  ]);
  const r = await integrations({ fetchImpl: teams.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "teams", action: "disconnect", purge: true }) }));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  assertEquals(JSON.parse(text), { platform: "teams", status: "disconnected", revoked: false, purged: { employees: 9, pushes: 2 } });
  assertEquals(teams.seen.filter((s) => /microsoft/.test(s.url.hostname)).length, 0, "nothing to revoke for client credentials");
  assertEquals(JSON.parse(teams.calls("PATCH", "/rest/v1/integrations")[0].body).status, "disconnected");
  assertStringIncludes(teams.calls("DELETE", "/rest/v1/employees")[0].path, "platform=eq.teams");

  const keys = await deriveKeys(TOKEN_KEY);
  const meet = router([
    gotrueUser(), profile("admin"), integrationRow("meet"), eventsOk, patchOk("integrations"),
    { method: "POST", test: rpc("integration_token_get"), reply: async () => j(200, [{ refresh_token_hex: await encryptToHex(keys, "g-rt"), access_token_hex: await encryptToHex(keys, "g-at"), access_expires_at: null, rotated_at: null }]) },
    { method: "POST", test: rpc("integration_token_delete"), reply: () => new Response(null, { status: 204 }) },
    { method: "POST", test: (u) => u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke", reply: (_r, u, body) => { assertEquals(u.search, "", "the token never travels in the URL"); assertEquals(new URLSearchParams(body).get("token"), "g-rt"); return j(200, {}); } },
  ]);
  const r2 = await integrations({ fetchImpl: meet.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: JSON.stringify({ platform: "meet", action: "disconnect" }) }));
  assertEquals(await r2.json(), { platform: "meet", status: "disconnected", revoked: true, purged: { employees: 0, pushes: 0 } });
  assertEquals(meet.calls("POST", "/rest/v1/rpc/integration_token_delete").length, 1);
});

// ------------------------------------------------------------------ mb-export-pack
const packReq = (body: unknown) => authed(`${SB_URL}/functions/v1/mb-export-pack`, { method: "POST", body: JSON.stringify(body) });

Deno.test("export-pack: 400 on bad input / zoom platform; 404 for an unknown background — never 500", async () => {
  configure();
  const fake = router([gotrueUser(), profile("admin"), { method: "GET", test: rest("backgrounds"), reply: () => j(200, []) }]);
  const h = exportPack({ fetchImpl: fake.fetchImpl });
  const code = async (body: unknown) => { const r = await h(packReq(body)); return [r.status, (await r.json()).error]; };
  assertEquals(await code({}), [400, "bad_request"]);
  assertEquals(await code({ background_id: "nope", platform: "teams" }), [400, "bad_request"]);
  assertEquals(await code({ background_id: BG, platform: "zoom" }), [400, "unsupported_platform"]);
  assertEquals(await code({ background_id: BG, platform: "teams", employee_ids: "x" }), [400, "bad_request"]);
  assertEquals(await code({ background_id: BG, platform: "teams", employee_ids: ["x"] }), [400, "bad_request"]);
  assertEquals(await code({ background_id: BG, platform: "teams" }), [404, "background_not_found"]);
  assertEquals(await code({ background_id: BG, platform: "meet" }), [404, "background_not_found"]);
  assertEquals(fake.seen.filter((s) => s.path.startsWith("/storage/")).length, 0);
});

function packRoutes(opts: { thumb?: boolean; jpg?: boolean; schema007?: boolean; signFails?: boolean } = {}): Route[] {
  const assets = [
    { id: ASSET, kind: "export", bucket: "mb-exports", storage_path: `${ORG}/export/abc.png`, mime: "image/png", width: 1920, height: 1080, bytes: 1000 },
    ...(opts.thumb ? [{ id: THUMB, kind: "thumb", bucket: "mb-exports", storage_path: `${ORG}/thumb/abc.png`, mime: "image/png", width: 280, height: 158, bytes: 100 }] : []),
    ...(opts.jpg ? [{ id: JPG, kind: "export_jpg", bucket: "mb-exports", storage_path: `${ORG}/export_jpg/abc.jpg`, mime: "image/jpeg", width: 1920, height: 1080, bytes: 900 }] : []),
  ];
  return [
    gotrueUser(), profile("admin"), eventsOk,
    { method: "GET", test: rest("backgrounds"), reply: (_r, u) => {
      const sel = u.searchParams.get("select") ?? "";
      if (sel.includes("thumb_asset_id")) return opts.schema007 === false ? j(400, { code: "42703", message: 'column backgrounds.thumb_asset_id does not exist' }) : j(200, [{ thumb_asset_id: opts.thumb ? THUMB : null, export_jpg_asset_id: opts.jpg ? JPG : null }]);
      return j(200, [{ id: BG, label: "Lobby / Blue: 2026", slug: "lobbyblue", export_asset_id: ASSET }]);
    } },
    { method: "GET", test: rest("brand_assets"), reply: (_r, u) => { const ids = (u.searchParams.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(","); return j(200, assets.filter((a) => ids.includes(a.id))); } },
    { method: "GET", test: rest("employees"), reply: (_r, u) => {
      const rows = [{ id: EMP(1), ext_id: "g1", email: "dana@acme.com", name: "Dana", title: "CTO", dept: "R&D", active: true }, { id: EMP(2), ext_id: "g2", email: "bot@acme.com", name: "Bot", title: null, dept: "IT", active: true }];
      const ids = u.searchParams.get("id");
      return j(200, ids ? rows.filter((r) => ids.includes(r.id)) : rows);
    } },
    { method: "POST", test: (u) => u.pathname.startsWith("/storage/v1/object/sign/mb-exports/"), reply: (_r, u, body) => {
      if (opts.signFails) return j(400, { statusCode: "404", error: "not_found", message: "Object not found" });
      assertEquals(JSON.parse(body).expiresIn, 3600);
      return j(200, { signedURL: `${u.pathname.replace("/storage/v1", "")}?token=sig-${u.pathname.split("/").pop()}` });
    } },
  ];
}

Deno.test("export-pack teams: PNG + thumb signed (1 h), GUID file names, Intune PowerShell + macOS scripts, runbook with the honest limit; thumb missing → ready:false + missing[] (200)", async () => {
  configure();
  const t0 = Date.parse("2026-09-15T12:00:00Z");
  const fake = router(packRoutes({ thumb: true }));
  const r = await exportPack({ fetchImpl: fake.fetchImpl, now: () => t0 })(packReq({ background_id: BG, platform: "teams", employee_ids: [EMP(1), EMP(2), EMP(3)] }));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  const b = JSON.parse(text);
  assertEquals(b.ready, true);
  assertEquals(b.missing, []);
  assertEquals(b.schema_007_applied, true);
  assertEquals(b.expires_at, new Date(t0 + 3600_000).toISOString());
  assertEquals(b.background.guid, BG.toUpperCase());
  assertStringIncludes(b.assets.png.url, `/object/sign/mb-exports/${ORG}/export/abc.png?token=sig-abc.png`);
  assertStringIncludes(b.assets.thumb.url, `/object/sign/mb-exports/${ORG}/thumb/abc.png`);
  assertEquals(b.assets.png.filename, `${BG.toUpperCase()}MeetingBrand - Lobby Blue 2026.png`);
  assertEquals(b.assets.thumb.filename, `${BG.toUpperCase()}MeetingBrand - Lobby Blue 2026_thumb.png`);
  assertEquals(b.files.png, b.assets.png.filename);
  assertStringIncludes(b.files.windows_folder, "MSTeams_8wekyb3d8bbwe");
  assertStringIncludes(b.files.macos_folder, "com.microsoft.teams2");
  assertEquals(b.employees.map((e: { id: string }) => e.id), [EMP(1), EMP(2)]);
  assertEquals(b.unknown_employee_ids, [EMP(3)]);
  assertEquals(b.delivery, DELIVERY.teams);
  assertStringIncludes(b.runbook.honest_limit, "no background API");
  assert(b.runbook.steps.length >= 5);
  assertStringIncludes(b.scripts.windows_ps1, "Invoke-WebRequest -UseBasicParsing -Uri $PngUrl");
  assertStringIncludes(b.scripts.windows_ps1, b.assets.png.url);
  assertStringIncludes(b.scripts.windows_ps1, `${BG.toUpperCase()}MeetingBrand - Lobby Blue 2026_thumb.png`);
  assertStringIncludes(b.scripts.windows_ps1, "Backgrounds\\Uploads");
  assertStringIncludes(b.scripts.macos_sh, "com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/Backgrounds/Uploads");
  assertStringIncludes(b.scripts.macos_sh, `curl -fsSL "$THUMB_URL"`);
  assertEquals(b.generated.client, ["1920×1080 PNG export (kind export)", "280×158 PNG thumb (kind thumb)"]);
  const ev = JSON.parse(fake.calls("POST", "/rest/v1/events")[0].body);
  assertEquals(ev.event, "export_pack");

  const noThumb = router(packRoutes({ thumb: false }));
  const r2 = await exportPack({ fetchImpl: noThumb.fetchImpl })(packReq({ background_id: BG, platform: "teams" }));
  const b2 = await r2.json();
  assertEquals(r2.status, 200);
  assertEquals(b2.ready, false);
  assertEquals(b2.missing.map((m: { key: string; reason: string }) => [m.key, m.reason]), [["thumb", "not_registered"]]);
  assert(b2.assets.png?.url, "the PNG is still signed so the app can show it");
  assertEquals(b2.employees.length, 2, "no employee_ids → all active employees of the platform");
  assertStringIncludes(noThumb.calls("GET", "/rest/v1/employees")[0].path, "active=eq.true");

  const old = router(packRoutes({ thumb: true, schema007: false }));
  const b3 = await (await exportPack({ fetchImpl: old.fetchImpl })(packReq({ background_id: BG, platform: "teams" }))).json();
  assertEquals(b3.schema_007_applied, false);
  assertEquals(b3.ready, false, "007 not applied → thumb counts as missing, still no 500");

  const gone = router(packRoutes({ thumb: true, signFails: true }));
  const b4 = await (await exportPack({ fetchImpl: gone.fetchImpl })(packReq({ background_id: BG, platform: "teams" }))).json();
  assertEquals(b4.ready, false);
  assertEquals(b4.missing.map((m: { reason: string }) => m.reason), ["sign_failed", "sign_failed"]);
});

Deno.test("export-pack meet: JPEG only (PNG export alone → missing export_jpg), admin-console runbook with the 15-per-OU limit and the no-memory truth", async () => {
  configure();
  const fake = router(packRoutes({ jpg: true }));
  const r = await exportPack({ fetchImpl: fake.fetchImpl })(packReq({ background_id: BG, platform: "meet" }));
  const b = await r.json();
  assertEquals(r.status, 200);
  assertEquals(b.ready, true);
  assertEquals(b.assets.jpg.mime, "image/jpeg");
  assertEquals(b.assets.jpg.filename, "MeetingBrand - Lobby Blue 2026.jpg");
  assertEquals(b.files.jpg, "MeetingBrand - Lobby Blue 2026.jpg");
  assertEquals(b.assets.png, undefined, "Meet never gets the PNG");
  assertEquals(b.scripts, undefined);
  assertStringIncludes(b.runbook.honest_limit, "does not remember");
  assert(b.runbook.steps.some((s: { detail: string }) => /15 images per OU/.test(s.detail)));
  assert(b.runbook.steps.some((s: { detail: string }) => /Anyone with the link/.test(s.detail)));
  assertEquals(b.runbook.targets, { employees: 2, by_department: { "R&D": 1, IT: 1 } });
  assertEquals(b.generated.client, ["1920×1080 JPEG export (kind export_jpg)"]);

  const pngOnly = router(packRoutes({ jpg: false }));
  const b2 = await (await exportPack({ fetchImpl: pngOnly.fetchImpl })(packReq({ background_id: BG, platform: "meet" }))).json();
  assertEquals(b2.ready, false);
  assertEquals(b2.missing[0].kind, "export_jpg");
  assertEquals(pngOnly.seen.filter((s) => s.path.startsWith("/storage/")).length, 0, "nothing signed when the JPEG is absent");
});

// ------------------------------------------------------------------ security review 2026-09-16: caps + host pins
Deno.test("sync-ms / sync-google: a second sync within 30 s answers 429 sync_too_soon before any platform call", async () => {
  configure();
  const t0 = Date.parse("2026-09-16T10:00:00Z");
  const recent = new Date(t0 - 10_000).toISOString();
  const ms = router([gotrueUser(), profile("admin"), integrationRow("teams", "connected", { last_sync_at: recent })]);
  const r = await syncMs({ fetchImpl: ms.fetchImpl, now: () => t0 })(authed(`${SB_URL}/functions/v1/mb-sync-ms`, { method: "POST" }));
  assertEquals(r.status, 429, await r.clone().text());
  const b = await r.json();
  assertEquals(b.error, "sync_too_soon");
  assertEquals(b.retry_after_ms, 20_000);
  assertEquals(ms.seen.filter((s) => /microsoft/.test(s.url.hostname)).length, 0);
  const g = router([gotrueUser(), profile("admin"), integrationRow("meet", "connected", { last_sync_at: recent })]);
  const r2 = await syncGoogle({ fetchImpl: g.fetchImpl, now: () => t0 })(authed(`${SB_URL}/functions/v1/mb-sync-google`, { method: "POST" }));
  assertEquals(r2.status, 429);
  assertEquals(g.calls("POST", "/rest/v1/rpc/").length, 0, "the vault is not even read");
  // 31 s later it runs (and fails on the fake's unrouted Graph call — anything but 429 proves the gate opened)
  const later = router([gotrueUser(), profile("admin"), integrationRow("teams", "connected", { last_sync_at: recent }), patchOk("integrations")]);
  const r3 = await syncMs({ fetchImpl: later.fetchImpl, now: () => t0 + 31_000 })(authed(`${SB_URL}/functions/v1/mb-sync-ms`, { method: "POST" }));
  assert(r3.status !== 429, `expected the gate to open, got ${r3.status}`);
  await r3.text();
});

Deno.test("request bodies: > 256 KB answers 413 body_too_large (declared or actual), never a 500", async () => {
  configure();
  const fake = router([gotrueUser(), profile("admin")]);
  const big = JSON.stringify({ background_id: BG, platform: "teams", employee_ids: Array.from({ length: 7000 }, (_, i) => EMP(i)) });
  assert(big.length > 256 * 1024);
  const r = await exportPack({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-export-pack`, { method: "POST", body: big }));
  assertEquals(r.status, 413, await r.clone().text());
  assertEquals((await r.json()).error, "body_too_large");
  const declared = await integrations({ fetchImpl: fake.fetchImpl })(authed(`${SB_URL}/functions/v1/mb-integrations`, { method: "POST", body: "{}", headers: { "content-length": String(10 * 1024 * 1024) } }));
  assertEquals(declared.status, 413);
  await declared.text();
});

Deno.test("export-pack: employee_ids are looked up in chunks of 100 (the gateway caps the URL), every chunk org-pinned", async () => {
  configure();
  const ids = Array.from({ length: 250 }, (_, i) => EMP(i));
  const fake = router([
    gotrueUser(), profile("admin"), eventsOk,
    { method: "GET", test: rest("backgrounds"), reply: (_r, u) => j(200, u.searchParams.has("org_id") ? [{ id: BG, label: "L", slug: "l", export_asset_id: null }] : [{ thumb_asset_id: null, export_jpg_asset_id: null }]) },
    { method: "GET", test: rest("employees"), reply: (_r, u) => {
      assertEquals(u.searchParams.get("org_id"), `eq.${ORG}`);
      assertEquals(u.searchParams.get("platform"), "eq.teams");
      const inList = u.searchParams.get("id") ?? "";
      const n = inList.replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);
      assert(n.length <= 100, `chunk of ${n.length}`);
      return j(200, n.map((id) => ({ id, ext_id: id, email: null, name: null, title: null, dept: null, active: true })));
    } },
  ]);
  const r = await exportPack({ fetchImpl: fake.fetchImpl })(packReq({ background_id: BG, platform: "teams", employee_ids: ids }));
  const text = await r.text();
  assertEquals(r.status, 200, text);
  const b = JSON.parse(text);
  assertEquals(b.employees.length, 250);
  assertEquals(b.unknown_employee_ids, []);
  assertEquals(fake.calls("GET", "/rest/v1/employees").length, 3);
  for (const s of fake.calls("GET", "/rest/v1/employees")) assert(s.path.length < 8000, `URL ${s.path.length} chars`);
});
