// _shared/http.ts — CORS, JSON responses, request ids, structured logging (no secrets ever).

export const ALLOWED_ORIGINS = ["https://meetingbrand.com", "http://localhost:8787"] as const;

const BASE_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-request-id",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
} as const;

/** CORS headers for this request. Unknown origins get no Allow-Origin (browser blocks; curl unaffected). */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = { ...BASE_HEADERS };
  if ((ALLOWED_ORIGINS as readonly string[]).includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/** Request id: honour a well-formed x-request-id from the caller, else mint one. */
export function requestId(req: Request): string {
  const given = req.headers.get("x-request-id") ?? "";
  if (/^[A-Za-z0-9._-]{8,64}$/.test(given)) return given;
  return crypto.randomUUID();
}

export function json(req: Request, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** Uniform error shape: {error, detail, …}. */
export function jsonError(req: Request, status: number, error: string, detail?: string, extra: Record<string, unknown> = {}): Response {
  return json(req, status, { error, detail: detail ?? error, ...extra });
}

/** Thrown by helpers to short-circuit a handler with a specific HTTP status. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public extra: Record<string, unknown> = {}) {
    super(detail ?? code);
  }
  toResponse(req: Request): Response {
    return jsonError(req, this.status, this.code, this.detail, this.extra);
  }
}

/** One JSON line per event. Callers must never pass tokens, secrets or file bytes. */
export function makeLogger(fn: string, rid: string) {
  const line = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (/token|secret|authorization|cookie|password/i.test(k)) safe[k] = "[redacted]";
      else safe[k] = v;
    }
    const out = JSON.stringify({ t: new Date().toISOString(), fn, rid, level, event, ...safe });
    if (level === "error") console.error(out);
    else if (level === "warn") console.warn(out);
    else console.log(out);
  };
  return {
    info: (event: string, fields?: Record<string, unknown>) => line("info", event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => line("warn", event, fields),
    error: (event: string, fields?: Record<string, unknown>) => line("error", event, fields),
  };
}
export type Logger = ReturnType<typeof makeLogger>;

/** Largest JSON body any mb-* function accepts (the biggest legitimate one is ~2000 uuids ≈ 80 KB). */
export const MAX_BODY_BYTES = 256 * 1024;

/** Parse a JSON body; empty body → {}. Throws HttpError 400 on malformed JSON, 413 when larger than MAX_BODY_BYTES. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", `request body must be at most ${MAX_BODY_BYTES} bytes`);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", `request body must be at most ${MAX_BODY_BYTES} bytes`);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "bad_json", "request body must be JSON");
  }
}

/** Wrap a handler: preflight, request id, uniform error translation, never leaks a stack to the client. */
export function serveFn(fn: string, handler: (req: Request, ctx: { rid: string; log: Logger }) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const pf = preflight(req);
    if (pf) return pf;
    const rid = requestId(req);
    const log = makeLogger(fn, rid);
    const started = Date.now();
    try {
      const res = await handler(req, { rid, log });
      res.headers.set("x-request-id", rid);
      log.info("done", { status: res.status, ms: Date.now() - started, method: req.method });
      return res;
    } catch (e) {
      if (e instanceof HttpError) {
        log.warn("http_error", { status: e.status, code: e.code, detail: e.detail, ms: Date.now() - started });
        const res = e.toResponse(req);
        res.headers.set("x-request-id", rid);
        return res;
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.error("unhandled", { message: msg, ms: Date.now() - started });
      const res = jsonError(req, 500, "internal", "unexpected error; see request id", { request_id: rid });
      res.headers.set("x-request-id", rid);
      return res;
    }
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
