// deno test -A tests/  — Zoom adapter: error mapping, pagination, 429, concurrency, upload, token refresh.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import { b64url, decryptFromHex, deriveKeys, encryptToHex } from "../_shared/crypto.ts";
import type { ZoomEnv } from "../_shared/env.ts";
import {
  authorizeUrl,
  backgroundFilename,
  classifyZoomError,
  exchangeCode,
  getAccessToken,
  listEmployees,
  mimeFromPath,
  NeedsReconnect,
  accountIdFromToken,
  refreshTokens,
  retryAfterMs,
  ZoomApi,
  ZoomError,
  zoomErrorToHttp,
  rateLimitInfo,
} from "../_shared/zoom.ts";

const ENV: ZoomEnv = {
  clientId: "cid",
  clientSecret: "csecret",
  tokenKeyB64: b64url(crypto.getRandomValues(new Uint8Array(32))),
  appUrl: "https://meetingbrand.com/app/",
  redirectUri: "https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom/callback",
};
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = () => Promise.resolve();

// ------------------------------------------------------------------ error mapping

Deno.test("classifyZoomError maps Zoom failures to push states", () => {
  assertEquals(classifyZoomError({ status: 429, body: { code: 429, message: "too many requests" }, retryAfterMs: 3000 }).kind, "retry");
  assertEquals(classifyZoomError({ status: 429, body: null, retryAfterMs: 3000 }).retryAfterMs, 3000);
  assertEquals(classifyZoomError({ status: 503, body: null }).kind, "retry");
  assertEquals(classifyZoomError({ status: 0, body: null }).kind, "retry");
  assertEquals(classifyZoomError({ status: 401, body: { code: 124, message: "Invalid access token." } }).kind, "needs_reconnect");
  assertEquals(classifyZoomError({ status: 400, body: { error: "invalid_grant", reason: "Invalid Token!" } }).kind, "needs_reconnect");
  assertEquals(classifyZoomError({ status: 400, body: { code: 4711, message: "Invalid access token, does not contain scopes:[user:write:virtual_background_files:admin]" } }).code, "missing_scope");
  assertEquals(classifyZoomError({ status: 404, body: { code: 1001, message: "User does not exist: abc." } }).code, "user_not_found");
  const full = classifyZoomError({ status: 400, body: { code: 300, message: "You have reached the maximum number of virtual background files (10)." } });
  assertEquals(full.kind, "blocked");
  assertEquals(full.code, "library_full_or_limit");
  // real upload errors are 400 code 120 (OpenAPI spec, uploadVBuser): the cap is "blocked", the rest are permanent for this file
  const cap = classifyZoomError({ status: 400, body: { code: 120, message: "A maximum of 10 files are allowed for a user." } });
  assertEquals([cap.kind, cap.code], ["blocked", "library_full_or_limit"]);
  assertEquals(classifyZoomError({ status: 400, body: { code: 120, message: "File size cannot exceed 15M." } }).code, "bad_file");
  assertEquals(classifyZoomError({ status: 400, body: { code: 120, message: "Only jpg/jpeg, gif or png image file can be uploaded." } }).code, "bad_file");
  assertEquals(classifyZoomError({ status: 400, body: { code: 120, message: "No file uploaded, verify that a file has been uploaded." } }).code, "bad_file");
  assertEquals(classifyZoomError({ status: 400, body: { code: 124, message: "Access token is expired." } }).kind, "needs_reconnect", "124 arrives as HTTP 400, not only 401");
  assertEquals(classifyZoomError({ status: 404, body: { code: 2001, message: "Account does not exist: abc" } }).kind, "failed");
  // 429 flavours: QPS (no Retry-After) vs daily (X-RateLimit-Type: Daily-limit + ISO Retry-After)
  const qps = classifyZoomError({ status: 429, body: { code: 429, message: "You have reached the maximum per-second rate limit for this API. Try again later." }, rateLimit: { type: "qps", resetAt: null } });
  assertEquals([qps.kind, qps.code, qps.retryAfterMs], ["retry", "rate_limited", 1000]);
  const daily = classifyZoomError({ status: 429, body: { code: 429, message: "You have reached the maximum daily rate limit for this API." }, retryAfterMs: 60_000, rateLimit: { type: "daily", resetAt: "2026-09-14T00:00:00.000Z" } });
  assertEquals([daily.kind, daily.code], ["retry", "daily_limit"]);
  assertStringIncludes(daily.detail, "2026-09-14T00:00:00.000Z");
  assertEquals(rateLimitInfo(new Headers({ "x-ratelimit-type": "Daily-limit", "retry-after": "2026-09-14T00:00:00Z" })), { type: "daily", resetAt: "2026-09-14T00:00:00.000Z" });
  assertEquals(rateLimitInfo(new Headers({ "x-ratelimit-type": "QPS" })), { type: "qps", resetAt: null });
  assertEquals(rateLimitInfo(new Headers()), { type: null, resetAt: null });
  assertEquals(classifyZoomError({ status: 400, body: { code: 200, message: "Virtual background is disabled for this account." } }).code, "feature_unavailable");
  assertEquals(classifyZoomError({ status: 403, body: { code: 200, message: "Only available for paid account." } }).kind, "blocked");
  assertEquals(classifyZoomError({ status: 400, body: { code: 300, message: "Invalid file format." } }).code, "bad_file");
  assertEquals(classifyZoomError({ status: 400, body: { code: 300, message: "Something odd" } }).kind, "failed");
  assert(!JSON.stringify(classifyZoomError({ status: 401, body: { message: "x" } })).includes("Bearer"));
});

Deno.test("zoomErrorToHttp: retry → 503 with retry_after_ms, reconnect → 409, blocked → 409, other → 502", () => {
  assertEquals(zoomErrorToHttp(new ZoomError({ kind: "retry", code: "rate_limited", detail: "d", retryAfterMs: 1500 }, 429)).status, 503);
  assertEquals(zoomErrorToHttp(new ZoomError({ kind: "retry", code: "rate_limited", detail: "d", retryAfterMs: 1500 }, 429)).extra.retry_after_ms, 1500);
  assertEquals(zoomErrorToHttp(new NeedsReconnect("gone")).status, 409);
  assertEquals(zoomErrorToHttp(new ZoomError({ kind: "needs_reconnect", code: "token_invalid", detail: "d" }, 401)).code, "needs_reconnect");
  assertEquals(zoomErrorToHttp(new ZoomError({ kind: "blocked", code: "feature_unavailable", detail: "d" }, 400)).status, 409);
  assertEquals(zoomErrorToHttp(new ZoomError({ kind: "failed", code: "zoom_error", detail: "d" }, 400)).status, 502);
  assertEquals(zoomErrorToHttp(new Error("boom")).status, 500);
});

Deno.test("retryAfterMs: seconds, http-date, garbage; capped at 60 s", () => {
  assertEquals(retryAfterMs("2"), 2000);
  assertEquals(retryAfterMs("999"), 60_000);
  assertEquals(retryAfterMs(null), null);
  assertEquals(retryAfterMs("soon"), null);
  const inFuture = new Date(Date.now() + 5000).toUTCString();
  const ms = retryAfterMs(inFuture)!;
  assert(ms > 2000 && ms <= 5000, `http-date → ${ms}`);
});

Deno.test("helpers: authorizeUrl, backgroundFilename, mimeFromPath", () => {
  const u = new URL(authorizeUrl(ENV, "st.ate"));
  assertEquals(u.origin + u.pathname, "https://zoom.us/oauth/authorize");
  assertEquals(u.searchParams.get("response_type"), "code");
  assertEquals(u.searchParams.get("client_id"), "cid");
  assertEquals(u.searchParams.get("redirect_uri"), ENV.redirectUri);
  assertEquals(u.searchParams.get("state"), "st.ate");
  assertEquals(backgroundFilename("Office / Blue: v2 🎨", "image/png"), "MeetingBrand - Office Blue v2.png");
  assertEquals(backgroundFilename(null, "image/jpeg"), "MeetingBrand.jpg");
  assertEquals(mimeFromPath("org/export/abc.PNG", null), "image/png");
  assertEquals(mimeFromPath("org/export/abc.bin", "image/jpeg"), "image/jpeg");
  assertEquals(mimeFromPath("org/export/abc.webp", "image/webp"), null);
});

// ------------------------------------------------------------------ OAuth token endpoint

Deno.test("exchangeCode posts Basic auth + form body; invalid_grant → needs_reconnect; 5xx → retry", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const ok = await exchangeCode(ENV, "the-code", (url, init) => {
    seen = { url: String(url), init: init! };
    return Promise.resolve(jsonRes(200, { access_token: "a", token_type: "bearer", refresh_token: "r", expires_in: 3599, scope: "user:read:list_users:admin" }));
  });
  assert(ok.ok);
  assertEquals(seen!.url, "https://zoom.us/oauth/token");
  assertEquals((seen!.init.headers as Record<string, string>).Authorization, "Basic " + btoa("cid:csecret"));
  const body = new URLSearchParams(String(seen!.init.body));
  assertEquals(body.get("grant_type"), "authorization_code");
  assertEquals(body.get("code"), "the-code");
  assertEquals(body.get("redirect_uri"), ENV.redirectUri);

  const bad = await refreshTokens(ENV, "dead", () => Promise.resolve(jsonRes(400, { error: "invalid_grant", reason: "Invalid Token!" })));
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.kind, "needs_reconnect");
  const down = await refreshTokens(ENV, "x", () => Promise.resolve(jsonRes(502, {})));
  if (!down.ok) assertEquals(down.kind, "retry");
  const wrongApp = await refreshTokens(ENV, "x", () => Promise.resolve(jsonRes(401, { error: "invalid_client", reason: "Invalid client_id or client_secret" })));
  if (!wrongApp.ok) assert(wrongApp.detail.includes("ZOOM_CLIENT_ID"));
  const offline = await refreshTokens(ENV, "x", () => Promise.reject(new Error("dns")));
  if (!offline.ok) assertEquals(offline.kind, "retry");
});

// ------------------------------------------------------------------ directory: pagination + 429 + concurrency

Deno.test("listUsers follows next_page_token and honours Retry-After on 429", async () => {
  const calls: string[] = [];
  const waits: number[] = [];
  let rateLimited = false;
  const fetchImpl: typeof fetch = (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    if (u.pathname === "/v2/users") {
      assertEquals(u.searchParams.get("status"), "active");
      assertEquals(u.searchParams.get("page_size"), "300");
      const tok = u.searchParams.get("next_page_token");
      if (!tok) return Promise.resolve(jsonRes(200, { users: [{ id: "u1", email: "A@x.com", first_name: "Ann", last_name: "Lee" }, { id: "u2", display_name: "Bob" }], next_page_token: "p2" }));
      if (tok === "p2" && !rateLimited) {
        rateLimited = true;
        return Promise.resolve(jsonRes(429, { code: 429, message: "slow down" }, { "retry-after": "2" }));
      }
      if (tok === "p2") return Promise.resolve(jsonRes(200, { users: [{ id: "u3", email: "c@x.com" }], next_page_token: "" }));
    }
    return Promise.resolve(jsonRes(404, { code: 1001, message: "nope" }));
  };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); } });
  const users = await api.listUsers();
  assertEquals(users.map((u) => u.id), ["u1", "u2", "u3"]);
  assertEquals(calls.filter((c) => c.startsWith("/v2/users?")).length, 3, "page1, page2 (429), page2 again");
  assertEquals(waits, [2000], "slept exactly Retry-After");
});

Deno.test("listEmployees enriches job_title with at most 4 concurrent GET /users/{id}", async () => {
  const ids = Array.from({ length: 23 }, (_, i) => `u${i}`);
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/v2/users") return jsonRes(200, { users: ids.map((id) => ({ id, email: `${id}@x.com`, first_name: id })), next_page_token: "" });
    const m = /^\/v2\/users\/(u\d+)$/.exec(u.pathname);
    if (m) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (m[1] === "u5") return jsonRes(404, { code: 1001, message: "User does not exist" });
      if (m[1] === "u7") return jsonRes(500, { code: 500, message: "oops" });
      return jsonRes(200, { id: m[1], job_title: `Title ${m[1]}`, dept: "Sales" });
    }
    return jsonRes(404, {});
  };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: noSleep, maxRetries: 1 });
  const people = await listEmployees(api, { concurrency: 8 });
  assertEquals(people.length, 23);
  assert(peak <= 4, `peak concurrency ${peak}`);
  assert(peak >= 2, "actually parallel");
  assertEquals(people.find((p) => p.ext_id === "u1")?.title, "Title u1");
  assertEquals(people.find((p) => p.ext_id === "u1")?.dept, "Sales");
  assertEquals(people.find((p) => p.ext_id === "u5")?.title, null, "404 → keep the list row");
  assertEquals(people.find((p) => p.ext_id === "u7")?.title, null, "5xx → keep the list row, no throw");
  assertEquals(people.find((p) => p.ext_id === "u0")?.email, "u0@x.com");
});

Deno.test("listEmployees: missing user:read:user:admin scope → titles skipped, sync still succeeds", async () => {
  let userGets = 0;
  const fetchImpl: typeof fetch = (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/v2/users") return Promise.resolve(jsonRes(200, { users: Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com` })) }));
    userGets++;
    return Promise.resolve(jsonRes(400, { code: 4711, message: "Invalid access token, does not contain scopes:[user:read:user:admin]" }));
  };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: noSleep });
  const people = await listEmployees(api);
  assertEquals(people.length, 12);
  assert(people.every((p) => p.title === null));
  assert(userGets <= 4, `stopped after the first scope failure (${userGets} calls)`);
});

Deno.test("me(): falls back to the token's aid claim when user:read:user:admin is missing", async () => {
  const jwt = "x." + btoa(JSON.stringify({ aid: "acc-from-jwt", uid: "u" })).replace(/=+$/, "") + ".y";
  assertEquals(accountIdFromToken(jwt), "acc-from-jwt");
  assertEquals(accountIdFromToken("opaque"), null);
  const scoped = new ZoomApi(jwt, { fetchImpl: () => Promise.resolve(jsonRes(400, { code: 4711, message: "does not contain scopes:[user:read:user:admin]" })), sleepImpl: noSleep, maxRetries: 0 });
  assertEquals((await scoped.me()).account_id, "acc-from-jwt");
  const dead = new ZoomApi(jwt, { fetchImpl: () => Promise.resolve(jsonRes(401, { code: 124, message: "Invalid access token." })), sleepImpl: noSleep, maxRetries: 0 });
  await assertRejects(() => dead.me(), ZoomError, "token_invalid");
});

Deno.test("listEmployees aborts on needs_reconnect during enrichment", async () => {
  const fetchImpl: typeof fetch = (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/v2/users") return Promise.resolve(jsonRes(200, { users: [{ id: "u1" }, { id: "u2" }] }));
    return Promise.resolve(jsonRes(401, { code: 124, message: "Invalid access token." }));
  };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: noSleep });
  await assertRejects(() => listEmployees(api), ZoomError, "token_invalid");
});

// ------------------------------------------------------------------ upload + preflight

Deno.test("uploadVirtualBackground sends multipart field `file`; maps limits; refuses >15 MB and bad mime locally", async () => {
  let captured: Request | null = null;
  const fetchImpl: typeof fetch = (url, init) => {
    captured = new Request(String(url), init);
    return Promise.resolve(jsonRes(201, { id: "file-1", name: "MeetingBrand - Look.png", size: 4, type: "image/png", is_default: false }));
  };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: noSleep });
  const out = await api.uploadVirtualBackground("user-9", new Uint8Array([137, 80, 78, 71]), "MeetingBrand - Look.png", "image/png");
  assertEquals(out.id, "file-1");
  assertEquals(captured!.method, "POST");
  assertEquals(new URL(captured!.url).pathname, "/v2/users/user-9/settings/virtual_backgrounds");
  assertEquals(captured!.headers.get("authorization"), "Bearer tok");
  assert(captured!.headers.get("content-type")?.startsWith("multipart/form-data"), "FormData sets the boundary");
  const form = await captured!.formData();
  const f = form.get("file") as File;
  assertEquals(f.name, "MeetingBrand - Look.png");
  assertEquals(f.type, "image/png");
  assertEquals(f.size, 4);

  const full = new ZoomApi("tok", { fetchImpl: () => Promise.resolve(jsonRes(400, { code: 120, message: "A maximum of 10 files are allowed for a user." })), sleepImpl: noSleep });
  const err = await assertRejects(() => full.uploadVirtualBackground("u", new Uint8Array(1), "a.png", "image/png"), ZoomError);
  assertEquals(err.cls.kind, "blocked");
  assertEquals(err.cls.code, "library_full_or_limit");

  const big = new Uint8Array(15 * 1024 * 1024 + 1);
  const e2 = await assertRejects(() => api.uploadVirtualBackground("u", big, "a.png", "image/png"), ZoomError);
  assertEquals(e2.cls.code, "bad_file");
  const e3 = await assertRejects(() => api.uploadVirtualBackground("u", new Uint8Array(1), "a.webp", "image/webp"), ZoomError);
  assertEquals(e3.cls.code, "bad_file");
});

Deno.test("POST upload is re-sent at most once on 429 (rejected = no side effect)", async () => {
  let posts = 0;
  const api = new ZoomApi("tok", { fetchImpl: () => { posts++; return Promise.resolve(jsonRes(429, { code: 429 }, { "retry-after": "1" })); }, sleepImpl: noSleep, maxRetries: 3 });
  const e = await assertRejects(() => api.uploadVirtualBackground("u", new Uint8Array(1), "a.png", "image/png"), ZoomError);
  assertEquals(e.cls.code, "rate_limited");
  assertEquals(posts, 2);
});

Deno.test("a DAILY-limit 429 is never re-sent (not even a GET) and classifies as daily_limit", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = () => { calls++; return Promise.resolve(jsonRes(429, { code: 429, message: "You have reached the maximum daily rate limit for this API." }, { "x-ratelimit-type": "Daily-limit", "retry-after": "2026-09-14T00:00:00Z" })); };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: noSleep, maxRetries: 3 });
  const e = await assertRejects(() => api.uploadVirtualBackground("u", new Uint8Array(1), "a.png", "image/png"), ZoomError);
  assertEquals(e.cls.code, "daily_limit");
  assertEquals(calls, 1);
  await assertRejects(() => api.getUser("x"), ZoomError);
  assertEquals(calls, 2, "GET not retried either");
});

Deno.test("POST upload is NOT retried on 5xx (non-idempotent); GET is", async () => {
  let posts = 0;
  let gets = 0;
  const fetchImpl: typeof fetch = (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      return Promise.resolve(jsonRes(502, {}));
    }
    gets++;
    return Promise.resolve(gets < 3 ? jsonRes(503, {}) : jsonRes(200, { id: "me", account_id: "acc" }));
  };
  const api = new ZoomApi("tok", { fetchImpl, sleepImpl: noSleep, maxRetries: 3 });
  const e = await assertRejects(() => api.uploadVirtualBackground("u", new Uint8Array(1), "a.png", "image/png"), ZoomError);
  assertEquals(e.cls.kind, "retry");
  assertEquals(posts, 1);
  assertEquals((await api.me()).account_id, "acc");
  assertEquals(gets, 3);
});

Deno.test("accountVirtualBackgroundEnabled: always GET /accounts/me/settings; true/false/unknown; 401 throws needs_reconnect", async () => {
  const mk = (res: Response) => new ZoomApi("tok", { fetchImpl: (u) => { assertEquals(new URL(String(u)).pathname, "/v2/accounts/me/settings"); return Promise.resolve(res.clone()); }, sleepImpl: noSleep, maxRetries: 0 });
  assertEquals((await mk(jsonRes(404, { code: 2001, message: "Account does not exist: acc" })).accountVirtualBackgroundEnabled()).enabled, null, "wrong account id → skipped, never blocks");
  assertEquals((await mk(jsonRes(200, { in_meeting: { virtual_background: true } })).accountVirtualBackgroundEnabled()).enabled, true);
  assertEquals((await mk(jsonRes(200, { in_meeting: { virtual_background: false } })).accountVirtualBackgroundEnabled()).enabled, false);
  assertEquals((await mk(jsonRes(200, { in_meeting: {} })).accountVirtualBackgroundEnabled()).enabled, null);
  assertEquals((await mk(jsonRes(400, { code: 4711, message: "does not contain scopes:[account:read:settings:admin]" })).accountVirtualBackgroundEnabled()).enabled, null, "missing preflight scope → skip, do not block pushes");
  await assertRejects(() => mk(jsonRes(401, { code: 124, message: "Invalid access token." })).accountVirtualBackgroundEnabled(), ZoomError);
});

// ------------------------------------------------------------------ token vault + single-flight refresh

interface FakeVault {
  row: { refresh_token_hex: string | null; access_token_hex: string | null; access_expires_at: string | null; rotated_at: string | null; refresh_lease_until?: number | null } | null;
  leaseRpc: boolean; // whether 006 is "installed"
  sets: Array<{ p_refresh_hex: string | null; p_access_hex: string; p_access_expires_at: string }>;
  updates: Array<Record<string, unknown>>;
  deleted: number;
  begins: number;
  now: () => number;
}
function fakeSb(v: FakeVault): SupabaseClient {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "integration_token_get") return Promise.resolve({ data: v.row ? [v.row] : [], error: null });
      if (name === "integration_token_begin_refresh") {
        if (!v.leaseRpc) return Promise.resolve({ data: null, error: { message: "Could not find the function mb.integration_token_begin_refresh (PGRST202)" } });
        v.begins++;
        if (!v.row) return Promise.resolve({ data: [{ acquired: false, row_exists: false }], error: null });
        if (v.row.refresh_lease_until && v.row.refresh_lease_until > v.now()) return Promise.resolve({ data: [{ acquired: false, row_exists: true }], error: null });
        v.row.refresh_lease_until = v.now() + Number(args.p_lease_seconds) * 1000;
        return Promise.resolve({ data: [{ acquired: true, row_exists: true, ...v.row }], error: null });
      }
      if (name === "integration_token_end_refresh") {
        if (v.row) v.row.refresh_lease_until = null;
        return Promise.resolve({ data: null, error: null });
      }
      if (name === "integration_token_set") {
        const a = args as { p_refresh_hex: string | null; p_access_hex: string; p_access_expires_at: string };
        v.sets.push(a);
        v.row = {
          refresh_token_hex: a.p_refresh_hex ?? v.row?.refresh_token_hex ?? null,
          access_token_hex: a.p_access_hex,
          access_expires_at: a.p_access_expires_at,
          rotated_at: new Date(v.now()).toISOString(),
          refresh_lease_until: null,
        };
        return Promise.resolve({ data: null, error: null });
      }
      if (name === "integration_token_delete") {
        v.deleted++;
        v.row = null;
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_c: string, _v: string) => {
          v.updates.push(patch);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

async function seededVault(keys: Awaited<ReturnType<typeof deriveKeys>>, opts: { accessLeftMs: number; leaseRpc?: boolean; now: () => number }): Promise<FakeVault> {
  return {
    row: {
      refresh_token_hex: await encryptToHex(keys, "refresh-OLD"),
      access_token_hex: await encryptToHex(keys, "access-OLD"),
      access_expires_at: new Date(opts.now() + opts.accessLeftMs).toISOString(),
      rotated_at: null,
    },
    leaseRpc: opts.leaseRpc ?? true,
    sets: [],
    updates: [],
    deleted: 0,
    begins: 0,
    now: opts.now,
  };
}

Deno.test("getAccessToken: fresh token (>5 min left) is returned without calling Zoom", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const t = 1_800_000_000_000;
  const v = await seededVault(keys, { accessLeftMs: 6 * 60_000, now: () => t });
  let zoomCalls = 0;
  const tok = await getAccessToken({ sb: fakeSb(v), keys, env: ENV, now: () => t, fetchImpl: () => { zoomCalls++; return Promise.reject(new Error("must not be called")); } }, { id: "int-1" });
  assertEquals(tok, "access-OLD");
  assertEquals(zoomCalls, 0);
  assertEquals(v.begins, 0);
});

Deno.test("getAccessToken: <5 min left → refresh, rotate the stored refresh token, bump expires_at", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const t = 1_800_000_000_000;
  const v = await seededVault(keys, { accessLeftMs: 4 * 60_000, now: () => t });
  let sentRefresh = "";
  const fetchImpl: typeof fetch = (_u, init) => {
    sentRefresh = new URLSearchParams(String(init!.body)).get("refresh_token") ?? "";
    return Promise.resolve(jsonRes(200, { access_token: "access-NEW", token_type: "bearer", refresh_token: "refresh-NEW", expires_in: 3600, scope: "a b" }));
  };
  const tok = await getAccessToken({ sb: fakeSb(v), keys, env: ENV, now: () => t, fetchImpl, sleepImpl: noSleep }, { id: "int-1" });
  assertEquals(tok, "access-NEW");
  assertEquals(sentRefresh, "refresh-OLD");
  assertEquals(v.sets.length, 1);
  assertEquals(await decryptFromHex(keys, v.sets[0].p_refresh_hex!), "refresh-NEW", "rotated refresh token stored encrypted");
  assertEquals(await decryptFromHex(keys, v.sets[0].p_access_hex), "access-NEW");
  assertEquals(v.sets[0].p_access_expires_at, new Date(t + 3600_000).toISOString());
  assertEquals(v.begins, 1);
  assertEquals(v.row?.refresh_lease_until, null, "lease cleared by token_set");
  const patch = v.updates.at(-1)!;
  assertEquals(patch.status, "connected");
  assertEquals(patch.expires_at, new Date(t + 90 * 86400_000).toISOString(), "90-day refresh lifetime restarts on rotation");
  assertEquals(patch.scopes, ["a", "b"]);
});

Deno.test("getAccessToken: invalid_grant → vault deleted, status needs_reconnect, NeedsReconnect thrown", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const t = 1_800_000_000_000;
  const v = await seededVault(keys, { accessLeftMs: 0, now: () => t });
  const fetchImpl: typeof fetch = () => Promise.resolve(jsonRes(400, { error: "invalid_grant", reason: "Invalid Token!" }));
  await assertRejects(() => getAccessToken({ sb: fakeSb(v), keys, env: ENV, now: () => t, fetchImpl, sleepImpl: noSleep }, { id: "int-1" }), NeedsReconnect);
  assertEquals(v.deleted, 1);
  assertEquals(v.updates.at(-1)?.status, "needs_reconnect");
  assertEquals(v.sets.length, 0);
});

Deno.test("getAccessToken: no vault row → NeedsReconnect (never a crash)", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const v: FakeVault = { row: null, leaseRpc: true, sets: [], updates: [], deleted: 0, begins: 0, now: Date.now };
  await assertRejects(() => getAccessToken({ sb: fakeSb(v), keys, env: ENV }, { id: "int-1" }), NeedsReconnect);
});

Deno.test("getAccessToken: single-flight — the second caller waits for the first one's write and never hits Zoom", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  let t = 1_800_000_000_000;
  const now = () => t;
  const v = await seededVault(keys, { accessLeftMs: 60_000, now });
  let zoomCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const fetchImpl: typeof fetch = async () => {
    zoomCalls++;
    await gate; // hold the first refresh open so the second caller sees the lease
    return jsonRes(200, { access_token: "access-NEW", token_type: "bearer", refresh_token: "refresh-NEW", expires_in: 3600 });
  };
  const sb = fakeSb(v);
  const first = getAccessToken({ sb, keys, env: ENV, now, fetchImpl, sleepImpl: noSleep }, { id: "int-1" });
  await new Promise((r) => setTimeout(r, 5)); // let the first caller take the lease
  let secondPolled = 0;
  const second = getAccessToken({ sb, keys, env: ENV, now, fetchImpl, sleepImpl: () => { secondPolled++; if (secondPolled === 2) release(); return new Promise((r) => setTimeout(r, 2)); } }, { id: "int-1" });
  const [a, b] = await Promise.all([first, second]);
  assertEquals(a, "access-NEW");
  assertEquals(b, "access-NEW");
  assertEquals(zoomCalls, 1, "exactly one refresh against Zoom");
  assertEquals(v.begins, 2);
  assertEquals(v.sets.length, 1);
  t += 1; // silence unused-assignment lint
});

Deno.test("getAccessToken: refresh 5xx releases the lease and surfaces retry", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const t = 1_800_000_000_000;
  const v = await seededVault(keys, { accessLeftMs: 0, now: () => t });
  const e = await assertRejects(
    () => getAccessToken({ sb: fakeSb(v), keys, env: ENV, now: () => t, fetchImpl: () => Promise.resolve(jsonRes(503, {})), sleepImpl: noSleep }, { id: "int-1" }),
    ZoomError,
  );
  assertEquals(e.cls.kind, "retry");
  assertEquals(v.row?.refresh_lease_until, null, "lease released");
  assertEquals(v.deleted, 0, "vault kept: a transient failure must not force a reconnect");
});

Deno.test("getAccessToken: works (unleased) when 006 is not installed yet", async () => {
  const keys = await deriveKeys(ENV.tokenKeyB64);
  const t = 1_800_000_000_000;
  const v = await seededVault(keys, { accessLeftMs: 0, leaseRpc: false, now: () => t });
  const fetchImpl: typeof fetch = () => Promise.resolve(jsonRes(200, { access_token: "access-NEW", token_type: "bearer", refresh_token: "refresh-NEW", expires_in: 3600 }));
  const tok = await getAccessToken({ sb: fakeSb(v), keys, env: ENV, now: () => t, fetchImpl, sleepImpl: noSleep }, { id: "int-1" });
  assertEquals(tok, "access-NEW");
  assertEquals(v.sets.length, 1);
});
