// deno test -A tests/  — mb-agent: key/token hashing + formats, token rotation, GUID determinism, assignment shaping,
// report state mapping (pure, _shared/agent.ts) and the handler end-to-end against the routed fake fetch
// (PostgREST rpc/tables, Storage sign + download).
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  asEmail,
  assignmentGuid,
  cleanEvidence,
  isAgentOs,
  KEY_RE,
  mapReportState,
  MB_GUID_NAMESPACE,
  newDeviceToken,
  pickEmployee,
  platformForOs,
  POLL_SECONDS,
  pushKey,
  reportStatesFor,
  ROTATE_BELOW_MS,
  safeUrl,
  sha256Hex,
  shapeAssignments,
  shapeMeetAssignment,
  shouldRotate,
  tileLabel,
  TOKEN_RE,
  TOKEN_TTL_MS,
  uuidV5,
} from "../_shared/agent.ts";
import { actionOf, deliveryPlatform, ENROLL_FAILS_PER_WINDOW, escapeLike, FailureLimiter, makeHandler, ownPlatform, sourceIp } from "../mb-agent/handler.ts";
import { ASSET, BG, configure, EMP, eventsOk, j, JPG, ORG, patchOk, rest, router, rpc, SB_URL, THUMB, type Route } from "./_fake.ts";

// ------------------------------------------------------------------ pure rules
Deno.test("agent: key + token formats; sha256 of the plaintext is what the DB stores", async () => {
  // the SQL side: 'mbk_' || base64url(24 random bytes) → 32 chars
  const key = "mbk_" + "A".repeat(32);
  assert(KEY_RE.test(key));
  assert(!KEY_RE.test("mbk_" + "A".repeat(31)));
  assert(!KEY_RE.test("mbd_" + "A".repeat(32)));
  assert(!KEY_RE.test("mbk_" + "A".repeat(31) + "+"), "url-safe alphabet only");
  const t = newDeviceToken();
  assert(TOKEN_RE.test(t), t);
  assertEquals(t.length, 44);
  assertNotEquals(newDeviceToken(), t);
  // known vector: sha256("abc")
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assertEquals((await sha256Hex(key)).length, 64);
  assertEquals(await sha256Hex(key), await sha256Hex(key));
  assertNotEquals(await sha256Hex(key), await sha256Hex(key.slice(0, -1) + "B"));
});

Deno.test("agent: token rotation when < 30 days remain; expiry", () => {
  const now = Date.UTC(2026, 8, 17);
  assertEquals(shouldRotate(new Date(now + TOKEN_TTL_MS).toISOString(), now), false, "fresh token: 90 days left");
  assertEquals(shouldRotate(new Date(now + ROTATE_BELOW_MS + 1000).toISOString(), now), false, "just over 30 days: keep");
  assertEquals(shouldRotate(new Date(now + ROTATE_BELOW_MS - 1000).toISOString(), now), true, "just under 30 days: rotate");
  assertEquals(shouldRotate(null, now), true, "no expiry recorded: rotate");
  assertEquals(shouldRotate("garbage", now), true);
});

Deno.test("agent: GUID is a deterministic uuid v5 of (org, employee, background)", async () => {
  const a = await assignmentGuid(ORG, EMP(1), BG);
  const b = await assignmentGuid(ORG.toUpperCase(), EMP(1), BG.toUpperCase());
  assertEquals(a, b, "case of the input ids does not matter");
  assertEquals(a, a.toUpperCase(), "upper-case like the export pack's file names");
  assert(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(a), a);
  assertNotEquals(a, await assignmentGuid(ORG, EMP(2), BG), "another employee → another file");
  assertNotEquals(a, await assignmentGuid(ORG, EMP(1), THUMB), "another background → another file");
  // RFC 4122 appendix vector: v5 of "python.org" under the DNS namespace
  assertEquals(await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
  assert(/^[0-9a-f-]{36}$/.test(MB_GUID_NAMESPACE));
});

Deno.test("agent: tile label + push key + e-mail / employee helpers", () => {
  assertEquals(tileLabel("Walnut lobby"), "MeetingBrand - Walnut lobby");
  assertEquals(tileLabel(null), "MeetingBrand");
  assertEquals(tileLabel('a/b\\c:d*e?"<>|'), "MeetingBrand - a b c d e");
  assertEquals(pushKey(ORG, EMP(1), BG), `${ORG}:${EMP(1)}:${BG}:teams`);
  assertEquals(asEmail("  Jane.Doe@Acme.COM "), "jane.doe@acme.com");
  assertEquals(asEmail("DESKTOP-1\\jane"), null);
  assertEquals(asEmail(42), null);
  // PostgREST rewrites `*` to `%` inside ilike filters and nothing can escape it: wildcards are refused up front
  assertEquals(asEmail("*@*.*"), null);
  assertEquals(asEmail("%@acme.com"), null);
  assertEquals(asEmail("j*ne@acme.com"), null);
  assertEquals(asEmail("jane@acme.com,or=(x)"), null);
  assertEquals(asEmail("jane\\@acme.com"), null);
  assertEquals(asEmail("jane_o'brien+mb@sub.acme.co.il"), "jane_o'brien+mb@sub.acme.co.il", "real e-mails with _ ' + still pass (the _ is escaped for LIKE)");
  const rows = [
    { id: "z", platform: "zoom", active: true },
    { id: "c1", platform: "csv", active: false },
    { id: "c2", platform: "csv", active: true },
    { id: "t", platform: "teams", active: false },
  ];
  assertEquals(pickEmployee(rows)!.id, "t", "the Teams directory row wins even when inactive");
  assertEquals(pickEmployee(rows.filter((r) => r.platform !== "teams"))!.id, "c2", "same platform: the active row first");
  assertEquals(pickEmployee([]), null);
  assertEquals(escapeLike("a_b%c\\d@x.com"), "a\\_b\\%c\\\\d@x.com");
  assertEquals(actionOf(new URL("https://x/functions/v1/mb-agent/enroll")), "enroll");
  assertEquals(actionOf(new URL("https://x/functions/v1/mb-agent?action=report")), "report");
  assertEquals(actionOf(new URL("https://x/functions/v1/mb-agent/")), "");
});

Deno.test("agent: assignment shaping — assigned vs starters, exports only, removes for unassigned written pairs, re-queues", () => {
  const bgs = [
    { id: "a", label: "A", slug: "a", export_asset_id: "xa", thumb_asset_id: null },
    { id: "b", label: "B", slug: "b", export_asset_id: null, thumb_asset_id: null }, // no export yet
    { id: "c", label: "C", slug: "c", export_asset_id: "xc", thumb_asset_id: "tc" },
    { id: "s", label: "S", slug: "s", export_asset_id: "xs", thumb_asset_id: null },
  ];
  // explicit assignment: a (export), b (no export), c (export) — 'other' is not this org's
  let r = shapeAssignments({ assigned: ["a", "b", "c", "other", "a"], starters: ["s"], backgrounds: bgs, existing: [], active: true, revoked: false });
  assertEquals(r.write.map((b) => b.id), ["a", "c"]);
  assertEquals(r.skipped, ["b"]);
  assertEquals(r.remove, []);
  assertEquals(r.queue, ["a", "c"], "new pairs get a queued row");
  // empty assignment → starters
  r = shapeAssignments({ assigned: [], starters: ["s", "b"], backgrounds: bgs, existing: [], active: true, revoked: false });
  assertEquals(r.write.map((b) => b.id), ["s"]);
  assertEquals(r.skipped, ["b"]);
  // c was unassigned after being written → remove; a stays available (no re-queue); failed 'old' is left alone
  r = shapeAssignments({
    assigned: ["a"],
    starters: [],
    backgrounds: bgs,
    existing: [{ id: "p1", background_id: "a", state: "available" }, { id: "p2", background_id: "c", state: "available" }, { id: "p3", background_id: "old", state: "failed" }, { id: "p4", background_id: "s", state: "queued" }],
    active: true,
    revoked: false,
  });
  assertEquals(r.write.map((b) => b.id), ["a"]);
  assertEquals(r.remove, ["c", "s"]);
  assertEquals(r.queue, []);
  // a blocked pair that is still assigned is re-queued (the agent retries; blocked again = honest live state)
  r = shapeAssignments({ assigned: ["a"], starters: [], backgrounds: bgs, existing: [{ id: "p1", background_id: "a", state: "blocked" }], active: true, revoked: false });
  assertEquals(r.queue, ["a"]);
  // inactive employee → nothing written, everything written before removed
  r = shapeAssignments({ assigned: ["a"], starters: ["s"], backgrounds: bgs, existing: [{ id: "p1", background_id: "a", state: "available" }], active: false, revoked: false });
  assertEquals(r.write, []);
  assertEquals(r.remove, ["a"]);
  // revoked agent → same
  r = shapeAssignments({ assigned: ["a"], starters: [], backgrounds: bgs, existing: [{ id: "p1", background_id: "a", state: "pushed" }], active: true, revoked: true });
  assertEquals(r.write, []);
  assertEquals(r.remove, ["a"]);
});

Deno.test("agent: report state → pushes.state mapping + evidence cleaning", () => {
  assertEquals(mapReportState("written", null), { pushState: "available", error: null, event: "push_delivered" });
  assertEquals(mapReportState("verified", { sha256: "x" }), { pushState: "available", error: null, event: "push_delivered" });
  assertEquals(mapReportState("restart_needed", null).pushState, "pushed");
  const rm = mapReportState("removed", null);
  assertEquals(rm.pushState, "failed");
  assertStringIncludes(rm.error!, "removed by the agent");
  assertEquals(rm.event, "push_removed");
  const bl = mapReportState("blocked", { message: "container write denied (macOS 27: needs the PPPC Full Disk Access profile)" });
  assertEquals(bl.pushState, "blocked");
  assertStringIncludes(bl.error!, "Full Disk Access");
  assertEquals(mapReportState("error", { message: "" }).error, "agent error (no message)");
  assertEquals(mapReportState("error", { message: "x".repeat(900) }).error!.length, 500);
  assertEquals(cleanEvidence(null), null);
  assertEquals(cleanEvidence([1]), null);
  const ev = cleanEvidence({ path: "/Users/x/Library/…/Uploads/G.png", sha256: "AB".repeat(32), bytes: 12.7, thumbBytes: -1, teamsRunning: true, message: "ok", extra: "dropped" });
  assertEquals(ev, { path: "/Users/x/Library/…/Uploads/G.png", sha256: "ab".repeat(32), bytes: 12, teamsRunning: true, message: "ok" });
  assertEquals(cleanEvidence({ sha256: "not-hex" }), {});
});

// ------------------------------------------------------------------ handler: fake backend
const AGENT = "77777777-7777-4777-8777-777777777777";
const KEY = "mbk_" + "k".repeat(32);
const STARTER = "88888888-8888-4888-8888-888888888888";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);

interface Store {
  key: { revoked: boolean; limited: boolean; exists: boolean };
  employees: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  backgrounds: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  pushes: Array<Record<string, unknown>>;
  reports: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  patches: Array<{ table: string; query: string; body: Record<string, unknown> }>;
}

function fresh(over: Partial<Store> = {}): Store {
  return {
    key: { revoked: false, limited: false, exists: true },
    employees: [{ id: EMP(1), org_id: ORG, platform: "csv", email: "jane@acme.com", name: "Jane", active: true, assigned_bg: [] }],
    agents: [],
    backgrounds: [{ id: STARTER, org_id: ORG, label: "Walnut lobby", slug: "walnut", export_asset_id: ASSET, thumb_asset_id: THUMB, state: { starter: true }, created_at: "2026-09-01T00:00:00Z" }],
    assets: [
      { id: ASSET, org_id: ORG, bucket: "mb-exports", storage_path: `${ORG}/${STARTER}.png`, mime: "image/png", bytes: null, sha256: null },
      { id: THUMB, org_id: ORG, bucket: "mb-exports", storage_path: `${ORG}/${STARTER}_thumb.png`, mime: "image/png", bytes: 100, sha256: null },
    ],
    pushes: [],
    reports: [],
    events: [],
    patches: [],
    ...over,
  };
}

/** Enough PostgREST to run the four actions: eq/in/ilike filters on the tables mb-agent touches, upsert, patch, rpc. */
function backend(st: Store) {
  const filt = (rows: Array<Record<string, unknown>>, u: URL) => {
    let out = rows;
    for (const [k, v] of u.searchParams) {
      if (["select", "limit", "order", "on_conflict", "columns"].includes(k)) continue;
      const col = k.includes("->>") ? k : k;
      const m = /^(eq|in|ilike)\.(.*)$/s.exec(v);
      if (!m) continue;
      const [, op, val] = m;
      const get = (r: Record<string, unknown>) => {
        if (col.includes("->>")) {
          const [c, p] = col.split("->>");
          const o = r[c] as Record<string, unknown> | undefined;
          return o ? String(o[p]) : undefined;
        }
        return r[col];
      };
      if (op === "eq") out = out.filter((r) => String(get(r)) === val);
      else if (op === "in") {
        const set = new Set(val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")));
        out = out.filter((r) => set.has(String(get(r))));
      } else if (op === "ilike") {
        const want = val.replace(/\\(.)/g, "$1").replace(/\*/g, "%").toLowerCase();
        out = out.filter((r) => String(get(r) ?? "").toLowerCase() === want);
      }
    }
    return out;
  };
  const table = (name: string, rows: () => Array<Record<string, unknown>>): Route[] => [
    { method: "GET", test: rest(name), reply: (_r, u) => j(200, filt(rows(), u)) },
    { method: "PATCH", test: rest(name), reply: (_r, u, body) => {
      const patch = JSON.parse(body);
      const hit = filt(rows(), u);
      for (const r of hit) Object.assign(r, patch);
      st.patches.push({ table: name, query: u.search, body: patch });
      return new Response(null, { status: 204 });
    } },
  ];
  const routes: Route[] = [
    { method: "POST", test: rpc("enrollment_key_use"), reply: async (_r, _u, body) => {
      const b = JSON.parse(body);
      assertEquals(b.p_key_hash, await sha256Hex(KEY), "the plaintext key never reaches the database");
      assertEquals(b.p_limit, 60);
      if (!st.key.exists) return j(200, []);
      return j(200, [{ key_id: "k1", key_org_id: ORG, revoked: st.key.revoked, limited: st.key.limited }]);
    } },
    ...table("employees", () => st.employees),
    ...table("agents", () => st.agents),
    { method: "POST", test: rest("agents"), reply: (_r, _u, body) => {
      const row = { id: AGENT, ...JSON.parse(body) };
      st.agents.push(row);
      return j(201, [{ id: row.id }]);
    } },
    ...table("backgrounds", () => st.backgrounds),
    ...table("brand_assets", () => st.assets),
    ...table("pushes", () => st.pushes),
    { method: "POST", test: rest("pushes"), reply: (req, _u, body) => {
      assertStringIncludes(req.headers.get("prefer") ?? "", "resolution=merge-duplicates");
      const rows = JSON.parse(body) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const prev = st.pushes.find((p) => p.idempotency_key === r.idempotency_key);
        if (prev) Object.assign(prev, r);
        else st.pushes.push({ id: `p-${st.pushes.length + 1}`, ...r });
      }
      return new Response(null, { status: 201 });
    } },
    { method: "POST", test: rest("agent_reports"), reply: (_r, _u, body) => {
      st.reports.push(JSON.parse(body));
      return new Response(null, { status: 201 });
    } },
    { method: "POST", test: rest("events"), reply: (_r, _u, body) => {
      st.events.push(JSON.parse(body));
      return new Response(null, { status: 201 });
    } },
    { method: "POST", test: (u) => u.pathname.startsWith("/storage/v1/object/sign/mb-exports/"), reply: (_r, u) => j(200, { signedURL: `${u.pathname.replace("/storage/v1", "")}?token=sig` }) },
    { method: "GET", test: (u) => u.pathname === `/storage/v1/object/mb-exports/${ORG}/${STARTER}.png`, reply: () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }) },
    { method: "GET", test: (u) => u.pathname === `/storage/v1/object/mb-exports/${ORG}/${STARTER}.jpg`, reply: () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }) },
  ];
  return router(routes);
}

const fnUrl = (action: string) => `${SB_URL}/functions/v1/mb-agent/${action}`;
const post = (action: string, body: unknown, token?: string) => new Request(fnUrl(action), { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const get = (action: string, token?: string) => new Request(fnUrl(action), { method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} });
const enrollBody = { orgKey: KEY, deviceId: "MAC-0001", os: "macos", hostname: "janes-mbp", localIdentity: "jane@acme.com", version: "0.1.0" };

Deno.test("mb-agent: routing — unknown action 404, wrong method 405, CORS preflight harmless", async () => {
  configure();
  const h = makeHandler({ fetchImpl: () => Promise.reject(new Error("no network")) });
  assertEquals((await h(new Request(fnUrl("nope"), { method: "POST" }))).status, 404);
  assertEquals((await h(new Request(fnUrl("enroll"), { method: "GET" }))).status, 405);
  assertEquals((await h(new Request(fnUrl("assignments"), { method: "POST" }))).status, 405);
  const pf = await h(new Request(fnUrl("enroll"), { method: "OPTIONS", headers: { origin: "https://meetingbrand.com" } }));
  assertEquals(pf.status, 204);
});

Deno.test("mb-agent /enroll: bad / unknown / revoked / rate-limited keys; validation", async () => {
  configure();
  const st = fresh();
  const be = backend(st);
  const h = makeHandler({ fetchImpl: be.fetchImpl });
  let r = await h(post("enroll", { ...enrollBody, orgKey: "mbk_short" }));
  assertEquals(r.status, 401);
  assertEquals(be.seen.length, 0, "a malformed key never reaches the database");
  r = await h(post("enroll", { ...enrollBody, os: "linux" }));
  assertEquals(r.status, 400);
  r = await h(post("enroll", { ...enrollBody, deviceId: "bad id/with spaces" }));
  assertEquals(r.status, 400);
  r = await h(post("enroll", { ...enrollBody, employeeEmail: "not-an-email" }));
  assertEquals(r.status, 400);
  st.key.exists = false;
  r = await h(post("enroll", enrollBody));
  assertEquals(r.status, 401);
  assertEquals((await r.json()).error, "bad_key");
  st.key.exists = true;
  st.key.revoked = true;
  r = await h(post("enroll", enrollBody));
  assertEquals(r.status, 410);
  st.key.revoked = false;
  st.key.limited = true;
  r = await h(post("enroll", enrollBody));
  assertEquals(r.status, 429);
  assertEquals((await r.json()).retry_after_ms, 60000);
  assertEquals(st.agents.length, 0, "no agent row on any refusal");
  // a wildcard e-mail never reaches the roster query
  st.key.limited = false;
  r = await h(post("enroll", { ...enrollBody, employeeEmail: "*@*.*" }));
  assertEquals(r.status, 400);
  assert(!be.seen.some((u) => u.path.includes("/rest/v1/employees")), "no employees query for a wildcard e-mail");
});

Deno.test("mb-agent /enroll: a source that keeps sending refused keys is cut off before the database (per-IP failure limiter)", async () => {
  configure();
  const st = fresh();
  st.key.exists = false;
  const be = backend(st);
  let t = Date.UTC(2026, 8, 17);
  const lim = new FailureLimiter();
  const h = makeHandler({ fetchImpl: be.fetchImpl, now: () => t, enrollFailures: lim });
  const from = (ip: string, body: unknown = enrollBody) => new Request(fnUrl("enroll"), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` }, body: JSON.stringify(body) });
  for (let i = 0; i < ENROLL_FAILS_PER_WINDOW; i++) {
    const r = await h(from("203.0.113.7"));
    assertEquals(r.status, 401);
  }
  const rpcCalls = be.seen.filter((u) => u.path.includes("enrollment_key_use")).length;
  assertEquals(rpcCalls, ENROLL_FAILS_PER_WINDOW);
  let r = await h(from("203.0.113.7"));
  assertEquals(r.status, 429, "the 31st refused attempt is cut off");
  assertEquals((await r.json()).error, "rate_limited");
  assertEquals(be.seen.filter((u) => u.path.includes("enrollment_key_use")).length, rpcCalls, "no database call once limited");
  // another address is unaffected; a malformed key counts as a failure too but never reaches the RPC
  r = await h(from("203.0.113.8", { ...enrollBody, orgKey: "mbk_nope" }));
  assertEquals(r.status, 401);
  assertEquals(be.seen.filter((u) => u.path.includes("enrollment_key_use")).length, rpcCalls);
  // a valid key from the limited address is still refused until the window passes, then works again
  st.key.exists = true;
  r = await h(from("203.0.113.7"));
  assertEquals(r.status, 429);
  t += 10 * 60_000;
  r = await h(from("203.0.113.7"));
  assertEquals(r.status, 200, "window passed → enrolled");
  // successful enrollments never count: 40 of them from one office NAT stay 200
  for (let i = 0; i < 40; i++) {
    const rr = await h(from("198.51.100.2", { ...enrollBody, deviceId: `PC-${i}` }));
    assertEquals(rr.status, 200);
  }
  assertEquals(sourceIp(new Request("https://x", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } })), "203.0.113.7");
  assertEquals(sourceIp(new Request("https://x")), "?");
});

Deno.test("mb-agent /enroll: matches by localIdentity e-mail, stores only the token hash, re-enroll refreshes the same row; unmatched is reported clearly", async () => {
  configure();
  const st = fresh();
  const be = backend(st);
  const h = makeHandler({ fetchImpl: be.fetchImpl, now: () => Date.UTC(2026, 8, 17) });
  const r = await h(post("enroll", enrollBody));
  assertEquals(r.status, 200);
  const b = await r.json();
  assert(TOKEN_RE.test(b.deviceToken), b.deviceToken);
  assertEquals(b.agentId, AGENT);
  assertEquals(b.state, "matched");
  assertEquals(b.employee, { id: EMP(1), email: "jane@acme.com", name: "Jane", active: true });
  assertEquals(b.pollSeconds, POLL_SECONDS);
  assertEquals(b.tokenExpiresAt, new Date(Date.UTC(2026, 8, 17) + TOKEN_TTL_MS).toISOString());
  assertEquals(st.agents.length, 1);
  const row = st.agents[0];
  assertEquals(row.token_hash, await sha256Hex(b.deviceToken));
  assertEquals(row.employee_id, EMP(1));
  assertEquals(row.os, "macos");
  assertEquals(row.revoked_at, null);
  assertEquals(JSON.stringify(st).includes(b.deviceToken), false, "the plaintext device token is never stored");
  assertEquals(st.events.filter((e) => e.event === "agent_enrolled").length, 1);

  // re-enroll from the same device: same row, new token, revoked flag cleared
  row.revoked_at = "2026-09-10T00:00:00Z";
  const r2 = await h(post("enroll", { ...enrollBody, version: "0.2.0" }));
  const b2 = await r2.json();
  assertEquals(r2.status, 200);
  assertEquals(b2.agentId, AGENT);
  assertNotEquals(b2.deviceToken, b.deviceToken);
  assertEquals(st.agents.length, 1, "one row per (org, device)");
  assertEquals(st.agents[0].token_hash, await sha256Hex(b2.deviceToken));
  assertEquals(st.agents[0].revoked_at, null);
  assertEquals(st.agents[0].version, "0.2.0");

  // explicit employeeEmail wins over the local identity; unknown person → unmatched, agent row without employee
  const st2 = fresh();
  const h2 = makeHandler({ fetchImpl: backend(st2).fetchImpl });
  const r3 = await h2(post("enroll", { ...enrollBody, deviceId: "WIN-0002", os: "windows", localIdentity: "CORP\\jdoe", employeeEmail: "nobody@acme.com" }));
  const b3 = await r3.json();
  assertEquals(r3.status, 200);
  assertEquals(b3.state, "unmatched");
  assertEquals(b3.employee, null);
  assertStringIncludes(b3.detail, "nobody@acme.com");
  assertEquals(st2.agents[0].employee_id, null);
  // Windows identity without an e-mail → no lookup at all
  const st3 = fresh();
  const be3 = backend(st3);
  const h3 = makeHandler({ fetchImpl: be3.fetchImpl });
  await h3(post("enroll", { ...enrollBody, deviceId: "WIN-0003", os: "windows", localIdentity: "CORP\\jdoe" }));
  assertEquals(be3.calls("GET", "/rest/v1/employees").length, 0);
});

Deno.test("mb-agent: device-token auth — missing/malformed/unknown → 401, expired → 401, revoked → 410 on every action", async () => {
  configure();
  const st = fresh();
  const be = backend(st);
  const h = makeHandler({ fetchImpl: be.fetchImpl });
  assertEquals((await h(get("assignments"))).status, 401);
  assertEquals((await h(get("assignments", "mbd_short"))).status, 401);
  assertEquals((await h(post("heartbeat", {}, "user-jwt"))).status, 401);
  assertEquals(be.seen.length, 0, "no database round trip for a malformed token");
  assertEquals((await h(get("assignments", newDeviceToken()))).status, 401, "unknown token");

  const tok = newDeviceToken();
  st.agents.push({ id: AGENT, org_id: ORG, employee_id: EMP(1), device_id: "d", os: "macos", version: null, token_hash: await sha256Hex(tok), token_expires_at: "2026-01-01T00:00:00Z", revoked_at: null });
  const ex = await h(get("assignments", tok));
  assertEquals(ex.status, 401);
  assertEquals((await ex.json()).error, "token_expired");

  st.agents[0].token_expires_at = "2099-01-01T00:00:00Z";
  st.agents[0].revoked_at = "2026-09-16T00:00:00Z";
  st.pushes.push({ id: "p1", org_id: ORG, employee_id: EMP(1), background_id: STARTER, platform: "teams", state: "available", idempotency_key: pushKey(ORG, EMP(1), STARTER) });
  const rv = await h(get("assignments", tok));
  assertEquals(rv.status, 410);
  const body = await rv.json();
  assertEquals(body.error, "revoked");
  assertEquals(body.action, "remove_all");
  assertEquals(body.assignments.length, 1);
  assertEquals(body.assignments[0].action, "remove");
  assertEquals(body.assignments[0].guid, await assignmentGuid(ORG, EMP(1), STARTER));
  assertEquals((await h(post("report", { items: [{ backgroundId: STARTER, state: "removed" }] }, tok))).status, 410);
  assertEquals((await h(post("heartbeat", {}, tok))).status, 410);
});

Deno.test("mb-agent /assignments: starters when nothing is assigned, signed URLs, sha256 computed + stored once, queued push rows, token rotation", async () => {
  configure();
  const st = fresh();
  const be = backend(st);
  const NOW = Date.UTC(2026, 8, 17);
  const h = makeHandler({ fetchImpl: be.fetchImpl, now: () => NOW });
  const tok = newDeviceToken();
  st.agents.push({ id: AGENT, org_id: ORG, employee_id: EMP(1), device_id: "d", os: "macos", version: "0.1.0", token_hash: await sha256Hex(tok), token_expires_at: new Date(NOW + TOKEN_TTL_MS).toISOString(), revoked_at: null });

  const r = await h(get("assignments", tok));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.state, "matched");
  assertEquals(b.assignments.length, 1);
  const a = b.assignments[0];
  assertEquals(a.platform, "teams");
  assertEquals(a.backgroundId, STARTER);
  assertEquals(a.action, "write");
  assertEquals(a.guid, await assignmentGuid(ORG, EMP(1), STARTER));
  assertEquals(a.label, "MeetingBrand - Walnut lobby");
  assertStringIncludes(a.pngUrl, `/object/sign/mb-exports/${ORG}/${STARTER}.png?token=sig`);
  assertStringIncludes(a.thumbUrl, `${STARTER}_thumb.png?token=sig`);
  assertEquals(a.sha256, await sha256Hex(PNG));
  assertEquals(a.bytes, PNG.byteLength);
  assertEquals(b.deviceToken, undefined, "90 days left: no rotation");
  assertEquals(b.pollSeconds, POLL_SECONDS);
  // sha256 stored on the asset row
  assertEquals(st.assets[0].sha256, await sha256Hex(PNG));
  assertEquals(st.assets[0].bytes, PNG.byteLength);
  assertEquals(be.calls("GET", "/storage/v1/object/mb-exports/").length, 1, "downloaded once to hash it");
  // queued push row with the teams idempotency key
  assertEquals(st.pushes.length, 1);
  assertEquals(st.pushes[0].idempotency_key, pushKey(ORG, EMP(1), STARTER));
  assertEquals(st.pushes[0].state, "queued");
  assertEquals(st.pushes[0].platform, "teams");
  assertEquals(st.pushes[0].agent_id, AGENT);
  assertEquals(st.agents[0].last_seen_at, new Date(NOW).toISOString());

  // second poll: no download (sha stored), no new queue row, still one write
  const r2 = await h(get("assignments", tok));
  const b2 = await r2.json();
  assertEquals(b2.assignments.length, 1);
  assertEquals(be.calls("GET", "/storage/v1/object/mb-exports/").length, 1, "hash re-used from brand_assets.sha256");
  assertEquals(st.pushes.length, 1);

  // token with 10 days left → rotated; the new hash is stored, the old one is gone
  st.agents[0].token_expires_at = new Date(NOW + 10 * 24 * 3600 * 1000).toISOString();
  const r3 = await h(get("assignments", tok));
  const b3 = await r3.json();
  assert(TOKEN_RE.test(b3.deviceToken), "rotated token handed out");
  assertNotEquals(b3.deviceToken, tok);
  assertEquals(b3.tokenExpiresAt, new Date(NOW + TOKEN_TTL_MS).toISOString());
  assertEquals(st.agents[0].token_hash, await sha256Hex(b3.deviceToken));
  assertEquals((await h(get("assignments", tok))).status, 401, "the old token is dead after rotation");
  assertEquals((await h(get("assignments", b3.deviceToken))).status, 200);
});

Deno.test("mb-agent /assignments: explicit assigned_bg, no export → skipped (never a 500), unassigned written pair → remove, inactive → removes only, unmatched → []", async () => {
  configure();
  const NOEXP = "99999999-9999-4999-8999-999999999999";
  const st = fresh();
  st.backgrounds.push({ id: NOEXP, org_id: ORG, label: "Not exported", slug: "nx", export_asset_id: null, thumb_asset_id: null, state: {}, created_at: "2026-09-02T00:00:00Z" });
  st.employees[0].assigned_bg = [NOEXP];
  st.pushes.push({ id: "p1", org_id: ORG, employee_id: EMP(1), background_id: STARTER, platform: "teams", state: "available", idempotency_key: pushKey(ORG, EMP(1), STARTER) });
  const be = backend(st);
  const h = makeHandler({ fetchImpl: be.fetchImpl });
  const tok = newDeviceToken();
  st.agents.push({ id: AGENT, org_id: ORG, employee_id: EMP(1), device_id: "d", os: "windows", version: null, token_hash: await sha256Hex(tok), token_expires_at: "2099-01-01T00:00:00Z", revoked_at: null });

  let b = await (await h(get("assignments", tok))).json();
  assertEquals(b.skipped, [NOEXP], "assigned but not exported yet: reported, not written");
  assertEquals(b.assignments.map((x: { action: string; backgroundId: string }) => [x.action, x.backgroundId]), [["remove", STARTER]], "the starter is no longer wanted once an explicit assignment exists");
  assertEquals(st.pushes.length, 1, "no queue row for a skipped pair");
  assertEquals(be.calls("GET", "/rest/v1/backgrounds").some((c) => c.path.includes("starter")), false, "starters are not consulted when assigned_bg is set");

  st.employees[0].active = false;
  st.employees[0].assigned_bg = [STARTER];
  b = await (await h(get("assignments", tok))).json();
  assertEquals(b.state, "inactive");
  assertEquals(b.assignments.map((x: { action: string }) => x.action), ["remove"]);

  st.agents[0].employee_id = null;
  b = await (await h(get("assignments", tok))).json();
  assertEquals(b.state, "unmatched");
  assertEquals(b.assignments, []);
});

Deno.test("mb-agent /report: maps states into pushes + agent_reports + events; fake item → 422, mixed → 200 with per-item results; validation 400", async () => {
  configure();
  const st = fresh();
  st.pushes.push({ id: "p1", org_id: ORG, employee_id: EMP(1), background_id: STARTER, platform: "teams", state: "queued", idempotency_key: pushKey(ORG, EMP(1), STARTER) });
  const be = backend(st);
  const h = makeHandler({ fetchImpl: be.fetchImpl });
  const tok = newDeviceToken();
  st.agents.push({ id: AGENT, org_id: ORG, employee_id: EMP(1), device_id: "d", os: "macos", version: "0.1.0", token_hash: await sha256Hex(tok), token_expires_at: "2099-01-01T00:00:00Z", revoked_at: null });

  assertEquals((await h(post("report", {}, tok))).status, 400);
  assertEquals((await h(post("report", { items: [] }, tok))).status, 400);
  assertEquals((await h(post("report", { items: new Array(51).fill({ backgroundId: STARTER, state: "written" }) }, tok))).status, 400);

  // a fake background id (never assigned) → 422, nothing written
  const fake = await h(post("report", { items: [{ backgroundId: BG, state: "written", evidence: { path: "/x" } }] }, tok));
  assertEquals(fake.status, 422);
  const fb = await fake.json();
  assertEquals(fb.error, "no_valid_items");
  assertStringIncludes(fb.results[0].error, "unknown_assignment");
  assertEquals(st.reports.length, 0);
  assertEquals(st.pushes[0].state, "queued");

  // real item + a garbage item → 200, per-item results
  const ok = await h(post("report", {
    items: [
      { backgroundId: STARTER, state: "restart_needed", evidence: { path: "/Users/j/Library/Containers/com.microsoft.teams2/…/Uploads/G.png", sha256: await sha256Hex(PNG), bytes: 8, thumbBytes: 100, teamsRunning: true } },
      { backgroundId: "nope", state: "written" },
    ],
  }, tok));
  assertEquals(ok.status, 200);
  const ob = await ok.json();
  assertEquals(ob.accepted, 1);
  assertEquals(ob.rejected, 1);
  assertEquals(ob.results[0], { backgroundId: STARTER, ok: true, state: "pushed" });
  assertEquals(st.pushes[0].state, "pushed");
  assertEquals(st.pushes[0].agent_id, AGENT);
  const ev = st.pushes[0].evidence as Record<string, unknown>;
  assertEquals(ev.via, "agent");
  assertEquals(ev.report, "restart_needed");
  assertEquals(ev.teamsRunning, true);
  assertEquals(st.reports.length, 1);
  assertEquals(st.reports[0].push_id, "p1");
  assertEquals(st.reports[0].state, "restart_needed");
  const delivered = st.events.filter((e) => e.event === "push_delivered");
  assertEquals(delivered.length, 1);
  assertEquals((delivered[0].props as Record<string, unknown>).platform, "teams");
  assertEquals((delivered[0].props as Record<string, unknown>).via, "agent");

  // verified → available; blocked → blocked with the reason; removed → failed 'removed…'
  await h(post("report", { items: [{ backgroundId: STARTER, state: "verified" }] }, tok));
  assertEquals(st.pushes[0].state, "available");
  await h(post("report", { items: [{ backgroundId: STARTER, state: "blocked", evidence: { message: "EACCES: container write denied" } }] }, tok));
  assertEquals(st.pushes[0].state, "blocked");
  assertStringIncludes(String(st.pushes[0].error), "EACCES");
  assertEquals(st.events.filter((e) => e.event === "push_failed").length, 1);
  await h(post("report", { items: [{ backgroundId: STARTER, state: "removed" }] }, tok));
  assertEquals(st.pushes[0].state, "failed");
  assertStringIncludes(String(st.pushes[0].error), "removed by the agent");
  assertEquals(st.events.filter((e) => e.event === "push_removed").length, 1);
  assertEquals(st.reports.length, 4);

  // an unmatched device cannot report
  st.agents[0].employee_id = null;
  assertEquals((await h(post("report", { items: [{ backgroundId: STARTER, state: "written" }] }, tok))).status, 409);
});

Deno.test("mb-agent /heartbeat: last_seen_at + version", async () => {
  configure();
  const st = fresh();
  const be = backend(st);
  const NOW = Date.UTC(2026, 8, 17, 12);
  const h = makeHandler({ fetchImpl: be.fetchImpl, now: () => NOW });
  const tok = newDeviceToken();
  st.agents.push({ id: AGENT, org_id: ORG, employee_id: null, device_id: "d", os: "macos", version: "0.1.0", token_hash: await sha256Hex(tok), token_expires_at: "2099-01-01T00:00:00Z", revoked_at: null });
  const r = await h(post("heartbeat", { version: "0.3.0", teamsRunning: false }, tok));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b, { ok: true, agentId: AGENT, state: "unmatched", pollSeconds: POLL_SECONDS });
  assertEquals(st.agents[0].last_seen_at, new Date(NOW).toISOString());
  assertEquals(st.agents[0].version, "0.3.0");
  const r2 = await h(post("heartbeat", {}, tok));
  assertEquals(r2.status, 200);
  assertEquals(st.agents[0].version, "0.3.0", "no version in the body keeps the stored one");
  assertEquals(be.calls("GET", "/rest/v1/employees").length, 0);
  void eventsOk;
  void patchOk;
});


// ================================================================== the Meet extension (011): os chrome|edge, platform meet
Deno.test("extension: os + platform rules, meet push key, report vocabularies, evidence + url scrubbing", () => {
  assertEquals(["windows", "macos", "chrome", "edge"].every(isAgentOs), true);
  assertEquals(isAgentOs("linux"), false);
  assertEquals(platformForOs("chrome"), "meet");
  assertEquals(platformForOs("edge"), "meet");
  assertEquals(platformForOs("macos"), "teams");
  assertEquals(deliveryPlatform(null, "chrome"), "meet");
  assertEquals(deliveryPlatform("teams", "chrome"), "teams", "an explicit platform wins over the os default");
  assertEquals(deliveryPlatform(" MEET ", "windows"), "meet");
  let threw = 0;
  try { deliveryPlatform("zoom", "chrome"); } catch { threw++; }
  assertEquals(threw, 1);
  // what a device may act on: its own platform only
  assertEquals(ownPlatform(null, "chrome"), "meet");
  assertEquals(ownPlatform("meet", "edge"), "meet");
  assertEquals(ownPlatform(null, "macos"), "teams");
  assertEquals(ownPlatform("teams", "windows"), "teams");
  for (const [v, os] of [["teams", "chrome"], ["meet", "macos"], ["zoom", "windows"]]) {
    try { ownPlatform(v, os); threw++; } catch { /* expected */ }
  }
  assertEquals(threw, 1, "a browser may not act on teams, an OS agent not on meet");
  assertEquals(pushKey(ORG, EMP(1), BG, "meet"), `${ORG}:${EMP(1)}:${BG}:meet`);
  assertEquals(pushKey(ORG, EMP(1), BG), `${ORG}:${EMP(1)}:${BG}:teams`, "default stays teams (the agent's rows keep their keys)");
  assertEquals(reportStatesFor("meet"), ["applied", "unavailable", "error"]);
  assertEquals(reportStatesFor("teams").includes("applied"), false);
  assertEquals(mapReportState("applied", null), { pushState: "selected", error: null, event: "push_delivered" });
  assertEquals(mapReportState("unavailable", { message: "Meet's own effect is on" }), { pushState: "pushed", error: "not applied: Meet's own effect is on", event: "push_delivered" });
  assertEquals(mapReportState("unavailable", null).error, "not applied (no reason given by the extension)");
  assertEquals(safeUrl("https://meet.google.com/abc-defg-hij?authuser=1&pli=1#x"), "https://meet.google.com/abc-defg-hij");
  assertEquals(safeUrl("javascript:alert(1)"), "");
  assertEquals(safeUrl("not a url"), "");
  const ev = cleanEvidence({ url: "https://meet.google.com/abc-defg-hij?hs=1", technique: "B", meetVersionHint: "k=meet.ui.\u0000x".repeat(10), browser: "Chrome 152", fps: 19.96, segMs: 10.0612, message: "ok", bogus: 1 })!;
  assertEquals(ev.url, "https://meet.google.com/abc-defg-hij");
  assertEquals(ev.technique, "B");
  assertEquals(ev.meetVersionHint!.length, 80);
  assertEquals(ev.meetVersionHint!.includes("\u0000"), false);
  assertEquals(ev.browser, "Chrome 152");
  assertEquals(ev.fps, 20);
  assertEquals(ev.segMs, 10.06);
  assertEquals(("bogus" in ev), false);
  assertEquals(cleanEvidence({ technique: "not valid!" })!.technique, undefined);
});

Deno.test("extension: shapeMeetAssignment — one look, JPEG over PNG, PNG when no JPEG, skipped when neither, removes + queue", () => {
  const A = "a1111111-1111-4111-8111-111111111111", B = "b2222222-2222-4222-8222-222222222222", C = "c3333333-3333-4333-8333-333333333333";
  const bgs = [
    { id: A, label: "A", slug: "a", export_asset_id: "png-a", thumb_asset_id: null, export_jpg_asset_id: "jpg-a" },
    { id: B, label: "B", slug: "b", export_asset_id: "png-b", thumb_asset_id: null, export_jpg_asset_id: null },
    { id: C, label: "C", slug: "c", export_asset_id: null, thumb_asset_id: null, export_jpg_asset_id: null },
  ];
  let m = shapeMeetAssignment({ assigned: [A, B], starters: [C], backgrounds: bgs, existing: [], active: true, revoked: false });
  assertEquals(m.apply?.bg.id, A);
  assertEquals(m.apply?.assetId, "jpg-a");
  assertEquals(m.apply?.mime, "image/jpeg");
  assertEquals(m.queue, [A]);
  assertEquals(m.skipped, []);
  m = shapeMeetAssignment({ assigned: [B], starters: [A], backgrounds: bgs, existing: [], active: true, revoked: false });
  assertEquals(m.apply?.assetId, "png-b", "PNG is used when no JPEG export exists");
  assertEquals(m.apply?.mime, "image/png");
  m = shapeMeetAssignment({ assigned: [C, B], starters: [], backgrounds: bgs, existing: [], active: true, revoked: false });
  assertEquals(m.skipped, [C], "no export at all → skipped, the next wanted look is applied");
  assertEquals(m.apply?.bg.id, B);
  m = shapeMeetAssignment({ assigned: [], starters: [A], backgrounds: bgs, existing: [{ id: "p", background_id: B, state: "selected" }, { id: "q", background_id: A, state: "failed" }], active: true, revoked: false });
  assertEquals(m.remove, [B], "a previously applied other look is removed");
  assertEquals(m.queue, [A], "a failed row of the applied look is re-queued");
  m = shapeMeetAssignment({ assigned: [A], starters: [], backgrounds: bgs, existing: [{ id: "p", background_id: A, state: "selected" }], active: false, revoked: false });
  assertEquals(m.apply, null);
  assertEquals(m.remove, [A], "inactive employee: nothing applied, the live look removed");
  m = shapeMeetAssignment({ assigned: [A], starters: [], backgrounds: bgs, existing: [{ id: "p", background_id: A, state: "selected" }], active: true, revoked: false });
  assertEquals(m.queue, [], "an already-selected row is not re-queued");
});

Deno.test("mb-agent /enroll + /assignments for a chrome device: platform meet by default, JPEG preferred, queued 'meet' push, ?platform=teams refused (400), bad platform 400", async () => {
  configure();
  const st = fresh();
  st.backgrounds[0].export_jpg_asset_id = JPG;
  st.assets.push({ id: JPG, org_id: ORG, bucket: "mb-exports", storage_path: `${ORG}/${STARTER}.jpg`, mime: "image/jpeg", bytes: null, sha256: null });
  const be = backend(st);
  const NOW = Date.UTC(2026, 8, 17);
  const h = makeHandler({ fetchImpl: be.fetchImpl, now: () => NOW });
  const er = await h(post("enroll", { orgKey: KEY, deviceId: "ext-uuid-1", os: "chrome", hostname: "Chrome 152 · macOS", version: "1.0.0", employeeEmail: "Jane@ACME.com" }));
  assertEquals(er.status, 200);
  const eb = await er.json();
  assertEquals(eb.state, "matched");
  assertEquals(st.agents[0].os, "chrome");
  assertEquals(st.agents[0].hostname, "Chrome 152 · macOS");
  assertEquals((await h(post("enroll", { orgKey: KEY, deviceId: "x", os: "firefox" }))).status, 400);

  const r = await h(get("assignments", eb.deviceToken));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.platform, "meet");
  assertEquals(b.assignments.length, 1);
  const a = b.assignments[0];
  assertEquals(a.platform, "meet");
  assertEquals(a.action, "apply");
  assertEquals(a.backgroundId, STARTER);
  assertEquals(a.mime, "image/jpeg");
  assertStringIncludes(a.imageUrl, `/object/sign/mb-exports/${ORG}/${STARTER}.jpg?token=sig`);
  assertEquals(a.pngUrl, a.imageUrl);
  assertEquals(a.sha256, await sha256Hex(JPEG));
  assertEquals(a.bytes, JPEG.byteLength);
  assertEquals(a.label, "MeetingBrand - Walnut lobby");
  assertStringIncludes(a.thumbUrl, `${STARTER}_thumb.png?token=sig`);
  assertEquals(a.guid, await assignmentGuid(ORG, EMP(1), STARTER));
  assertEquals(st.pushes.length, 1);
  assertEquals(st.pushes[0].platform, "meet");
  assertEquals(st.pushes[0].idempotency_key, pushKey(ORG, EMP(1), STARTER, "meet"));
  assertEquals(st.pushes[0].state, "queued");
  assertEquals(be.calls("GET", "/storage/v1/object/mb-exports/").length, 1, "the JPEG was downloaded once to hash it");
  assertEquals(be.calls("GET", "/storage/v1/object/mb-exports/")[0].path.endsWith(".jpg"), true);

  // no JPEG export → the PNG
  st.backgrounds[0].export_jpg_asset_id = null;
  const b2 = await (await h(get("assignments", eb.deviceToken))).json();
  assertEquals(b2.assignments[0].mime, "image/png");
  assertStringIncludes(b2.assignments[0].imageUrl, `${STARTER}.png?token=sig`);
  assertEquals(st.pushes.length, 1, "same pair, same key: no second row");

  // a browser device cannot write Teams tiles: asking for the Teams shape is refused and queues nothing
  const bt = await h(get("assignments?platform=teams", eb.deviceToken));
  assertEquals(bt.status, 400);
  assertStringIncludes(JSON.stringify(await bt.json()), "meet only");
  assertEquals(st.pushes.length, 1, "no teams row was queued by a browser device");
  assertEquals((await h(get("assignments?platform=meet", eb.deviceToken))).status, 200, "its own platform explicitly is fine");
  assertEquals((await h(get("assignments?platform=zoom", eb.deviceToken))).status, 400);

  // a teams row of the same pair (written by an OS agent) is never listed as a remove (rows are read per platform)
  st.pushes.push({ id: "t-other", org_id: ORG, employee_id: EMP(1), background_id: STARTER, platform: "teams", state: "available", idempotency_key: pushKey(ORG, EMP(1), STARTER, "teams") });
  const b3 = await (await h(get("assignments", eb.deviceToken))).json();
  assertEquals(b3.assignments.map((x: { action: string }) => x.action), ["apply"]);
  st.pushes.pop();

  // another look assigned → the old one is a remove, the new one an apply
  const OTHER = "0aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  st.backgrounds.push({ id: OTHER, org_id: ORG, label: "Other", slug: "other", export_asset_id: ASSET, thumb_asset_id: null, export_jpg_asset_id: null, state: {}, created_at: "2026-09-03T00:00:00Z" });
  st.employees[0].assigned_bg = [OTHER];
  const b4 = await (await h(get("assignments", eb.deviceToken))).json();
  assertEquals(b4.assignments.map((x: { action: string; backgroundId: string }) => [x.action, x.backgroundId]), [["remove", STARTER], ["apply", OTHER]]);

  // revoked → 410 with the removes
  st.agents[0].revoked_at = "2026-09-17T01:00:00Z";
  const rv = await h(get("assignments", eb.deviceToken));
  assertEquals(rv.status, 410);
  assertEquals((await rv.json()).action, "remove_all");
});

Deno.test("mb-agent /report from a chrome device: applied → selected, unavailable → pushed + reason, error → failed; agent-only states rejected; a browser cannot touch teams rows, an OS agent cannot touch meet rows; events via extension", async () => {
  configure();
  const st = fresh();
  st.pushes.push({ id: "m1", org_id: ORG, employee_id: EMP(1), background_id: STARTER, platform: "meet", state: "queued", idempotency_key: pushKey(ORG, EMP(1), STARTER, "meet") });
  st.pushes.push({ id: "t1", org_id: ORG, employee_id: EMP(1), background_id: STARTER, platform: "teams", state: "queued", idempotency_key: pushKey(ORG, EMP(1), STARTER, "teams") });
  const be = backend(st);
  const h = makeHandler({ fetchImpl: be.fetchImpl });
  const tok = newDeviceToken();
  st.agents.push({ id: AGENT, org_id: ORG, employee_id: EMP(1), device_id: "ext-1", os: "edge", version: "1.0.0", token_hash: await sha256Hex(tok), token_expires_at: "2099-01-01T00:00:00Z", revoked_at: null });

  const r = await h(post("report", { items: [
    { backgroundId: STARTER, state: "applied", evidence: { url: "https://meet.google.com/abc-defg-hij?authuser=0", technique: "B", meetVersionHint: "k=meet.ui.2026", browser: "Edge 152", fps: 20, segMs: 10.1 } },
    { backgroundId: STARTER, state: "written" },
  ] }, tok));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.accepted, 1);
  assertEquals(b.rejected, 1);
  assertStringIncludes(b.results[1].error, "applied|unavailable|error");
  assertEquals(st.pushes[0].state, "selected", "the meet row moved");
  assertEquals(st.pushes[1].state, "queued", "the teams row of the same pair is untouched");
  const ev = st.pushes[0].evidence as Record<string, unknown>;
  assertEquals(ev.via, "extension");
  assertEquals(ev.url, "https://meet.google.com/abc-defg-hij");
  assertEquals(ev.technique, "B");
  assertEquals(ev.os, "edge");
  assertEquals(st.reports.length, 1);
  assertEquals(st.reports[0].state, "applied");
  assertEquals(st.reports[0].push_id, "m1");
  const delivered = st.events.filter((e) => e.event === "push_delivered");
  assertEquals(delivered.length, 1);
  assertEquals((delivered[0].props as Record<string, unknown>).platform, "meet");
  assertEquals((delivered[0].props as Record<string, unknown>).via, "extension");

  await h(post("report", { items: [{ backgroundId: STARTER, state: "unavailable", evidence: { message: "Meet's own effect is on" } }] }, tok));
  assertEquals(st.pushes[0].state, "pushed");
  assertStringIncludes(String(st.pushes[0].error), "Meet's own effect is on");
  await h(post("report", { items: [{ backgroundId: STARTER, state: "error", evidence: { message: "WebAssembly CompileError" } }] }, tok));
  assertEquals(st.pushes[0].state, "failed");
  assertEquals(st.events.filter((e) => e.event === "push_failed").length, 1);

  // explicit platform teams from a browser device: refused per item — the teams row of the same pair never moves
  const cross = await h(post("report", { items: [{ backgroundId: STARTER, state: "written", platform: "teams" }] }, tok));
  assertEquals(cross.status, 422);
  assertStringIncludes((await cross.json()).results[0].error, "meet only");
  assertEquals(st.pushes[1].state, "queued", "a browser device cannot forge Teams delivery");
  assertEquals((await h(post("report", { items: [{ backgroundId: STARTER, state: "applied", platform: "zoom" }] }, tok))).status, 422);

  // an OS agent cannot report the extension's states, nor touch the meet row even with the right vocabulary
  const tok2 = newDeviceToken();
  st.agents.push({ id: "77777777-7777-4777-8777-777777777778", org_id: ORG, employee_id: EMP(1), device_id: "mac-1", os: "macos", version: "0.1.0", token_hash: await sha256Hex(tok2), token_expires_at: "2099-01-01T00:00:00Z", revoked_at: null });
  const bad = await h(post("report", { items: [{ backgroundId: STARTER, state: "applied" }] }, tok2));
  assertEquals(bad.status, 422);
  assertStringIncludes((await bad.json()).results[0].error, "platform teams");
  const before = st.pushes[0].state;
  const bad2 = await h(post("report", { items: [{ backgroundId: STARTER, state: "applied", platform: "meet" }] }, tok2));
  assertEquals(bad2.status, 422);
  assertStringIncludes((await bad2.json()).results[0].error, "teams only");
  assertEquals(st.pushes[0].state, before, "an OS agent cannot forge Meet delivery");
});
