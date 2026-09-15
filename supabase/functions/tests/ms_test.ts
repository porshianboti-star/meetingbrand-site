// deno test -A tests/  — _shared/ms.ts: admin-consent URL, token-error classes, Graph pagination + cap, employee mapping.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { adminConsentUrl, classifyGraphError, classifyTokenError, clientCredentialsToken, GraphApi, MAX_USERS, MsError, msErrorToHttp, TENANT_RE, toEmployee, USERS_SELECT } from "../_shared/ms.ts";

const j = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

Deno.test("adminConsentUrl: /common/adminconsent with client_id, state and the PATH redirect", () => {
  const u = new URL(adminConsentUrl({ clientId: "app-1", redirectUri: "https://x.supabase.co/functions/v1/mb-oauth-ms/callback" }, "st.ate"));
  assertEquals(u.origin + u.pathname, "https://login.microsoftonline.com/common/adminconsent");
  assertEquals(u.searchParams.get("client_id"), "app-1");
  assertEquals(u.searchParams.get("state"), "st.ate");
  assertEquals(u.searchParams.get("redirect_uri"), "https://x.supabase.co/functions/v1/mb-oauth-ms/callback");
  assertEquals(u.searchParams.has("scope"), false, "the v1 admin-consent endpoint grants the permissions configured on the app registration");
});

Deno.test("TENANT_RE: GUID or verified domain only", () => {
  assert(TENANT_RE.test("72f988bf-86f1-41af-91ab-2d7cd011db47"));
  assert(TENANT_RE.test("contoso.onmicrosoft.com"));
  assert(TENANT_RE.test("acme.co.il"));
  assert(!TENANT_RE.test("common"));
  assert(!TENANT_RE.test("../x"));
  assert(!TENANT_RE.test("evil.com/path"));
  assert(!TENANT_RE.test(""));
});

Deno.test("classifyTokenError: consent missing vs our own bad secret vs transient", () => {
  assertEquals(classifyTokenError(400, { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented", error_codes: [65001] }).kind, "needs_reconnect");
  assertEquals(classifyTokenError(400, { error: "unauthorized_client", error_description: "AADSTS700016: Application with identifier 'x' was not found in the directory", error_codes: [700016] }).code, "app_not_in_tenant");
  const bad = classifyTokenError(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.", error_codes: [7000215] });
  assertEquals(bad.kind, "failed");
  assertEquals(bad.code, "bad_client_secret");
  assertStringIncludes(bad.detail, "MS_CLIENT_SECRET");
  assertEquals(classifyTokenError(503, null).kind, "retry");
  assertEquals(classifyTokenError(0, null).kind, "retry");
});

Deno.test("classifyGraphError: 401 token, 403 permission → needs_reconnect; 429 honours Retry-After; 5xx retry", () => {
  assertEquals(classifyGraphError(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired" } }, null).code, "token_invalid");
  assertEquals(classifyGraphError(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } }, null).kind, "needs_reconnect");
  const rl = classifyGraphError(429, { error: { code: "TooManyRequests", message: "x" } }, "7");
  assertEquals(rl.kind, "retry");
  assertEquals(rl.retryAfterMs, 7000);
  assertEquals(classifyGraphError(503, null, null).kind, "retry");
  assertEquals(classifyGraphError(400, { error: { code: "Request_BadRequest", message: "Invalid $filter" } }, null).code, "bad_query");
});

Deno.test("clientCredentialsToken: posts client_credentials for the tenant with the Graph .default scope; refuses a bad tenant without a call", async () => {
  let seen: { url: string; body: string } | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    seen = { url: String(input), body: String(init?.body) };
    return j(200, { token_type: "Bearer", expires_in: 3599, access_token: "graph-token" });
  };
  const r = await clientCredentialsToken({ clientId: "cid", clientSecret: "sec" }, "72f988bf-86f1-41af-91ab-2d7cd011db47", fetchImpl);
  assert(r.ok && r.accessToken === "graph-token" && r.expiresIn === 3599);
  assertEquals(seen!.url, "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token");
  const p = new URLSearchParams(seen!.body);
  assertEquals(p.get("grant_type"), "client_credentials");
  assertEquals(p.get("scope"), "https://graph.microsoft.com/.default");
  assertEquals(p.get("client_id"), "cid");
  assertEquals(p.get("client_secret"), "sec");

  let called = false;
  const bad = await clientCredentialsToken({ clientId: "cid", clientSecret: "sec" }, "common/../evil", async () => { called = true; return j(200, {}); });
  assert(!bad.ok && bad.cls.code === "bad_tenant" && !called);

  const unreachable = await clientCredentialsToken({ clientId: "cid", clientSecret: "sec" }, "contoso.onmicrosoft.com", () => Promise.reject(new Error("dns")));
  assert(!unreachable.ok && unreachable.cls.kind === "retry");
});

function graphPages(pageSizes: number[], opts: { failOnce?: number } = {}) {
  const calls: string[] = [];
  let failed = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assertEquals(new Headers(init?.headers).get("authorization"), "Bearer graph-token");
    const page = Number(new URL(url).searchParams.get("page") ?? "0");
    if (opts.failOnce === page && !failed) {
      failed = true;
      return j(503, { error: { code: "ServiceUnavailable", message: "try later" } }, { "retry-after": "0" });
    }
    const n = pageSizes[page] ?? 0;
    const value = Array.from({ length: n }, (_, i) => ({ id: `u-${page}-${i}`, displayName: `User ${page}-${i}`, mail: `u${page}${i}@acme.com`, userPrincipalName: `u${page}${i}@acme.onmicrosoft.com`, jobTitle: "Eng", department: "R&D", accountEnabled: true }));
    const body: Record<string, unknown> = { value };
    if (page + 1 < pageSizes.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0/users?$skiptoken=opaque-${page + 1}&page=${page + 1}`;
    return j(200, body);
  };
  return { fetchImpl, calls };
}

Deno.test("GraphApi.listUsers: $select/$top/$filter on the first call, @odata.nextLink followed VERBATIM, 5xx retried", async () => {
  const g = graphPages([2, 2, 1], { failOnce: 1 });
  const api = new GraphApi("graph-token", { fetchImpl: g.fetchImpl, sleepImpl: () => Promise.resolve() });
  const pages: number[] = [];
  const r = await api.listUsers((n) => pages.push(n));
  assertEquals(r.users.length, 5);
  assertEquals(r.truncated, false);
  assertEquals(pages, [1, 2, 3]);
  const first = new URL(g.calls[0]);
  assertEquals(first.origin + first.pathname, "https://graph.microsoft.com/v1.0/users");
  assertEquals(first.searchParams.get("$select"), USERS_SELECT);
  assertEquals(first.searchParams.get("$top"), "999");
  assertEquals(first.searchParams.get("$filter"), "accountEnabled eq true");
  assertEquals(g.calls.length, 4, "3 pages + 1 retried 503");
  assertEquals(g.calls[1], "https://graph.microsoft.com/v1.0/users?$skiptoken=opaque-1&page=1", "nextLink is not re-parameterised");
  assertEquals(g.calls[2], g.calls[1], "the 503 page was re-requested as-is");
});

Deno.test("GraphApi.listUsers: stops at the 2000 cap and reports truncated; a 403 becomes needs_reconnect", async () => {
  const g = graphPages([999, 999, 999, 999]);
  const api = new GraphApi("graph-token", { fetchImpl: g.fetchImpl, sleepImpl: () => Promise.resolve() });
  const r = await api.listUsers();
  assertEquals(r.users.length, MAX_USERS);
  assertEquals(r.truncated, true);
  assertEquals(g.calls.length, 3, "the fourth page is never fetched");

  const small = new GraphApi("graph-token", { fetchImpl: g.fetchImpl, maxUsers: 1000 });
  const s = await small.listUsers();
  assertEquals(s.users.length, 1000);
  assertEquals(s.truncated, true);

  const denied = new GraphApi("graph-token", { fetchImpl: async () => j(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } }) });
  const e = await assertRejects(() => denied.listUsers(), MsError);
  assertEquals(e.cls.kind, "needs_reconnect");
  const http = msErrorToHttp(e);
  assertEquals(http.status, 409);
  assertEquals(http.code, "needs_reconnect");
});

Deno.test("toEmployee: mail over UPN, display name fallback to the UPN local part, trimming, nulls", () => {
  assertEquals(toEmployee({ id: "1", displayName: "  Dana Levi ", mail: "Dana@Acme.com", userPrincipalName: "dana_acme.com#EXT#@acme.onmicrosoft.com", jobTitle: " CTO ", department: "", accountEnabled: true }), {
    ext_id: "1",
    email: "dana@acme.com",
    name: "Dana Levi",
    title: "CTO",
    dept: null,
  });
  assertEquals(toEmployee({ id: "2", displayName: null, mail: null, userPrincipalName: "svc.bot@acme.onmicrosoft.com", jobTitle: null, department: "IT" }), {
    ext_id: "2",
    email: "svc.bot@acme.onmicrosoft.com",
    name: "svc.bot",
    title: null,
    dept: "IT",
  });
  assertEquals(toEmployee({ id: "" } as never), null);
});
