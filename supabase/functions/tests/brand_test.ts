// tests/brand_test.ts — mb-brand: host validation, address classification, the pinned HTTP/1.1 client (against raw local TCP
// servers through an injected dialer), sniffing/stripping/extraction, rate windows and the handler end to end.
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { BrandError, classifyIp, decodeBody, type Dialer, fetchUrl, GrowBuf, httpGet, normalizeHost, parseV4, parseV6, regDomain, vetHost, type Vetted } from "../mb-brand/net.ts";
import { attrs, extract, looksLikeHtml, manifestIcons, stripScripts } from "../mb-brand/html.ts";
import { callerKey, clientIp, MemLimiter, SWEEP_EVERY_MS } from "../mb-brand/ratelimit.ts";
import { LIMITS, makeHandler } from "../mb-brand/handler.ts";

const enc = new TextEncoder(), dec = new TextDecoder();

// ---------- raw TCP test servers (HTTP/1.1 by hand so chunking, caps and malformed heads are under test control)
type Responder = (req: string, conn: Deno.Conn) => Promise<void> | void;
function rawServer(responder: Responder): { port: number; close: () => void } {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  (async () => {
    try {
      for await (const conn of l) {
        (async () => {
          try {
            const buf = new Uint8Array(65536);
            const n = await conn.read(buf);
            await responder(dec.decode(buf.subarray(0, n ?? 0)), conn);
          } catch { /* client gone */ } finally {
            try { conn.close(); } catch { /* closed */ }
          }
        })();
      }
    } catch { /* listener closed */ }
  })();
  return { port: (l.addr as Deno.NetAddr).port, close: () => { try { l.close(); } catch { /* closed */ } } };
}
async function writeAll(conn: Deno.Conn, b: Uint8Array) { let o = 0; while (o < b.length) o += await conn.write(b.subarray(o)); }
function head(status: number, headers: Record<string, string>) {
  return `HTTP/1.1 ${status} X\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";
}
async function send(conn: Deno.Conn, status: number, headers: Record<string, string>, body: Uint8Array | string = "") {
  const b = typeof body === "string" ? enc.encode(body) : body;
  const h = { ...headers };
  if (!("Transfer-Encoding" in h) && !("Content-Length" in h)) h["Content-Length"] = String(b.length);
  await writeAll(conn, enc.encode(head(status, h)));
  await writeAll(conn, b);
}
const plainDial = (ports: Record<string, number>): Dialer => async (_ip, port, sni) => {
  const p = ports[sni] ?? ports["*"];
  if (!p) throw new Error("no fixture for " + sni);
  if (port !== 443) throw new Error("dialled port " + port);
  return await Deno.connect({ hostname: "127.0.0.1", port: p });
};
const fakeVet = (log: string[] = []) => async (host: string): Promise<Vetted> => { log.push(host); return { host, ip: "93.184.216.34", family: 4, all: ["93.184.216.34"] }; };
const HTML = (title: string, extra = "") => `<!DOCTYPE html><html><head><title>${title}</title>${extra}</head><body><header><a href="/"><img src="/img/logo.svg" alt="${title} logo" width="120"></a></header><p>hello</p></body></html>`;
const noEnv = { url: "", serviceRoleKey: "", schema: "mb", hmacSecret: "test-secret" };

// ---------- 1. hostname-only input
Deno.test("normalizeHost accepts bare public hostnames and refuses everything else", () => {
  assertEquals(normalizeHost(" Acme.com. "), "acme.com");
  assertEquals(normalizeHost("www.s-horowitz.com"), "www.s-horowitz.com");
  assertEquals(normalizeHost("xn--4dbrk0ce.xn--4dbcr.il"), "xn--4dbrk0ce.xn--4dbcr.il");
  assertEquals(normalizeHost("pathwaysimpact.org"), "pathwaysimpact.org");
  assertEquals(normalizeHost("acme.com\n"), "acme.com"); // surrounding whitespace is trimmed, inner whitespace refused
  assertEquals(classifyIp("3ffe::1"), "public"); // just below the RFC 9637 documentation block, still global unicast
  const bad = ["127.0.0.1", "0x7f.1", "0x7f.0x0.0x0.0x1", "2130706433", "127.1", "1.1", "[::1]", "::1", "::ffff:127.0.0.1", "fe80::1%25eth0",
    "localhost", "foo.localhost", "a.internal", "metadata.google.internal", "k8s.default.svc", "foo.localdomain", "x.svc.cluster.local", "x.supabase.co", "ohobtgbyrlczfdztzvqi.supabase.co", "acme.local", "acme.test", "acme.example",
    "http://acme.com", "acme.com/", "acme.com/path", "acme.com:443", "user@acme.com", "acme", "acme.com%2f", "acme.com%00", "-a.com", "a-.com", "a..com", "acme.c0m", "acme.123",
    "a.b.c.d.e.1", "acme\n.com", "acme .com", "аcme.com" /* Cyrillic a */, "a".repeat(64) + ".com", ("a.".repeat(130)) + "com", "", "   ", 42, null, undefined, {}];
  for (const b of bad) assertEquals(normalizeHost(b as unknown), null, "should refuse " + JSON.stringify(b));
});

// ---------- 2. address classification (v4 + v6 incl. every embedding trick)
Deno.test("classifyIp — public stays public, every private/loopback/link-local/multicast/reserved/mapped form is refused", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:800::200e", "2600::1"]) assertEquals(classifyIp(ip), "public", ip);
  const refused: Record<string, string> = {
    "127.0.0.1": "loopback", "127.255.255.254": "loopback", "10.1.2.3": "private", "172.16.0.1": "private", "172.31.255.255": "private", "192.168.1.1": "private",
    "169.254.169.254": "link-local", "100.64.0.1": "private", "100.127.255.255": "private", "0.0.0.0": "unspecified", "0.1.2.3": "unspecified", "224.0.0.1": "multicast",
    "239.255.255.255": "multicast", "255.255.255.255": "reserved", "240.0.0.1": "reserved", "192.0.0.1": "reserved", "192.0.2.1": "reserved", "198.18.0.1": "reserved",
    "198.19.255.255": "reserved", "198.51.100.7": "reserved", "203.0.113.9": "reserved", "192.88.99.1": "reserved",
    "::1": "loopback", "::": "unspecified", "::ffff:127.0.0.1": "loopback", "::ffff:7f00:1": "loopback", "::ffff:169.254.169.254": "link-local", "::ffff:10.0.0.1": "private",
    "::ffff:192.168.0.1": "private", "::127.0.0.1": "reserved", "::a": "reserved", "::ffff:0:0": "unspecified", "64:ff9b::7f00:1": "loopback", "64:ff9b::10.0.0.1": "private",
    "64:ff9b::a9fe:a9fe": "link-local", "64:ff9b:1::1": "reserved", "2002:7f00:1::": "reserved", "2002:0a00:1::1": "reserved", "2001::1": "reserved", "2001:0:4136:e378:8000:63bf:3fff:fdd2": "reserved",
    "2001:db8::1": "reserved", "2001:10::1": "reserved", "2001:1f::1": "reserved", "2001:20::1": "reserved", "fc00::1": "private", "fd12:3456::1": "private", "fe80::1": "link-local",
    "fe80::1%eth0": "link-local", "fec0::1": "private", "ff02::1": "multicast", "ff0e::1": "multicast", "100::1": "reserved", "4000::1": "reserved", "1::": "reserved", "3fff::1": "reserved", "3fff:fff::1": "reserved", "2001:2::1": "reserved", "2001:2:0:ffff::1": "reserved", "5f00::1": "reserved", "168.63.129.16": "reserved", "[::1]": "loopback",
    "0:0:0:0:0:ffff:7f00:0001": "loopback", "::FFFF:127.0.0.1": "loopback",
  };
  for (const [ip, k] of Object.entries(refused)) assertEquals(classifyIp(ip), k, ip);
  for (const ip of ["1.2.3", "1.2.3.4.5", "gggg::1", "1.2.3.256", "::ffff:1.2.3", "1:2:3:4:5:6:7:8:9", "1::2::3", "", "abc", "010.0.0.1", "0177.0.0.1", "001.001.001.001", "::ffff:010.0.0.1"]) assertEquals(classifyIp(ip), "invalid", ip);
  assertEquals(parseV4("0.0.0.1"), [0, 0, 0, 1]); assertEquals(parseV4("010.0.0.1"), null); // a single 0 is canonical, a leading zero is not
  assertEquals(classifyIp("2001:3::1"), "public"); assertEquals(classifyIp("168.63.129.17"), "public");
  assertEquals(parseV6("64:ff9b::1.2.3.4"), [0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
  assertEquals(classifyIp("64:ff9b::1.2.3.4"), "public"); // NAT64 of a public address: the embedded IPv4 decides
});

// ---------- 3. vetting: any non-public answer refuses the whole name
Deno.test("vetHost refuses a name with ANY private answer, prefers IPv4, reports no address / resolver failure", async () => {
  const v = await vetHost("acme-fixture.com", async () => ["2606:4700::1", "93.184.216.34"]);
  assertEquals(v.ip, "93.184.216.34"); assertEquals(v.family, 4); assertEquals(v.all.length, 2);
  const v6 = await vetHost("acme-fixture.com", async () => ["2606:4700::1"]);
  assertEquals(v6.family, 6);
  await assertRejects(() => vetHost("acme-fixture.com", async () => ["93.184.216.34", "10.0.0.1"]), BrandError, "private");
  await assertRejects(() => vetHost("acme-fixture.com", async () => ["93.184.216.34", "::ffff:127.0.0.1"]), BrandError, "loopback");
  await assertRejects(() => vetHost("acme-fixture.com", async () => ["169.254.169.254"]), BrandError, "link-local");
  await assertRejects(() => vetHost("acme-fixture.com", async () => []), BrandError, "no address");
  await assertRejects(() => vetHost("acme-fixture.com", async () => { throw new Error("boom"); }), BrandError, "could not be resolved");
  const codes: string[] = [];
  for (const r of [async () => ["10.0.0.1"], async () => [], async () => { throw new Error("x"); }]) { try { await vetHost("a.com", r); } catch (e) { codes.push((e as BrandError).code + ":" + (e as BrandError).status); } }
  assertEquals(codes, ["blocked_host:403", "unresolvable:502", "dns_failed:502"]);
});

// ---------- 4. the HTTP/1.1 client
Deno.test("httpGet — content-length body, request line + Host + Connection: close, no cookies/authorization forwarded", async () => {
  let seen = "";
  const s = rawServer(async (req, conn) => { seen = req; await send(conn, 200, { "Content-Type": "text/html; charset=utf-8" }, HTML("Acme")); });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: s.port });
    const r = await httpGet(conn, "acme-fixture.com", "/", Date.now() + 3000, 2_000_000);
    conn.close();
    assertEquals(r.status, 200); assertEquals(r.truncated, false); assertEquals(dec.decode(r.body), HTML("Acme")); assertEquals(r.bytes, enc.encode(HTML("Acme")).length);
    assertMatch(seen, /^GET \/ HTTP\/1\.1\r\nHost: acme-fixture\.com\r\n/); assert(/Connection: close/.test(seen)); assert(!/cookie|authorization|apikey/i.test(seen));
    assert(/MeetingBrand\/1\.0 \(\+https:\/\/meetingbrand\.com\/\)/.test(seen));
  } finally { s.close(); }
});

Deno.test("httpGet — chunked transfer-encoding is reassembled (extensions + trailers ignored)", async () => {
  const s = rawServer(async (_r, conn) => {
    await writeAll(conn, enc.encode(head(200, { "Content-Type": "text/html", "Transfer-Encoding": "chunked" })));
    for (const part of ["<!DOCTYPE html><html><head><title>Chunky</title>", "</head><body>", "<p>x</p></body></html>"]) await writeAll(conn, enc.encode(part.length.toString(16) + ";ext=1\r\n" + part + "\r\n"));
    await writeAll(conn, enc.encode("0\r\nX-Trailer: 1\r\n\r\n"));
  });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: s.port });
    const r = await httpGet(conn, "h", "/", Date.now() + 3000, 2_000_000);
    conn.close();
    assertEquals(dec.decode(r.body), "<!DOCTYPE html><html><head><title>Chunky</title></head><body><p>x</p></body></html>");
  } finally { s.close(); }
});

Deno.test("httpGet — the body is STREAM-capped (content-length and chunked): 300 KB offered, 100 KB kept, truncated flagged", async () => {
  const big = enc.encode("<!DOCTYPE html><html><body>" + "x".repeat(300_000) + "</body></html>");
  const s1 = rawServer(async (_r, conn) => { await send(conn, 200, { "Content-Type": "text/html" }, big); });
  const s2 = rawServer(async (_r, conn) => {
    await writeAll(conn, enc.encode(head(200, { "Content-Type": "text/html", "Transfer-Encoding": "chunked" })));
    for (let i = 0; i < big.length; i += 4096) { const part = big.subarray(i, i + 4096); await writeAll(conn, enc.encode(part.length.toString(16) + "\r\n")); await writeAll(conn, part); await writeAll(conn, enc.encode("\r\n")); }
    await writeAll(conn, enc.encode("0\r\n\r\n"));
  });
  try {
    for (const s of [s1, s2]) {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port: s.port });
      const r = await httpGet(conn, "h", "/", Date.now() + 4000, 100_000);
      conn.close();
      assertEquals(r.body.length, 100_000); assertEquals(r.truncated, true); assert(r.bytes >= 100_000 && r.bytes <= big.length, String(r.bytes));
    }
  } finally { s1.close(); s2.close(); }
});

Deno.test("httpGet — a response head over 64 KB, a non-HTTP banner and a closed socket are bad_response; a silent server times out at the deadline", async () => {
  const sHuge = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("HTTP/1.1 200 OK\r\nX-Pad: " + "a".repeat(70_000) + "\r\n\r\n")); });
  const sBanner = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("220 smtp.example ESMTP\r\n\r\n")); });
  const sClose = rawServer(async (_r, conn) => { conn.close(); });
  const sSilent = rawServer(async (_r, conn) => { await new Promise((r) => setTimeout(r, 2500)); try { conn.close(); } catch { /* closed */ } });
  try {
    for (const [s, code, detail] of [[sHuge, "bad_response", /too large/], [sBanner, "bad_response", /not an HTTP/], [sClose, "bad_response", /closed/]] as const) {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port: s.port });
      const err = await httpGet(conn, "h", "/", Date.now() + 3000, 1_000_000).then(() => null, (e) => e as BrandError);
      try { conn.close(); } catch { /* closed */ }
      assert(err instanceof BrandError, "expected BrandError"); assertEquals(err.code, code); assertMatch(err.detail, detail);
    }
    const t0 = Date.now();
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: sSilent.port });
    const err = await httpGet(conn, "h", "/", Date.now() + 500, 1_000_000).then(() => null, (e) => e as BrandError);
    try { conn.close(); } catch { /* closed */ }
    assert(err instanceof BrandError && err.code === "timeout", String(err)); assert(Date.now() - t0 < 1500, "deadline honoured");
  } finally { sHuge.close(); sBanner.close(); sClose.close(); sSilent.close(); }
});

// ---------- 5. redirects re-run the vetting per hop; http → https; IP literal / loops refused
Deno.test("fetchUrl — follows 301 to another vetted host (both vetted, port 443, SNI = hop host); http: upgraded; IP-literal hop refused; loop → too_many_redirects", async () => {
  const b = rawServer(async (req, conn) => { await send(conn, 200, { "Content-Type": "text/html" }, HTML("B " + (/^GET (\S+)/.exec(req) || [])[1])); });
  const a = rawServer(async (_r, conn) => { await send(conn, 301, { Location: "http://www.a-fixture.com/x?y=1#frag" }, ""); });
  const aRoot = rawServer(async (_r, conn) => { await send(conn, 301, { Location: "http://b-fixture.org/#frag" }, ""); });
  const aPath = rawServer(async (_r, conn) => { await send(conn, 301, { Location: "https://b-fixture.org/internal/admin?token=abc" }, ""); });
  const ipHop = rawServer(async (_r, conn) => { await send(conn, 302, { Location: "https://127.0.0.1/" }, ""); });
  const loop = rawServer(async (_r, conn) => { await send(conn, 302, { Location: "https://loop-fixture.net/" }, ""); });
  const noLoc = rawServer(async (_r, conn) => { await send(conn, 302, {}, ""); });
  const vetted: string[] = [];
  const dial = plainDial({ "a-fixture.com": a.port, "www.a-fixture.com": b.port, "aroot-fixture.com": aRoot.port, "apath-fixture.com": aPath.port, "b-fixture.org": b.port, "ip-fixture.com": ipHop.port, "loop-fixture.net": loop.port, "noloc-fixture.com": noLoc.port });
  const deps = { vet: fakeVet(vetted), dial };
  try {
    const p = await fetchUrl(new URL("https://a-fixture.com/"), deps, Date.now() + 4000, 1_000_000, 1500);
    assertEquals(p.url.href, "https://www.a-fixture.com/x?y=1"); assertEquals(p.hops.length, 2); assertEquals(vetted, ["a-fixture.com", "www.a-fixture.com"]); // same registrable domain: the path is kept
    assertEquals(p.res.status, 200); assert(dec.decode(p.res.body).includes("<title>B /x?y=1</title>"));
    const pr = await fetchUrl(new URL("https://aroot-fixture.com/"), deps, Date.now() + 4000, 1_000_000, 1500);
    assertEquals(pr.url.href, "https://b-fixture.org/"); // another registrable domain: only its root is followed (brand.com -> brand.de/)
    const ep = await fetchUrl(new URL("https://apath-fixture.com/"), deps, Date.now() + 3000, 1_000_000, 1500).then(() => null, (e) => e as BrandError);
    assert(ep instanceof BrandError && ep.code === "blocked_host" && /cross-site/.test(ep.detail), "arbitrary path on a third-party host must be refused: " + String(ep));
    assertEquals(regDomain("shop.acme.co.uk"), "acme.co.uk"); assertEquals(regDomain("www.a-fixture.com"), "a-fixture.com"); assertEquals(regDomain("cdn.datocms-assets.com"), "datocms-assets.com");
    assertEquals(regDomain("evil.github.io"), "evil.github.io"); assert(regDomain("victim.github.io") !== regDomain("evil.github.io"), "github.io tenants are different sites"); assertEquals(regDomain("www.victim.github.io"), "victim.github.io");
    assertEquals(regDomain("a.pages.dev"), "a.pages.dev"); assertEquals(regDomain("x.vercel.app"), "x.vercel.app"); assertEquals(regDomain("github.io"), "github.io");
    const e1 = await fetchUrl(new URL("https://ip-fixture.com/"), deps, Date.now() + 3000, 1_000_000, 1500).then(() => null, (e) => e as BrandError);
    assert(e1 instanceof BrandError && e1.code === "blocked_host" && e1.status === 403, String(e1));
    const e2 = await fetchUrl(new URL("https://loop-fixture.net/"), deps, Date.now() + 4000, 1_000_000, 1500).then(() => null, (e) => e as BrandError);
    assert(e2 instanceof BrandError && e2.code === "too_many_redirects", String(e2));
    const e3 = await fetchUrl(new URL("https://noloc-fixture.com/"), deps, Date.now() + 3000, 1_000_000, 1500).then(() => null, (e) => e as BrandError);
    assert(e3 instanceof BrandError && e3.code === "bad_redirect", String(e3));
    for (const u of ["https://user:pw@a-fixture.com/", "https://a-fixture.com:8443/", "ftp://a-fixture.com/"]) {
      const e = await fetchUrl(new URL(u), deps, Date.now() + 3000, 1_000_000, 1500).then(() => null, (e) => e as BrandError);
      assert(e instanceof BrandError && e.code === "blocked_host", u + " → " + String(e));
    }
  } finally { a.close(); aRoot.close(); aPath.close(); b.close(); ipHop.close(); loop.close(); noLoc.close(); }
});

// ---------- 5b. the review's protocol edges
Deno.test("httpGet — a 100 Continue interim head is skipped; conflicting Content-Length headers are bad_response; 'chunkedfoo' is NOT chunked; a chunk header over 1 KB (even with its CRLF) is refused; a non-hex chunk token is refused", async () => {
  const sInterim = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("HTTP/1.1 100 Continue\r\n\r\n")); await send(conn, 200, { "Content-Type": "text/html" }, "<html>after-100</html>"); });
  const sDupCL = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 999\r\n\r\nhello")); });
  const sTeFoo = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunkedfoo\r\n\r\nplain body")); });
  const sBigExt = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;" + "e".repeat(4096) + "\r\nhello\r\n0\r\n\r\n")); });
  const sBadTok = rawServer(async (_r, conn) => { await writeAll(conn, enc.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n-5\r\nhello\r\n0\r\n\r\n")); });
  const run = async (s: { port: number }) => { const conn = await Deno.connect({ hostname: "127.0.0.1", port: s.port }); try { return await httpGet(conn, "h", "/", Date.now() + 3000, 1_000_000); } catch (e) { return e as BrandError; } finally { try { conn.close(); } catch { /* closed */ } } };
  try {
    const r1 = await run(sInterim); assert(!(r1 instanceof Error)); assertEquals(r1.status, 200); assertEquals(dec.decode(r1.body), "<html>after-100</html>");
    const r2 = await run(sDupCL); assert(r2 instanceof BrandError && r2.code === "bad_response" && /content-length/.test(r2.detail), String(r2));
    const r3 = await run(sTeFoo); assert(!(r3 instanceof Error)); assertEquals(dec.decode(r3.body), "plain body");
    const r4 = await run(sBigExt); assert(r4 instanceof BrandError && /chunk header/.test(r4.detail), String(r4));
    const r5 = await run(sBadTok); assert(r5 instanceof BrandError && /chunk size/.test(r5.detail), String(r5));
  } finally { sInterim.close(); sDupCL.close(); sTeFoo.close(); sBigExt.close(); sBadTok.close(); }
});

Deno.test("httpGet — a trickling server (64-byte segments) costs linear time (GrowBuf): 200 KB in 3200 segments well under the deadline", async () => {
  const s = rawServer(async (_r, conn) => { const body = enc.encode("<!DOCTYPE html><html><body>" + "y".repeat(200_000) + "</body></html>"); await writeAll(conn, enc.encode(head(200, { "Content-Type": "text/html", "Content-Length": String(body.length) }))); for (let i = 0; i < body.length; i += 64) { await writeAll(conn, body.subarray(i, i + 64)); if (i % 4096 === 0) await new Promise((r) => setTimeout(r, 1)); } });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: s.port });
    const t0 = Date.now(); const r = await httpGet(conn, "h", "/", Date.now() + 8000, 1_000_000); const ms = Date.now() - t0; conn.close();
    assertEquals(r.body.length, 200_041); assert(ms < 3000, "took " + ms + " ms");
    const g = new GrowBuf(16); for (let i = 0; i < 1000; i++) g.append(enc.encode("ab")); assertEquals(g.length, 2000); assertEquals(dec.decode(g.take(4)), "abab"); assertEquals(g.length, 1996); assertEquals(g.indexOf([0x62, 0x61]), 1);
  } finally { s.close(); }
});

// ---------- 6. encodings, sniffing, stripping, extraction
Deno.test("decodeBody — gzip decoded, a 5 MB zip bomb capped at the limit, br refused, identity passthrough", async () => {
  const gz = async (bytes: Uint8Array) => new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const html = enc.encode(HTML("Zip"));
  const d = await decodeBody(await gz(html), "gzip", 1_000_000);
  assertEquals(dec.decode(d.bytes), HTML("Zip")); assertEquals(d.truncated, false);
  const bomb = await gz(new Uint8Array(5 * 1024 * 1024));
  assert(bomb.length < 20_000, "compresses tiny: " + bomb.length);
  const b = await decodeBody(bomb, "gzip", 100_000);
  assertEquals(b.bytes.length, 100_000); assertEquals(b.truncated, true);
  const id = await decodeBody(html, null, 10);
  assertEquals(id.bytes, html);
  await assertRejects(() => decodeBody(html, "br", 1_000_000), BrandError, "content-encoding");
});

Deno.test("looksLikeHtml — header AND bytes: JSON/SVG/PDF/images/plain text refused, BOM + whitespace + doctype accepted", () => {
  const h = (s: string) => enc.encode(s);
  assert(looksLikeHtml(h(HTML("x")), "text/html; charset=utf-8"));
  assert(looksLikeHtml(h("﻿ \n <!DOCTYPE html><html>"), null));
  assert(looksLikeHtml(h("<html lang=en><head>"), "application/xhtml+xml"));
  assert(looksLikeHtml(h("<!-- c --><div>"), null));
  assert(!looksLikeHtml(h('{"a":1}'), "text/html"));
  assert(!looksLikeHtml(h(HTML("x")), "application/json"));
  assert(!looksLikeHtml(h(HTML("x")), "image/svg+xml"));
  assert(!looksLikeHtml(h('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), null));
  assert(!looksLikeHtml(h("%PDF-1.4"), null));
  assert(!looksLikeHtml(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), null));
  assert(!looksLikeHtml(h("plain text <b>"), "text/plain"));
  assert(!looksLikeHtml(h("plain text <b>"), null));
  assert(!looksLikeHtml(h(""), null));
});

Deno.test("stripScripts — every script block gone (inline, src, mixed case, unterminated), JSON-LD kept, noscript/styles kept", () => {
  const src = '<html><head><script>alert(1)</script><SCRIPT src="/x.js"></SCRIPT><script type="application/ld+json">{"@type":"Organization","logo":"/l.png"}</script><style>.a{}</style></head><body><noscript><img src="/n.png"></noscript><script>bad(' + "x".repeat(10) ;
  const out = stripScripts(src);
  assert(!/alert|x\.js|bad\(/.test(out), out);
  assert(out.includes('application/ld+json">{"@type":"Organization","logo":"/l.png"}</script>'));
  assert(out.includes("<style>.a{}</style>") && out.includes("<noscript><img"));
  assertEquals(stripScripts("<p>no scripts</p>"), "<p>no scripts</p>");
  assertEquals(stripScripts("<p>a <scripture>b</scripture> c</p>"), "<p>a <scripture>b</scripture> c</p>"); // not a script tag
  // fix review: only a REAL type attribute keeps a block, and never one with a src
  assertEquals(stripScripts('<script data-type="application/ld+json" src="https://evil.example/x.js"></script>k'), "k");
  assertEquals(stripScripts('<script itemtype="application/ld+json">alert(1)</script>k'), "k");
  assertEquals(stripScripts("<script data-foo-type = 'application/ld+json'>alert(1)</script>k"), "k");
  assertEquals(stripScripts('<script type="application/ld+json" src="https://evil.example/x.js"></script>k'), "k");
  assertEquals(stripScripts('<script type="text/javascript" data-x=\'application/ld+json\'>alert(1)</script>k'), "k");
  assertEquals(stripScripts('<script type="application/ld+json">{"a":1}</script>k'), '<script type="application/ld+json">{"a":1}</script>k');
  assertEquals(stripScripts("<script\ttype='application/ld+json' >{}</script>k"), "<script\ttype='application/ld+json' >{}</script>k");
  assertEquals(stripScripts("<SCRIPT\ntype=module>x</SCRIPT\n>tail"), "tail");
  // the review's attack: "<script " repeated (no ">") — minutes with the old regexes, linear now; and a 2 MB page of complete tiny scripts
  const t0 = Date.now(); const atk = stripScripts("<!doctype html>" + "<script ".repeat(262_000)); const ms0 = Date.now() - t0;
  assertEquals(atk, "<!doctype html>"); assert(ms0 < 400, "attack input took " + ms0 + " ms");
  const t1 = Date.now(); const many = stripScripts("<html>" + "<script>x</script>".repeat(120_000) + "<b>end</b></html>"); const ms1 = Date.now() - t1;
  assertEquals(many, "<html><b>end</b></html>"); assert(ms1 < 400, "many scripts took " + ms1 + " ms");
  const t2 = Date.now(); stripScripts("<script" + "<script".repeat(300_000) + ">"); assert(Date.now() - t2 < 400, "nested openers");
});

Deno.test("extract — JSON-LD logo, og:logo, link rel=logo, header img, icons, manifest, og names; URLs absolute; strips/customers ignored", () => {
  const page = `<!DOCTYPE html><html><head><title> Acme  Widgets | Home </title>
<meta property="og:site_name" content="Acme Widgets"><meta property="og:title" content="Acme"><meta property="og:image" content="/img/share.png">
<meta property="og:logo" content="//cdn.acme-fixture.com/og-logo.png"><link rel="logo" href="/brand/mark.svg"><link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><link rel="preload" as="image" href="/img/logo-wide.png">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x"},{"@type":"Organization","logo":{"@type":"ImageObject","url":"https://acme-fixture.com/jsonld-logo.png"}}]}</script>
</head><body><header><a href="/"><img src="/img/logo.svg" alt="Acme logo" width="140"></a><nav><img data-src="/img/nav-logo.png" alt="logo" class="lazy"></nav></header>
<section class="customers"><img src="/img/customer-logo-1.png" alt="Customer logo"></section><img src="/img/avatar.png" alt="avatar logo" width="12">
<footer><img src="/img/footer-logo.png" alt="Acme logo"></footer></body></html>`;
  const ex = extract(page, new URL("https://acme-fixture.com/"));
  const by = Object.fromEntries(ex.logos.map((l) => [l.src, l]));
  assertEquals(by["https://acme-fixture.com/jsonld-logo.png"].score, 10);
  assertEquals(by["https://cdn.acme-fixture.com/og-logo.png"].score, 7);
  assertEquals(by["https://acme-fixture.com/brand/mark.svg"].score, 7);
  assert(by["https://acme-fixture.com/img/logo.svg"].score >= 8, JSON.stringify(ex.logos));
  assert(by["https://acme-fixture.com/img/nav-logo.png"], "lazy data-src picked up");
  assert(by["https://acme-fixture.com/img/logo-wide.png"], "preload logo");
  assert(!by["https://acme-fixture.com/img/customer-logo-1.png"], "customer strip never a candidate");
  assert(!by["https://acme-fixture.com/img/avatar.png"], "tiny avatar never a candidate");
  assertEquals(ex.logos[0].src, "https://acme-fixture.com/jsonld-logo.png");
  assertEquals(ex.manifest, "https://acme-fixture.com/site.webmanifest");
  assertEquals(ex.icons.map((i) => i.kind + ":" + i.src + ":" + i.sizes), ["icon:https://acme-fixture.com/favicon.ico:32x32", "apple-touch:https://acme-fixture.com/apple-touch-icon.png:180x180"]);
  assertEquals(ex.og.site_name, "Acme Widgets"); assertEquals(ex.og.image, "https://acme-fixture.com/img/share.png"); assertEquals(ex.og.logo, "https://cdn.acme-fixture.com/og-logo.png");
  assertEquals(ex.title, "Acme Widgets | Home");
  assertEquals(attrs('<img src="/a.png" data-src=\'/b.png\' alt=Logo width=120 hidden>'), { src: "/a.png", "data-src": "/b.png", alt: "Logo", width: "120", hidden: "" });
  assertEquals(manifestIcons('{"icons":[{"src":"/i-48.png","sizes":"48x48"},{"src":"/i-512.png","sizes":"512x512"},{"src":"javascript:alert(1)"},{"src":"/i-192.png","sizes":"192x192"}]}', new URL("https://acme-fixture.com/site.webmanifest")).map((i) => i.src),
    ["https://acme-fixture.com/i-512.png", "https://acme-fixture.com/i-192.png", "https://acme-fixture.com/i-48.png"]);
  assertEquals(manifestIcons("not json", new URL("https://a.com/m")), []);
  const bigPage = "<html><head>" + '<img src="/x.png" alt="logo">'.repeat(5000) + "</head></html>";
  const t0 = Date.now(); extract(bigPage, new URL("https://acme-fixture.com/")); assert(Date.now() - t0 < 500, "extract stays cheap");
});

// ---------- 7. rate windows and caller keys
Deno.test("MemLimiter windows + callerKey (HMAC, stable, not the IP) + clientIp (cf header first, else LAST x-forwarded-for)", async () => {
  const m = new MemLimiter(); let now = 1_000_000;
  for (let i = 0; i < 20; i++) assert(m.hit("k", 20, 60_000, now += 10));
  assert(!m.hit("k", 20, 60_000, now += 10), "21st refused");
  assert(m.hit("k", 20, 60_000, now + 61_000), "window slides");
  // review: a flood of 6000 fresh 10 s burst keys must not evict a victim's 15 s-old minute entry (the sweep uses the fixed 60 s window)
  const m2 = new MemLimiter(); let t = 2_000_000;
  for (let i = 0; i < 20; i++) m2.hit("ip:victim", 20, 60_000, t);
  assert(!m2.hit("ip:victim", 20, 60_000, t), "victim's 21st refused");
  t += 15_000; for (let i = 0; i < 6000; i++) m2.hit("b:flood" + i, 8, 10_000, t + (i % 7) * 100); // crosses several sweep ticks
  t += SWEEP_EVERY_MS + 1; m2.hit("b:tick", 8, 10_000, t);
  assert(!m2.hit("ip:victim", 20, 60_000, t), "victim still limited after the burst flood (not evicted)");
  assert(m2.hit("ip:victim", 20, 60_000, t + 60_000), "the victim's window slides out normally");
  // bounded map: once maxKeys distinct keys are live, a fresh key is refused instead of growing the map
  const m3 = new MemLimiter(100); for (let i = 0; i < 100; i++) assert(m3.hit("k" + i, 5, 60_000, 3_000_000));
  assert(m3.hit("k-new", 5, 60_000, 3_000_000), "a fresh key is ALLOWED at the bound (fix review: no lockout)"); assertEquals(m3.size, 100, "the oldest key was evicted instead");
  for (let i = 0; i < 5; i++) m3.hit("k0", 5, 60_000, 3_000_000); assert(!m3.hit("k0", 5, 60_000, 3_000_000), "the evicted key started over and is limited again after its own 5 hits");
  const m4 = new MemLimiter(); for (let i = 0; i < 100_000; i++) m4.hit("hammer", 20, 60_000, 4_000_000 + i); assert(m4.hit("other", 20, 60_000, 4_000_000), "a hammering key does not grow its entry without bound");
  const k1 = await callerKey("203.0.113.9", "s"), k2 = await callerKey("203.0.113.9", "s");
  assertEquals(k1, k2); assertEquals(k1.length, 32); assert(!k1.includes("203"));
  assertEquals(clientIp(new Request("https://x/", { headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 5.5.5.5" } })), "1.2.3.4");
  assertEquals(clientIp(new Request("https://x/", { headers: { "x-forwarded-for": "9.9.9.9, 5.5.5.5" } })), "5.5.5.5");
  assertEquals(clientIp(new Request("https://x/")), "unknown");
});

// ---------- 8. the handler end to end (injected deps; the DB window is skipped without an env)
Deno.test("handler — GET ?host → JSON with stripped html/logos/icons/manifest icons; safe headers; CORS only for meetingbrand.com; www fallback; errors", async () => {
  const main = rawServer(async (req, conn) => {
    const p = (/^GET (\S+)/.exec(req) || [])[1];
    if (p === "/site.webmanifest") return await send(conn, 200, { "Content-Type": "application/manifest+json" }, '{"icons":[{"src":"/icon-512.png","sizes":"512x512"},{"src":"/icon-192.png","sizes":"192x192"}]}');
    await send(conn, 200, { "Content-Type": "text/html; charset=utf-8" }, HTML("Acme", '<script>alert(1)</script><link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script type="application/ld+json">{"@type":"Organization","logo":"/ld.png"}</script>'));
  });
  const wwwOnly = rawServer(async (_r, conn) => { await send(conn, 200, { "Content-Type": "text/html" }, HTML("WWW")); });
  const jsonOnly = rawServer(async (_r, conn) => { await send(conn, 200, { "Content-Type": "application/json" }, '{"a":1}'); });
  const dial = plainDial({ "acme-fixture.com": main.port, "www.acme-fixture.com": main.port, "www.wwwonly-fixture.com": wwwOnly.port, "json-fixture.com": jsonOnly.port, "www.json-fixture.com": jsonOnly.port });
  const vetted: string[] = [];
  const h = makeHandler({ vet: fakeVet(vetted), dial }, noEnv, new MemLimiter());
  try {
    const r = await h(new Request("https://fn.local/mb-brand?host=Acme-Fixture.com", { headers: { origin: "https://meetingbrand.com", "x-forwarded-for": "198.51.100.7" } }));
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("content-type"), "application/json; charset=utf-8");
    assertEquals(r.headers.get("x-content-type-options"), "nosniff");
    assertMatch(r.headers.get("content-disposition") || "", /^attachment/);
    assertEquals(r.headers.get("content-security-policy"), "sandbox");
    assertEquals(r.headers.get("access-control-allow-origin"), "https://meetingbrand.com");
    assertEquals(r.headers.get("cache-control"), "no-store");
    const j = await r.json();
    assertEquals(j.ok, true); assertEquals(j.host, "acme-fixture.com"); assertEquals(j.final_url, "https://acme-fixture.com/"); assertEquals(j.status, 200);
    assert(!/alert\(1\)/.test(j.html) && j.html.includes("application/ld+json"), "scripts stripped, JSON-LD kept");
    assertEquals(j.logos[0].src, "https://acme-fixture.com/ld.png");
    assert(j.logos.some((l: { src: string }) => l.src === "https://acme-fixture.com/img/logo.svg"));
    assertEquals(j.icons, [{ src: "https://acme-fixture.com/apple-touch-icon.png", kind: "apple-touch", sizes: null }]);
    assertEquals(j.manifest, "https://acme-fixture.com/site.webmanifest");
    assertEquals(j.manifest_icons.map((i: { src: string }) => i.src), ["https://acme-fixture.com/icon-512.png", "https://acme-fixture.com/icon-192.png"]);
    assertEquals(j.title, "Acme"); assert(typeof j.html_bytes === "number" && j.html_bytes > 100); assertEquals(j.truncated, false);
    assertEquals(vetted, ["acme-fixture.com", "acme-fixture.com"], "page + manifest, each vetted");
    // foreign origin → no CORS grant (the browser blocks the read); same body otherwise
    const r2 = await h(new Request("https://fn.local/mb-brand?host=acme-fixture.com", { headers: { origin: "https://evil.example.org", "x-forwarded-for": "198.51.100.8" } }));
    assertEquals(r2.status, 200); assertEquals(r2.headers.get("access-control-allow-origin"), null);
    // preflight
    const pf = await h(new Request("https://fn.local/mb-brand", { method: "OPTIONS", headers: { origin: "https://meetingbrand.com" } }));
    assertEquals(pf.status, 204); assertEquals(pf.headers.get("access-control-allow-origin"), "https://meetingbrand.com");
    // POST body form
    const r3 = await h(new Request("https://fn.local/mb-brand", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify({ host: "acme-fixture.com" }) }));
    assertEquals(r3.status, 200);
    // apex fails (no fixture = connect error) → www. answers
    const r4 = await h(new Request("https://fn.local/mb-brand?host=wwwonly-fixture.com", { headers: { "x-forwarded-for": "198.51.100.10" } }));
    const j4 = await r4.json(); assertEquals(r4.status, 200); assertEquals(j4.final_url, "https://www.wwwonly-fixture.com/"); assertEquals(j4.title, "WWW");
    // errors
    const bad = async (q: string, ip: string) => { const r = await h(new Request("https://fn.local/mb-brand" + q, { headers: { "x-forwarded-for": ip } })); return [r.status, (await r.json()).error, r.headers.get("x-content-type-options")]; };
    const tb = Date.now(); assertEquals(await bad("?host=127.0.0.1", "198.51.100.11"), [400, "bad_host", "nosniff"]); assert(Date.now() - tb < 500, "a malformed host is refused at once (no floor)");
    assertEquals(await bad("?host=http%3A%2F%2Facme.com%2F", "198.51.100.12"), [400, "bad_host", "nosniff"]);
    assertEquals(await bad("", "198.51.100.13"), [400, "bad_host", "nosniff"]);
    assertEquals(await bad("?host=json-fixture.com", "198.51.100.14"), [415, "not_html", "nosniff"]);
    assertEquals(await bad("?host=nofixture-fixture.com", "198.51.100.15"), [502, "unreachable", "nosniff"]);
    const generic = await h(new Request("https://fn.local/mb-brand?host=nofixture-fixture.com", { headers: { "x-forwarded-for": "198.51.100.17" } }));
    const gj = await generic.json(); assertEquals(gj.detail, "the site could not be fetched"); assert(!/fixture|connect|dial|never|no fixture/.test(JSON.stringify(gj)), "no per-target reason leaks: " + JSON.stringify(gj));
    const put = await h(new Request("https://fn.local/mb-brand?host=acme-fixture.com", { method: "PUT", headers: { "x-forwarded-for": "198.51.100.16" } }));
    assertEquals(put.status, 405);
  } finally { main.close(); wwwOnly.close(); jsonOnly.close(); }
});

Deno.test("handler — a blocked DNS answer is answered as a GENERIC 502 unreachable (no address-class oracle) and the www. variant is NOT tried; an unresolvable name is the same 502", async () => {
  const dialed: string[] = [];
  const h = makeHandler({ vet: async (host) => { if (host === "evil-fixture.com") throw new BrandError(403, "blocked_host", "the name points at a loopback address"); throw new BrandError(502, "unresolvable", "no address"); }, dial: async (_i, _p, sni) => { dialed.push(sni); throw new Error("never"); } }, noEnv, new MemLimiter());
  const r = await h(new Request("https://fn.local/mb-brand?host=evil-fixture.com", { headers: { "x-forwarded-for": "198.51.100.20" } }));
  const jb = await r.json(); assertEquals(r.status, 502); assertEquals(jb.error, "unreachable"); assertEquals(jb.detail, "the site could not be fetched"); assertEquals(dialed, []);
  const r2 = await h(new Request("https://fn.local/mb-brand?host=nx-fixture.com", { headers: { "x-forwarded-for": "198.51.100.21" } }));
  const j2 = await r2.json(); assertEquals(r2.status, 502); assertEquals(j2.error, "unreachable"); assertEquals(j2.detail, "the site could not be fetched"); // indistinguishable from the blocked name
});

Deno.test("handler — per-caller burst and minute windows answer 429 (memory window, no DB); another caller is unaffected", async () => {
  const h = makeHandler({ vet: async () => { throw new BrandError(502, "unresolvable", "x"); }, dial: async () => { throw new Error("never"); } }, noEnv, new MemLimiter());
  const call = async (ip: string) => (await h(new Request("https://fn.local/mb-brand?host=rl-fixture.com", { headers: { "x-forwarded-for": ip } }))).status;
  const codes: number[] = [];
  for (let i = 0; i < LIMITS.ipBurst10s + 1; i++) codes.push(await call("198.51.100.30"));
  assertEquals(codes.slice(0, LIMITS.ipBurst10s).every((c) => c === 502), true);
  assertEquals(codes[LIMITS.ipBurst10s], 429);
  assertEquals(await call("198.51.100.31"), 502);
});
