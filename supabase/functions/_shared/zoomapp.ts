// _shared/zoomapp.ts — the pure parts of "MeetingBrand for Zoom" (the user-managed Zoom App, PLAN-active-push §1.2):
//   * decryptAppContext(): the x-zoom-app-context header the Zoom client sends with every GET of the Home URL —
//     AES-256-GCM, key = SHA-256(client secret), url-safe base64 of
//     [ivLength:1][iv][aadLength:2 LE][aad][cipherLength:4 LE][cipherText][tag:16]
//     (developers.zoom.us/docs/zoom-apps/zoom-app-context — verified 2026-09-23; decrypted JSON: typ, uid, mid?, ts, exp, act?)
//   * tickets: mb-zoom-app (which holds the client secret) turns the decrypted context into a short HMAC ticket that it
//     embeds in the page; the page posts the ticket to mb-agent /zoom/resolve, which verifies it with the same
//     MB_TOKEN_KEY-derived key and hands out a device token. The page never sees the secret, and a ticket cannot be
//     forged without MB_TOKEN_KEY. No Deno APIs beyond WebCrypto — unit-tested in tests/zoomapp_test.ts.
//
// Why the Zoom user id and not an e-mail: the Zoom Apps SDK's getUserContext() returns status / screenName /
// participantUUID / role only (no e-mail, no account id — appssdk.zoom.us GetUserContextResponse, verified 2026-09-23).
// The only authenticated identity a Zoom App gets without an OAuth token exchange is `uid` in this header.

import { b64url, deriveHmac, fromB64url } from "./crypto.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ZoomAppContextError extends Error {}

export interface AppContext {
  /** 'panel' (main client), 'meeting', 'webinar', 'chat' */
  typ: string;
  /** the Zoom user id who opened the app — matches mb.employees.ext_id written by mb-sync-zoom */
  uid: string;
  /** meeting uuid (meeting/webinar contexts only) */
  mid?: string;
  ts: number;
  exp: number;
  act?: string;
}

/** SHA-256 of the client secret as an AES-256-GCM key. */
export async function contextKey(clientSecret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(clientSecret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Split the header into its parts; throws ZoomAppContextError on a malformed layout. */
export function unpackAppContext(header: string): { iv: Uint8Array; aad: Uint8Array; cipherText: Uint8Array; tag: Uint8Array } {
  const h = header.trim();
  if (!h || h.length > 8192 || /[^A-Za-z0-9_=+\/-]/.test(h)) throw new ZoomAppContextError("bad header encoding");
  let buf: Uint8Array;
  try {
    buf = fromB64url(h.replace(/=+$/, ""));
  } catch {
    throw new ZoomAppContextError("bad base64");
  }
  let o = 0;
  const need = (n: number) => {
    if (o + n > buf.length) throw new ZoomAppContextError("truncated header");
  };
  need(1);
  const ivLen = buf[o++];
  need(ivLen);
  const iv = buf.slice(o, o + ivLen);
  o += ivLen;
  need(2);
  const aadLen = buf[o] | (buf[o + 1] << 8);
  o += 2;
  need(aadLen);
  const aad = buf.slice(o, o + aadLen);
  o += aadLen;
  need(4);
  const ctLen = (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
  o += 4;
  need(ctLen);
  const cipherText = buf.slice(o, o + ctLen);
  o += ctLen;
  const tag = buf.slice(o);
  if (tag.length !== 16 || ivLen < 12) throw new ZoomAppContextError("bad tag/iv length");
  return { iv, aad, cipherText, tag };
}

/** Decrypt + validate the header. Throws ZoomAppContextError (never leaks which check failed beyond the message). */
export async function decryptAppContext(header: string, clientSecret: string, nowMs: number): Promise<AppContext> {
  const { iv, aad, cipherText, tag } = unpackAppContext(header);
  const key = await contextKey(clientSecret);
  const ct = new Uint8Array(cipherText.length + tag.length);
  ct.set(cipherText, 0);
  ct.set(tag, cipherText.length);
  let plain: string;
  try {
    plain = dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ct));
  } catch {
    throw new ZoomAppContextError("decrypt failed (wrong client secret or tampered header)");
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(plain);
  } catch {
    throw new ZoomAppContextError("context is not JSON");
  }
  const uid = typeof o.uid === "string" ? o.uid.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw new ZoomAppContextError("context has no usable uid");
  const typ = typeof o.typ === "string" ? o.typ.trim().toLowerCase().slice(0, 16) : "";
  if (!typ) throw new ZoomAppContextError("context has no typ");
  const exp = toMs(o.exp);
  const ts = toMs(o.ts);
  if (!Number.isFinite(exp)) throw new ZoomAppContextError("context has no exp");
  if (exp <= nowMs) throw new ZoomAppContextError("context expired");
  const out: AppContext = { typ, uid, ts: Number.isFinite(ts) ? ts : nowMs, exp };
  if (typeof o.mid === "string" && o.mid.trim()) out.mid = o.mid.trim().slice(0, 128);
  if (typeof o.act === "string" && o.act.trim()) out.act = o.act.trim().slice(0, 512);
  return out;
}

/** Zoom writes ts/exp as unix seconds (long); tolerate milliseconds too. */
function toMs(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

/** Test/fixture helper: build a header exactly the way the Zoom client does (also used by the QA runbook). */
export async function encryptAppContext(ctx: Record<string, unknown>, clientSecret: string, aadText = "mb-test"): Promise<string> {
  const key = await contextKey(clientSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = enc.encode(aadText);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, enc.encode(JSON.stringify(ctx))));
  const cipherText = ct.slice(0, ct.length - 16);
  const tag = ct.slice(ct.length - 16);
  const out = new Uint8Array(1 + iv.length + 2 + aad.length + 4 + cipherText.length + 16);
  let o = 0;
  out[o++] = iv.length;
  out.set(iv, o);
  o += iv.length;
  out[o++] = aad.length & 0xff;
  out[o++] = (aad.length >> 8) & 0xff;
  out.set(aad, o);
  o += aad.length;
  out[o++] = cipherText.length & 0xff;
  out[o++] = (cipherText.length >> 8) & 0xff;
  out[o++] = (cipherText.length >> 16) & 0xff;
  out[o++] = (cipherText.length >> 24) & 0xff;
  out.set(cipherText, o);
  o += cipherText.length;
  out.set(tag, o);
  return b64url(out);
}

// ---------------------------------------------------------------- tickets (mb-zoom-app → page → mb-agent)

export const TICKET_INFO = "mb-zoom-app-ticket/hmac-sha256/v1";
export const TICKET_TTL_MS = 10 * 60 * 1000;
export const TICKET_RE = /^[A-Za-z0-9_-]{20,2048}\.[A-Za-z0-9_-]{40,50}$/;

export interface Ticket {
  uid: string;
  typ: string;
  mid?: string;
  iat: number;
  exp: number;
}

export async function ticketKey(tokenKeyB64: string): Promise<CryptoKey> {
  return deriveHmac(tokenKeyB64, TICKET_INFO);
}

/** ticket = b64url(json) + "." + b64url(hmac). Stateless: TTL + signature. */
export async function signTicket(key: CryptoKey, ctx: Pick<AppContext, "uid" | "typ" | "mid">, nowMs: number): Promise<string> {
  const t: Ticket = { uid: ctx.uid, typ: ctx.typ, iat: nowMs, exp: nowMs + TICKET_TTL_MS };
  if (ctx.mid) t.mid = ctx.mid;
  const body = b64url(enc.encode(JSON.stringify(t)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The ticket's payload when the signature verifies and it has not expired; null otherwise. */
export async function verifyTicket(key: CryptoKey, ticket: string, nowMs: number): Promise<Ticket | null> {
  if (typeof ticket !== "string" || !TICKET_RE.test(ticket)) return null;
  const [body, mac] = ticket.split(".");
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, fromB64url(mac), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let t: Ticket;
  try {
    t = JSON.parse(dec.decode(fromB64url(body)));
  } catch {
    return null;
  }
  if (typeof t.uid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.uid)) return null;
  if (typeof t.exp !== "number" || t.exp <= nowMs) return null;
  if (typeof t.iat !== "number" || t.iat > nowMs + 60_000) return null;
  return t;
}

// ---------------------------------------------------------------- the page's OWASP headers (Zoom refuses to render without them)

export const ZOOM_APP_SDK_HOST = "https://appssdk.zoom.us";

/**
 * The Content-Type of the page. WHY THE ODD CASE (verified 2026-09-23 with a throwaway probe function, deleted afterwards):
 * the Supabase gateway rewrites every function response whose Content-Type is `text/html` to `text/plain` +
 * `Content-Security-Policy: default-src 'none'; sandbox` whenever the request looks like a browser navigation
 * (Accept: text/html or a browser User-Agent) — an anti-phishing rule for the shared *.supabase.co domain (HTML is
 * served untouched only behind the paid custom-domain add-on). The gateway's match is case-sensitive; HTTP media types
 * are not (RFC 9110 §8.3.1), so `Text/HTML` reaches Chromium — and the Zoom client's embedded browser — as an HTML
 * document with OUR four headers intact. This is a workaround, not a contract: mb-zoom-app /health re-checks it live
 * (`html.passthrough`) so a gateway change shows up as `false` before a customer sees a blank app. The durable fixes,
 * both the owner's call: a Supabase custom domain, or a Cloudflare Worker on zoom.meetingbrand.com (README §2).
 */
export const HTML_CONTENT_TYPE = "Text/HTML; charset=utf-8";

/** Does a live response of the page still reach browsers as HTML (not the gateway's text/plain + sandbox rewrite)? */
export function htmlPassthrough(headers: Headers): { ok: boolean; contentType: string; csp: string } {
  const contentType = headers.get("content-type") ?? "";
  const csp = headers.get("content-security-policy") ?? "";
  const ok = /^text\/html\b/i.test(contentType.trim()) && !/\bsandbox\b/i.test(csp);
  return { ok, contentType, csp };
}

/**
 * The four headers the Zoom client validates on every text/html 200 of the Home URL
 * (developers.zoom.us/docs/zoom-apps/security/owasp — verified 2026-09-23: presence is checked, values are ours).
 * CSP: only the SDK host + this origin for scripts (no inline script at all — #mb-ctx is a JSON data block, which
 * CSP does not execute), only the Supabase origin (signed export URLs + mb-agent) for images/fetch, inline styles
 * allowed (the page is one file). No frame-ancestors: the Zoom client embeds the page.
 */
export function owaspHeaders(selfOrigin: string): Record<string, string> {
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${ZOOM_APP_SDK_HOST}`,
    "style-src 'unsafe-inline'",
    `img-src 'self' ${selfOrigin} data:`,
    `connect-src 'self' ${selfOrigin}`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}
