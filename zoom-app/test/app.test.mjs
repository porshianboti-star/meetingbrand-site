// node --test zoom-app/test/  — MeetingBrand for Zoom page logic with a mocked Zoom Apps SDK + mocked backend.
// Covers: config → resolve → assignment → HEAD → setVirtualBackground → report (applied), denied (10017 and a
// message), SDK error codes, missing assignment, not in roster / no workspace, outside Zoom, unsupported client,
// running-context change re-apply, token rotation, ticket expiry, retry ignoring the applied memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const MB = require("../app.js");

const API = "https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1";
const IMG = "https://ohobtgbyrlczfdztzvqi.supabase.co/storage/v1/object/sign/mb-exports/org/bg.jpg?token=sig";
const BG = "44444444-4444-4444-8444-444444444444";
const ITEM = { platform: "zoom", backgroundId: BG, guid: "G", label: "MeetingBrand - Walnut lobby", imageUrl: IMG, mime: "image/jpeg", sha256: "ab".repeat(32), bytes: 1234, action: "apply" };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** A mocked zoomSdk: config resolves with the given context; setVirtualBackground resolves or rejects per `vb`. */
function mockSdk({ runningContext = "inMeeting", clientVersion = "6.2.0", unsupportedApis = [], vb = "ok", configError = null } = {}) {
  const calls = { config: [], vb: [], handlers: [] };
  return {
    calls,
    config: (opts) => {
      calls.config.push(opts);
      if (configError) return Promise.reject(configError);
      return Promise.resolve({ runningContext, clientVersion, unsupportedApis, auth: {}, product: "desktop" });
    },
    setVirtualBackground: (opts) => {
      calls.vb.push(opts);
      if (vb === "ok") return Promise.resolve({ message: "Success" });
      return Promise.reject(vb);
    },
    onRunningContextChange: (h) => calls.handlers.push(h),
    fire: (ctx) => calls.handlers.forEach((h) => h({ runningContext: ctx })),
  };
}

/** A mocked backend: records every request; answers resolve / assignments / report / HEAD per options. */
function mockFetch({ resolve = 200, assignments = [ITEM], skipped = [], assignStatus = 200, head = true, rotate = null, resolveBody = null } = {}) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (body == null ? "" : JSON.stringify(body)) });
    if (url === IMG) return reply(head ? 200 : 403, null);
    if (url.endsWith("/mb-agent/zoom/resolve")) {
      if (resolve === 200) return reply(200, resolveBody || { deviceToken: "mbd_" + "t".repeat(40), employee: { id: "e1", email: "jane@acme.com" }, state: "matched" });
      if (resolve === 404) return reply(404, { error: "not_enrolled", reason: "not_in_roster" });
      if (resolve === "404ws") return reply(404, { error: "not_enrolled", reason: "no_workspace" });
      return reply(resolve, { error: "x", detail: "boom" });
    }
    if (url.includes("/mb-agent/assignments")) {
      if (assignStatus !== 200) return reply(assignStatus, { error: "revoked" });
      return reply(200, { platform: "zoom", assignments, skipped, state: "matched", ...(rotate ? { deviceToken: rotate } : {}) });
    }
    if (url.endsWith("/mb-agent/report")) return reply(200, { accepted: 1 });
    return reply(599, { error: "unrouted" });
  };
  f.seen = seen;
  f.of = (frag) => seen.filter((s) => s.url.includes(frag));
  return f;
}

function renders() {
  const list = [];
  const render = (state, data) => list.push({ state, data });
  render.list = list;
  render.last = () => list[list.length - 1];
  return render;
}

const ctxZoom = { mode: "zoom", ticket: "eyJ.sig", apiBase: API, typ: "meeting" };

test("happy path: config → resolve (deviceId, clientVersion) → assignment → HEAD → setVirtualBackground({fileUrl}) → report applied → 'applied' with the label", async () => {
  const sdk = mockSdk();
  const fetch = mockFetch();
  const render = renders();
  const storage = memStorage();
  const app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage, render });
  const state = await app.run();
  assert.equal(state, "applied");
  assert.deepEqual(sdk.calls.config[0], { capabilities: MB.CAPABILITIES, version: "0.16" });
  assert.ok(MB.CAPABILITIES.includes("setVirtualBackground"));
  const resolve = fetch.of("/zoom/resolve")[0];
  assert.equal(resolve.method, "POST");
  assert.equal(resolve.body.ticket, "eyJ.sig");
  assert.equal(resolve.body.clientVersion, "6.2.0");
  assert.match(resolve.body.deviceId, /^[A-Za-z0-9._-]{8,100}$/);
  assert.equal(storage.getItem("mb.zoom.deviceId"), resolve.body.deviceId, "the device id is kept for the next open");
  const asg = fetch.of("/assignments")[0];
  assert.equal(asg.url, API + "/mb-agent/assignments?platform=zoom");
  assert.equal(asg.headers.authorization, "Bearer mbd_" + "t".repeat(40));
  assert.equal(fetch.seen.find((s) => s.url === IMG).method, "HEAD");
  assert.deepEqual(sdk.calls.vb, [{ fileUrl: IMG }]);
  const rep = fetch.of("/report")[0];
  assert.equal(rep.headers.authorization, "Bearer mbd_" + "t".repeat(40));
  assert.deepEqual(rep.body.items[0], { backgroundId: BG, state: "applied", platform: "zoom", evidence: { runningContext: "inMeeting", clientVersion: "6.2.0" } });
  assert.equal(render.list[0].state, "loading");
  assert.equal(render.last().state, "applied");
  assert.equal(render.last().data.label, "MeetingBrand - Walnut lobby");
  assert.equal(render.last().data.runningContext, "inMeeting");
  // the same image a moment later (same context) is not re-applied — Zoom would prompt again for nothing
  const app2 = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage, render });
  assert.equal(await app2.run(), "applied");
  assert.equal(sdk.calls.vb.length, 1, "no second setVirtualBackground within 15 min for the same sha + context");
  // Retry ignores that memory
  assert.equal(await app2.retry(), "applied");
  assert.equal(sdk.calls.vb.length, 2);
});

test("denied: SDK code 10017 → 'denied', report denied with code; a 'user denied' message without a code too", async () => {
  const sdk = mockSdk({ vb: { code: 10017, message: "User denied the request" } });
  const fetch = mockFetch();
  const render = renders();
  const app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render });
  assert.equal(await app.run(), "denied");
  const rep = fetch.of("/report")[0].body.items[0];
  assert.equal(rep.state, "denied");
  assert.equal(rep.evidence.code, 10017);
  assert.equal(rep.evidence.message, "User denied the request");
  assert.equal(render.last().state, "denied");
  assert.equal(render.last().data.code, 10017);
  assert.equal(MB.classifySdkError({ message: "The user declined" }).state, "denied");
  assert.equal(MB.classifySdkError(new Error("Request cancelled by user")).state, "denied");
  assert.equal(MB.classifySdkError({ code: "10017" }).state, "denied", "string codes are numbers too");
  // retry after a denial calls the SDK again (Zoom prompts again)
  sdk.setVirtualBackground = () => Promise.resolve({});
  assert.equal(await app.retry(), "applied");
});

test("SDK errors: 10031 (VB disabled) / 10045 (no package) / unknown → 'error' with the documented hint, report error", async () => {
  for (const [code, frag] of [[10031, "web settings"], [10045, "package"], [10151, "disabled in this meeting"], [42, "Zoom said"]]) {
    const sdk = mockSdk({ vb: { code, message: "err " + code } });
    const fetch = mockFetch();
    const render = renders();
    const app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render });
    assert.equal(await app.run(), "error", String(code));
    assert.match(render.last().data.hint, new RegExp(frag), String(code));
    assert.equal(fetch.of("/report")[0].body.items[0].state, "error");
    assert.equal(fetch.of("/report")[0].body.items[0].evidence.code, code);
  }
  assert.equal(MB.classifySdkError(undefined).state, "error");
  assert.equal(MB.classifySdkError("plain string").message, "plain string");
});

test("missing assignment: no apply item → 'no_background' (skipped → the Prepare hint), nothing sent to the SDK, no report", async () => {
  const sdk = mockSdk();
  let fetch = mockFetch({ assignments: [] });
  let render = renders();
  let app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render });
  assert.equal(await app.run(), "no_background");
  assert.equal(sdk.calls.vb.length, 0);
  assert.equal(fetch.of("/report").length, 0);
  assert.equal(render.last().data.hint, null);
  fetch = mockFetch({ assignments: [{ platform: "zoom", backgroundId: BG, action: "remove" }], skipped: [BG] });
  render = renders();
  app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render });
  assert.equal(await app.run(), "no_background");
  assert.match(render.last().data.hint, /Prepare backgrounds/);
  assert.equal(sdk.calls.vb.length, 0, "a remove-only answer never calls the SDK");
});

test("resolve refusals: 404 not_in_roster / no_workspace, 401 stale ticket, 503 not configured, network error; assignments 410 revoked", async () => {
  const cases = [
    [{ resolve: 404 }, "not_in_roster"],
    [{ resolve: "404ws" }, "no_workspace"],
    [{ resolve: 401 }, "ticket_expired"],
    [{ resolve: 503 }, "not_configured"],
    [{ resolve: 500 }, "error"],
    [{ assignStatus: 410 }, "revoked"],
  ];
  for (const [opts, want] of cases) {
    const sdk = mockSdk();
    const fetch = mockFetch(opts);
    const app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render: renders() });
    assert.equal(await app.run(), want, JSON.stringify(opts));
    assert.equal(sdk.calls.vb.length, 0);
  }
  const sdk = mockSdk();
  const app = MB.createZoomApp({ sdk, fetch: async () => { throw new Error("offline"); }, ctx: ctxZoom, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "error");
  assert.equal(sdk.calls.vb.length, 0);
});

test("outside Zoom (no ticket / no SDK / config rejects) → 'outside'; server-side modes not_configured / bad_context render as such and never call the backend", async () => {
  const fetch = mockFetch();
  let app = MB.createZoomApp({ sdk: null, fetch, ctx: { mode: "outside", apiBase: API }, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "outside");
  app = MB.createZoomApp({ sdk: mockSdk({ configError: new Error("not in zoom") }), fetch, ctx: { mode: "outside", apiBase: API }, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "outside");
  for (const mode of ["not_configured", "bad_context"]) {
    const r = renders();
    app = MB.createZoomApp({ sdk: mockSdk(), fetch, ctx: { mode, apiBase: API }, storage: memStorage(), render: r });
    assert.equal(await app.run(), mode);
    assert.equal(r.last().data.clientVersion, "6.2.0", "the client version is still shown for support");
  }
  assert.equal(fetch.seen.length, 0, "no backend call without a zoom-mode ticket");
  // a zoom-mode ticket but config fails (the page was opened in a plain browser with a pasted URL) → outside
  app = MB.createZoomApp({ sdk: null, fetch, ctx: ctxZoom, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "outside");
  assert.equal(fetch.seen.length, 0);
});

test("unsupported client (setVirtualBackground in unsupportedApis) → 'unsupported', no resolve; a non-apply running context → 'wrong_context'", async () => {
  const fetch = mockFetch();
  let app = MB.createZoomApp({ sdk: mockSdk({ unsupportedApis: ["setVirtualBackground"] }), fetch, ctx: ctxZoom, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "unsupported");
  assert.equal(fetch.seen.length, 0);
  const sdk = mockSdk({ runningContext: "inChat" });
  app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "wrong_context");
  assert.equal(sdk.calls.vb.length, 0);
  assert.equal(fetch.of("/report").length, 0);
});

test("running-context change (Auto-open opened the main-client page, then the meeting starts) re-applies once per context; token rotation is honoured", async () => {
  const sdk = mockSdk({ runningContext: "inMainClient" });
  const fetch = mockFetch({ rotate: "mbd_" + "r".repeat(40) });
  const app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage: memStorage(), render: renders() });
  assert.equal(await app.run(), "applied");
  assert.equal(sdk.calls.handlers.length, 1, "subscribed to onRunningContextChange once");
  assert.equal(fetch.of("/report")[0].headers.authorization, "Bearer mbd_" + "r".repeat(40), "the rotated token is used from then on");
  sdk.fire("inMeeting");
  await app.applying;
  assert.equal(sdk.calls.vb.length, 2, "a new apply context → setVirtualBackground again");
  assert.equal(fetch.of("/report")[1].body.items[0].evidence.runningContext, "inMeeting");
  sdk.fire("inMeeting");
  assert.equal(sdk.calls.vb.length, 2, "the same context again → nothing");
  sdk.fire("inChat");
  assert.equal(sdk.calls.vb.length, 2, "a non-apply context → nothing");
  // a second run() in the same app never subscribes twice
  await app.run();
  assert.equal(sdk.calls.handlers.length, 1);
});

test("HEAD failure is a warning only (the Zoom client fetches the URL itself); the applied memory is per context", async () => {
  const sdk = mockSdk();
  const fetch = mockFetch({ head: false });
  const logs = [];
  const storage = memStorage();
  const app = MB.createZoomApp({ sdk, fetch, ctx: ctxZoom, storage, render: renders(), log: (e, d) => logs.push([e, d]) });
  assert.equal(await app.run(), "applied");
  assert.ok(logs.some(([e]) => e === "head_check_failed"));
  assert.ok(!logs.some(([, d]) => String(d).includes("token=")), "the signed token never reaches the console");
  const app2 = MB.createZoomApp({ sdk: mockSdk({ runningContext: "inMainClient" }), fetch, ctx: ctxZoom, storage, render: renders() });
  assert.equal(await app2.run(), "applied");
  assert.equal(fetch.of("/report").length, 2, "another context → applied again (and reported)");
});

test("readCtx + deviceIdFrom are defensive: malformed JSON → outside; a bad stored id is replaced; storage errors are survived", () => {
  const doc = { getElementById: (id) => (id === "mb-ctx" ? { textContent: "{not json" } : null) };
  assert.deepEqual(MB.readCtx(doc), { mode: "outside" });
  assert.deepEqual(MB.readCtx({ getElementById: () => ({ textContent: '{"mode":"zoom","ticket":"a.b","apiBase":"x"}' }) }), { mode: "zoom", ticket: "a.b", apiBase: "x" });
  assert.equal(MB.readCtx(null).mode, "outside");
  const st = memStorage();
  st.setItem("mb.zoom.deviceId", "bad id!");
  const id = MB.deviceIdFrom(st);
  assert.match(id, /^[A-Za-z0-9._-]{8,100}$/);
  assert.equal(MB.deviceIdFrom(st), id);
  const throwing = { getItem: () => { throw new Error("private"); }, setItem: () => { throw new Error("private"); } };
  assert.match(MB.deviceIdFrom(throwing), /^[A-Za-z0-9._-]{8,100}$/);
  assert.match(MB.deviceIdFrom(null), /^[A-Za-z0-9._-]{8,100}$/);
});

test("SDK handshake that never settles (the page outside the Zoom client, or a blocked bridge): mode zoom → 'outside' after the config timeout; other modes render at once and never wait", async () => {
  const hanging = { config: () => new Promise(() => {}) };
  const states = [];
  const app = MB.createZoomApp({ sdk: hanging, fetch: async () => { throw new Error("must not be called"); }, ctx: { mode: "zoom", ticket: "t.t", apiBase: API }, render: (s, d) => states.push([s, d]), configTimeoutMs: 30 });
  assert.equal(await app.run(), "outside");
  assert.match(states[states.length - 1][1].hint, /did not answer the SDK handshake/);
  const outsideStates = [];
  const t0 = Date.now();
  const app2 = MB.createZoomApp({ sdk: hanging, fetch: async () => { throw new Error("must not be called"); }, ctx: { mode: "outside", apiBase: API }, render: (s) => outsideStates.push(s), outsideConfigTimeoutMs: 20 });
  const p = app2.run();
  assert.equal(outsideStates[outsideStates.length - 1], "outside", "rendered synchronously, before the SDK race ends");
  assert.equal(await p, "outside");
  assert.ok(Date.now() - t0 < 1000);
  const notConfigured = [];
  const app3 = MB.createZoomApp({ sdk: null, fetch: null, ctx: { mode: "not_configured", apiBase: API }, render: (s) => notConfigured.push(s) });
  assert.equal(await app3.run(), "not_configured");
  const sdkThrows = { config: () => { throw new Error("no bridge"); } };
  const app4 = MB.createZoomApp({ sdk: sdkThrows, fetch: null, ctx: { mode: "zoom", ticket: "t.t", apiBase: API }, render: () => {} });
  assert.equal(await app4.run(), "outside", "a synchronous throw from config is 'outside' too");
});

test("auto-boot: loading app.js in a page that has #mb-ctx boots on its own (a fake `self` with a DOM) — outside mode renders at once and the instance is exposed", async () => {
  const nodes = {};
  const el = (id, text) => (nodes[id] = { id, textContent: text || "", className: "", listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; } });
  el("mb-ctx", JSON.stringify({ mode: "outside", apiBase: API }));
  ["dot", "title", "body", "label", "retry", "again", "meta"].forEach((id) => el(id));
  const fakeWindow = { document: { getElementById: (id) => nodes[id] || null }, console: { log() {}, error(...a) { throw new Error("boot failed: " + a.join(" ")); } }, localStorage: null, fetch: null, zoomSdk: null };
  const prevSelf = globalThis.self;
  globalThis.self = fakeWindow;
  try {
    const fresh = createRequire(import.meta.url);
    const path = fresh.resolve("../app.js");
    delete fresh.cache[path];
    const api = fresh(path);
    assert.ok(api.instance, "boot ran and exposed the instance");
    assert.equal(fakeWindow.MBZoomApp, undefined, "module.exports path (node) — the browser gets window.MBZoomApp instead");
    assert.equal(nodes.title.textContent, "Open this app inside Zoom");
    assert.equal(nodes.dot.className, "dot warn");
    assert.equal(typeof nodes.retry.listeners.click, "function");
    assert.equal(await api.instance.run(), "outside");
    delete fresh.cache[path];
  } finally {
    if (prevSelf === undefined) delete globalThis.self; else globalThis.self = prevSelf;
  }
});
