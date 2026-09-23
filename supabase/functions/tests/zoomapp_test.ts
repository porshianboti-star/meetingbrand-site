// deno test -A tests/  — MeetingBrand for Zoom: the x-zoom-app-context decrypt (layout, key, expiry, tamper), the
// mb-zoom-app → page → mb-agent ticket, the OWASP headers, and the mb-zoom-app handler end-to-end (page modes,
// app.js, health, page.ts in sync with zoom-app/index.html + app.js).
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { decryptAppContext, encryptAppContext, owaspHeaders, signTicket, TICKET_RE, TICKET_TTL_MS, ticketKey, unpackAppContext, verifyTicket, ZoomAppContextError } from "../_shared/zoomapp.ts";
import { HEALTH_PROBE_MEMO_MS, makeHandler, renderPage, subPath } from "../mb-zoom-app/handler.ts";
import { HTML_CONTENT_TYPE, htmlPassthrough } from "../_shared/zoomapp.ts";

/** What the Supabase gateway lets through today (Text/HTML untouched) — /health probes it; tests never touch the network. */
const passFetch: typeof fetch = (_input, _init) => Promise.resolve(new Response(null, { status: 200, headers: { "Content-Type": HTML_CONTENT_TYPE, "Content-Security-Policy": "default-src 'none'; script-src 'self' https://appssdk.zoom.us" } }));
/** The gateway's anti-phishing rewrite (what a plain text/html response gets). */
const rewriteFetch: typeof fetch = () => Promise.resolve(new Response(null, { status: 200, headers: { "Content-Type": "text/plain", "Content-Security-Policy": "default-src 'none'; sandbox" } }));
import { APP_JS, INDEX_HTML, PAGE_HASH } from "../mb-zoom-app/page.ts";
import { b64url } from "../_shared/crypto.ts";
import { configure, SB_URL, TOKEN_KEY } from "./_fake.ts";

const SECRET = "zoom-app-client-secret-example";
const NOW = Date.UTC(2026, 8, 23, 9, 0, 0);
const CTX = { typ: "meeting", uid: "AbC123_-xyz", mid: "m-uuid-1==", ts: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 300, act: "" };

Deno.test("zoomapp: x-zoom-app-context — encrypt/unpack/decrypt round trip (little-endian lengths, url-safe base64, SHA-256(secret) key)", async () => {
  const h = await encryptAppContext(CTX, SECRET, "aad-bytes");
  assertMatch(h, /^[A-Za-z0-9_-]+$/, "url-safe base64, no padding");
  const parts = unpackAppContext(h);
  assertEquals(parts.iv.length, 12);
  assertEquals(new TextDecoder().decode(parts.aad), "aad-bytes");
  assertEquals(parts.tag.length, 16);
  const c = await decryptAppContext(h, SECRET, NOW);
  assertEquals(c.uid, CTX.uid);
  assertEquals(c.typ, "meeting");
  assertEquals(c.mid, CTX.mid);
  assertEquals(c.exp, CTX.exp * 1000, "seconds → ms");
  assertEquals(c.act, undefined, "empty act dropped");
  // standard base64 with padding is tolerated (Zoom's samples decode both ways)
  const std = h.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (h.length % 4)) % 4);
  assertEquals((await decryptAppContext(std, SECRET, NOW)).uid, CTX.uid);
  // ms timestamps are tolerated too
  const h2 = await encryptAppContext({ ...CTX, exp: NOW + 5000, ts: NOW }, SECRET);
  assertEquals((await decryptAppContext(h2, SECRET, NOW)).exp, NOW + 5000);
});

Deno.test("zoomapp: decrypt refuses the wrong secret, tampering, expiry, junk, a context without uid/typ/exp", async () => {
  const h = await encryptAppContext(CTX, SECRET);
  await assertRejects(() => decryptAppContext(h, "another-secret", NOW), ZoomAppContextError, "decrypt failed");
  const bytes = new TextEncoder().encode(h);
  bytes[bytes.length - 3] = bytes[bytes.length - 3] === 65 ? 66 : 65; // flip a tag character
  await assertRejects(() => decryptAppContext(new TextDecoder().decode(bytes), SECRET, NOW), ZoomAppContextError);
  await assertRejects(() => decryptAppContext(h, SECRET, CTX.exp * 1000 + 1), ZoomAppContextError, "expired");
  await assertRejects(() => decryptAppContext("", SECRET, NOW), ZoomAppContextError);
  await assertRejects(() => decryptAppContext("not base64 !!", SECRET, NOW), ZoomAppContextError);
  await assertRejects(() => decryptAppContext(b64url(new Uint8Array([12, 1, 2])), SECRET, NOW), ZoomAppContextError, "truncated");
  await assertRejects(() => decryptAppContext("A".repeat(9000), SECRET, NOW), ZoomAppContextError);
  await assertRejects(async () => decryptAppContext(await encryptAppContext({ typ: "meeting", exp: CTX.exp }, SECRET), SECRET, NOW), ZoomAppContextError, "uid");
  await assertRejects(async () => decryptAppContext(await encryptAppContext({ uid: "u", exp: CTX.exp }, SECRET), SECRET, NOW), ZoomAppContextError, "typ");
  await assertRejects(async () => decryptAppContext(await encryptAppContext({ uid: "u", typ: "panel" }, SECRET), SECRET, NOW), ZoomAppContextError, "exp");
  await assertRejects(async () => decryptAppContext(await encryptAppContext({ uid: "bad uid with spaces", typ: "panel", exp: CTX.exp }, SECRET), SECRET, NOW), ZoomAppContextError, "uid");
  await assertRejects(async () => decryptAppContext(await encryptAppContext({ uid: "u", typ: "$'</script>", exp: CTX.exp }, SECRET), SECRET, NOW), ZoomAppContextError, "typ");
  assertEquals((await decryptAppContext(await encryptAppContext({ uid: "u", typ: " Panel ", exp: CTX.exp }, SECRET), SECRET, NOW)).typ, "panel");
});

Deno.test("zoomapp: tickets — sign/verify, TTL, tamper, another root key, malformed", async () => {
  const key = await ticketKey(TOKEN_KEY);
  const t = await signTicket(key, { uid: CTX.uid, typ: "meeting", mid: CTX.mid }, NOW);
  assert(TICKET_RE.test(t), t);
  const v = await verifyTicket(key, t, NOW + 1000);
  assertEquals(v?.uid, CTX.uid);
  assertEquals(v?.typ, "meeting");
  assertEquals(v?.mid, CTX.mid);
  assertEquals(v?.exp, NOW + TICKET_TTL_MS);
  assertEquals(await verifyTicket(key, t, NOW + TICKET_TTL_MS), null, "expired at exp");
  assertEquals(await verifyTicket(key, t, NOW - 120_000), null, "issued in the future (clock skew > 60 s) is refused");
  const [body, mac] = t.split(".");
  const other = b64url(new TextEncoder().encode(JSON.stringify({ uid: "someone-else", typ: "meeting", iat: NOW, exp: NOW + TICKET_TTL_MS })));
  assertEquals(await verifyTicket(key, `${other}.${mac}`, NOW), null, "payload swap");
  assertEquals(await verifyTicket(key, `${body}.${mac.slice(0, -2)}AA`, NOW), null, "mac tamper");
  const key2 = await ticketKey(b64url(crypto.getRandomValues(new Uint8Array(32))));
  assertEquals(await verifyTicket(key2, t, NOW), null, "another MB_TOKEN_KEY");
  assertEquals(await verifyTicket(key, "garbage", NOW), null);
  assertEquals(await verifyTicket(key, "", NOW), null);
  assertNotEquals(await signTicket(key, { uid: "a", typ: "panel" }, NOW), await signTicket(key, { uid: "b", typ: "panel" }, NOW));
});

Deno.test("zoomapp: the four OWASP headers + a CSP that allows only the SDK host and the Supabase origin", () => {
  const h = owaspHeaders(SB_URL);
  for (const n of ["Strict-Transport-Security", "X-Content-Type-Options", "Content-Security-Policy", "Referrer-Policy"]) assert(h[n], n);
  assertEquals(h["X-Content-Type-Options"], "nosniff");
  assertStringIncludes(h["Content-Security-Policy"], "script-src 'self' https://appssdk.zoom.us");
  assertStringIncludes(h["Content-Security-Policy"], `connect-src 'self' ${SB_URL}`);
  assertStringIncludes(h["Content-Security-Policy"], `img-src 'self' ${SB_URL} data:`);
  assert(!/unsafe-eval/.test(h["Content-Security-Policy"]));
  assert(!/frame-ancestors/.test(h["Content-Security-Policy"]), "the Zoom client embeds the page; no frame-ancestors rule");
});

Deno.test("zoomapp: page.ts is in sync with zoom-app/index.html + app.js (run python3 zoom-app/build-page.py after an edit)", async () => {
  const root = new URL("../../../", import.meta.url);
  const html = await Deno.readTextFile(new URL("zoom-app/index.html", root));
  const js = await Deno.readTextFile(new URL("zoom-app/app.js", root));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html + "\n---\n" + js)));
  let hex = "";
  for (const b of d) hex += b.toString(16).padStart(2, "0");
  assertEquals(PAGE_HASH, hex, "page.ts is stale");
  assertEquals(INDEX_HTML, html);
  assertEquals(APP_JS, js);
  assertStringIncludes(html, 'src="https://appssdk.zoom.us/sdk.js"');
  assertStringIncludes(html, '<script id="mb-ctx" type="application/json">');
  assert(!/<link [^>]*href="http/.test(html), "no external stylesheet (CSP)");
  assert(!/wise\s*stamp/i.test(html + js), "no legacy brand");
  const externalScripts = [...html.matchAll(/<script src="(https?:[^"]+)"/g)].map((m) => m[1]);
  assertEquals(externalScripts, ["https://appssdk.zoom.us/sdk.js"], "the Zoom Apps SDK is the only external script");
});

// ------------------------------------------------------------------ the handler
const fnUrl = (sub = "") => `${SB_URL}/functions/v1/mb-zoom-app${sub}`;
function setZoomApp(on: boolean) {
  if (on) {
    Deno.env.set("ZOOM_APP_CLIENT_ID", "zoom-app-cid");
    Deno.env.set("ZOOM_APP_CLIENT_SECRET", SECRET);
  } else {
    Deno.env.delete("ZOOM_APP_CLIENT_ID");
    Deno.env.delete("ZOOM_APP_CLIENT_SECRET");
  }
}
function ctxOf(html: string): Record<string, unknown> {
  const m = /<script id="mb-ctx" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert(m, "ctx block present");
  return JSON.parse(m[1]);
}

Deno.test("mb-zoom-app: routing + sub paths; a plain GET (no context header) → the page with the four headers and mode 'outside'; app.js; health; 404/405", async () => {
  configure();
  setZoomApp(true);
  const h = makeHandler({ now: () => NOW, fetch: passFetch });
  assertEquals(subPath(new URL(fnUrl())), "/");
  assertEquals(subPath(new URL(fnUrl("/"))), "/");
  assertEquals(subPath(new URL(fnUrl("/index.html"))), "/index.html");
  assertEquals(subPath(new URL(fnUrl("/app.js"))), "/app.js");
  assertEquals(subPath(new URL(fnUrl("/app.js/"))), "/app.js");
  const r = await h(new Request(fnUrl()));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("content-type"), HTML_CONTENT_TYPE, "Text/HTML: the gateway rewrites lowercase text/html to text/plain+sandbox for browsers (2026-09-23)");
  assertStringIncludes((r.headers.get("content-type") ?? "").toLowerCase(), "text/html");
  assert(htmlPassthrough(r.headers).ok, "our own response passes the passthrough check");
  for (const n of ["strict-transport-security", "x-content-type-options", "content-security-policy", "referrer-policy"]) assert(r.headers.get(n), n);
  assertEquals(r.headers.get("cache-control"), "no-store");
  const html = await r.text();
  const ctx = ctxOf(html);
  assertEquals(ctx.mode, "outside");
  assertEquals(ctx.apiBase, `${SB_URL}/functions/v1`);
  assertEquals(ctx.ticket, undefined);
  assertStringIncludes(html, `<script src="${SB_URL}/functions/v1/mb-zoom-app/app.js"></script>`, "app.js is addressed absolutely (the page URL has no trailing slash)");
  assert(!html.includes('src="app.js"'));
  const js = await h(new Request(fnUrl("/app.js")));
  assertEquals(js.status, 200);
  assertStringIncludes(js.headers.get("content-type") ?? "", "application/javascript");
  assertEquals(js.headers.get("x-content-type-options"), "nosniff");
  assertEquals(await js.text(), APP_JS);
  const he = await h(new Request(fnUrl("/health")));
  assertEquals(he.status, 200);
  const hj = await he.json();
  assertEquals(hj.ok, true);
  assertEquals(hj.configured, true);
  assertEquals(hj.missing, []);
  assertEquals(hj.page, PAGE_HASH);
  assertEquals(hj.html.passthrough, true);
  // /ctx: the same object as #mb-ctx, as JSON (for a front host that only proxies the header; unused by the Home URL itself)
  const cx = await h(new Request(fnUrl("/ctx")));
  assertEquals(cx.status, 200);
  assertStringIncludes(cx.headers.get("content-type") ?? "", "application/json");
  assertEquals(await cx.json(), { mode: "outside", apiBase: `${SB_URL}/functions/v1` });
  assertEquals((await h(new Request(fnUrl("/nope")))).status, 404);
  assertEquals((await h(new Request(fnUrl(), { method: "POST" }))).status, 405);
  const head = await h(new Request(fnUrl(), { method: "HEAD" }));
  assertEquals(head.status, 200);
  assert(head.headers.get("content-security-policy"));
  assertEquals((await h(new Request(fnUrl(), { method: "OPTIONS", headers: { origin: "https://meetingbrand.com" } }))).status, 204);
});

Deno.test("mb-zoom-app: a real x-zoom-app-context → mode 'zoom' with a ticket mb-agent can verify (uid, typ, mid); the secret never appears in the page", async () => {
  configure();
  setZoomApp(true);
  const h = makeHandler({ now: () => NOW, fetch: passFetch });
  const header = await encryptAppContext(CTX, SECRET, "real-aad");
  const r = await h(new Request(fnUrl(), { headers: { "x-zoom-app-context": header } }));
  assertEquals(r.status, 200);
  const html = await r.text();
  const ctx = ctxOf(html);
  assertEquals(ctx.mode, "zoom");
  assertEquals(ctx.typ, "meeting");
  assert(TICKET_RE.test(String(ctx.ticket)));
  const t = await verifyTicket(await ticketKey(TOKEN_KEY), String(ctx.ticket), NOW + 1000);
  assertEquals(t?.uid, CTX.uid);
  assertEquals(t?.mid, CTX.mid);
  assert(!html.includes(SECRET));
  assert(!html.includes(header));
  assert(!html.includes("zoom-app-cid"));
  assert(!html.includes(TOKEN_KEY));
  const cx = await (await h(new Request(fnUrl("/ctx"), { headers: { "x-zoom-app-context": header } }))).json();
  assertEquals(cx.mode, "zoom");
  assertEquals(cx.typ, "meeting");
  assertEquals((await verifyTicket(await ticketKey(TOKEN_KEY), String(cx.ticket), NOW + 1000))?.uid, CTX.uid);
  assert(!JSON.stringify(cx).includes(header) && !JSON.stringify(cx).includes(SECRET));
  // the ctx block cannot be broken out of
  const evil = renderPage({ mode: "zoom", ticket: "</script><script>alert(1)</script>" }, "/x/app.js");
  assert(!evil.includes("</script><script>alert"));
  assertEquals(ctxOf(evil).ticket, "</script><script>alert(1)</script>");
  // String.replace patterns ($&, $', $`) in the data are literal, never expanded into the surrounding page
  const dollars = renderPage({ mode: "zoom", ticket: "a$&b$'c$`d$1e", typ: "$'" }, "/x/app.js$&");
  assertEquals(ctxOf(dollars).ticket, "a$&b$'c$`d$1e");
  assertEquals(ctxOf(dollars).typ, "$'");
  assertStringIncludes(dollars, '<script src="/x/app.js$&"></script>');
  assertEquals(dollars.split("<script").length, INDEX_HTML.split("<script").length, "no extra script element");
});

Deno.test("mb-zoom-app: a context that does not decrypt → mode 'bad_context' (200, page still renders); expired → bad_context; secrets unset → 'not_configured' + health says which", async () => {
  configure();
  setZoomApp(true);
  const h = makeHandler({ now: () => NOW, fetch: passFetch });
  const wrong = await encryptAppContext(CTX, "a-different-marketplace-secret");
  let ctx = ctxOf(await (await h(new Request(fnUrl(), { headers: { "x-zoom-app-context": wrong } }))).text());
  assertEquals(ctx.mode, "bad_context");
  const expired = await encryptAppContext({ ...CTX, exp: Math.floor(NOW / 1000) - 1 }, SECRET);
  ctx = ctxOf(await (await h(new Request(fnUrl(), { headers: { "x-zoom-app-context": expired } }))).text());
  assertEquals(ctx.mode, "bad_context");
  ctx = ctxOf(await (await h(new Request(fnUrl(), { headers: { "x-zoom-app-context": "garbage!!" } }))).text());
  assertEquals(ctx.mode, "bad_context");
  setZoomApp(false);
  const good = await encryptAppContext(CTX, SECRET);
  const r = await h(new Request(fnUrl(), { headers: { "x-zoom-app-context": good } }));
  assertEquals(r.status, 200, "the page always renders — the state is in the ctx");
  assertEquals(ctxOf(await r.text()).mode, "not_configured");
  assertEquals((await (await h(new Request(fnUrl("/ctx"), { headers: { "x-zoom-app-context": good } }))).json()).mode, "not_configured");
  setZoomApp(true);
  assertEquals((await (await h(new Request(fnUrl("/ctx"), { headers: { "x-zoom-app-context": wrong } }))).json()).mode, "bad_context");
  setZoomApp(false);
  const he = await (await h(new Request(fnUrl("/health")))).json();
  assertEquals(he.configured, false);
  assertEquals(he.missing, ["ZOOM_APP_CLIENT_ID", "ZOOM_APP_CLIENT_SECRET"]);
  assertEquals(ctxOf(await (await h(new Request(fnUrl()))).text()).mode, "outside", "no header: outside, even unconfigured");
});

Deno.test("mb-zoom-app: /health probes the live Home URL like a browser — passthrough true (Text/HTML untouched), false (gateway rewrite to text/plain+sandbox), null (probe failed); htmlPassthrough is case-insensitive", async () => {
  configure();
  setZoomApp(true);
  let probed: { url: string; accept: string } | null = null;
  const spy: typeof fetch = (input, init) => {
    probed = { url: String(input), accept: new Headers(init?.headers).get("accept") ?? "" };
    return passFetch(input, init);
  };
  let he = await (await makeHandler({ now: () => NOW, fetch: spy })(new Request(fnUrl("/health")))).json();
  assertEquals(he.html.passthrough, true);
  assertEquals(he.homeUrl, `${SB_URL}/functions/v1/mb-zoom-app`);
  assertEquals(probed!.url, `${SB_URL}/functions/v1/mb-zoom-app/`, "probes its own root, not /health (no recursion)");
  assertStringIncludes(probed!.accept, "text/html", "asks like a browser, which is what triggers the rewrite");
  he = await (await makeHandler({ now: () => NOW, fetch: rewriteFetch })(new Request(fnUrl("/health")))).json();
  assertEquals(he.html.passthrough, false);
  assertEquals(he.html.contentType, "text/plain");
  he = await (await makeHandler({ now: () => NOW, fetch: () => Promise.reject(new Error("boom")) })(new Request(fnUrl("/health")))).json();
  assertEquals(he.html.passthrough, null);
  assertEquals(he.ok, true, "health itself still answers");
  // the probe is memoised per isolate (public endpoint: no 1:1 outbound amplification)
  let clock = NOW;
  let probes = 0;
  const counting: typeof fetch = (i, init) => { probes++; return passFetch(i, init); };
  const hm = makeHandler({ now: () => clock, fetch: counting });
  for (let i = 0; i < 5; i++) assertEquals((await (await hm(new Request(fnUrl("/health")))).json()).html.passthrough, true);
  assertEquals(probes, 1, "five health calls within a minute → one probe");
  clock = NOW + HEALTH_PROBE_MEMO_MS + 1;
  await hm(new Request(fnUrl("/health")));
  assertEquals(probes, 2, "re-probed after the memo expired");
  assertEquals(htmlPassthrough(new Headers({ "content-type": "TEXT/HTML; charset=utf-8", "content-security-policy": "default-src 'self'" })).ok, true);
  assertEquals(htmlPassthrough(new Headers({ "content-type": "text/html", "content-security-policy": "default-src 'none'; sandbox" })).ok, false);
  assertEquals(htmlPassthrough(new Headers({ "content-type": "text/plain" })).ok, false);
});
