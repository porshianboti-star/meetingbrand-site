// mb-brand/ratelimit.ts — a fast in-memory window (per isolate) in front of the authoritative DB window (mb.brand_rate_hit).
// The caller is keyed by an HMAC of its IP (the IP itself is never stored or logged).

export const SWEEP_EVERY_MS = 10_000, SWEEP_WINDOW_MS = 60_000;
/** Sliding windows per key. Review fixes: the sweep runs at most every 10 s against a FIXED 60 s window (a 10 s burst hit used to evict
 * still-valid minute entries), a key's timestamps are pruned in place, and the map is bounded — at maxKeys the OLDEST key is evicted
 * (a flood of fresh keys can only make the limiter forget older callers, never lock a new caller out). */
export class MemLimiter {
  private m = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(public readonly maxKeys = 20_000) {}
  hit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (now - this.lastSweep >= SWEEP_EVERY_MS) this.sweep(now);
    let arr = this.m.get(key);
    if (!arr) {
      if (this.m.size >= this.maxKeys) { const oldest = this.m.keys().next().value; if (oldest !== undefined) this.m.delete(oldest); } // fix review: evict the oldest key (insertion order), never lock fresh callers out
      arr = [];
      this.m.set(key, arr);
    }
    const cut = now - windowMs;
    let k = 0;
    while (k < arr.length && arr[k] <= cut) k++;
    if (k) arr.splice(0, k);
    arr.push(now);
    if (arr.length > limit * 4 + 8) arr.splice(0, arr.length - (limit * 4 + 8)); // a hammering caller never grows its own entry without bound
    return arr.length <= limit;
  }
  sweep(now: number) {
    this.lastSweep = now;
    for (const [k, arr] of this.m) if (!arr.length || now - arr[arr.length - 1] >= SWEEP_WINDOW_MS) this.m.delete(k);
  }
  get size() {
    return this.m.size;
  }
}

/** The client address as the edge sees it: Cloudflare's header first (set by the edge, not by the caller), else the LAST
 * x-forwarded-for entry (the one appended by the proxy in front of us), else unknown. */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  const xr = req.headers.get("x-real-ip");
  return xr && xr.trim() ? xr.trim() : "unknown";
}

let hmacKeyP: Promise<CryptoKey> | null = null;
function hmacKey(secret: string): Promise<CryptoKey> {
  if (!hmacKeyP) hmacKeyP = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hmacKeyP;
}

/** hex HMAC-SHA256(secret, ip)[0:32] — stable across isolates (the DB window needs that), not reversible to the IP. */
export async function callerKey(ip: string, secret: string): Promise<string> {
  const k = await hmacKey(secret || "mb-brand");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(ip)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export interface DbEnv { url: string; serviceRoleKey: string; schema?: string }

/** mb.brand_rate_hit(p_key, p_limit) → true = allowed. null = the DB could not be asked (the caller fails OPEN on null:
 * the in-memory window still holds, and a PostgREST hiccup must not take the brand fetch down). */
export async function dbHit(env: DbEnv | null, key: string, limit: number, timeoutMs = 900): Promise<boolean | null> {
  if (!env || !env.url || !env.serviceRoleKey) return null;
  try {
    const r = await fetch(env.url.replace(/\/+$/, "") + "/rest/v1/rpc/brand_rate_hit", {
      method: "POST",
      headers: {
        apikey: env.serviceRoleKey,
        Authorization: "Bearer " + env.serviceRoleKey,
        "Content-Type": "application/json",
        "Content-Profile": env.schema || "mb",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_key: key, p_limit: limit }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const v = await r.json();
    return v === true ? true : v === false ? false : null;
  } catch {
    return null;
  }
}
