// mb-zoom-app — the server side of "MeetingBrand for Zoom" (the SECOND, user-managed Zoom Marketplace app; PLAN-active-push §1.2):
// it is the only place that holds ZOOM_APP_CLIENT_SECRET, so it is the only place that can decrypt the
// x-zoom-app-context header the Zoom client sends with every GET of the app's Home URL (AES-256-GCM, key =
// SHA-256(secret)); it turns that context into a 10-minute HMAC ticket the page exchanges at mb-agent /zoom/resolve.
//
// HOSTING — THIS FUNCTION IS THE HOME URL (decision 2026-09-23, own curls; details in zoom-app/README-ZOOM-APP.md §2):
// the Zoom client validates every text/html 200 of the Home URL for four OWASP response headers
// (Strict-Transport-Security, X-Content-Type-Options, Content-Security-Policy, Referrer-Policy —
// developers.zoom.us/docs/zoom-apps/security/owasp) and refuses to render without them. GitHub Pages cannot set
// response headers at all (the /zoom-app/ folder there is a header-less mirror for humans). Netlify is ruled out
// (shared deploy credits). This function sets the four headers itself — but the Supabase gateway rewrites a
// `text/html` function response to text/plain + a sandbox CSP for browser-looking requests on the shared
// *.supabase.co domain. It does NOT touch `Text/HTML` (case-sensitive match; media types are case-insensitive), so the
// page goes out as HTML_CONTENT_TYPE and /health re-checks the passthrough live (_shared/zoomapp.ts explains).
// Home URL = https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app
//
//   GET  /mb-zoom-app/ctx        → application/json {mode:'zoom', ticket, typ, apiBase} | {mode:'outside'} (no
//                                  x-zoom-app-context header) | {mode:'not_configured'} (ZOOM_APP_CLIENT_SECRET /
//                                  MB_TOKEN_KEY unset) | {mode:'bad_context'} (decrypt failed: the Marketplace secret
//                                  and ours differ, or the context expired). Always 200; the header value is never echoed.
//   GET  /mb-zoom-app            → the page (HTML_CONTENT_TYPE) + the four headers, #mb-ctx = the same object — the Home URL
//   GET  /mb-zoom-app/app.js     → application/javascript (+ nosniff, no-store)
//   GET  /mb-zoom-app/health     → {ok:true, configured, missing, page: PAGE_HASH, homeUrl, html:{passthrough}} (passthrough =
//                                  a live browser-style HEAD of the root still comes back as HTML, not the gateway rewrite)
//   anything else                → 404; non-GET → 405
// No auth (the Zoom client sends no JWT; verify_jwt=false), no database, no secret in any response or log.
// The page itself is zoom-app/index.html + zoom-app/app.js (mirrored on GitHub Pages at /zoom-app/ for humans),
// bundled here as page.ts by zoom-app/build-page.py.

import { supabaseEnv, zoomAppEnv } from "../_shared/env.ts";
import { HttpError, json, serveFn } from "../_shared/http.ts";
import { decryptAppContext, HTML_CONTENT_TYPE, htmlPassthrough, owaspHeaders, signTicket, ticketKey, ZoomAppContextError } from "../_shared/zoomapp.ts";
import { APP_JS, INDEX_HTML, PAGE_HASH } from "./page.ts";

export interface Deps {
  now?: () => number;
  /** /health probes the function's own public URL with a browser Accept header (tests inject a fake). */
  fetch?: typeof fetch;
}

export const FN_NAME = "mb-zoom-app";
export const CONTEXT_HEADER = "x-zoom-app-context";

/** The sub-path after …/mb-zoom-app: "" | "/" | "/index.html" → the page; "/app.js"; "/health". */
export function subPath(url: URL): string {
  const i = url.pathname.indexOf(`/${FN_NAME}`);
  const rest = i < 0 ? url.pathname : url.pathname.slice(i + FN_NAME.length + 1);
  return rest.replace(/\/+$/, "") || "/";
}

/** The page with #mb-ctx and the app.js src filled in (JSON is escaped so no `</script` can break out). */
export function renderPage(ctx: Record<string, unknown>, appJsPath: string): string {
  const data = JSON.stringify(ctx).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
  let html = INDEX_HTML.replace(/<script id="mb-ctx" type="application\/json">[\s\S]*?<\/script>/, `<script id="mb-ctx" type="application/json">${data}</script>`);
  html = html.replace(/<script src="app\.js"><\/script>/, `<script src="${appJsPath}"></script>`);
  return html;
}

export function makeHandler(deps: Deps = {}) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  return serveFn(FN_NAME, async (req, { log }) => {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "use GET");
    const url = new URL(req.url);
    const sub = subPath(url);
    const sbEnv = supabaseEnv();
    const selfOrigin = sbEnv.ok ? sbEnv.env.url : url.origin;
    const fnBase = `${selfOrigin}/functions/v1/${FN_NAME}`;
    const zEnv = zoomAppEnv();

    if (sub === "/health") {
      // Live self-check of the hosting workaround: GET our own root the way a browser (the Zoom client) does.
      let html: { passthrough: boolean | null; contentType?: string; csp?: string; error?: string } = { passthrough: null };
      try {
        const r = await fetchImpl(`${fnBase}/`, { method: "HEAD", headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0 (MeetingBrand health probe) Chrome/128.0" }, signal: AbortSignal.timeout(6000) });
        const p = htmlPassthrough(r.headers);
        html = { passthrough: r.status === 200 && p.ok, contentType: p.contentType, csp: p.csp.slice(0, 120) };
        if (!html.passthrough) log.warn("html_passthrough_lost", { status: r.status, content_type: p.contentType });
      } catch (e) {
        html = { passthrough: null, error: e instanceof Error ? e.message.slice(0, 120) : "probe failed" };
      }
      return json(req, 200, { ok: true, configured: zEnv.ok, missing: zEnv.ok ? [] : zEnv.missing, page: PAGE_HASH, homeUrl: fnBase, html });
    }
    if (sub === "/app.js") {
      return new Response(APP_JS, { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    if (sub !== "/" && sub !== "/index.html" && sub !== "/ctx") throw new HttpError(404, "not_found", "the Zoom App lives at the function root (or /ctx, /app.js, /health)");

    const header = req.headers.get(CONTEXT_HEADER);
    let ctx: Record<string, unknown> = { mode: "outside", apiBase: `${selfOrigin}/functions/v1` };
    if (header) {
      if (!zEnv.ok) {
        log.warn("context_but_not_configured", { missing: zEnv.missing });
        ctx = { mode: "not_configured", apiBase: ctx.apiBase };
      } else {
        try {
          const c = await decryptAppContext(header, zEnv.env.clientSecret, now());
          const ticket = await signTicket(await ticketKey(zEnv.env.tokenKeyB64), c, now());
          ctx = { mode: "zoom", ticket, typ: c.typ, apiBase: ctx.apiBase };
          log.info("context_ok", { typ: c.typ, has_meeting: !!c.mid });
        } catch (e) {
          const msg = e instanceof ZoomAppContextError ? e.message : "unexpected";
          log.warn("context_bad", { message: msg });
          ctx = { mode: "bad_context", apiBase: ctx.apiBase };
        }
      }
    }
    if (sub === "/ctx") return json(req, 200, ctx);
    const html = renderPage(ctx, `${fnBase}/app.js`);
    return new Response(req.method === "HEAD" ? null : html, {
      status: 200,
      headers: { ...owaspHeaders(selfOrigin), "Content-Type": HTML_CONTENT_TYPE },
    });
  });
}

export const handler = makeHandler();
