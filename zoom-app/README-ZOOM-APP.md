# MeetingBrand for Zoom — the SECOND Zoom app (owner guide)

*English first, Hebrew below / עברית למטה.* Written 2026-09-23. Everything marked **[test]** must be proven on a real
Zoom tenant before it is promised to a customer; everything else is verified against Zoom's own docs (dated) or by
our own tests/curls (this repo, this date).

## 1. What this is, in one paragraph

Rung B of `PLAN-active-push.md` §1.2. A **user-managed Zoom App** ("MeetingBrand for Zoom") whose page runs inside the
employee's Zoom client and calls `zoomSdk.setVirtualBackground({ fileUrl })` with the background their workspace
prepared in MeetingBrand. Zoom shows **its own consent dialog** (once, or per call — **[test]**), then the background is
set — no file to copy, no picker. The customer admin installs it for everyone with **Add for Others** (verified:
KB0057683 / KB0061035, all user-level apps incl. private ones) and, if the tenant offers it, turns on auto-open at
meeting start (**[test]** — see §4). It is a **separate Marketplace app** from our admin-managed REST app
(`supabase/functions/README-ZOOM.md`): Zoom staff confirm admin-managed and user-managed scopes cannot live in one app
(devforum 116068, 127722). Two apps by design.

Code (all in this repo; tests green on 2026-09-23: **152 deno + 12 node**):

| Piece | Path | Role |
|---|---|---|
| The page | `zoom-app/index.html` + `zoom-app/app.js` | one card, honest states (`applied` / `denied` / `no_background` / `not_in_roster` / `no_workspace` / `outside` / `unsupported` / `wrong_context` / `error` …), Retry; SDK flow `config → resolve → assignment → HEAD → setVirtualBackground → report`; re-applies when the running context changes (Auto-open's known "opens the main-client page" defect, devforum 88879); every SDK handshake is raced with a timer |
| **Home URL host** | Edge Function `mb-zoom-app` (`supabase/functions/mb-zoom-app/`) — **deployed**: `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app` | serves the page WITH the four OWASP headers (§2), decrypts `x-zoom-app-context` (AES-256-GCM, key = SHA-256(client secret)) → 10-min HMAC ticket in `#mb-ctx`; `/app.js`, `/ctx`, `/health` (live self-check of the hosting workaround) |
| Backend | Edge Function `mb-agent` (`POST /zoom/resolve`, `GET /assignments?platform=zoom`, `POST /report`) — **deployed**; schema `mb-012-zoom-app.sql` — **applied** (constraints + functions re-verified live 2026-09-23) | ticket → device token for the Zoom user found in `mb.employees` (platform `zoom`, `ext_id` = Zoom user id, written by the REST app's directory sync) of a workspace whose Zoom integration is connected; one signed (1 h) image per employee; reports → `mb.pushes` (`selected` / `awaiting_client` / `failed`) → My team chips |
| Tests | `supabase/functions/tests/zoomapp_test.ts`, zoom cases in `agent_test.ts`; `zoom-app/test/app.test.mjs` (`node --test zoom-app/test/app.test.mjs`) | mocked SDK + mocked backend end to end: happy path, denied, SDK error codes, missing assignment, every refusal, context change, handshake timeout, auto-boot |
| Mirror | https://meetingbrand.com/zoom-app/ (GitHub Pages; `gen-site.py` never touches this folder — verified: it writes named files only, no directory sweep) | for humans; without the header it always shows "Open this app inside Zoom" |

**Identity — why the Zoom user id and not an e-mail (changes the original plan):** the Zoom Apps SDK's
`getUserContext()` returns `status / screenName / participantUUID / role` only — **no e-mail, no account id**
(appssdk.zoom.us `GetUserContextResponse`, read 2026-09-23). The only authenticated identity a Zoom App gets
without an OAuth token exchange is `uid` inside the encrypted `x-zoom-app-context` header, which only our client secret
can decrypt. So the app works for employees who are in the workspace's **synced Zoom directory** (the admin connected
the REST app in My team → Zoom and synced). A CSV-only roster cannot be matched — the page says so honestly
(`not_in_roster`). This is *stronger* than the planned e-mail match: nobody can obtain a colleague's background by
knowing their e-mail. Residual risk (documented in `mb-agent/handler.ts`): whoever holds `ZOOM_APP_CLIENT_SECRET` or
`MB_TOKEN_KEY` can mint any employee's device token; the token only ever yields that employee's own background — a
1-hour signed URL of an image the whole workspace already sees. Same class as the agent's org-wide key; accepted.

**Live proof on 2026-09-23 (no Zoom credentials exist yet, so nothing has run inside a real Zoom client):**
the Home URL answers a browser-style GET (Accept `text/html`, Chrome UA) with `200`, `Content-Type: Text/HTML`,
`Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`, `Referrer-Policy`; Chromium (the
in-app Browser pane) renders it, loads the Zoom SDK under our CSP and boots the card to "Open this app inside Zoom"
(the SDK rejects `config()` outside the client with "not supported by this browser" — handled). `/health` →
`html.passthrough: true`, `configured: false` (secrets missing, as expected). `mb-agent`: a ticket signed with the real
`MB_TOKEN_KEY` for an unknown Zoom user → `404 {reason:"not_in_roster"}`; a 20-minute-old ticket → `401 bad_ticket`;
a forged ticket → `401`; `/assignments?platform=zoom` without a token → `401`. Schema: `agents_os_check` includes
`zoom`, `agent_reports_state_check` includes `denied`, `guard_push_consistency` and `revoke_agent` carry the `zoom`
branches. QA residue: 0 `agents` rows with `os='zoom'`, 0 `qa+mb…` users, 0 QA orgs.

## 2. Hosting decision (exact) — the Home URL is the Supabase Edge Function `mb-zoom-app`

**Home URL = `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app`** (also the OAuth redirect URL).

Why not the obvious hosts:

1. **The Zoom client refuses to render a Home URL whose `text/html` 200 lacks `Strict-Transport-Security`,
   `X-Content-Type-Options`, `Content-Security-Policy` and `Referrer-Policy`** ("Missing OWASP Secure Headers",
   developers.zoom.us/docs/zoom-apps/security/owasp). These are *response headers*; HSTS and X-Content-Type-Options
   cannot be expressed as `<meta http-equiv>` at all, and Zoom checks the HTTP response, not the markup.
2. **GitHub Pages cannot set response headers** (GitHub staff, community discussion #54257; `curl -sI https://meetingbrand.com/`
   shows none of the four). So `/zoom-app/` on meetingbrand.com is a mirror only.
3. **Netlify is ruled out** by the owner (each deploy burns shared credits that once froze prosignature.co).
4. **The Supabase gateway rewrites `text/html`** function responses to `text/plain` + `Content-Security-Policy:
   default-src 'none'; sandbox` whenever the request looks like a browser navigation (Accept `text/html` or a browser
   User-Agent) — an anti-phishing rule on the shared `*.supabase.co` domain; HTML is served untouched only behind the
   paid custom-domain add-on. Verified 2026-09-23 with a throwaway probe function (deleted): plain curl gets HTML,
   browser-style requests get the rewrite.

**What works (verified live 2026-09-23):** the gateway's match is **case-sensitive** while HTTP media types are not
(RFC 9110 §8.3.1). `mb-zoom-app` therefore sends `Content-Type: Text/HTML; charset=utf-8`: the gateway leaves it alone,
Chromium — and the Zoom client's embedded Chromium — treats it as an HTML document, and our four headers arrive intact.
Be honest about what this is: **a workaround that Supabase could close any day.** Hence:

- `GET …/mb-zoom-app/health` re-checks it on every call by fetching its own root the way a browser does and reports
  `html.passthrough: true|false|null` (+ the content type and CSP it saw). Wire it into whatever uptime check you use;
  `false` means the Zoom client would show a blank app and it is time for one of the durable fixes below.
- **Durable fix A (paid, 5 minutes): Supabase custom domain** (Pro plan + the custom-domain add-on) — then the function
  serves plain `text/html` on `api.meetingbrand.com` and the Home URL becomes `https://api.meetingbrand.com/functions/v1/mb-zoom-app`.
- **Durable fix B (free, ~30 minutes): a Cloudflare Worker** on `zoom.meetingbrand.com` that proxies `GET /` and
  `/app.js` to the function (forwarding `x-zoom-app-context`) and sets the four headers itself. Nothing in the page or
  the backend changes except the Home URL + the allow list.
- **[test] the Marketplace form's own "Home URL is missing required OWASP response header(s)" check** — three
  developers reported it fetches the **origin root** (devforum 113210), which for us is
  `https://ohobtgbyrlczfdztzvqi.supabase.co/` → `404` JSON with HSTS + Referrer-Policy only. If the form refuses the
  Home URL, that alone forces fix A or B (both put the app on an origin whose root we control).

## 3. Create the Zoom Marketplace app (owner — needs your Zoom sign-in)

1. https://marketplace.zoom.us → **Develop ▸ Build App** → **General App** → Create (a "Zoom App" is a General App
   with the Zoom Apps SDK feature enabled in the unified build flow).
2. **Basic Information**
   - App name: `MeetingBrand for Zoom` (≤50 chars; the Marketplace rule is "must not use Zoom branding" — if it refuses,
     use `MeetingBrand Backgrounds`).
   - **Select how the app is managed: User-managed.** (Not admin-managed — that is the other app. This cannot be
     changed after publishing.)
   - **OAuth Redirect URL**: `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app` (a Zoom App is an
     OAuth app: the field is required and installation IS the OAuth consent; we never exchange the code — the page
     ignores `?code=`).
   - **OAuth allow list**: the same URL, plus `https://meetingbrand.com/zoom-app/`.
   - **Home URL**: `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app`
   - **Domain Allow List** (Features ▸ Surface, "Add URLs you want the Zoom client to accept"):
     `ohobtgbyrlczfdztzvqi.supabase.co` (the page, the signed background images AND the `mb-agent` API — all on this
     host), `appssdk.zoom.us`, `meetingbrand.com`. (A wildcard needs domain-ownership proof — devforum 99405; list the
     hosts exactly instead.)
3. **Features ▸ Surface**: enable **Zoom App SDK**; under *Add APIs* select exactly two:
   `setVirtualBackground` and `onRunningContextChange` (the `capabilities` list in `app.js` — nothing else is called;
   `config()` already returns the running context and client version. Zoom's review checks scope minimisation. An API
   that is not enabled here fails with "No Permission for this API", code 10013). Products: **Meetings** (and Webinars if you want panelists covered). Running
   contexts: **In Meeting** + **Main client** (setVirtualBackground works in both from client 5.13.5). Leave Guest Mode
   on (setVirtualBackground supports it; the page still needs a roster match).
4. **Scopes**: only `zoomapp:inmeeting` (+ `zoomapp:inwebinar` if webinars). Nothing else — no user/account read scopes;
   the app never calls the REST API.
5. **App Credentials** (Development set for now): copy **Client ID** and **Client Secret** and save them on this Mac as
   `~/.config/meetingbrand/zoom-app.env`:
   ```
   ZOOM_APP_CLIENT_ID=…
   ZOOM_APP_CLIENT_SECRET=…
   ```
   (`chmod 600`; never commit.) Tell me — I set them on the project:
   `supabase secrets set ZOOM_APP_CLIENT_ID=… ZOOM_APP_CLIENT_SECRET=… --project-ref ohobtgbyrlczfdztzvqi` and
   `curl https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app/health` flips to `"configured":true`.
   When you later publish, Zoom issues a **Production** client id/secret — those replace the development pair (the header
   is encrypted with whichever secret belongs to the client's install).
6. **Technical Design** (mandatory section, even for a private app): stack = Supabase Edge Functions (Deno/TypeScript)
   serving a static HTML/JS page + Postgres; third-party code = the Zoom Apps SDK only; external APIs = none (no Zoom
   REST calls from this app); data stored = Zoom user id (`mb.agents.local_identity`), device row, delivery state; no
   meeting content, no media. Architecture diagram: Zoom client → `mb-zoom-app` (Home URL, decrypts the context) →
   page → `mb-agent` → signed image in Supabase Storage → `setVirtualBackground`.
7. **Local Test** (Development ▸ Local Test ▸ **Add App Now** ▸ Allow) adds the app to *your* account; private/beta apps
   need no review (developers.zoom.us/docs/distribute/app-review-process). Sharing outside your account needs
   "Request to Share" (3–4 business days, 4-week windows, max 100 users for a private user-level app, SSDLC/SAST/DAST/
   pen-test evidence) — or a full Marketplace review for a published app (OWASP Top-10 testing, test credentials,
   listing metadata even for an unlisted app).

## 4. Customer admin runbook (what you sell — per customer tenant)

1. In MeetingBrand: **My team → Zoom → Connect** (the REST app) and let the directory sync — the Zoom App only finds
   employees who are in that synced directory. **Prepare backgrounds** (exports must exist).
2. Zoom Marketplace (as the customer's Zoom admin): open the app's page (or **Manage → Apps on Account**) →
   **Add for Others → All users** (or Users & Groups) → **Allow**. Zero install, zero OAuth for employees; new users are
   auto-provisioned; they get an in-client notification (KB0057683 / KB0061035). If the tenant has app pre-approval on
   (default for multi-user accounts, KB0062300) this step is also the approval.
3. **Auto-open at meeting start — [test], be honest:** Zoom's public docs describe *Auto-open selected apps* only as a
   **per-user** desktop setting (Zoom Workplace → Settings → General → Zoom Apps → Manage; KB0060612), and two devforum
   threads asking for an admin push (114589, 117700) were still unanswered in Jan 2026. The plan's claim of an
   account/group control at `zoom.us/account/group/{id}/settings?tab=zoomapps` is **unverified** — check it on a real
   admin tenant before promising it. Until then the honest customer sentence is: *"Employees open MeetingBrand once from
   the Apps panel (or turn on Auto-open for it in their Zoom settings); the app then sets the company background and
   asks Zoom's one permission."*
4. The employee sees Zoom's consent dialog ("Allow MeetingBrand for Zoom to set your virtual background") **[test:
   once vs per call]**; the card then says **"Your company background is set"** with the look's name. My team shows the
   chip from `pushes` (`selected`); a refusal shows as `awaiting_client` "declined in Zoom". **Be honest about what
   `selected` proves here:** it is the page's own report that `zoomSdk.setVirtualBackground` resolved (self-attested,
   like the Meet extension's `applied`) — Zoom has no REST call that reads a user's current background, so the server
   cannot verify it. It is accepted only from the device the image was handed to, for that pair, on platform `zoom`.

### Security model (review 2026-09-23 — what an attacker cannot do)

- **No org key, no e-mail, no guessing:** the only input to `/zoom/resolve` is a ticket that `mb-zoom-app` minted from
  a `x-zoom-app-context` header it decrypted with the Zoom App's client secret (AES-256-GCM, key = SHA-256(secret) —
  the header can only be produced by Zoom). The ticket is an HMAC over `{uid, typ, mid?, iat, exp}` with a key derived
  from `MB_TOKEN_KEY`, 10 minutes. A forged / stale / foreign ticket is a 401 that counts toward the per-IP limiter
  (30 refusals per 10 min → 429); nothing touches the database before the signature verifies. Live-proven 2026-09-23.
- **Identity = the Zoom user id**, matched to `mb.employees.ext_id` on platform `zoom` — rows that only the REST app's
  directory sync (service role) can write: the client insert policy + `guard_employee_insert` pin client rows to
  platform `csv`, and `guard_employee_columns` makes `platform` / `ext_id` immutable. So a uid resolves into a workspace
  only if Zoom's own `/users` listing of that workspace's connected account contained it. Residual: two workspaces that
  connected the *same* Zoom account both hold the uid — the active row, then the most recently synced, wins.
- **Own rows only:** the device row key is `zoom:<uid>:<web view id>` — the web-view id is the page's choice, the uid is
  the ticket's, so one employee's page can never select or re-bind a colleague's row (the previous `zoom:<web view id>`
  key let a colleague who knew a device id replace its token and binding).
- **Replay bounded:** a ticket is reusable within its 10 minutes by design (Auto-open, Retry); grants are capped at 20
  per uid per 10 minutes (429), so one employee cannot mint unbounded device rows / tokens.
- **The page trusts nothing it did not verify:** `imageUrl` must be `https` on the API origin
  (`ohobtgbyrlczfdztzvqi.supabase.co`, where the signed Storage URLs live) or the page refuses to call
  `setVirtualBackground` and reports nothing; the ticket is only ever posted over https; every string is rendered
  with `textContent` (no HTML from the server or Zoom reaches the DOM); `#mb-ctx` is an `application/json` block with
  `<` escaped, written with function replacers (a `$&` in any value is literal). CSP: `script-src 'self'
  https://appssdk.zoom.us`, `connect-src`/`img-src` the API origin only, no inline script, `base-uri 'none'`,
  `form-action 'none'`.
- **Nothing to steal on the page:** no client secret, no service key, no org key; the device token is held in memory
  for the open; storage keeps only a random web-view id and the sha256 of the last applied image.
- **`/health` is public but cheap:** its self-probe is memoised for 60 s per isolate, so it cannot be used to double
  the function's own traffic.
- **Reports are scoped:** a `zoom` device may report only `applied | denied | error`, only for platform `zoom`, only
  for a pair that was handed to it (`pushes.idempotency_key = org:employee:background:zoom`); a Teams/Meet device
  cannot touch those rows and vice versa (`ownPlatform`).

## 5. The [test] list (needs your Zoom tenant — nothing else can answer these)

- Consent dialog: once per app, once per background, or every `setVirtualBackground` call? (Zoom docs only say the
  client "will subsequently show the consent dialog"; the only "once is enough" staff statement is about OAuth.)
- A refused consent dialog: does `setVirtualBackground` reject with code **10017**? (The SDK reference documents 10017
  only for `removeVirtualBackground`'s dialog; `app.js` also treats any "denied / declined / cancelled" message as
  `denied`, everything else as `error`.)
- Does the background **persist** after the meeting / client restart (`VirtualBkgnd_Custom` slot written)?
- Admin-level **Auto-open** control: does it exist on your account/group settings page? If yes: does the app open in the
  meeting context or on the main-client page (devforum 88879)? The page handles both (re-applies on
  `onRunningContextChange`).
- Marketplace **Home URL header check**: does the form accept the function URL (its origin root is a 404 JSON without
  a CSP — devforum 113210 says the root is what gets checked)? If not → §2 fix A or B.
- The Zoom client's own header check against `Content-Type: Text/HTML` (it renders Chromium, which is case-insensitive;
  whether Zoom's validator even runs on a non-lowercase type is unknown — either way the four headers are present).
- `fileUrl` CORS: Supabase Storage answers `access-control-allow-origin: *` (curl-verified), so the signed URL should
  load; if the client still refuses (devforum 86311), switch the page to `imageData` (fetch → ImageData ≤15 MB) — a
  small change in `app.js` `apply()`.
- Does an unpublished development app appear under *Add for Others* for the whole account (documented as "all
  user-level apps", not explicitly for dev-state apps)?

## 6. Operations

- Secrets: `ZOOM_APP_CLIENT_ID`, `ZOOM_APP_CLIENT_SECRET` (only `mb-zoom-app` reads them), `MB_TOKEN_KEY` (already set;
  the ticket HMAC key is derived from it with its own HKDF info). Nothing about the Zoom App is ever stored except the
  Zoom user id and the device row.
- Redeploy after edits: `python3 zoom-app/build-page.py` (regenerates `mb-zoom-app/page.ts`; the deno test fails when
  stale) → `npx -y deno-bin test -A tests/` in `supabase/functions` → `node --test zoom-app/test/app.test.mjs` →
  `SUPABASE_ACCESS_TOKEN=$(cat ~/.config/meetingbrand/supabase-token) npx -y supabase@2 functions deploy mb-agent mb-zoom-app --project-ref ohobtgbyrlczfdztzvqi --no-verify-jwt --use-api`
  from `supabase/` → push (the GitHub Pages mirror updates itself; nothing else to deploy).
- Watch `…/mb-zoom-app/health` → `html.passthrough` (§2). `false` = the Supabase gateway started rewriting our page;
  the Zoom client would show a blank app until fix A or B.
- Push rows: the App's rows are `<org>:<employee>:<background>:zoom`; the REST library upload's rows have no suffix.
  Two deliveries, two rows; My team may show both chips for one person until the product merges them (follow-up).
- Revoking a Zoom App device = My team → Agents → Revoke (`revoke_agent` now also fails its `zoom` pushes); the page
  answers "This device was signed out by your admin".

---

# MeetingBrand for Zoom — האפליקציה השנייה ב‑Zoom (מדריך לבעלים)

## 1. מה זה, בפסקה אחת

שלב B מ‑`PLAN-active-push.md` §1.2: **Zoom App מנוהל‑משתמש** ("MeetingBrand for Zoom") שהדף שלו רץ בתוך לקוח ה‑Zoom של העובד
וקורא ל‑`zoomSdk.setVirtualBackground({ fileUrl })` עם הרקע שהעסק הכין ב‑MeetingBrand. Zoom מציג **דיאלוג הסכמה משלו**
(פעם אחת או בכל קריאה — **[test]**), ואז הרקע מוגדר: בלי להעתיק קובץ, בלי לבחור בגלריה. מנהל הלקוח מתקין לכולם ב‑**Add for Others**
(מאומת: KB0057683 / KB0061035), ואם הטננט מאפשר — פתיחה אוטומטית בתחילת פגישה (**[test]**, ראה §4). זו **אפליקציה נפרדת** ב‑Marketplace
מאפליקציית ה‑REST המנוהלת‑מנהל (`supabase/functions/README-ZOOM.md`): צוות Zoom אישר ששני סוגי הניהול לא יכולים לחיות באפליקציה אחת. שתי אפליקציות בכוונה.

**זהות — למה מזהה משתמש Zoom ולא אימייל (שינוי מהתכנון):** ה‑SDK לא מחזיר אימייל (getUserContext = status / screenName /
participantUUID / role בלבד, אומת 2026-09-23). הזהות המאומתת היחידה היא `uid` בתוך הכותרת המוצפנת `x-zoom-app-context`, שרק
ה‑client secret שלנו מפענח. לכן האפליקציה עובדת לעובדים שנמצאים **בספריית Zoom שסונכרנה** (המנהל חיבר את אפליקציית ה‑REST ב‑My team → Zoom).
רשימת CSV בלבד לא ניתנת להתאמה — הדף אומר זאת בכנות. זה *חזק יותר* מהתאמה לפי אימייל. סיכון שיורי: מי שמחזיק ב‑`ZOOM_APP_CLIENT_SECRET`
או ב‑`MB_TOKEN_KEY` יכול להנפיק טוקן של כל עובד — שמניב רק את הרקע של אותו עובד (URL חתום לשעה של תמונה שכל העסק כבר רואה). מקובל, כמו מפתח הסוכן.

**הוכחה חיה (2026-09-23; עדיין אין אישורי Zoom, ולכן שום דבר לא רץ בתוך לקוח Zoom אמיתי):** ה‑Home URL עונה לבקשת דפדפן
(Accept `text/html`, Chrome UA) ב‑200 עם `Content-Type: Text/HTML` וארבע כותרות ה‑OWASP; Chromium מרנדר את הדף, טוען את ה‑SDK של Zoom תחת
ה‑CSP שלנו ומציג "Open this app inside Zoom". `/health` → `html.passthrough: true`, `configured: false` (הסודות חסרים, כצפוי).
`mb-agent`: כרטיס חתום ב‑`MB_TOKEN_KEY` האמיתי למשתמש Zoom לא מוכר → `404 not_in_roster`; כרטיס בן 20 דקות → `401`; כרטיס מזויף → `401`.
הסכימה (`zoom` ב‑agents.os, `denied` ב‑agent_reports, ענפי `zoom` ב‑guard/revoke) אומתה חיה. שארית QA: 0.

## 2. החלטת האירוח (מדויק) — ה‑Home URL הוא פונקציית ה‑Edge של Supabase `mb-zoom-app`

**Home URL = `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app`** (וגם ה‑OAuth redirect URL).

לקוח Zoom דורש ארבע כותרות תגובה (HSTS, X-Content-Type-Options, CSP, Referrer-Policy) על ה‑Home URL, אחרת לא מרנדר — כותרות HTTP, לא `<meta>`.
**GitHub Pages לא יכול להגדיר כותרות** בכלל (מראה בלבד). **Netlify נפסל** (קרדיטים משותפים). **Supabase משכתב `text/html`** בדומיין
`*.supabase.co` ל‑text/plain + CSP sandbox לכל בקשה שנראית כדפדפן (אומת עם פונקציית בדיקה זמנית, שנמחקה).
**מה שעובד (אומת חי 2026-09-23):** ההתאמה של Supabase רגישה לאותיות ואילו סוגי מדיה ב‑HTTP לא — לכן `mb-zoom-app` שולח
`Content-Type: Text/HTML; charset=utf-8`, השער לא נוגע, Chromium (וגם הדפדפן המוטמע של Zoom) מרנדר HTML וארבע הכותרות שלנו מגיעות.
**בכנות: זה מעקף ש‑Supabase יכולה לסגור בכל יום.** לכן `/health` בודק זאת חי בכל קריאה (`html.passthrough`). תיקונים עמידים, שניהם החלטה שלך:
**A** דומיין מותאם ב‑Supabase (בתשלום, 5 דקות) — ואז `text/html` רגיל על `api.meetingbrand.com`; **B** Cloudflare Worker חינמי על
`zoom.meetingbrand.com` שמעביר את `/` ו‑`/app.js` לפונקציה ומגדיר את הכותרות בעצמו. **[test]**: טופס ה‑Marketplace בודק לפי דיווחים את
שורש המקור (`https://ohobtgbyrlczfdztzvqi.supabase.co/` = 404 JSON בלי CSP) — אם הוא מסרב ל‑Home URL, זה לבדו מחייב A או B.

## 3. יצירת האפליקציה ב‑Zoom Marketplace (אתה — דורש כניסה ל‑Zoom)

1. https://marketplace.zoom.us → **Develop ▸ Build App** → **General App** → Create.
2. **Basic Information**: שם `MeetingBrand for Zoom`; **User-managed** (לא admin-managed — זו האפליקציה השנייה; לא ניתן לשנות אחרי פרסום);
   OAuth Redirect URL ו‑**Home URL**: `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-zoom-app`; OAuth allow list: אותו URL +
   `https://meetingbrand.com/zoom-app/`; **Domain Allow List**: `ohobtgbyrlczfdztzvqi.supabase.co` (הדף, התמונות החתומות וה‑API), `appssdk.zoom.us`, `meetingbrand.com`.
3. **Features ▸ Surface**: הפעל **Zoom App SDK**; ב‑Add APIs סמן בדיוק שניים: `setVirtualBackground` ו‑`onRunningContextChange`
   (רק מה שהדף קורא — Zoom בודקים מינימיזציה של הרשאות); מוצרים: Meetings; הקשרים: In Meeting + Main client.
4. **Scopes**: רק `zoomapp:inmeeting` (+ `zoomapp:inwebinar` אם רוצים וובינרים).
5. **App Credentials**: העתק Client ID ו‑Client Secret ל‑`~/.config/meetingbrand/zoom-app.env` (שתי שורות `ZOOM_APP_CLIENT_ID=` /
   `ZOOM_APP_CLIENT_SECRET=`, `chmod 600`, לא ל‑git) ותגיד לי — אני מגדיר אותם ב‑`supabase secrets set`, ו‑`/health` עובר ל‑`"configured":true`.
6. **Technical Design** (חובה גם לאפליקציה פרטית): Supabase Edge Functions (Deno) שמגישות דף סטטי + Postgres; קוד צד‑שלישי = Zoom Apps SDK בלבד;
   בלי קריאות REST ל‑Zoom; נשמר רק מזהה משתמש Zoom ומצב המסירה.
7. **Local Test → Add App Now → Allow** מוסיף לחשבון שלך בלי ביקורת. שיתוף מחוץ לחשבון = "Request to Share" (3–4 ימי עסקים, חלונות של 4 שבועות,
   עד 100 משתמשים, ראיות SSDLC/SAST/DAST/pen-test) או ביקורת Marketplace מלאה.

## 4. הרצת מנהל אצל הלקוח

1. ב‑MeetingBrand: **My team → Zoom → Connect** וסנכרון ספרייה (האפליקציה מוצאת רק עובדים מהספרייה המסונכרנת); **Prepare backgrounds**.
2. ב‑Marketplace (מנהל Zoom של הלקוח): **Add for Others → All users → Allow**. אפס התקנה ואפס OAuth לעובדים; משתמשים חדשים מתווספים אוטומטית.
3. **פתיחה אוטומטית בתחילת פגישה — [test], בכנות:** התיעוד הציבורי של Zoom מתאר "Auto-open selected apps" רק כהגדרה **פר‑משתמש** בלקוח,
   ושני דיונים בפורום שביקשו דחיפה של מנהל נותרו ללא מענה (ינואר 2026). הטענה בתכנית על בקרת חשבון/קבוצה **לא מאומתת** — לבדוק על טננט אמיתי
   לפני שמבטיחים. עד אז המשפט הכן ללקוח: *"העובדים פותחים את MeetingBrand פעם אחת מפאנל האפליקציות (או מפעילים Auto-open בהגדרות Zoom שלהם);
   האפליקציה מגדירה את רקע החברה ומבקשת את ההרשאה האחת של Zoom."*
4. העובד רואה את דיאלוג ההסכמה של Zoom **[test: פעם אחת או בכל קריאה]**; הכרטיס אומר **"Your company background is set"** עם שם הלוק;
   ב‑My team הצ'יפ מגיע מ‑`pushes` (`selected`; סירוב = `awaiting_client` "declined in Zoom"). **בכנות:** `selected` כאן הוא
   דיווח עצמי של הדף שהקריאה `setVirtualBackground` הצליחה (כמו `applied` של תוסף Meet) — ל‑Zoom אין REST שקורא את הרקע
   הנוכחי של משתמש, אז השרת לא יכול לאמת. הוא מתקבל רק מהמכשיר שקיבל את התמונה, לאותו זוג, בפלטפורמה `zoom`.
   **מודל האבטחה (סקירה 2026-09-23):** הכניסה היחידה היא כרטיס HMAC שנוצר מהכותרת המוצפנת של Zoom (רק Zoom יכולה לייצר אותה);
   הזהות היא ה‑Zoom user id מול שורות שרק סנכרון ה‑REST כותב; מפתח שורת המכשיר הוא `zoom:<uid>:<web view id>` (עובד לא יכול
   לגעת בשורה של עמית); עד 20 כניסות ל‑uid ב‑10 דקות; הדף שולח ל‑Zoom רק תמונות ב‑https מה‑origin של ה‑API. פירוט באנגלית למעלה.

## 5. רשימת ה‑[test] (דורש את הטננט שלך)

דיאלוג ההסכמה — פעם אחת או בכל קריאה; האם הרקע **נשמר** אחרי הפגישה/הפעלה מחדש; האם קיימת בקרת Auto-open ברמת מנהל ובאיזה הקשר האפליקציה
נפתחת (הדף מטפל בשניהם); האם טופס ה‑Marketplace מקבל את ה‑Home URL של הפונקציה (שורש המקור הוא 404 JSON); האם לקוח Zoom עצמו מקבל
`Content-Type: Text/HTML` (Chromium כן; ארבע הכותרות קיימות בכל מקרה); CORS של `fileUrl` (Supabase Storage מחזיר `*`; אם הלקוח מסרב —
מעבר ל‑`imageData`, שינוי קטן ב‑`app.js`); האם אפליקציה במצב פיתוח מופיעה ב‑Add for Others.

## 6. תפעול

סודות: `ZOOM_APP_CLIENT_ID`, `ZOOM_APP_CLIENT_SECRET` (רק `mb-zoom-app` קורא), `MB_TOKEN_KEY` (קיים). אחרי עריכה: `python3 zoom-app/build-page.py`
→ בדיקות deno ב‑`supabase/functions` + `node --test zoom-app/test/app.test.mjs` → פריסת `mb-agent mb-zoom-app` → push (המראה ב‑GitHub Pages
מתעדכנת לבד). לעקוב אחרי `/health` → `html.passthrough` (§2): `false` = Supabase התחילה לשכתב את הדף — לקוח Zoom יראה אפליקציה ריקה עד תיקון A או B.
שורות ה‑push של האפליקציה הן `…:zoom` — נפרדות משורות ה‑REST; ייתכנו שני צ'יפים לאדם עד שהמוצר ימזג (המשך). ביטול מכשיר: My team → Agents → Revoke.
