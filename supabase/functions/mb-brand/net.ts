// mb-brand/net.ts — hostname validation, DNS resolution + address classification, and a PINNED HTTP/1.1 client over TLS.
//
// Why not fetch(): fetch resolves the name itself, so the address we vetted and the address it connects to can differ
// (DNS rebinding / a second answer). Here we resolve, classify EVERY answer, pick one public address, open the TCP socket
// to THAT address and start TLS with the hostname as SNI (the certificate is validated against the hostname, so a public
// address that does not own the site's certificate fails too). Every redirect hop re-runs the whole vetting.
// Memory rule (review-before-deploy-public-endpoints): refuse IP literals of any family, classify v4 + v6 incl. ::ffff:,
// ::a.b.c.d, 64:ff9b::/96, 2002::/16, Teredo, ULA, link-local, multicast, docs, non-2000::/3; pin the socket; time out
// across hops; stream-cap the body (never buffer-then-check).

export class BrandError extends Error {
  constructor(public status: number, public code: string, public detail: string) {
    super(detail);
  }
}

export const HOST_MAX = 253;
export const LABEL_MAX = 63;
// never fetched, whatever they resolve to (internal / special-use / our own infrastructure)
const BLOCKED_SUFFIX = [
  ".localhost", ".localdomain", ".local", ".internal", ".arpa", ".home", ".lan", ".corp", ".intranet", ".private", ".test", ".example",
  ".invalid", ".onion", ".i2p", ".svc", ".supabase.co", ".supabase.in", ".supabase.net", ".supabase.red", ".supabase.com",
];
const BLOCKED_EXACT = new Set([
  "localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data", "supabase.co", "supabase.com",
]);

/** A bare public hostname (lower-cased, no trailing dot) or null. Hostname ONLY: no scheme, path, port, userinfo, brackets,
 * percent-encoding, whitespace or non-ASCII; no IP literal in any notation (dotted, hex, integer, IPv6). */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let h = input.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > HOST_MAX) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) {
    if (!l || l.length > LABEL_MAX || l.startsWith("-") || l.endsWith("-")) return null;
  }
  const tld = labels[labels.length - 1];
  // the public suffix is alphabetic (or an IDN xn-- label): an all-digit or 0x.. last label is an IP literal in disguise
  if (!/^(xn--[a-z0-9-]{2,}|[a-z]{2,24})$/.test(tld)) return null;
  if (BLOCKED_EXACT.has(h)) return null;
  for (const s of BLOCKED_SUFFIX) if (h.endsWith(s)) return null;
  return h;
}

export type IpKind = "public" | "private" | "loopback" | "link-local" | "multicast" | "reserved" | "unspecified" | "invalid";

/** Canonical dotted-decimal only: a leading zero (010.0.0.1 — octal to some parsers, decimal to others) is INVALID, never guessed. */
export function parseV4(s: string): number[] | null {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(String(s).trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

export function classifyV4(o: number[]): IpKind {
  const [a, b, c] = o;
  if (a === 0) return "unspecified"; // 0.0.0.0/8
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64/10 shared address space (CGNAT)
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local"; // incl. the cloud metadata address 169.254.169.254
  if (a === 168 && b === 63 && c === 129 && o[3] === 16) return "reserved"; // Azure WireServer (review)
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "reserved"; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return "reserved"; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "reserved"; // 6to4 relay anycast
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved"; // 240/4 + 255.255.255.255
  return "public";
}

/** 8 groups (0..65535) or null. Accepts [brackets], a %zone, and an embedded dotted-quad tail (::ffff:1.2.3.4). */
export function parseV6(s: string): number[] | null {
  let str = String(s).trim().toLowerCase();
  if (str.startsWith("[") && str.endsWith("]")) str = str.slice(1, -1);
  const z = str.indexOf("%");
  if (z >= 0) str = str.slice(0, z);
  if (!/^[0-9a-f:.]+$/.test(str) || str.indexOf(":") < 0) return null;
  let v4tail: number[] | null = null;
  if (str.includes(".")) {
    const i = str.lastIndexOf(":");
    const v4 = parseV4(str.slice(i + 1));
    if (!v4) return null;
    v4tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    str = str.slice(0, i + 1) + "x"; // placeholder group for the two tail groups
  }
  const parts = str.split("::");
  if (parts.length > 2) return null;
  const toGroups = (p: string): number[] | null => {
    if (p === "") return [];
    const out: number[] = [];
    for (const g of p.split(":")) {
      if (g === "x" && v4tail) { out.push(...v4tail); continue; }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(parts[0]);
  if (!head) return null;
  if (parts.length === 2) {
    const tail = toGroups(parts[1]);
    if (!tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...new Array(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

export function classifyV6(g: number[]): IpKind {
  if (g.length !== 8) return "invalid";
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return "unspecified"; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback"; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyV4(v4(g[6], g[7])); // ::ffff:a.b.c.d IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return "reserved"; // ::a.b.c.d IPv4-compatible (deprecated) — never public
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return classifyV4(v4(g[6], g[7])); // 64:ff9b::/96 NAT64 — the embedded IPv4 decides
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "reserved"; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return "reserved"; // 2002::/16 6to4 (relay-tunnelled to an embedded IPv4)
  if (g[0] === 0x2001 && g[1] === 0) return "reserved"; // 2001::/32 Teredo (embeds an obfuscated IPv4)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0) return "reserved"; // 2001:2::/48 benchmarking (review)
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return "reserved"; // 3fff::/20 documentation, RFC 9637 (review)
  if (g[0] === 0x5f00) return "reserved"; // 5f00::/16 SRv6 SIDs, RFC 9602 (review)
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return "reserved"; // 2001:10::/28 ORCHID
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0020) return "reserved"; // 2001:20::/28 ORCHIDv2
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return "reserved"; // 100::/64 discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return "private"; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if ((g[0] & 0xe000) !== 0x2000) return "reserved"; // outside 2000::/3 = not global unicast
  return "public";
}

export function classifyIp(ip: string): IpKind {
  const v4 = parseV4(ip);
  if (v4) return classifyV4(v4);
  const v6 = parseV6(ip);
  if (v6) return classifyV6(v6);
  return "invalid";
}

export type Resolver = (host: string) => Promise<string[]>;

/** The runtime resolver: A + AAAA. A missing record type is an empty list; a resolver that cannot run at all throws. */
export const systemResolve: Resolver = async (host) => {
  if (typeof Deno === "undefined" || typeof Deno.resolveDns !== "function") throw new BrandError(503, "resolver_unavailable", "Deno.resolveDns is not available");
  const q = async (t: "A" | "AAAA"): Promise<string[]> => {
    try {
      return (await Deno.resolveDns(host, t)) as string[];
    } catch (e) {
      // NXDOMAIN / no such record type → nothing of this type; anything else (no resolver, permission) is a real failure
      if (e instanceof Deno.errors.NotFound) return [];
      const msg = String((e as Error)?.message || e).toLowerCase();
      if (/no record|not found|nxdomain|no such|name error|does not exist|no data|servfail|refused|timed out|timeout/.test(msg)) return [];
      throw e;
    }
  };
  const [a, aaaa] = await Promise.all([q("A"), q("AAAA")]);
  return [...a, ...aaaa];
};

export interface Vetted {
  host: string;
  ip: string;
  family: 4 | 6;
  all: string[];
}

/** Resolve and classify. ANY non-public answer refuses the whole name (no "pick the public one" — a rebinding trick
 * answers one public and one private address). IPv4 preferred for the socket. */
export async function vetHost(host: string, resolve: Resolver): Promise<Vetted> {
  let addrs: string[];
  try {
    addrs = Array.from(new Set((await resolve(host)).map((a) => String(a).trim()).filter(Boolean)));
  } catch (e) {
    if (e instanceof BrandError) throw e;
    throw new BrandError(502, "dns_failed", "the name could not be resolved");
  }
  if (!addrs.length) throw new BrandError(502, "unresolvable", "the name has no address");
  for (const ip of addrs) {
    const k = classifyIp(ip);
    if (k !== "public") throw new BrandError(403, "blocked_host", "the name points at a " + k + " address");
  }
  const v4 = addrs.find((ip) => parseV4(ip));
  return { host, ip: v4 ?? addrs[0], family: v4 ? 4 : 6, all: addrs };
}

export type Dialer = (ip: string, port: number, sni: string, timeoutMs: number) => Promise<Deno.Conn>;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new BrandError(504, "timeout", what + " timed out")), Math.max(1, ms));
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t)) as Promise<T>;
}

/** TCP to the VETTED address, then TLS with the hostname as SNI (certificate checked against the hostname), HTTP/1.1 only. */
export const tlsDialer: Dialer = async (ip, port, sni, timeoutMs) => {
  const tcp = await withTimeout(Deno.connect({ hostname: ip, port, transport: "tcp" }), timeoutMs, "connect");
  try {
    return await withTimeout(Deno.startTls(tcp, { hostname: sni, alpnProtocols: ["http/1.1"] }), timeoutMs, "tls handshake");
  } catch (e) {
    try { tcp.close(); } catch { /* already closed */ }
    throw e;
  }
};

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 MeetingBrand/1.0 (+https://meetingbrand.com/)";
export const HEADERS_MAX = 64 * 1024;

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  truncated: boolean;
  bytes: number; // body bytes received (before any decompression), capped
}

/** Amortised-linear byte accumulator (review: a concat per read was O(n^2) under a trickling server): a doubling backing store and a
 * read cursor; take()/view() never copy. */
export class GrowBuf {
  private data: Uint8Array;
  private start = 0;
  private end = 0;
  constructor(cap = 64 * 1024) {
    this.data = new Uint8Array(Math.max(16, cap));
  }
  get length() {
    return this.end - this.start;
  }
  append(chunk: Uint8Array) {
    if (!chunk.length) return;
    if (this.end + chunk.length > this.data.length) {
      const live = this.end - this.start;
      let cap = this.data.length;
      while (cap < live + chunk.length) cap *= 2;
      const nd = new Uint8Array(cap);
      nd.set(this.data.subarray(this.start, this.end), 0);
      this.data = nd; this.start = 0; this.end = live;
    }
    this.data.set(chunk, this.end);
    this.end += chunk.length;
  }
  view(): Uint8Array {
    return this.data.subarray(this.start, this.end);
  }
  take(n: number): Uint8Array {
    const k = Math.min(n, this.length);
    const out = this.data.subarray(this.start, this.start + k);
    this.start += k;
    return out;
  }
  indexOf(seq: number[], from = 0): number {
    return indexOfSeq(this.view(), seq, from);
  }
}

function indexOfSeq(buf: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = Math.max(0, from); i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/** Buffered reader over a connection with one deadline for every read. */
class Stream {
  buf = new GrowBuf();
  eof = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(conn: Deno.Conn, private deadline: number) {
    this.reader = conn.readable.getReader();
  }
  get length() {
    return this.buf.length;
  }
  async fill(): Promise<boolean> {
    if (this.eof) return false;
    const ms = this.deadline - Date.now();
    if (ms <= 0) throw new BrandError(504, "timeout", "read deadline passed");
    const r = await withTimeout(this.reader.read(), ms, "read");
    if (r.done) { this.eof = true; return false; }
    this.buf.append(r.value);
    return true;
  }
  take(n: number): Uint8Array {
    return this.buf.take(n);
  }
  /** hands the socket back to the caller (who closes it); never cancels the readable — that would close the connection under the caller */
  release() {
    try { this.reader.releaseLock(); } catch { /* already released */ }
  }
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array, deadline: number) {
  let off = 0;
  while (off < bytes.length) {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new BrandError(504, "timeout", "write deadline passed");
    off += await withTimeout(conn.write(bytes.subarray(off)), ms, "write");
  }
}

const CRLFCRLF = [13, 10, 13, 10], CRLF = [13, 10];

/** One GET over an already connected socket. Body streamed and CAPPED at maxBody (the rest is not read); chunked and
 * content-length handled; headers capped at HEADERS_MAX. Never throws on an HTTP error status (the caller decides). */
export async function httpGet(conn: Deno.Conn, host: string, path: string, deadline: number, maxBody: number, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"): Promise<HttpResult> {
  const req = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: ${accept}\r\nAccept-Language: en,he;q=0.8\r\nConnection: close\r\n\r\n`;
  await writeAll(conn, new TextEncoder().encode(req), deadline);
  const s = new Stream(conn, deadline);
  try {
    // ---- head (a 1xx interim head — 100 Continue, 103 Early Hints — is skipped: the final head follows)
    let status = 0, headers = new Headers(), cls: string[] = [];
    for (let interim = 0; ; interim++) {
      let hdrEnd = -1, scanFrom = 0;
      while ((hdrEnd = s.buf.indexOf(CRLFCRLF, scanFrom)) < 0) {
        if (s.length >= HEADERS_MAX) throw new BrandError(502, "bad_response", "response head too large");
        scanFrom = Math.max(0, s.length - 3);
        if (!(await s.fill())) throw new BrandError(502, "bad_response", "connection closed before the response head");
      }
      if (hdrEnd + 4 > HEADERS_MAX) throw new BrandError(502, "bad_response", "response head too large");
      const headText = new TextDecoder("latin1").decode(s.take(hdrEnd + 4));
      const lines = headText.split("\r\n");
      const st = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || "");
      if (!st) throw new BrandError(502, "bad_response", "not an HTTP/1.x response");
      status = Number(st[1]);
      headers = new Headers(); cls = [];
      for (const ln of lines.slice(1)) {
        const i = ln.indexOf(":");
        if (i <= 0) continue;
        const k = ln.slice(0, i).trim(), v = ln.slice(i + 1).trim();
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) continue;
        if (k.toLowerCase() === "content-length") cls.push(v);
        try { headers.append(k, v); } catch { /* an unrepresentable value is dropped */ }
      }
      if (status >= 100 && status < 200 && interim < 3) continue;
      break;
    }
    if (new Set(cls.map((x) => x.trim())).size > 1) throw new BrandError(502, "bad_response", "conflicting content-length headers");
    // ---- body (streamed into an amortised-linear buffer, capped at maxBody)
    const body = new GrowBuf(Math.min(maxBody + 1, 256 * 1024));
    let truncated = false, bytes = 0;
    const push = (chunk: Uint8Array) => {
      bytes += chunk.length;
      const room = maxBody - body.length;
      if (room <= 0) { truncated = true; return false; }
      if (chunk.length > room) { body.append(chunk.subarray(0, room)); truncated = true; return false; }
      body.append(chunk);
      return true;
    };
    const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
    const te = (headers.get("transfer-encoding") || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const chunked = te.length > 0 && te[te.length - 1] === "chunked";
    if (noBody) { /* nothing */ } else if (chunked) {
      chunks: for (;;) {
        let le: number;
        while ((le = s.buf.indexOf(CRLF)) < 0) {
          if (s.length > 1024) throw new BrandError(502, "bad_response", "bad chunk header");
          if (!(await s.fill())) break chunks;
        }
        if (le > 1024) throw new BrandError(502, "bad_response", "bad chunk header");
        const sizeLine = new TextDecoder("latin1").decode(s.take(le + 2)).trim();
        const tok = sizeLine.split(";")[0].trim();
        if (!/^[0-9a-fA-F]{1,8}$/.test(tok)) throw new BrandError(502, "bad_response", "bad chunk size");
        const size = parseInt(tok, 16);
        if (size === 0) break; // trailers ignored
        let need = size;
        while (need > 0) {
          if (!s.length && !(await s.fill())) break chunks;
          const part = s.take(Math.min(need, s.length));
          need -= part.length;
          if (!push(part)) break chunks;
        }
        // the CRLF after the chunk data
        while (s.length < 2) if (!(await s.fill())) break chunks;
        s.take(2);
      }
    } else {
      const cl = cls[0];
      let want = cl != null && /^\d+$/.test(cl.trim()) ? Number(cl.trim()) : Infinity;
      for (;;) {
        if (want <= 0) break;
        if (!s.length && !(await s.fill())) break;
        const part = s.take(Math.min(s.length, want === Infinity ? s.length : want));
        want -= part.length;
        if (!push(part)) break;
      }
    }
    return { status, headers, body: body.view(), truncated, bytes };
  } finally {
    s.release();
  }
}

export const MAX_HOPS = 4;

/** Registrable domain with a short public-suffix list (two-level ccTLD suffixes such as co.uk / co.il / com.au). Mirrors the app's regDomain. */
const TENANT_SUFFIX = new Set(["github.io", "gitlab.io", "pages.dev", "vercel.app", "netlify.app", "herokuapp.com", "blogspot.com", "wordpress.com", "azurewebsites.net",
  "cloudfront.net", "amazonaws.com", "web.app", "firebaseapp.com", "workers.dev", "onrender.com", "fly.dev", "surge.sh", "glitch.me", "repl.co", "webflow.io",
  "squarespace.com", "myshopify.com", "wixsite.com", "weebly.com", "godaddysites.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "azurestaticapps.net", "appspot.com", "run.app", "github.dev", "readthedocs.io", "hubspotpagebuilder.com"]);
export function regDomain(h: string): string {
  const p = String(h || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (p.length <= 2) return p.join(".");
  if (TENANT_SUFFIX.has(p.slice(-2).join("."))) return p.slice(-3).join("."); // fix review: tenants of a shared host suffix are different sites
  const sld = p[p.length - 1].length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gob|nom|mil|ltd|plc|me|biz|info|web|firm|gen|ind|sch|res|muni|k12|id|my|in)$/.test(p[p.length - 2]);
  return p.slice(sld ? -3 : -2).join(".");
}

export interface Deps {
  vet: (host: string) => Promise<Vetted>;
  dial: Dialer;
}

export interface PageResult {
  url: URL;
  res: HttpResult;
  hops: string[];
  ip: string;
}

/** One URL with redirects: every hop is a bare https host (port 443, no userinfo) that passes normalizeHost + vetHost and
 * is dialled at its vetted address. http: redirects are upgraded to https (we only speak TLS). */
export async function fetchUrl(start: URL, deps: Deps, deadline: number, maxBody: number, connectMs: number, accept?: string): Promise<PageResult> {
  let url = new URL(start.href);
  const hops: string[] = [];
  const startReg = regDomain(start.hostname);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") throw new BrandError(403, "blocked_host", "only https is fetched");
    if (url.username || url.password) throw new BrandError(403, "blocked_host", "userinfo in URL refused");
    if (url.port && url.port !== "443") throw new BrandError(403, "blocked_host", "only port 443 is fetched");
    const host = normalizeHost(url.hostname);
    if (!host) throw new BrandError(403, "blocked_host", "refused host");
    const remaining = deadline - Date.now();
    if (remaining < 250) throw new BrandError(504, "timeout", "time budget exhausted");
    const vet = await deps.vet(host);
    const conn = await deps.dial(vet.ip, 443, host, Math.min(remaining, connectMs));
    let res: HttpResult;
    try {
      res = await httpGet(conn, host, (url.pathname || "/") + (url.search || ""), deadline, maxBody, accept);
    } finally {
      try { conn.close(); } catch { /* closed */ }
    }
    hops.push(url.href);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new BrandError(502, "bad_redirect", "redirect without a location");
      let next: URL;
      try { next = new URL(loc, url); } catch { throw new BrandError(502, "bad_redirect", "unparseable location"); }
      next.hash = "";
      // review: a hop to ANOTHER registrable domain is followed only to that site's root (brand.com -> brand.de/), never to an arbitrary
      // path or query — otherwise this function is a fetcher of any public URL. Inside the same registrable domain the path is kept (acme.com -> www.acme.com/en/).
      if (regDomain(next.hostname) !== startReg && ((next.pathname || "/") !== "/" || next.search)) throw new BrandError(403, "blocked_host", "cross-site redirect to a path refused");
      url = next;
      continue;
    }
    return { url, res, hops, ip: vet.ip };
  }
  throw new BrandError(502, "too_many_redirects", "more than " + MAX_HOPS + " redirects");
}

/** gzip / deflate bodies decoded with the SAME cap (a tiny compressed body must not inflate into gigabytes). */
export async function decodeBody(body: Uint8Array, encoding: string | null, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const enc = (encoding || "").trim().toLowerCase();
  if (!enc || enc === "identity") return { bytes: body, truncated: false };
  const formats: string[] = enc === "gzip" || enc === "x-gzip" ? ["gzip"] : enc === "deflate" ? ["deflate", "deflate-raw"] : [];
  if (!formats.length) throw new BrandError(415, "not_html", "unsupported content-encoding " + enc);
  let lastErr: unknown = null;
  for (const f of formats) {
    try {
      const ds = new DecompressionStream(f as "gzip");
      const reader = new Blob([body as BlobPart]).stream().pipeThrough(ds).getReader();
      const out = new GrowBuf(Math.min(maxBytes + 1, 256 * 1024));
      let truncated = false;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        const room = maxBytes - out.length;
        if (r.value.length >= room) { out.append(r.value.subarray(0, Math.max(0, room))); truncated = true; await reader.cancel().catch(() => {}); break; }
        out.append(r.value);
      }
      return { bytes: out.view(), truncated };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new BrandError(415, "not_html", "undecodable " + enc + " body" + (lastErr ? "" : ""));
}
