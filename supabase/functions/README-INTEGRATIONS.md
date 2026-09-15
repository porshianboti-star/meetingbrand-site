# MeetingBrand × Teams + Meet — backend setup (owner guide)

*English first, Hebrew below / עברית למטה.* Zoom is documented separately in `README-ZOOM.md`.

## 1. What this is

Five more Supabase Edge Functions (same shared project `ohobtgbyrlczfdztzvqi`, schema `mb`) so the **My team** tab can
connect Microsoft Teams and Google Meet next to Zoom, import their employees, and hand the admin an honest delivery pack:

| Function | Method | Does |
|---|---|---|
| `mb-oauth-ms` | `GET ?action=start` (admin) → `{url}`; `GET /callback?tenant&state&admin_consent=True` (no JWT — Microsoft's redirect); `POST ?action=finish {tenant, state}` (admin) | **Entra admin consent** for a multitenant app. `start` mints an HMAC-signed `state` (org + user, 10 min) and returns `https://login.microsoftonline.com/common/adminconsent?client_id=…&state=…&redirect_uri=…`. The unauthenticated `/callback` only verifies the state and bounces the browser to `MB_APP_URL#integrations=teams&status=pending&tenant=…&state=…`. `finish` (same session that started, or `403 state_mismatch`) proves the consent by minting an app-only token for that tenant, then stores `mb.integrations {platform:'teams', status:'connected', account_ext_id:<tenant id>, scopes:['User.Read.All']}`. **Nothing goes into the token vault**: client-credentials tokens are minted per call from `MS_CLIENT_ID/MS_CLIENT_SECRET` + the tenant; there is no refresh token. |
| `mb-sync-ms` | `POST` (admin) | Graph `GET /v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled&$top=999&$filter=accountEnabled eq true` (follows `@odata.nextLink`, cap 2 000) → upserts `mb.employees` (platform `teams`, `ext_id` = Graph user id) → `{imported, updated, total, stale, truncated}`. `jobTitle`/`department` come back because they are `$select`-ed — no second call per user. |
| `mb-oauth-google` | `GET ?action=start` (admin) → `{url}`; `GET /callback?code&state` (no JWT); `POST ?action=finish {code, state}` (admin) | Google OAuth code flow with `access_type=offline&prompt=consent`, scopes `openid email https://www.googleapis.com/auth/admin.directory.user.readonly`. `finish` exchanges the code, refuses a consent without the directory scope (`409 scope_not_granted`) or a consumer Gmail account (`409 not_workspace`), binds the Workspace domain (`hd` claim) as `account_ext_id` and stores the refresh + access token **AES-256-GCM encrypted** in `priv.integration_tokens`. `invalid_grant` later → `needs_reconnect`. |
| `mb-sync-google` | `POST` (admin) | Admin SDK `GET /admin/directory/v1/users?customer=my_customer&maxResults=500&query=isSuspended=false&projection=full` (follows `nextPageToken`, cap 2 000; title/department from `organizations[]`) → upserts `mb.employees` (platform `meet`). `403 Not Authorized` = the Google account that consented lacks the *Users › Read* admin privilege → `409 google_blocked`. |
| `mb-export-pack` | `POST {background_id, platform:"teams"\|"meet", employee_ids?}` (admin) | Signed URLs (1 h) for the background's delivery files + a runbook JSON `{steps:[…]}`. **Teams**: `<GUID>.png` (1920×1080) + `<GUID>_thumb.png` (280×158) file names (GUID = the background id), the Intune PowerShell and the macOS shell script that drop both files into the new-Teams `Backgrounds\Uploads` folder. **Meet**: the 1920×1080 **JPEG** + the admin-console runbook (≤15 images per OU, Drive "anyone with the link", up to 24 h). `ready:false` + `missing:[…]` when a client-rendered file is not registered yet (never a 500). |
| `mb-integrations` (extended) | `GET` (member) / `POST {platform, action:"disconnect", purge?}` (admin) | `connect.{zoom,teams,meet}` each with `{configured, missing, start_url, redirect_uri, finish_url, sync_url, push_url|pack_url, delivery, push_api}`. `delivery` is the one honest sentence per platform. Disconnect now works for `teams` (row only — consent is removed in Entra) and `meet` (revokes the refresh token at Google + deletes the vault row). Backward compatible: `connect.zoom` keeps its v1 keys, `integrations[]` still has the four platform rows. |

Public URLs: `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/<name>`.
Until the platform secrets exist, every platform action answers `503 {"error":"not_configured","missing":[…]}` — but only
**after** the caller is authenticated and an admin (an unauthenticated probe still gets `401`). `mb-integrations GET`
answers `200` with `connect.teams.configured:false` / `connect.meet.configured:false` and the exact missing names,
so the My-team chooser shows "Coming soon" for that platform instead of failing.

**What is server-generated vs client-generated (export pack).** No image library is guaranteed in the Edge runtime, so
the **app** renders three files in the browser and registers them as `mb.brand_assets` rows: the 1920×1080 PNG export
(kind `export`, exists since v81), the 280×158 PNG thumb (kind `thumb` → `backgrounds.thumb_asset_id`) and the 1920×1080
JPEG (kind `export_jpg` → `backgrounds.export_jpg_asset_id`) — both added by `shared-cc/mb-007-export-kinds.sql`
(applied 2026-09-15). The **function** checks ownership + storage path, signs URLs, names the files, writes the runbook
and the two scripts. It never renders, resizes or re-encodes an image.

**The honest limits (PLAN-integrations §3.2 / §3.3) — this is what the product must say:**
- **Teams** has **no background API**. We import the directory from Graph and hand the admin an Intune/Jamf script
  (or, later, the MeetingBrand agent) that drops `<GUID>.png` + `<GUID>_thumb.png` into each employee's new-Teams
  gallery folder. The employee fully quits/relaunches Teams and picks the tile **once**; it then persists on that device.
  Pre-flight the admin must do: meeting policy `VideoFiltersMode = AllFilters`, no Premium "required background" policy.
  Only a **Teams Premium** customization policy ("Set as required") can force it — and its upload is not scriptable.
- **Google Meet** has **no background API and does not remember a choice**. We import the directory from the Admin SDK and
  hand the admin a JPEG + the admin-console runbook (≤15 images per OU, Drive-hosted, up to 24 h to appear); employees
  re-select it per browser/device. Only the force-installed MeetingBrand Chrome extension (later) applies it automatically.

## 2. Register the Entra app (owner — needs a Microsoft work account with Global Admin / Application Admin on meetingbrand.com's tenant)

1. https://entra.microsoft.com → **Identity ▸ Applications ▸ App registrations ▸ New registration**.
2. **Name**: `MeetingBrand`.
3. **Supported account types**: **Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant)**.
   Personal Microsoft accounts: not needed.
4. **Redirect URI**: platform **Web**, value (exactly, one line):
   `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-ms/callback`
5. Register → copy the **Application (client) ID** → this is `MS_CLIENT_ID`.
6. **Certificates & secrets ▸ Client secrets ▸ New client secret** (description `mb-edge`, expiry 24 months) → copy the
   **Value** immediately (it is shown once) → this is `MS_CLIENT_SECRET`. Put the expiry date in the calendar.
7. **API permissions ▸ Add a permission ▸ Microsoft Graph ▸ Application permissions** → tick **`User.Read.All`** → Add.
   (Delegated `User.Read` / `openid` / `profile` / `email` may stay; they are not used by the backend.)
   Do **not** click "Grant admin consent for <our tenant>" — customers consent for their own tenant through the app.
8. **Branding & properties**: Name `MeetingBrand`, logo (the kit mark, 215×215 PNG), Home page `https://meetingbrand.com/`,
   Terms `https://meetingbrand.com/terms/`, Privacy `https://meetingbrand.com/privacy/`,
   **Publisher domain** = `meetingbrand.com` (verify it: the page tells you to host
   `https://meetingbrand.com/.well-known/microsoft-identity-association.json` with the tenant id — add it to the site repo when asked).
9. Later, not blocking: **publisher verification** (Partner Center / MPN ID) removes the "unverified" warning on the consent screen.

What the customer's admin sees: the consent screen for `MeetingBrand` asking for "Read all users' full profiles" — they
accept once for the whole tenant. To revoke, they delete the enterprise app under **Enterprise applications**.

## 3. Register the Google Cloud OAuth client (owner — needs the Google account that owns the meetingbrand.com Workspace / Cloud project)

1. https://console.cloud.google.com → create project **`meetingbrand`** (or reuse one) → **APIs & Services ▸ Library** →
   enable **Admin SDK API**.
2. **APIs & Services ▸ OAuth consent screen** (Google Auth Platform):
   - User type **External**; app name `MeetingBrand`; support e-mail; logo; app domain `meetingbrand.com`;
     Home `https://meetingbrand.com/`, Privacy `https://meetingbrand.com/privacy/`, Terms `https://meetingbrand.com/terms/`;
     **authorized domain** `meetingbrand.com` (the domain must be verified in Search Console under the same account).
   - **Scopes ▸ Add**: `openid`, `.../auth/userinfo.email`, and **`https://www.googleapis.com/auth/admin.directory.user.readonly`**
     (listed under "sensitive scopes").
   - **Test users**: add your own Workspace admin account(s) — while the app is in **Testing**, only test users can consent,
     and their refresh tokens expire after **7 days** (a reconnect is then required).
   - **Publish app** → "In production" → Google **verification** (3–5 business days for a sensitive scope; needs the
     privacy policy on the verified domain, a scope justification — "reads the company directory to show the admin who
     gets a branded background" — and an unlisted YouTube demo of the consent flow). Until verified: warning screen +
     a hard cap of **100 users** who can consent.
3. **APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID**:
   - Application type **Web application**, name `MeetingBrand backend`.
   - **Authorized redirect URIs** (exactly, one line): `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-google/callback`
   - Create → copy **Client ID** (`GOOGLE_CLIENT_ID`) and **Client secret** (`GOOGLE_CLIENT_SECRET`).

What the customer's admin sees: Google's consent screen for `MeetingBrand` asking to "View users on your domain" — the
account that consents must hold the Workspace **Users › Read** admin privilege, otherwise the sync answers `409 google_blocked`.

## 4. Where the four values go (owner) and how they are set (orchestrator)

Two **local** files, never committed, never inside the repos:

```bash
mkdir -p ~/.config/meetingbrand
cat > ~/.config/meetingbrand/ms.env <<'EOF'
MS_CLIENT_ID=…paste the Application (client) ID…
MS_CLIENT_SECRET=…paste the client secret VALUE…
EOF
cat > ~/.config/meetingbrand/google.env <<'EOF'
GOOGLE_CLIENT_ID=…paste…
GOOGLE_CLIENT_SECRET=…paste…
EOF
chmod 600 ~/.config/meetingbrand/ms.env ~/.config/meetingbrand/google.env
```

Then the orchestrator runs (values are never printed; `MB_TOKEN_KEY` + `MB_APP_URL` already exist):

```bash
export SUPABASE_ACCESS_TOKEN=$(cat ~/.config/meetingbrand/supabase-token)
npx -y supabase@2 secrets set --env-file ~/.config/meetingbrand/ms.env     --project-ref ohobtgbyrlczfdztzvqi
npx -y supabase@2 secrets set --env-file ~/.config/meetingbrand/google.env --project-ref ohobtgbyrlczfdztzvqi
npx -y supabase@2 secrets list --project-ref ohobtgbyrlczfdztzvqi   # names only
```

Optional overrides: `MS_REDIRECT_URI`, `GOOGLE_REDIRECT_URI` (default to the two callback URLs above).
No redeploy is needed after setting secrets — `mb-integrations GET` flips `configured:true` on the next call.

## 5. Deploy / verify (orchestrator)

```bash
# SQL (idempotent) — applied 2026-09-15 via the Management API: supabase/shared-cc/mb-007-export-kinds.sql
cd ~/meetingbrand-site/supabase/functions && npx -y deno-bin task check && npx -y deno-bin task test   # 111 tests
cd ~/meetingbrand-site
export SUPABASE_ACCESS_TOKEN=$(cat ~/.config/meetingbrand/supabase-token)
npx -y supabase@2 functions deploy mb-oauth-ms mb-sync-ms mb-oauth-google mb-sync-google mb-export-pack mb-integrations \
  --project-ref ohobtgbyrlczfdztzvqi --no-verify-jwt --use-api
```

`verify_jwt = false` on all nine functions — same reason as in README-ZOOM.md §4 (ES256 sessions + platform redirects
without a JWT); every function verifies the Bearer itself against GoTrue and checks `mb.profiles.role`.

## 6. Manual test loop (before the My-team tab ships)

```bash
TOKEN=…Supabase session access token of a workspace ADMIN…
B="https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1"
curl -s -H "Authorization: Bearer $TOKEN" "$B/mb-integrations" | jq .connect          # configured / missing per platform
curl -s -H "Authorization: Bearer $TOKEN" "$B/mb-oauth-ms?action=start" | jq .url      # open in the browser as a tenant admin
#  → consent → browser lands on https://meetingbrand.com/app/#integrations=teams&status=pending&tenant=…&state=…
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tenant":"<tenant from the fragment>","state":"<state from the fragment>"}' "$B/mb-oauth-ms?action=finish"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$B/mb-sync-ms"                    # {imported, updated, total, stale}
curl -s -H "Authorization: Bearer $TOKEN" "$B/mb-oauth-google?action=start" | jq .url # same shape with code+state
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$B/mb-sync-google"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"background_id":"<uuid>","platform":"teams"}' "$B/mb-export-pack" | jq '.ready,.missing,.files,.scripts.windows_ps1'
```

---

# MeetingBrand × Teams + Meet — הקמת ה‑backend (מדריך לבעלים)

## 1. מה זה

חמש פונקציות Edge נוספות (אותו פרויקט משותף `ohobtgbyrlczfdztzvqi`, סכמה `mb`) כדי שהטאב **My team** יוכל לחבר גם Microsoft Teams ו‑Google Meet
לצד Zoom, לייבא את העובדים שלהם, ולתת למנהל חבילת הפצה כנה:

- **`mb-oauth-ms`** — הסכמת מנהל (admin consent) של Entra לאפליקציה רב‑דיירית. `start` מחזיר את כתובת ההסכמה; ה‑`callback` (בלי JWT) רק
  מאמת את ה‑`state` ומחזיר את הדפדפן לאפליקציה עם `tenant` + `state`; `finish` (אותו session שהתחיל) מוכיח את ההסכמה ע"י הנפקת
  token לדייר ושומר `mb.integrations` עם ה‑tenant בלבד. **שום דבר לא נשמר בכספת** — אין refresh token בזרימת client credentials.
- **`mb-sync-ms`** — Graph `GET /users` עם `$select` (כולל jobTitle + department, בלי קריאה שנייה לכל משתמש), `$filter=accountEnabled eq true`,
  דפדוף `@odata.nextLink`, תקרה 2,000 → `mb.employees` (platform `teams`).
- **`mb-oauth-google`** — OAuth של Google עם `access_type=offline&prompt=consent` והסקופ `admin.directory.user.readonly`;
  ה‑refresh token נשמר מוצפן (AES‑256‑GCM) ב‑`priv.integration_tokens`. `invalid_grant` בהמשך → `needs_reconnect`.
- **`mb-sync-google`** — Admin SDK `users.list` (`customer=my_customer`, `isSuspended=false`, `projection=full`, דפדוף `nextPageToken`,
  תקרה 2,000; תפקיד/מחלקה מ‑`organizations[]`) → `mb.employees` (platform `meet`).
- **`mb-export-pack`** — כתובות חתומות (שעה) לקבצי ההפצה + runbook. **Teams**: שמות `<GUID>.png` + `<GUID>_thumb.png` (ה‑GUID = מזהה הרקע),
  סקריפט PowerShell ל‑Intune וסקריפט shell ל‑macOS שמפילים את הקבצים לתיקיית ה‑Uploads של Teams החדש. **Meet**: JPEG 1920×1080 + runbook
  לקונסולת הניהול (עד 15 תמונות ל‑OU, Drive "כל מי שיש לו את הקישור", עד 24 שעות).
- **`mb-integrations`** (הורחב) — `connect.{zoom,teams,meet}` עם `configured / missing / start_url / delivery`; ניתוק גם ל‑teams ול‑meet.

עד שהסודות של הפלטפורמה קיימים, כל פעולה של אותה פלטפורמה מחזירה `503 not_configured` עם רשימת השמות החסרים — אבל רק **אחרי**
אימות (פרובר לא מזוהה מקבל `401`). `mb-integrations GET` ממשיך לעבוד ומחזיר `configured:false` — כך הבורר ב‑My team מציג "Coming soon".

**מה נוצר בשרת ומה בלקוח (export pack).** אין ספריית תמונות מובטחת ב‑Edge runtime, ולכן **האפליקציה** מרנדרת בדפדפן שלושה קבצים
ורושמת אותם ב‑`mb.brand_assets`: PNG ‏1920×1080 (kind `export`, קיים מ‑v81), thumb PNG ‏280×158 (kind `thumb` → `backgrounds.thumb_asset_id`)
ו‑JPEG ‏1920×1080 (kind `export_jpg` → `backgrounds.export_jpg_asset_id`) — שניהם נוספו ב‑`shared-cc/mb-007-export-kinds.sql` (הוחל 2026‑09‑15).
**הפונקציה** בודקת בעלות ונתיב, חותמת כתובות, נותנת שמות קבצים, כותבת את ה‑runbook ואת שני הסקריפטים. היא אף פעם לא מרנדרת או משנה תמונה.

**הגבולות הכנים (PLAN §3.2 / §3.3) — זה מה שהמוצר חייב להגיד:**
- ל‑**Teams** **אין API לרקעים**. אנחנו מייבאים את הספרייה מ‑Graph ונותנים למנהל סקריפט Intune/Jamf (ובהמשך את ה‑agent) שמפיל
  `<GUID>.png` + `<GUID>_thumb.png` לתיקיית הגלריה של Teams החדש אצל כל עובד. העובד סוגר ופותח את Teams ובוחר את האריח **פעם אחת**; מאז זה נשאר
  על אותו מכשיר. תנאים מקדימים: מדיניות `VideoFiltersMode = AllFilters`, בלי מדיניות "רקע נדרש" של Premium. רק מדיניות של **Teams Premium**
  ("Set as required") יכולה לכפות — וההעלאה שלה לא ניתנת לסקריפט.
- ל‑**Google Meet** **אין API לרקעים והוא לא זוכר בחירה**. אנחנו מייבאים את הספרייה מ‑Admin SDK ונותנים JPEG + runbook לקונסולת הניהול (עד 15 ל‑OU,
  מ‑Drive, עד 24 שעות); העובדים בוחרים מחדש בכל דפדפן/מכשיר. רק תוסף Chrome של MeetingBrand בהתקנה כפויה (בהמשך) מחיל אוטומטית.

## 2. רישום האפליקציה ב‑Entra (בעלים — צריך חשבון עבודה של Microsoft עם Global Admin / Application Admin בדייר של meetingbrand.com)

1. https://entra.microsoft.com ← **Identity ▸ Applications ▸ App registrations ▸ New registration**.
2. **Name**: `MeetingBrand`.
3. **Supported account types**: **Accounts in any organizational directory (Multitenant)**. חשבונות אישיים: לא צריך.
4. **Redirect URI**: פלטפורמה **Web**, הערך (בדיוק, שורה אחת):
   `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-ms/callback`
5. Register ← להעתיק את **Application (client) ID** ← זה `MS_CLIENT_ID`.
6. **Certificates & secrets ▸ Client secrets ▸ New client secret** (תיאור `mb-edge`, תוקף 24 חודשים) ← להעתיק את ה‑**Value** מיד (מוצג פעם אחת)
   ← זה `MS_CLIENT_SECRET`. לרשום ביומן את תאריך התפוגה.
7. **API permissions ▸ Add a permission ▸ Microsoft Graph ▸ Application permissions** ← לסמן **`User.Read.All`** ← Add.
   **לא** ללחוץ "Grant admin consent" לדייר שלנו — הלקוחות מאשרים לדייר שלהם דרך האפליקציה.
8. **Branding & properties**: שם `MeetingBrand`, לוגו (סמל הקיט, PNG ‏215×215), דף בית `https://meetingbrand.com/`,
   תנאים `https://meetingbrand.com/terms/`, פרטיות `https://meetingbrand.com/privacy/`, **Publisher domain** = `meetingbrand.com`
   (האימות מבקש לארח `https://meetingbrand.com/.well-known/microsoft-identity-association.json` עם מזהה הדייר — נוסיף לאתר כשתבקש).
9. בהמשך, לא חוסם: **publisher verification** (Partner Center / MPN ID) מסיר את אזהרת "unverified" ממסך ההסכמה.

## 3. רישום לקוח OAuth ב‑Google Cloud (בעלים — עם חשבון Google שמחזיק ב‑Workspace / בפרויקט Cloud של meetingbrand.com)

1. https://console.cloud.google.com ← פרויקט **`meetingbrand`** ← **APIs & Services ▸ Library** ← להפעיל **Admin SDK API**.
2. **OAuth consent screen**: סוג משתמש **External**; שם `MeetingBrand`; אימייל תמיכה; לוגו; דומיין `meetingbrand.com` (מאומת ב‑Search Console
   באותו חשבון); קישורי בית/פרטיות/תנאים. **Scopes**: `openid`, `userinfo.email`, ו‑**`https://www.googleapis.com/auth/admin.directory.user.readonly`**
   (סקופ "sensitive"). **Test users**: להוסיף את חשבון(ות) המנהל שלך — במצב **Testing** רק הם יכולים לאשר, וה‑refresh token שלהם פג אחרי **7 ימים**.
   **Publish app** ← "In production" ← אימות של Google (3–5 ימי עסקים; צריך מדיניות פרטיות על הדומיין המאומת, הצדקה לסקופ — "קורא את ספריית
   החברה כדי להראות למנהל מי מקבל רקע ממותג" — וסרטון YouTube לא רשום של זרימת ההסכמה). עד האימות: מסך אזהרה ותקרה של **100 משתמשים**.
3. **Credentials ▸ Create credentials ▸ OAuth client ID**: סוג **Web application**, שם `MeetingBrand backend`,
   **Authorized redirect URIs** (בדיוק): `https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-google/callback`
   ← Create ← להעתיק **Client ID** (`GOOGLE_CLIENT_ID`) ו‑**Client secret** (`GOOGLE_CLIENT_SECRET`).

החשבון של הלקוח שמאשר חייב להחזיק בהרשאת המנהל **Users › Read** ב‑Workspace, אחרת הסנכרון מחזיר `409 google_blocked`.

## 4. איפה שמים את ארבעת הערכים (בעלים) ואיך הם נקבעים (המתזמר)

שני קבצים **מקומיים**, אף פעם לא ב‑git ולא בתוך הריפו:

```bash
mkdir -p ~/.config/meetingbrand
cat > ~/.config/meetingbrand/ms.env <<'EOF'
MS_CLIENT_ID=…להדביק…
MS_CLIENT_SECRET=…להדביק…
EOF
cat > ~/.config/meetingbrand/google.env <<'EOF'
GOOGLE_CLIENT_ID=…להדביק…
GOOGLE_CLIENT_SECRET=…להדביק…
EOF
chmod 600 ~/.config/meetingbrand/ms.env ~/.config/meetingbrand/google.env
```

המתזמר מריץ `npx -y supabase@2 secrets set --env-file …` לכל קובץ (הערכים לא מודפסים לעולם); `MB_TOKEN_KEY` ו‑`MB_APP_URL` כבר קיימים.
אין צורך בפריסה מחדש — `mb-integrations GET` יחזיר `configured:true` בקריאה הבאה.
