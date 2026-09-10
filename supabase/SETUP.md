# MeetingBrand — Supabase setup / הקמת Supabase

The SQL files in this folder are the **only** source of truth for the MeetingBrand database. Everything that live code touches is defined here (the CompanyCard lesson: its `events` table and `funnel_stats` were created by hand in the SQL editor and never committed).

הקבצים בתיקייה הזו הם **מקור האמת היחיד** לבסיס הנתונים של MeetingBrand. כל אובייקט שהקוד החי נוגע בו מוגדר כאן (הלקח מ‑CompanyCard: טבלת `events` ו‑`funnel_stats` נוצרו ידנית ב‑SQL editor ומעולם לא נשמרו ב‑git).

| File | Apply? | What |
|---|---|---|
| `001-core.sql` | yes, first | orgs, profiles, invites, free_mail_domains, `my_org/my_role`, signup trigger, `invite_info`, `set_org_domain`, `org_for_domain`, `join_org_by_domain`, column guards, RLS |
| `002-brand.sql` | yes | brands, brand_assets, backgrounds, `public_background(slug)`, storage buckets `brand-assets` / `exports` / `previews` + policies |
| `003-events.sql` | yes | events (insert-only, server-stamped id/created_at), `funnel_stats(p_days)` |
| `004-deletion.sql` | yes | `priv.owner_keys`, `delete_my_account`, `owner_list_accounts`, `owner_delete_account`, `owner_set_plan`, `signup_export(k)` (owner-key gated) |
| `005-integrations.sql` | **NO — phase 2** | integrations, `priv.integration_tokens`, employees, pushes. Apply only when the first Edge Function adapter ships |

---

## 1. Create the project / יצירת הפרויקט

**EN**
1. https://supabase.com/dashboard → organisation **companycard** (the same org that holds `prosignature` and `companycard`) → **New project**.
2. Name: `meetingbrand`. Region: **Central EU (Frankfurt)** = `eu-central-1` (same as CompanyCard). Plan: Free.
3. Database password: generate one in the dashboard and store it **only** in the secrets file on the desktop, next to the ProSignature entries — never in this repo, never in `mb-config.json`.
4. Wait for "Project is ready" (2-3 minutes).

**HE**
1. https://supabase.com/dashboard ← ארגון **companycard** (אותו ארגון של `prosignature` ו‑`companycard`) ← **New project**.
2. שם: `meetingbrand`. אזור: **Central EU (Frankfurt)** = `eu-central-1` (כמו CompanyCard). תוכנית: Free.
3. סיסמת DB: לייצר בדשבורד ולשמור **רק** בקובץ הסודות בדסקטופ, ליד רשומות ProSignature — לעולם לא בריפו ולא ב‑`mb-config.json`.
4. לחכות ל‑"Project is ready" (2-3 דקות).

## 2. Run the SQL / הרצת ה‑SQL

**EN** — Dashboard → **SQL Editor** → New query → paste the whole file → **Run**. In this order, one file per run, and read the result panel each time (a red line means stop and report, do not continue):

1. `001-core.sql`
2. `002-brand.sql`
3. `003-events.sql`
4. `004-deletion.sql`

Do **not** run `005-integrations.sql`. Every file is idempotent (`if not exists` / `drop … if exists`), so re-running after a fix is safe.

**HE** — דשבורד ← **SQL Editor** ← New query ← להדביק את כל הקובץ ← **Run**. לפי הסדר, קובץ אחד בכל הרצה, ולקרוא את חלון התוצאה בכל פעם (שורה אדומה = לעצור ולדווח, לא להמשיך):

1. `001-core.sql`
2. `002-brand.sql`
3. `003-events.sql`
4. `004-deletion.sql`

**לא** להריץ את `005-integrations.sql`. כל קובץ אידמפוטנטי, ולכן הרצה חוזרת אחרי תיקון בטוחה.

Quick check after 004 (SQL editor):
```sql
select count(*) from public.orgs;                 -- 0 rows, no error
select * from public.funnel_stats(7);             -- 0 rows, no error
select id, public, file_size_limit from storage.buckets where id in ('brand-assets','exports','previews');  -- 3 rows
```

## 3. Dashboard toggles (not SQL) / הגדרות בדשבורד (לא SQL)

**Authentication → Providers → Email**

| Setting | Value | Why |
|---|---|---|
| Enable Email provider | ON | |
| **Confirm email** | **OFF** | ProSignature decision (PROJECT.md:97); signup returns a session immediately, the brand machine runs right after `signUp`. Both sisters run this way. |
| **Secure email change** | **ON** (the default — do not switch it off) | the auth email domain is what `org_for_domain` / `join_org_by_domain` trust; an unconfirmed email change would let anyone become `x@acme.com` and walk into acme's open workspace |
| Minimum password length | 8 | matches the gate's `minlength` |
| **Allow anonymous sign-ins** (Authentication → Settings) | **OFF** (the default) | every `grant … to authenticated` in these files — owner RPCs, `org_for_domain`, storage writes — would otherwise also cover throwaway anonymous sessions |

**Authentication → Providers → Google**

| Setting | Value |
|---|---|
| Enable Sign in with Google | ON |
| Client ID | the **new** GCP web client (below) |
| Client Secret | from the same GCP client (dashboard only — never in the repo) |
| Skip nonce check | ON (required for Google Identity Services `signInWithIdToken`, the ProSignature path) |

**New Google Cloud OAuth client** (do not reuse the ProSignature client `58897157944-…`; it carries the restricted Gmail scope and sits in the CASA verification queue):
1. https://console.cloud.google.com → a project of your choice → APIs & Services → Credentials → **Create credentials → OAuth client ID → Web application**, name `MeetingBrand sign-in`.
2. Authorised JavaScript origins: `https://meetingbrand.com`, `https://porshianboti-star.github.io`, `http://localhost:8000` (dev).
3. Authorised redirect URIs: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`.
4. OAuth consent screen: scopes **openid, email, profile only** — nothing sensitive or restricted, so it never enters the verification queue. Publish to "In production".
5. Copy the Client ID into `mb-config.json` (`googleClientId`) and into the Supabase Google provider; paste the Client Secret into the Supabase provider only.

**Authentication → URL Configuration**: Site URL `https://meetingbrand.com/app/`; Redirect URLs add `https://meetingbrand.com/**` and `https://porshianboti-star.github.io/**`.

**Storage → buckets** — the three buckets are created by `002-brand.sql` with size limits (`brand-assets` 15 MB, `exports` 15 MB, `previews` 2 MB) and MIME allow-lists. Open Storage in the dashboard once to confirm they show up; also set the **global upload limit** (Settings → Storage) to 15 MB.

**HE — בקצרה:** Email provider דלוק, **Confirm email כבוי**; Google provider דלוק עם **לקוח GCP חדש** (openid/email/profile בלבד — לא לעשות שימוש חוזר בלקוח של ProSignature); Skip nonce check דלוק; Site URL = `https://meetingbrand.com/app/`; שלושת ה‑buckets נוצרים מה‑SQL עם מגבלות גודל — רק לוודא שהם מופיעים.

## 4. Wire the keys into the product / חיבור המפתחות למוצר

**EN** — Dashboard → Project Settings → **API**:
- **Project URL** → `supabaseUrl`
- **Publishable key** (`sb_publishable_…`; the legacy `anon` JWT also works) → `supabaseAnonKey`

Edit `/Users/motty/branded-background/engine/mb-config.json` (the **only** place these values live; every `build-vNN.py` and `gen-site.py` read it):

```json
{
  "supabaseUrl": "https://<PROJECT_REF>.supabase.co",
  "supabaseAnonKey": "sb_publishable_…",
  "googleClientId": "<client id>.apps.googleusercontent.com",
  "ga4Id": "G-…",
  "supabaseJs": "2.116.0",
  "product": "meetingbrand"
}
```

Then rebuild the next product version (`python3 build-vNN.py` → `./ship.sh …`) and regenerate the site (`python3 gen-site.py`) so `/app/`, `backoffice` and `analytics` pick the values up. Empty values = the product runs in OFFLINE/demo mode. **Never** put the service_role key, the DB password or the Google client secret in this file.

**HE** — Project Settings ← **API**: להעתיק **Project URL** ו‑**Publishable key** לתוך `/Users/motty/branded-background/engine/mb-config.json` (המקום היחיד שבו הערכים האלה חיים). אחר כך לבנות גרסת מוצר חדשה ולהריץ `gen-site.py`. ערכים ריקים = מצב OFFLINE/demo. **לעולם לא** לשים כאן service_role, סיסמת DB או client secret.

## 5. Owner key for the back office / מפתח בעלים למשרד האחורי

**EN** — The owner RPCs (`owner_list_accounts`, `owner_delete_account`, `owner_set_plan`, `signup_export`) check a key in `priv.owner_keys`. Insert it by hand, once, in the SQL editor — it is never committed:

```sql
insert into priv.owner_keys (key, label)
values ('mb-owner-' || encode(extensions.gen_random_bytes(18), 'hex'), 'motty')
returning key;
```

Copy the returned value into your password manager; paste it into the back office page when asked (it is kept in that browser's `localStorage` only). Unlike ProSignature these RPCs need a signed-in session — sign in to the app first, then open the back office.

**HE** — ה‑RPC של הבעלים בודקים מפתח בטבלה `priv.owner_keys`. להריץ את ה‑INSERT שלמעלה פעם אחת ב‑SQL editor, להעתיק את הערך למנהל הסיסמאות ולהדביק בדף המשרד האחורי כשנשאלים. בניגוד ל‑ProSignature, צריך להיות מחוברים לאפליקציה כדי שהקריאות יעבדו.

## 6. Keepalive / שמירה על ערות

**EN** — The free tier pauses a project after 7 idle days; ProSignature's DB slept 2026-08-21 and login was dead for four days. `.github/workflows/db-keepalive.yml` in this repo pings PostgREST daily with the publishable key (PLAN §5 item 6 — the ProSignature workflow with the `\\` line-continuation bug fixed and the new ref/key). After the project exists: GitHub → Actions → **DB keepalive** → *Run workflow* once and confirm the log says `REST answered HTTP 200` (or 401/404 — anything but 000).

**HE** — התוכנית החינמית משהה פרויקט אחרי 7 ימים ללא פעילות. ה‑workflow `db-keepalive.yml` שולח ping יומי. אחרי שהפרויקט קיים: GitHub ← Actions ← **DB keepalive** ← Run workflow, ולוודא בלוג `REST answered HTTP 200`.

## 7. Verify from outside / בדיקה מבחוץ

```sh
U=https://<PROJECT_REF>.supabase.co; K=sb_publishable_…
curl -s "$U/rest/v1/orgs?select=*"     -H "apikey: $K"        # → []
curl -s "$U/rest/v1/profiles?select=*" -H "apikey: $K"        # → []
curl -s "$U/rest/v1/events?select=*"   -H "apikey: $K"        # → []
curl -s -X POST "$U/rest/v1/events" -H "apikey: $K" -H "Content-Type: application/json" \
     -H "Prefer: return=minimal" -d '{"event":"qa_ping","session_id":"qa-setup"}' -w '%{http_code}\n'   # → 201
curl -s -X POST "$U/rest/v1/rpc/funnel_stats" -H "apikey: $K" -H "Content-Type: application/json" -d '{"p_days":7}'   # → [] (qa- rows are excluded)
curl -s -X POST "$U/rest/v1/rpc/owner_list_accounts" -H "apikey: $K" -H "Content-Type: application/json" -d '{"k":"x"}' -w '%{http_code}\n'  # → 401/403 (anon may not call it)
curl -s -X POST "$U/rest/v1/rpc/signup_export"       -H "apikey: $K" -H "Content-Type: application/json" -d '{"k":"x"}' -w '%{http_code}\n'  # → 401/403 (same: owner-key RPC, signed-in + key)
curl -s "$U/storage/v1/object/list/previews" -X POST -H "apikey: $K" -H "Content-Type: application/json" -d '{"prefix":"","limit":10}'   # → [] (no anonymous listing of previews)
```

## 8. What is deliberately NOT here / מה בכוונה לא כאן
- No service_role key anywhere (deletion and the back office are SECURITY DEFINER RPCs).
- No payment processor: `orgs.plan` changes only via `owner_set_plan` or a future Edge Function webhook (service role) — the client cannot self-grant Pro (the hole both sisters have).
- No invite emails: invite links are copied to the clipboard (CompanyCard flow).
- `005-integrations.sql` stays unapplied until phase 2.
