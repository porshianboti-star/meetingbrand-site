// mb-brand — the brand scrape's own route (BRIEFS-EN.md C3, 2026-11-01).
// GET ?host=<bare hostname>  (or POST {"host": …}) → JSON {ok, host, final_url, status, html_bytes, truncated, html (script-stripped),
// logos:[{src,score,kind}], icons:[{src,kind,sizes}], manifest, manifest_icons:[{src,sizes}], og:{image,logo,site_name,title}, title, ms}
// Errors: 400 bad_host · 403 blocked_host · 405 · 415 not_html · 429 rate_limited · 502 unreachable/unresolvable/dns_failed · 504 timeout.
//
// Guarantees (memory review-before-deploy-public-endpoints): hostname-only input; IP literals of every family refused; every DNS
// answer classified and ANY private/loopback/link-local/multicast/reserved answer refuses the name; the socket is opened to the
// vetted address and TLS validated against the hostname (net.ts); 5 s across every hop; the body is streamed and capped at 2 MB;
// text/html only after sniffing the bytes; scripts stripped (JSON-LD kept); the response is JSON with nosniff + attachment +
// a sandbox CSP and never echoes an upstream content-type; per-caller rate windows (memory + mb.brand_rate_hit); CORS only for
// meetingbrand.com (_shared/http.ts ALLOWED_ORIGINS). No cookies, no Authorization, nothing of the caller is forwarded upstream.
import { HttpError, json, readJson, serveFn, type Logger } from "../_shared/http.ts";
import { BrandError, decodeBody, type Deps, fetchUrl, normalizeHost, systemResolve, tlsDialer, vetHost } from "./net.ts";
import { decodeText, extract, looksLikeHtml, manifestIcons, type ManifestIcon, stripScripts } from "./html.ts";
import { callerKey, clientIp, dbHit, MemLimiter } from "./ratelimit.ts";

export const TOTAL_MS = 7500; // the whole request, every hop and target included (was 5000: a real customer site, s-horowitz.com, needs ~4.5 s to its first byte — LiteSpeed/WordPress without a page cache — and the apex try alone ate the budget from the edge)
export const CONNECT_MS = 3500; // one connect + TLS handshake
export const HTML_MAX_BYTES = 2 * 1024 * 1024; // streamed cap on the body
export const HTML_RETURN_MAX = 512_000; // characters of stripped HTML returned to the app (the logos live in the head/header; review: egress cap)
export const MANIFEST_MAX = 64 * 1024;
export const MANIFEST_MIN_LEFT = 900; // ms that must remain before the manifest hop is attempted
export const LIMITS = { ipPerMin: 20, ipBurst10s: 8, hostPerMin: 60, allPerMin: 1500 } as const; // the global window is a runaway guard for one isolate, never the thing that rejects a legitimate caller

const SAFE: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": 'attachment; filename="brand.json"',
  "Content-Security-Policy": "sandbox",
  "Referrer-Policy": "no-referrer",
};

export interface Env {
  url: string;
  serviceRoleKey: string;
  schema: string;
  hmacSecret: string;
}

/** Without MB_TOKEN_KEY the caller key is salted per isolate (never with the PUBLIC anon key, which would make the HMAC reversible by
 * brute force over the IPv4 space); the DB window then only sees one isolate's traffic, and the warning says so once. */
const ISOLATE_SALT = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
let warnedNoKey = false;
function readEnv(log?: Logger): Env {
  const g = (n: string) => {
    try { return (Deno.env.get(n) || "").trim(); } catch { return ""; }
  };
  const key = g("MB_TOKEN_KEY");
  if (!key && log && !warnedNoKey) { warnedNoKey = true; log.warn("no_hmac_key", { note: "MB_TOKEN_KEY unset: caller keys salted per isolate" }); }
  return { url: g("SUPABASE_URL"), serviceRoleKey: g("SUPABASE_SERVICE_ROLE_KEY"), schema: "mb", hmacSecret: key || ("isolate:" + ISOLATE_SALT) };
}

/** What the caller is told. The exact reason (a private address, NXDOMAIN, a resolver failure) stays in the server log: the class of a
 * name's address must not be readable through this function (an internal-hostname oracle). The caller only learns "fetchable public
 * website or not", which its own resolver tells it anyway. */
const GENERIC: Record<string, [number, string, string]> = {
  blocked_host: [502, "unreachable", "the site could not be fetched"],
  unresolvable: [502, "unreachable", "the site could not be fetched"],
  dns_failed: [502, "unreachable", "the site could not be fetched"],
  resolver_unavailable: [503, "unavailable", "try again later"],
};

export const defaultDeps: Deps = { vet: (h) => vetHost(h, systemResolve), dial: tlsDialer };
const MEM = new MemLimiter();

function withSafe(res: Response): Response {
  for (const [k, v] of Object.entries(SAFE)) res.headers.set(k, v);
  return res;
}

export const ERROR_FLOOR_MS = 2600, ERROR_JITTER_MS = 900;
const floorLatency = (started: number, floorMs: number) => { const left = started + floorMs - Date.now(); return left > 0 ? new Promise<void>((r) => setTimeout(r, left)) : Promise.resolve(); };

export function makeHandler(deps: Deps = defaultDeps, env: Env | null = null, mem: MemLimiter = MEM) {
  return serveFn("mb-brand", async (req, { log }) => {
    const started = Date.now();
    try {
      return await brand(req, log, deps, env ?? readEnv(log), mem);
    } catch (e) {
      if (e instanceof BrandError) {
        log.warn("refused", { status: e.status, code: e.code, detail: e.detail });
        const g = GENERIC[e.code];
        if (g && e.code !== "resolver_unavailable") await floorLatency(started, ERROR_FLOOR_MS + Math.floor(Math.random() * ERROR_JITTER_MS)); // fix review: a blocked / nonexistent name must not answer measurably faster than a dead public host
        return json(req, g ? g[0] : e.status, { error: g ? g[1] : e.code, detail: g ? g[2] : e.detail }, SAFE);
      }
      if (e instanceof HttpError) return withSafe(e.toResponse(req));
      throw e;
    }
  });
}

async function brand(req: Request, log: Logger, deps: Deps, env: Env, mem: MemLimiter): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") throw new BrandError(405, "method_not_allowed", "GET ?host=<hostname> or POST {host}");
  let raw: unknown;
  if (req.method === "GET") raw = new URL(req.url).searchParams.get("host");
  else raw = (await readJson<{ host?: unknown }>(req)).host;
  const host = normalizeHost(raw);
  if (!host) throw new BrandError(400, "bad_host", "host must be a bare public hostname like acme.com");

  const t0 = Date.now();
  const key = await callerKey(clientIp(req), env.hmacSecret);
  const RL = "too many requests; try again in a minute"; // one wording for every window (fix review: which window tripped is not the caller's business)
  if (!mem.hit("ip:" + key, LIMITS.ipPerMin, 60_000) || !mem.hit("b:" + key, LIMITS.ipBurst10s, 10_000)) throw new BrandError(429, "rate_limited", RL);
  if (!mem.hit("all", LIMITS.allPerMin, 60_000)) throw new BrandError(429, "rate_limited", RL);
  if (!mem.hit("h:" + host, LIMITS.hostPerMin, 60_000)) throw new BrandError(429, "rate_limited", RL);
  const db = await dbHit(env.url && env.serviceRoleKey ? { url: env.url, serviceRoleKey: env.serviceRoleKey, schema: env.schema } : null, key, LIMITS.ipPerMin);
  if (db === false) throw new BrandError(429, "rate_limited", RL);
  if (db === null && env.url) log.warn("rate_db_unavailable", {});

  const deadline = t0 + TOTAL_MS;
  const targets = (host.startsWith("www.") ? [host, host.slice(4)] : [host, "www." + host]).filter((h) => normalizeHost(h));
  const errors: string[] = [];
  for (const tg of targets) {
    if (deadline - Date.now() < 400) { errors.push(tg + ": no time left"); break; }
    try {
      const page = await fetchUrl(new URL("https://" + tg + "/"), deps, deadline, HTML_MAX_BYTES, CONNECT_MS);
      const { res, url } = page;
      if (res.status < 200 || res.status >= 300) { errors.push(tg + ": http " + res.status); continue; }
      const dec = await decodeBody(res.body, res.headers.get("content-encoding"), HTML_MAX_BYTES);
      const ct = res.headers.get("content-type");
      if (!looksLikeHtml(dec.bytes, ct)) { errors.push(tg + ": not html"); continue; }
      let text = decodeText(dec.bytes, ct);
      const cut = text.length > HTML_RETURN_MAX * 2; // review: bound the work before stripping/extracting, not only the returned size
      if (cut) text = text.slice(0, HTML_RETURN_MAX * 2);
      let html = stripScripts(text);
      const truncated = res.truncated || dec.truncated || cut || html.length > HTML_RETURN_MAX;
      if (html.length > HTML_RETURN_MAX) html = html.slice(0, HTML_RETURN_MAX);
      const ex = extract(html, url);
      let manifest_icons: ManifestIcon[] = [];
      if (ex.manifest && deadline - Date.now() > MANIFEST_MIN_LEFT) {
        try {
          const mp = await fetchUrl(new URL(ex.manifest), deps, deadline, MANIFEST_MAX, 1500, "application/manifest+json,application/json;q=0.9,*/*;q=0.1");
          if (mp.res.status >= 200 && mp.res.status < 300 && !mp.res.truncated) {
            const md = await decodeBody(mp.res.body, mp.res.headers.get("content-encoding"), MANIFEST_MAX);
            const mt = new TextDecoder("utf-8", { fatal: false }).decode(md.bytes).replace(/^﻿/, "").trim();
            if (mt.startsWith("{") && !md.truncated) manifest_icons = manifestIcons(mt, mp.url);
          }
        } catch (e) {
          log.info("manifest_skipped", { reason: e instanceof BrandError ? e.code : "error" });
        }
      }
      const ms = Date.now() - t0;
      log.info("fetched", { host, target: tg, final_host: url.hostname, status: res.status, hops: page.hops.length, html_bytes: res.bytes, truncated, logos: ex.logos.length, icons: ex.icons.length, manifest_icons: manifest_icons.length, ms });
      return json(req, 200, {
        ok: true, host, final_url: url.href, status: res.status, html_bytes: res.bytes, truncated, html,
        logos: ex.logos, icons: ex.icons, manifest: ex.manifest, manifest_icons, og: ex.og, title: ex.title, ms,
      }, SAFE);
    } catch (e) {
      if (e instanceof BrandError) {
        errors.push(tg + ": " + e.code);
        if (e.code === "blocked_host" && tg === host) throw e; // the name itself is refused: the www. variant is not a way around it
        continue;
      }
      errors.push(tg + ": " + String((e as Error)?.message || e).replace(/[\r\n]+/g, " ").slice(0, 80));
    }
  }
  log.info("unreachable", { host, errors, ms: Date.now() - t0 }); // the per-target reasons stay here, never in the response
  const onlyNotHtml = errors.length > 0 && errors.every((x) => /not html/.test(x));
  throw new BrandError(onlyNotHtml ? 415 : 502, onlyNotHtml ? "not_html" : "unreachable", onlyNotHtml ? "the site did not answer with an HTML page" : "the site could not be fetched");
}

export const handler = makeHandler();
