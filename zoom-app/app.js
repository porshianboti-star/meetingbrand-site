/* MeetingBrand for Zoom — app.js (PLAN-active-push §1.2, rung B: one Zoom consent dialog, then the background is set)
 *
 * Flow (every open of the app — Auto-open at meeting start, or the employee opens it from the Apps panel):
 *   zoomSdk.config({capabilities, version:"0.16"})  → runningContext, clientVersion, unsupportedApis
 *   #mb-ctx (written by the mb-zoom-app Edge Function from the decrypted x-zoom-app-context header) → ticket
 *   POST {apiBase}/mb-agent/zoom/resolve {ticket, deviceId, clientVersion} → device token
 *   GET  {apiBase}/mb-agent/assignments?platform=zoom → ONE item {imageUrl (signed 1 h), mime, sha256, label, backgroundId}
 *   HEAD imageUrl (download check — a warning only; the Zoom client fetches the URL itself)
 *   zoomSdk.setVirtualBackground({fileUrl}) → Zoom shows ITS consent dialog → resolved = applied / rejected = denied | error
 *   POST {apiBase}/mb-agent/report {items:[{backgroundId, state, platform:"zoom", evidence:{runningContext, clientVersion, code, message}}]}
 * The identity is the Zoom user id inside the ticket (getUserContext() has no e-mail — appssdk.zoom.us, verified
 * 2026-09-23); the page never sees a client secret, only a 10-minute HMAC ticket it cannot forge.
 *
 * UMD: the browser gets window.MBZoomApp (and boots itself when #mb-ctx exists); node tests require() the same file
 * and drive createZoomApp() with a mocked SDK (zoom-app/test/app.test.mjs).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBZoomApp = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // The factory is defined OUTSIDE the wrapper's scope, so it must find the global itself (a bare `root` here would be
  // a ReferenceError in the browser — caught 2026-09-23 in Chromium: the page never booted). node has no `self`.
  var root = typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : {};

  var SDK_VERSION = "0.16";
  var CAPABILITIES = ["getRunningContext", "getUserContext", "getMeetingContext", "setVirtualBackground", "onRunningContextChange", "onMyMediaChange"];
  /** Running contexts in which setVirtualBackground is documented to work (desktop ≥ 5.6.7; inMainClient ≥ 5.13.5). */
  var APPLY_CONTEXTS = ["inMeeting", "inWebinar", "inImmersive", "inCamera", "inMainClient", "inCollaborate"];
  var DEVICE_KEY = "mb.zoom.deviceId";
  var APPLIED_KEY = "mb.zoom.applied";
  /** zoomSdk.config() never settles outside the Zoom client (verified in Chromium 2026-09-23: the page hung on
   *  "Setting…"); inside the client it answers in well under a second. So every SDK handshake is raced with a timer. */
  var CONFIG_TIMEOUT_MS = 15000;
  var OUTSIDE_CONFIG_TIMEOUT_MS = 3000;

  function withTimeout(promise, ms, onTimeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(onTimeout()); } }, ms);
      Promise.resolve(promise).then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }, function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  /** Zoom Apps SDK error codes for setVirtualBackground (appssdk.zoom.us class docs, verified 2026-09-23). */
  var SDK_ERRORS = {
    10017: { state: "denied", hint: "You chose not to allow the background." },
    10030: { state: "error", hint: "This device does not support virtual backgrounds." },
    10031: { state: "error", hint: "Virtual backgrounds are turned off in your Zoom web settings (Settings → In Meeting (Advanced) → Virtual background)." },
    10032: { state: "error", hint: "An immersive scene is active — leave it and try again." },
    10044: { state: "error", hint: "Zoom could not decode the image." },
    10045: { state: "error", hint: "Zoom's smart virtual background package is not installed yet — accept Zoom's download prompt and try again." },
    10056: { state: "error", hint: "Your video is merged with a shared resource — stop sharing and try again." },
    10064: { state: "error", hint: "Zoom was still downloading its background package — try again in a moment." },
    10150: { state: "error", hint: "The meeting is not ready yet — try again in a moment." },
    10151: { state: "error", hint: "Zoom Apps are disabled in this meeting." },
    10013: { state: "error", hint: "This app is missing the setVirtualBackground permission in its Marketplace configuration." },
  };
  var DENIED_RE = /denied|declin|not allow|disallow|reject|cancel|refus/i;

  function errorCode(err) {
    if (!err || typeof err !== "object") return null;
    var c = err.code != null ? err.code : err.errorCode != null ? err.errorCode : null;
    if (typeof c === "string" && /^\d+$/.test(c)) c = Number(c);
    return typeof c === "number" && isFinite(c) ? c : null;
  }
  function errorMessage(err) {
    if (err == null) return "";
    if (typeof err === "string") return err;
    return String(err.message || err.reason || err.error || (err.toString && err.toString !== Object.prototype.toString ? err.toString() : "") || "").slice(0, 300);
  }
  /** A rejected setVirtualBackground → {state: 'denied' | 'error', code, message, hint}. */
  function classifySdkError(err) {
    var code = errorCode(err);
    var message = errorMessage(err);
    var known = code != null ? SDK_ERRORS[code] : null;
    if (known) return { state: known.state, code: code, message: message, hint: known.hint };
    if (DENIED_RE.test(message)) return { state: "denied", code: code, message: message, hint: "You chose not to allow the background." };
    return { state: "error", code: code, message: message, hint: message ? "Zoom said: " + message : "Zoom did not say why." };
  }

  function readCtx(doc) {
    try {
      var el = doc && doc.getElementById("mb-ctx");
      var o = el ? JSON.parse(el.textContent || "{}") : {};
      if (!o || typeof o !== "object") o = {};
      if (typeof o.mode !== "string") o.mode = "outside";
      return o;
    } catch (e) {
      return { mode: "outside" };
    }
  }

  function randomId() {
    var s = "";
    try {
      var b = new Uint8Array(12);
      (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(b) : null;
      for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
      if (s.replace(/0/g, "") === "") s = "";
    } catch (e) { s = ""; }
    if (!s) s = String(Date.now().toString(16)) + Math.random().toString(16).slice(2, 10);
    return s;
  }
  /** One id per Zoom client web view, kept in storage (the device_id of the agents row is 'zoom:' + this). */
  function deviceIdFrom(storage) {
    var id = null;
    try { id = storage && storage.getItem(DEVICE_KEY); } catch (e) { id = null; }
    if (!id || !/^[A-Za-z0-9._-]{8,100}$/.test(id)) {
      id = randomId();
      try { storage && storage.setItem(DEVICE_KEY, id); } catch (e) { /* private mode: a fresh id per open is fine */ }
    }
    return id;
  }

  var COPY = {
    loading: { dot: "busy", title: "Setting your company background…", body: "Checking with your workspace." },
    applied: { dot: "ok", title: "Your company background is set", body: "Zoom is showing your workspace's background. Nothing else to do." },
    denied: { dot: "warn", title: "Background not applied", body: "Zoom asked for your permission and it was not given. Retry shows the prompt again." },
    no_background: { dot: "warn", title: "No background prepared yet", body: "Your workspace has not prepared a background for you. Ask your admin to open My team in MeetingBrand and prepare backgrounds." },
    not_in_roster: { dot: "warn", title: "You are not in the MeetingBrand roster", body: "Your workspace's admin connects Zoom in MeetingBrand (My team → Zoom) and syncs the directory; then this app can find you." },
    no_workspace: { dot: "warn", title: "Zoom is not connected to MeetingBrand", body: "Your workspace's Zoom connection in MeetingBrand is missing or expired — the admin reconnects it in My team → Zoom." },
    revoked: { dot: "bad", title: "This device was signed out by your admin", body: "Nothing is set. Ask your MeetingBrand admin if this is unexpected." },
    outside: { dot: "warn", title: "Open this app inside Zoom", body: "MeetingBrand for Zoom runs inside the Zoom client (Apps panel, or automatically when a meeting starts). Outside Zoom there is nothing to set." },
    not_configured: { dot: "bad", title: "App not configured yet", body: "The MeetingBrand server has no Zoom App credentials yet (ZOOM_APP_CLIENT_ID / ZOOM_APP_CLIENT_SECRET)." },
    bad_context: { dot: "bad", title: "Zoom's app context could not be read", body: "The Zoom client sent a context this server could not decrypt — the Marketplace client secret and the server's do not match. Tell your MeetingBrand admin." },
    ticket_expired: { dot: "warn", title: "This page is stale", body: "Close and reopen the app inside Zoom to get a fresh context." },
    unsupported: { dot: "bad", title: "Your Zoom client cannot set backgrounds from apps", body: "setVirtualBackground needs Zoom 5.6.7 or newer (5.13.5 outside a meeting). Update Zoom and open the app again." },
    wrong_context: { dot: "warn", title: "Nothing to set here", body: "This part of Zoom cannot take a background. Open the app in a meeting or from the main window." },
    error: { dot: "bad", title: "Could not set the background", body: "Something went wrong. Retry, or set the background yourself from Settings → Background & effects." },
  };

  /** DOM renderer for index.html; deps.render may replace it (tests). */
  function domRenderer(doc) {
    var $ = function (id) { return doc.getElementById(id); };
    return function (state, data) {
      data = data || {};
      var c = COPY[state] || COPY.error;
      var dot = $("dot"), title = $("title"), body = $("body"), label = $("label"), retry = $("retry"), again = $("again"), meta = $("meta");
      if (dot) dot.className = "dot " + c.dot;
      if (title) title.textContent = c.title;
      if (body) body.textContent = data.body || c.body;
      if (label) {
        label.textContent = data.label || "";
        label.className = "label" + (data.label ? "" : " hidden");
      }
      var canRetry = state === "denied" || state === "error" || state === "no_background" || state === "not_in_roster" || state === "no_workspace";
      if (retry) retry.className = canRetry ? "" : "hidden";
      if (again) again.className = "ghost" + (state === "applied" ? "" : " hidden");
      if (meta) {
        var bits = [];
        if (data.hint) bits.push(data.hint);
        if (data.runningContext) bits.push("Context: " + data.runningContext);
        if (data.clientVersion) bits.push("Zoom " + data.clientVersion);
        if (data.code != null) bits.push("Code " + data.code);
        meta.textContent = bits.join(" · ");
      }
    };
  }

  /**
   * deps: { sdk (window.zoomSdk or a mock), fetch, ctx ({mode, ticket?, apiBase, typ?}), storage, render(state, data),
   *         now?, log? }. Returns { run(), retry(), state, last }.
   */
  function createZoomApp(deps) {
    var sdk = deps.sdk;
    var fetchImpl = deps.fetch;
    var ctx = deps.ctx || { mode: "outside" };
    var storage = deps.storage || null;
    var render = deps.render || function () {};
    var now = deps.now || function () { return Date.now(); };
    var log = deps.log || function () {};
    var configTimeoutMs = deps.configTimeoutMs || CONFIG_TIMEOUT_MS;
    var outsideConfigTimeoutMs = deps.outsideConfigTimeoutMs || OUTSIDE_CONFIG_TIMEOUT_MS;
    var apiBase = String(ctx.apiBase || "").replace(/\/+$/, "");

    var app = { state: "loading", last: null, token: null, runningContext: null, clientVersion: null, subscribed: false, applying: null };

    function set(state, data) {
      app.state = state;
      app.last = data || null;
      render(state, data || {});
    }

    function api(method, path, body, token) {
      var headers = { "content-type": "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      return fetchImpl(apiBase + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" }).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: "bad_json", detail: t.slice(0, 200) }; }
          return { status: r.status, body: j || {} };
        });
      });
    }

    function configure(timeoutMs) {
      if (!sdk || typeof sdk.config !== "function") return Promise.resolve({ ok: false, reason: "outside" });
      var call;
      try { call = sdk.config({ capabilities: CAPABILITIES, version: SDK_VERSION }); } catch (e) { call = Promise.reject(e); }
      return withTimeout(call, timeoutMs || configTimeoutMs, function () {
        log("config_timeout", timeoutMs || configTimeoutMs);
        return { __timeout: true };
      }).then(function (cfg) {
        if (cfg && cfg.__timeout) return { ok: false, reason: "outside", message: "Zoom did not answer the SDK handshake (" + Math.round((timeoutMs || configTimeoutMs) / 1000) + " s) — this page is not running inside the Zoom client, or Zoom Apps are blocked." };
        cfg = cfg || {};
        app.runningContext = cfg.runningContext || null;
        app.clientVersion = cfg.clientVersion || null;
        var unsupported = Array.isArray(cfg.unsupportedApis) ? cfg.unsupportedApis : [];
        if (unsupported.indexOf("setVirtualBackground") >= 0) return { ok: false, reason: "unsupported" };
        return { ok: true, cfg: cfg };
      }, function (e) {
        log("config_failed", errorMessage(e));
        return { ok: false, reason: "outside", message: errorMessage(e) };
      });
    }

    function resolve() {
      var deviceId = deviceIdFrom(storage);
      return api("POST", "/mb-agent/zoom/resolve", { ticket: ctx.ticket, deviceId: deviceId, clientVersion: app.clientVersion, version: "1.0.0" }).then(function (r) {
        if (r.status === 200 && r.body.deviceToken) {
          app.token = r.body.deviceToken;
          return { ok: true, employee: r.body.employee };
        }
        if (r.status === 404) return { ok: false, state: r.body.reason === "no_workspace" ? "no_workspace" : "not_in_roster" };
        if (r.status === 401) return { ok: false, state: "ticket_expired" };
        if (r.status === 503) return { ok: false, state: "not_configured" };
        return { ok: false, state: "error", hint: "Server answered " + r.status + (r.body.detail ? ": " + r.body.detail : "") };
      }, function (e) {
        return { ok: false, state: "error", hint: "Could not reach the MeetingBrand server: " + errorMessage(e) };
      });
    }

    function assignment() {
      return api("GET", "/mb-agent/assignments?platform=zoom", null, app.token).then(function (r) {
        if (r.status === 410) return { ok: false, state: "revoked" };
        if (r.status === 401) return { ok: false, state: "ticket_expired", reauth: true };
        if (r.status !== 200) return { ok: false, state: "error", hint: "Server answered " + r.status + (r.body.detail ? ": " + r.body.detail : "") };
        if (r.body.deviceToken) app.token = r.body.deviceToken; // rotation
        var items = Array.isArray(r.body.assignments) ? r.body.assignments : [];
        var apply = null;
        for (var i = 0; i < items.length; i++) if (items[i] && items[i].action === "apply" && items[i].imageUrl) { apply = items[i]; break; }
        if (!apply) {
          var skipped = Array.isArray(r.body.skipped) ? r.body.skipped.length : 0;
          return { ok: false, state: "no_background", hint: skipped ? "A background is assigned but not exported yet — the admin opens My team and clicks Prepare backgrounds." : (r.body.state === "inactive" ? "You are marked inactive in MeetingBrand." : null) };
        }
        return { ok: true, item: apply };
      }, function (e) {
        return { ok: false, state: "error", hint: "Could not reach the MeetingBrand server: " + errorMessage(e) };
      });
    }

    function headCheck(url) {
      return fetchImpl(url, { method: "HEAD", cache: "no-store" }).then(function (r) { return r.ok; }, function () { return false; });
    }

    function report(item, state, extra) {
      if (!app.token) return Promise.resolve(false);
      var evidence = { runningContext: app.runningContext || undefined, clientVersion: app.clientVersion || undefined };
      if (extra && extra.code != null) evidence.code = extra.code;
      if (extra && extra.message) evidence.message = String(extra.message).slice(0, 500);
      return api("POST", "/mb-agent/report", { items: [{ backgroundId: item.backgroundId, state: state, platform: "zoom", evidence: evidence }] }, app.token)
        .then(function (r) { return r.status === 200; }, function () { return false; });
    }

    function rememberApplied(item) {
      try { storage && storage.setItem(APPLIED_KEY, JSON.stringify({ sha256: item.sha256, backgroundId: item.backgroundId, at: now(), ctx: app.runningContext })); } catch (e) { /* ignore */ }
    }
    function recentlyApplied(item) {
      try {
        var o = JSON.parse((storage && storage.getItem(APPLIED_KEY)) || "null");
        return !!(o && o.sha256 === item.sha256 && o.ctx === app.runningContext && now() - o.at < 15 * 60 * 1000);
      } catch (e) { return false; }
    }

    /** setVirtualBackground for the current assignment; force = ignore the "applied a moment ago" memory. */
    function apply(item, force) {
      var base = { label: item.label, runningContext: app.runningContext, clientVersion: app.clientVersion };
      if (APPLY_CONTEXTS.indexOf(app.runningContext) < 0 && app.runningContext) {
        set("wrong_context", base);
        return Promise.resolve("wrong_context");
      }
      if (!force && recentlyApplied(item)) {
        set("applied", base);
        return Promise.resolve("applied");
      }
      return headCheck(item.imageUrl).then(function (reachable) {
        if (!reachable) log("head_check_failed", item.imageUrl.split("?")[0]);
        return sdk.setVirtualBackground({ fileUrl: item.imageUrl });
      }).then(function () {
        rememberApplied(item);
        set("applied", base);
        return report(item, "applied", null).then(function () { return "applied"; });
      }, function (err) {
        var c = classifySdkError(err);
        var data = { label: item.label, runningContext: app.runningContext, clientVersion: app.clientVersion, code: c.code, hint: c.hint };
        set(c.state, data);
        return report(item, c.state, { code: c.code, message: c.message }).then(function () { return c.state; });
      });
    }

    function subscribe(item) {
      if (app.subscribed || !sdk || typeof sdk.onRunningContextChange !== "function") return;
      app.subscribed = true;
      try {
        sdk.onRunningContextChange(function (ev) {
          var next = ev && (ev.runningContext || ev.context);
          if (!next || next === app.runningContext) return;
          app.runningContext = next;
          log("context_changed", next);
          if (APPLY_CONTEXTS.indexOf(next) >= 0 && app.current) app.applying = apply(app.current, false);
        });
      } catch (e) { log("subscribe_failed", errorMessage(e)); }
    }

    function run(force) {
      set("loading", {});
      if (ctx.mode !== "zoom") {
        // Render the honest state at once (outside Zoom the SDK handshake never settles); the short config race only
        // enriches the meta line when we ARE inside a client (e.g. the mirror opened from the Apps panel by mistake).
        var mode = COPY[ctx.mode] ? ctx.mode : "outside";
        set(mode, {});
        return configure(outsideConfigTimeoutMs).then(function () {
          if (app.state === mode) set(mode, { runningContext: app.runningContext, clientVersion: app.clientVersion });
          return app.state;
        });
      }
      return configure().then(function (c) {
        if (!c.ok) {
          set(c.reason, { hint: c.message || null });
          return app.state;
        }
        return resolve().then(function (rr) {
          if (!rr.ok) { set(rr.state, { hint: rr.hint || null, runningContext: app.runningContext, clientVersion: app.clientVersion }); return app.state; }
          return assignment().then(function (a) {
            if (!a.ok) { set(a.state, { hint: a.hint || null, runningContext: app.runningContext, clientVersion: app.clientVersion }); return app.state; }
            app.current = a.item;
            subscribe(a.item);
            return apply(a.item, !!force);
          });
        });
      });
    }

    app.run = function () { return run(false); };
    /** Retry = the whole chain again, ignoring the "applied a moment ago" memory (Zoom may prompt again). */
    app.retry = function () { return run(true); };
    app.applyAgain = function () { return app.current ? apply(app.current, true) : run(true); };
    return app;
  }

  /** Browser boot: wires index.html to createZoomApp with the real SDK. */
  function boot(win) {
    var doc = win.document;
    var ctx = readCtx(doc);
    var app = createZoomApp({
      sdk: win.zoomSdk || null,
      fetch: win.fetch ? win.fetch.bind(win) : null,
      ctx: ctx,
      storage: (function () { try { return win.localStorage; } catch (e) { return null; } })(),
      render: domRenderer(doc),
      log: function (ev, detail) { try { win.console && win.console.log("[MeetingBrand for Zoom]", ev, detail || ""); } catch (e) { /* ignore */ } },
    });
    var retry = doc.getElementById("retry"), again = doc.getElementById("again");
    if (retry) retry.addEventListener("click", function () { app.retry(); });
    if (again) again.addEventListener("click", function () { app.applyAgain(); });
    app.run();
    api.instance = app;
    return app;
  }

  var api = { instance: null, createZoomApp: createZoomApp, classifySdkError: classifySdkError, deviceIdFrom: deviceIdFrom, readCtx: readCtx, boot: boot, withTimeout: withTimeout, CAPABILITIES: CAPABILITIES, SDK_VERSION: SDK_VERSION, APPLY_CONTEXTS: APPLY_CONTEXTS, COPY: COPY, SDK_ERRORS: SDK_ERRORS, CONFIG_TIMEOUT_MS: CONFIG_TIMEOUT_MS };
  if (root && root.document && root.document.getElementById && root.document.getElementById("mb-ctx")) {
    try { boot(root); } catch (e) { try { root.console && root.console.error("[MeetingBrand for Zoom] boot failed", e); } catch (e2) { /* ignore */ } }
  }
  return api;
});
