# MeetingBrand × Zoom — backend setup (owner guide)

*English first, Hebrew below / עברית למטה.*

## 1. What this is

Four Supabase Edge Functions (shared CompanyCard project `ohobtgbyrlczfdztzvqi`, schema `mb`) that let a
workspace admin connect the company's Zoom account, pull the employee directory, and upload a branded
background into every chosen employee's Zoom library:

| Function | Method | Does |
|---|---|---|
| `mb-oauth-zoom` | `GET ?action=start` (user Bearer) → `{url, finish_url}`; `GET /callback?code&state` (no JWT — Zoom's redirect); `POST ?action=finish {code, state}` (user Bearer) | Admin-managed OAuth in three legs. `start` mints an HMAC-signed `state` (org + user, 10 min). The unauthenticated `/callback` only checks the state and bounces the browser to `MB_APP_URL#integrations=zoom&status=pending&code=…&state=…` (or `&status=error&reason=…`) — it never exchanges the code, because a redirect cannot prove which user finished the consent (OAuth login-CSRF). The app then calls `finish` with the **same session that started**: the caller must be an admin whose user/org match the state, or it answers `403 state_mismatch`. `finish` exchanges the code, stores the refresh/access tokens **AES-256-GCM encrypted** in `priv.integration_tokens` and returns `{status:"connected"}`. |
| `mb-sync-zoom` | `POST` (admin) | `GET /users?status=active&page_size=300` (all pages) + `GET /users/{id}` for job titles → upserts `mb.employees` → `{imported, updated, total, stale}`. |
| `mb-push-zoom` | `POST {background_id, employee_ids[≤50]}` (admin) | Downloads the background's export from bucket `mb-exports`, preflights `GET /accounts/me/settings` (`me` = the authorising account; an explicit account id is 404 code 2001 unless you are a master account), then per employee `POST /users/{id}/settings/virtual_backgrounds` (multipart `file`, ≤15 MB, max 10 files per user). One `mb.pushes` row per (org, employee, background): `queued → pushing → awaiting_client | blocked | failed`. Sequential, 200 ms apart, 429-aware. |
| `mb-integrations` | `GET` (member) / `POST {platform:"zoom", action:"disconnect", purge?}` (admin) | Integrations tab read model; disconnect = revoke at Zoom + delete the token row (+ optional purge of employees/pushes). |

Public URLs: `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/<name>`.
Until the four secrets below exist, the Zoom-facing actions (`start`, `finish`, sync, push) answer
`503 {"error":"not_configured","missing":[…]}` — but only **after** the caller is authenticated and an admin
(an unauthenticated probe still gets `401`, so nothing about the deployment leaks). `mb-integrations GET` keeps
working before Zoom is configured: it returns `200` with `connect.zoom.configured:false` and `connect.zoom.missing:[…]`
so the tab renders "not configured" instead of failing; the OAuth `callback` needs only `MB_TOKEN_KEY` + `MB_APP_URL`.
Every function uses CORS for `https://meetingbrand.com` and `http://localhost:8787`, logs one JSON line per event with a
request id (`x-request-id`), and never writes a token or secret into a log or a URL.

**The honest limit (PLAN-integrations §3.1):** Zoom has **no API to select/activate** a background. After a
push the employee signs out and back in to the Zoom client and picks "MeetingBrand - …" once under
Settings → Background & effects; it then stays. The UI must say exactly that (`awaiting_client`).

## 2. Create the Zoom Marketplace app (owner — needs your Zoom sign-in)

1. Go to https://marketplace.zoom.us → sign in with the Zoom account that will own the app → **Develop ▸ Build App**.
2. Choose **General App** → Create.
3. **Basic Information**
   - App name: `MeetingBrand` (must not contain "Zoom"; ≤50 chars).
   - **Select how the app is managed: Admin-managed** (one consent for the whole account; required for the `…:admin` scopes).
   - **OAuth Redirect URL** (exactly, one line):
     `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom/callback`
   - **OAuth allow list**: add the same URL `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom/callback`
     (Zoom only validates the redirect target; `MB_APP_URL` is where *we* send the browser afterwards, it does not go in the list).
     The callback is a **path**, not `?action=callback`: Zoom staff confirm that query parameters inside a
     redirect URL are not supported (devforum.zoom.us/t/13765) — Zoom appends its own `?code=…&state=…`.
   - Copy **Client ID** and **Client Secret** (step 3 below).
4. **Scopes** (granular) — add:
   | Scope | Used by | Required? |
   |---|---|---|
   | `user:read:list_users:admin` | `GET /users` (directory sync) | **yes** |
   | `user:write:virtual_background_files:admin` | upload (`POST /users/{id}/settings/virtual_backgrounds`) | **yes** |
   | `user:delete:virtual_background_files:admin` | delete our older files when a user hits the 10-file cap | **yes** |
   | `user:read:user:admin` | `GET /users/{id}` (job titles) and `GET /users/me` (who connected) | recommended — without it titles stay empty (sync still succeeds) and the connect flow falls back to the account id inside the token |
   | `account:read:settings:admin` | preflight `GET /accounts/me/settings` → `in_meeting.virtual_background` | optional — without it (or on a free account: paid accounts only) the preflight is skipped and the upload itself reports the problem |
   Do **not** add `account:write:…` / `group:write:…` for now (org-wide library mode is not built).
5. **Features**: nothing (no event subscriptions, no Zoom App/SDK) for this phase.
6. Leave the app in **Development** — it works for **your own account** immediately, without review.
   Sharing with other companies needs Beta share/marketplace review later (PLAN §3.1 "Distribution").
7. Information tab (for later review, not needed to test): company name, developer contact email
   (`support@meetingbrand.com` once it exists), Privacy `https://meetingbrand.com/privacy/`, Terms
   `https://meetingbrand.com/terms/`, Support/Documentation pages.

## 3. Where the credentials go (owner) and how they are set (orchestrator)

Create a **local** file, never committed, never inside the repos:

```bash
mkdir -p ~/.config/meetingbrand
cat > ~/.config/meetingbrand/zoom.env <<'EOF'
ZOOM_CLIENT_ID=…paste…
ZOOM_CLIENT_SECRET=…paste…
EOF
chmod 600 ~/.config/meetingbrand/zoom.env
```

The orchestrator then sets the four function secrets (`MB_TOKEN_KEY` is generated once; **losing it makes
every stored Zoom token unreadable → everyone reconnects**, so back it up in the password manager):

```bash
export SUPABASE_ACCESS_TOKEN=$(cat ~/.config/meetingbrand/supabase-token)
npx -y supabase@2 secrets set --env-file ~/.config/meetingbrand/zoom.env --project-ref ohobtgbyrlczfdztzvqi
npx -y supabase@2 secrets set MB_TOKEN_KEY="$(openssl rand -base64 32)" MB_APP_URL=https://meetingbrand.com/app/ --project-ref ohobtgbyrlczfdztzvqi
npx -y supabase@2 secrets list --project-ref ohobtgbyrlczfdztzvqi   # names only, values are never shown
```

Optional: `ZOOM_REDIRECT_URI` overrides the callback URL (defaults to the one above).

## 4. Apply the SQL, deploy the functions (orchestrator)

```bash
# 1) SQL — Dashboard → SQL Editor, in this order (both idempotent):
#    supabase/shared-cc/mb-005-integrations.sql   (integrations, employees, pushes, token vault RPCs)
#    supabase/shared-cc/mb-006-token-lease.sql    (single-flight refresh lease)
# 2) Functions — no Docker on this Mac → bundle server-side:
cd ~/meetingbrand-site
export SUPABASE_ACCESS_TOKEN=$(cat ~/.config/meetingbrand/supabase-token)
npx -y supabase@2 functions deploy mb-oauth-zoom mb-sync-zoom mb-push-zoom mb-integrations \
  --project-ref ohobtgbyrlczfdztzvqi --use-api
```

`supabase/config.toml` carries `verify_jwt = false` for **all four** functions — on purpose. Besides the
Zoom redirect (no Supabase JWT at all), this project signs user sessions with an **ES256** key
(Management API `/config/auth/signing-keys`, 2026-09-13: ES256 `in_use`, HS256 `previously_used`) and the
gateway's `verify_jwt` only understands the legacy HS256 secret — Supabase: *"If you're using Edge
Functions that have the Verify JWT setting … you will need to turn off this setting."* Every function
still authenticates the caller itself: `requireUser` asks GoTrue (`GET /auth/v1/user`) to validate the
Bearer, refuses the anon/service keys as bearers, and admin rights come from `mb.profiles`.

Local checks (no deploy): `cd supabase/functions && npx -y deno-bin task check && npx -y deno-bin task test`.

## 5. Testing loop on your own Zoom account (private app, no review)

1. Sign in to https://meetingbrand.com/app/ as an **admin** of your workspace (`mb.profiles.role = admin`).
2. Integrations → **Connect Zoom** (the app calls `mb-oauth-zoom?action=start` and opens the returned URL).
   Until the tab ships, do it by hand:
   ```bash
   TOKEN=…your Supabase session access token (Dev tools → Application → Local storage → sb-…-auth-token → access_token)…
   curl -s -H "Authorization: Bearer $TOKEN" \
     "https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom?action=start"
   # → {"url":"https://zoom.us/oauth/authorize?...","expires_in":600}  → open the url in the browser
   ```
3. Zoom shows the consent screen for the admin-managed app → **Allow**. The browser lands on
   `https://meetingbrand.com/app/#integrations=zoom&status=pending&code=…&state=…`.
   If it says `status=error&reason=…`: `denied` (you declined), `missing_params`, `state_malformed`,
   `state_bad_signature` (MB_TOKEN_KEY changed), `state_expired` (took >10 min), `state_future`.
   Nothing is connected yet — the app (or you, by hand) must finish with the **same** session:
   ```bash
   CODE=…  STATE=…   # copy both from the fragment above
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d "{\"code\":\"$CODE\",\"state\":\"$STATE\"}" \
     "https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom?action=finish"
   # → {"platform":"zoom","status":"connected","account_ext_id":"…","scopes":[…]}
   ```
   `finish` errors: `403 state_mismatch` (the state was minted by another user/workspace — start again),
   `403 forbidden` (not an admin any more), `400 state_expired` (>10 min), `502 exchange_failed`
   (redirect URL/secret mismatch — compare step 2.3 and the secrets; a code is single-use, so a retry
   needs a new `start`), `502 zoom_me_failed` (scope), `500 db_error` (SQL from step 4 not applied).
4. Sync the directory:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}' \
     https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-sync-zoom
   # → {"imported":N,"updated":0,"total":N,"stale":0,"synced_at":"…"}
   ```
   People panel now shows the Zoom users (`mb.employees`, platform `zoom`).
5. In the app, export a background (this creates `mb.backgrounds.export_asset_id` → a PNG in bucket `mb-exports`).
6. Push it to yourself:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"background_id":"<backgrounds.id>","employee_ids":["<employees.id of you>"]}' \
     https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-push-zoom
   # → {"counts":{"pushed":1,…},"results":[{"outcome":"pushed","state":"awaiting_client","remote_file_id":"…"}],
   #    "preflight":{"enabled":true,…},"next_step":"…sign out and back in…"}
   ```
   Outcomes: `pushed` (file is in the user's Zoom library), `already_pushed` (idempotent), `retry` (429/5xx —
   call again), `blocked` (library full / feature disabled / plan), `failed`, `needs_reconnect`, `unknown_employee`.
7. Zoom desktop client: **sign out, sign in**, Settings → Background & effects → the tile
   **"MeetingBrand - <label>.png"** is there → click it once. That is the whole employee-side action.
8. Check the tab / read model:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-integrations
   ```
9. Disconnect (also revokes at Zoom and deletes the stored tokens; `"purge":true` also deletes the org's Zoom employees + pushes):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"platform":"zoom","action":"disconnect"}' https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-integrations
   ```

Logs: Dashboard → Edge Functions → `<name>` → Logs (JSON lines with `rid`, never tokens).

## 6. Things to know

- Zoom refresh tokens **rotate on every refresh and expire after 90 days**; `integrations.expires_at` shows the
  deadline, `status = needs_reconnect` means the admin must click Connect again (the app should nag).
  A nightly sync keeps the token alive (not built yet — cron later).
- 15 MB per file, **10 files per user** (we delete only files *we* uploaded when the cap is hit), PNG/JPG/GIF.
- Virtual background can be off at the account level (Account Settings → In Meeting (Advanced)); the preflight
  reports it and every push is `blocked` until it is on.
- Rate limits (Zoom: Light 30/s · Medium 20/s · Heavy 10/s on Pro; Free accounts are 4/2/1 per second plus
  daily caps): directory calls are Medium — the sync uses ≤4 parallel requests; pushes are sequential with
  200 ms spacing and at most 50 per call. A per-second 429 (`X-RateLimit-Type: QPS`, no `Retry-After`) is
  re-sent once after ~1 s; a **daily** 429 (`X-RateLimit-Type: Daily-limit`, `Retry-After` = ISO time the
  quota resets at 00:00 UTC) stops the push loop — the remaining employees get `retry`/`queued` rows without
  any further Zoom call. Upload errors are HTTP 400 code 120: the 10-file cap → `blocked` (we free our own
  older files and retry once); size/format/no-file → `failed`. Token errors are code 124 (HTTP 400 *or* 401).
- Edge Function wall clock is limited (≈150 s): 50 uploads fit; do not raise the cap without measuring.
- Everything Zoom-specific lives in `_shared/zoom.ts`; Teams/Meet/Zoho will reuse `integrations/employees/pushes`.

---

# MeetingBrand × Zoom — מדריך הקמה לבעלים (עברית)

## 1. מה זה

ארבע Edge Functions ב‑Supabase (הפרויקט המשותף עם CompanyCard, סכמה `mb`) שמאפשרות למנהל של סביבת עבודה
לחבר את חשבון ה‑Zoom של החברה, למשוך את רשימת העובדים, ולהעלות רקע ממותג לספריית ה‑Zoom של כל עובד שנבחר:

- `mb-oauth-zoom` — חיבור OAuth (אפליקציה בניהול אדמין) בשלושה שלבים: `start` (Bearer) → מסך ההסכמה של Zoom → `/callback` (בלי JWT) שרק בודק את ה‑`state` החתום ומפנה ל‑`MB_APP_URL#integrations=zoom&status=pending&code=…&state=…` (או `status=error&reason=…`) → האפליקציה קוראת ל‑`POST ?action=finish {code,state}` עם **אותו** סשן שהתחיל (אחרת `403 state_mismatch`). רק `finish` מחליף את הקוד בטוקנים ושומר אותם **מוצפנים AES‑256‑GCM** ב‑`priv.integration_tokens`. ההפרדה הזו חוסמת OAuth login‑CSRF (חיבור חשבון Zoom של מישהו אחר לארגון של התוקף).
- `mb-sync-zoom` — מושך את כל המשתמשים הפעילים (`GET /users`, כולל דפדוף) + תפקיד (`GET /users/{id}`) → `mb.employees`.
- `mb-push-zoom` — מוריד את קובץ הייצוא של הרקע מ‑`mb-exports`, בודק שהפיצ'ר דלוק בחשבון, ומעלה לכל עובד (`POST /users/{id}/settings/virtual_backgrounds`, עד 15MB, עד 10 קבצים למשתמש). שורה ב‑`mb.pushes` לכל (ארגון, עובד, רקע). עד 50 עובדים בקריאה, סדרתי, 200ms בין קריאות.
- `mb-integrations` — המידע ללשונית Integrations + ניתוק (ביטול ב‑Zoom + מחיקת הטוקנים).

עד שארבעת הסודות קיימים, הפעולות שפונות ל‑Zoom (`start`, `finish`, sync, push) מחזירות `503 {"error":"not_configured","missing":[…]}` — אבל רק אחרי אימות המשתמש (קריאה בלי Bearer עדיין מקבלת `401`). `mb-integrations GET` עובד גם לפני ההגדרה: מחזיר `200` עם `connect.zoom.configured:false` ו‑`missing:[…]`, כדי שהלשונית תציג "לא מוגדר" במקום שגיאה. שום פונקציה לא קורסת.

**המגבלה האמיתית:** ל‑Zoom **אין API שבוחר/מפעיל** רקע. אחרי ה‑push העובד מתנתק ומתחבר מחדש ל‑Zoom, נכנס
ל‑Settings → Background & effects ובוחר פעם אחת את "MeetingBrand - …" — ומאז זה נשאר. ככה בדיוק הממשק צריך להגיד.

## 2. יצירת האפליקציה ב‑Zoom Marketplace (אתה — דורש כניסה לחשבון Zoom)

1. https://marketplace.zoom.us → כניסה → **Develop ▸ Build App**.
2. בוחרים **General App** → Create.
3. **Basic Information**:
   - שם: `MeetingBrand` (בלי המילה Zoom).
   - **Select how the app is managed: Admin‑managed** (הסכמה אחת לכל החשבון; חובה בשביל ה‑scopes עם `:admin`).
   - **OAuth Redirect URL** (בדיוק כך):
     `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom/callback`
   - **OAuth allow list**: אותו URL בדיוק.
   - להעתיק **Client ID** ו‑**Client Secret** (שלב 3).
4. **Scopes** להוסיף: `user:read:list_users:admin` (חובה), `user:write:virtual_background_files:admin` (חובה),
   `user:delete:virtual_background_files:admin` (חובה — פינוי מקום כשמגיעים ל‑10 קבצים),
   `user:read:user:admin` (מומלץ — תפקידים; בלעדיו הסנכרון עובד אבל בלי תפקיד),
   `account:read:settings:admin` (אופציונלי — בדיקה מוקדמת שהרקעים דלוקים בחשבון; בלעדיו מדלגים על הבדיקה).
5. **Features**: כלום בשלב הזה.
6. משאירים את האפליקציה ב‑**Development** — עובדת מיד **על החשבון שלך** בלי ביקורת. שיתוף עם חברות אחרות
   דורש Beta share / ביקורת של Zoom בהמשך.

## 3. איפה שמים את הפרטים

קובץ **מקומי** בלבד, לא ב‑git ולא בתוך הריפו:

```bash
mkdir -p ~/.config/meetingbrand
cat > ~/.config/meetingbrand/zoom.env <<'EOF'
ZOOM_CLIENT_ID=…להדביק…
ZOOM_CLIENT_SECRET=…להדביק…
EOF
chmod 600 ~/.config/meetingbrand/zoom.env
```

האורקסטרטור (Claude) מגדיר מזה את סודות הפונקציות (`supabase secrets set`), מייצר `MB_TOKEN_KEY` פעם אחת
(**אם המפתח הזה הולך לאיבוד כל הטוקנים השמורים לא קריאים וכולם מתחברים מחדש** — לגבות במנהל הסיסמאות),
ומגדיר `MB_APP_URL=https://meetingbrand.com/app/`. הפקודות המדויקות בסעיף 3 באנגלית.

## 4. SQL ופריסה (האורקסטרטור)

להריץ ב‑SQL Editor לפי הסדר: `shared-cc/mb-005-integrations.sql` ואז `shared-cc/mb-006-token-lease.sql`.
לפרוס: `npx -y supabase@2 functions deploy mb-oauth-zoom mb-sync-zoom mb-push-zoom mb-integrations --project-ref ohobtgbyrlczfdztzvqi --use-api`
(אין Docker במק → בנייה בצד השרת). `config.toml` מבטל אימות JWT בשער ל‑**כל ארבע** הפונקציות בכוונה: הפרויקט חותם סשנים ב‑ES256 והשער מכיר רק את סוד ה‑HS256 הישן (עם `verify_jwt = true` כל סשן אמיתי היה מקבל 401). כל פונקציה מאמתת בעצמה את ה‑Bearer מול GoTrue (`GET /auth/v1/user`), דוחה את מפתחות ה‑anon/service כ‑Bearer, ובודקת admin מול `mb.profiles`; ה‑`/callback` של Zoom מאמת `state` חתום.

## 5. לולאת בדיקה על החשבון שלך

1. להתחבר ל‑https://meetingbrand.com/app/ כ‑**admin**.
2. Integrations → **Connect Zoom** (או ידנית: `GET …/mb-oauth-zoom?action=start` עם ה‑Bearer של הסשן → לפתוח את ה‑`url`).
3. מסך ההסכמה של Zoom → **Allow** → חוזרים ל‑`…/app/#integrations=zoom&status=pending&code=…&state=…`.
   אם `status=error`: `denied` (סירבת), `state_expired` (יותר מ‑10 דקות), `state_bad_signature` (ה‑MB_TOKEN_KEY השתנה).
   עדיין לא מחובר — האפליקציה (או ידנית) מסיימת עם אותו סשן: `POST …/mb-oauth-zoom?action=finish {"code":"…","state":"…"}` עם ה‑Bearer → `{"status":"connected"}`.
   שגיאות `finish`: `403 state_mismatch` (ה‑state נוצר ע"י משתמש/ארגון אחר — להתחיל מחדש), `403 forbidden` (כבר לא admin), `502 exchange_failed` (Redirect URL או Secret לא תואמים; קוד הוא חד‑פעמי, צריך `start` חדש), `502 zoom_me_failed` (scope), `500 db_error` (ה‑SQL לא הורץ).
4. `POST …/mb-sync-zoom` → `{"imported":N,…}` → העובדים מופיעים ב‑People.
5. לייצא רקע באפליקציה (נוצר `export_asset_id` + PNG ב‑`mb-exports`).
6. `POST …/mb-push-zoom {"background_id":"…","employee_ids":["<אתה>"]}` → `results[0].outcome = "pushed"`, `state = "awaiting_client"`.
7. בלקוח Zoom: **להתנתק ולהתחבר**, Settings → Background & effects → האריח **"MeetingBrand - …"** שם → ללחוץ פעם אחת.
8. `GET …/mb-integrations` מציג סטטוס, ספירות עובדים ו‑pushes אחרונים. ניתוק: `POST …/mb-integrations {"platform":"zoom","action":"disconnect"}`.

לוגים: Dashboard → Edge Functions → הפונקציה → Logs (שורות JSON עם `rid`; אף פעם לא טוקנים).

## 6. חשוב לדעת

- ה‑refresh token של Zoom **מתחלף בכל רענון ופג אחרי 90 יום**; `status = needs_reconnect` = האדמין צריך ללחוץ Connect שוב. סנכרון לילי (טרם נבנה) ישמור אותו חי.
- 15MB לקובץ, **10 קבצים למשתמש** (מוחקים רק קבצים שאנחנו העלינו), PNG/JPG/GIF.
- אם Virtual background כבוי ברמת החשבון — כל ה‑pushes יהיו `blocked` עד שמדליקים.
- מגבלות קצב: הסנכרון ≤4 בקשות במקביל ומכבד `Retry-After`; ה‑push סדרתי, 200ms בין עובדים, עד 50 בקריאה.
