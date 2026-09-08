#!/usr/bin/env python3
"""MeetingBrand marketing site generator — static HTML, no build step, GitHub Pages. Run: python3 gen-site.py
Brand: the complete kit (brand-final-v3): Deep Ink #031436 · Signal Violet #5739FB · Pulse Cyan #00BDDF · Cloud · Slate · Mist · Inter.
Copy: 04-messaging/website-copy.md + messaging-framework.md (Zoho Meeting added: the product supports it)."""
import os, datetime
INK="#031436"; VIO="#5739FB"; VIOH="#4528E8"; CYAN="#00BDDF"; CLOUD="#F5F7FB"; SLATE="#667085"; MIST="#DDE3EE"; WHITE="#FFFFFF"
DOMAIN="meetingbrand.com"; SITE="https://meetingbrand.com"; SUPPORT="support@meetingbrand.com"; APP="/app/"
TODAY=datetime.date(2026,9,8).strftime("%B %-d, %Y")
LOGO=f'<a class="logo" href="/" aria-label="MeetingBrand home"><img src="/assets/logo.png" alt="MeetingBrand" width="170" height="33"></a>'
LOGO_REV=f'<a class="logo" href="/" aria-label="MeetingBrand home"><img src="/assets/logo-reversed.png" alt="MeetingBrand" width="170" height="35"></a>'
PLATFORMS="Zoom, Microsoft Teams, Google Meet and Zoho Meeting"
def layout(title, desc, body, path="/", extra_head=""):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{SITE}{path}">
<meta property="og:type" content="website"><meta property="og:site_name" content="MeetingBrand"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}"><meta property="og:url" content="{SITE}{path}"><meta property="og:image" content="{SITE}/assets/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.ico" sizes="any"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/apple-touch-icon-180.png">
<meta name="theme-color" content="{INK}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/styles.css">
{extra_head}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap nav">{LOGO}<nav aria-label="Main"><a href="/#how">How it works</a><a href="/#platforms">Platforms</a><a href="/docs/">Docs</a><a href="/support/">Support</a><a class="btn" href="{APP}">Create your brand set</a></nav></div></header>
<main id="main">
{body}
</main>
<footer class="foot"><div class="wrap"><div class="fgrid"><div>{LOGO_REV}<p class="tag">Every meeting. On brand.</p></div><div><h4>Product</h4><a href="/#how">How it works</a><a href="/#platforms">Platforms</a><a href="{APP}">Create your brand set</a><a href="/docs/">Documentation</a></div><div><h4>Company</h4><a href="/support/">Support</a><a href="/privacy/">Privacy policy</a><a href="/terms/">Terms of service</a></div><div><h4>Contact</h4><a href="mailto:{SUPPORT}">{SUPPORT}</a><p class="muted small">Sister products: <a href="https://company-card.com">company-card.com</a> · <a href="https://prosignature.co">prosignature.co</a></p></div></div><p class="muted small">© 2026 MeetingBrand. Zoom is a trademark of Zoom Video Communications, Inc.; Microsoft Teams of Microsoft Corporation; Google Meet of Google LLC; Zoho Meeting of Zoho Corporation. MeetingBrand is not affiliated with or endorsed by them.</p></div></footer>
</body>
</html>
'''
LD=f'''<script type="application/ld+json">{{"@context":"https://schema.org","@graph":[
{{"@type":"Organization","@id":"{SITE}/#org","name":"MeetingBrand","url":"{SITE}/","logo":"{SITE}/assets/logo.png","email":"{SUPPORT}","slogan":"Every meeting. On brand."}},
{{"@type":"WebSite","@id":"{SITE}/#site","url":"{SITE}/","name":"MeetingBrand","publisher":{{"@id":"{SITE}/#org"}}}},
{{"@type":"SoftwareApplication","name":"MeetingBrand","applicationCategory":"BusinessApplication","operatingSystem":"Web","url":"{SITE}/","description":"Branded virtual backgrounds, created from your company website and deployed to every employee across Zoom, Microsoft Teams, Google Meet and Zoho Meeting.","offers":{{"@type":"Offer","price":"0","priceCurrency":"USD","description":"Free during early access"}},"publisher":{{"@id":"{SITE}/#org"}}}}
]}}</script>'''
# ---------- home
home=f'''
<section class="hero"><div class="wrap herogrid">
  <div>
  <p class="eyebrow">Branded virtual backgrounds at company scale</p>
  <h1>Every meeting.<br>On brand.</h1>
  <p class="lead">MeetingBrand creates realistic virtual backgrounds from your company website and deploys approved options across {PLATFORMS} — automatically.</p>
  <div class="cta"><a class="btn big" href="{APP}">Create your brand set</a><a class="btn ghost big" href="#how">See how it works</a></div>
  <p class="trust">No design work. No employee-by-employee setup. No off-brand calls.</p>
  </div>
  <div class="heroart" aria-hidden="true"><img src="/assets/scene-walnut-brass-logo.jpg" alt="" width="820" height="461"><span class="namebar"><b>Dana Levi</b><span>Head of Sales · Your company</span></span></div>
</div></section>

<section class="band"><div class="wrap">
  <div class="three">
    <div class="feature"><h2>Paste your domain. Get your brand.</h2><p>MeetingBrand identifies your logo, colors and visual style, then turns them into a ready-to-use background collection — with a personal name bar for every employee.</p></div>
    <div class="feature"><h2>Real backgrounds, not branded wallpaper.</h2><p>Your logo belongs in the space. It should not float over it. MeetingBrand creates natural-looking environments — brass, backlit letters, LED, oak, concrete — that feel credible on camera.</p></div>
    <div class="feature"><h2>Roll out once. Stay consistent everywhere.</h2><p>Publish approved backgrounds centrally and update the whole organization without sending files or setup instructions. Titles change? The name bar updates everywhere.</p></div>
  </div>
  <div class="scenes">
    <figure><img src="/assets/scene-cornerloft-illuminated.jpg" alt="Illuminated company letters on a concrete loft wall — a MeetingBrand background" width="820" height="461" loading="lazy"><figcaption>Illuminated letters · concrete loft</figcaption></figure>
    <figure><img src="/assets/scene-walnut-led.jpg" alt="LED company sign on a walnut wall — a MeetingBrand background" width="820" height="461" loading="lazy"><figcaption>LED sign · walnut wall</figcaption></figure>
    <figure><img src="/assets/scene-walnut-brass-logo.jpg" alt="Brass company mark on a walnut wall — a MeetingBrand background" width="820" height="461" loading="lazy"><figcaption>Brass mark · walnut wall</figcaption></figure>
  </div>
</div></section>

<section id="how" class="band alt"><div class="wrap">
  <h2>How it works</h2>
  <p class="lead narrow">From domain to rollout in minutes.</p>
  <div class="steps">
    <div class="step"><span class="n">1</span><h3>Connect your brand</h3><p>Type your domain. MeetingBrand pulls the logo and colors and mounts your sign on real office scenes — brushed metal, brass, oak, backlit, LED and more.</p></div>
    <div class="step"><span class="n">2</span><h3>Pick the looks</h3><p>Choose the scenes and sign treatments for the company, a department or a campaign. Add a name bar with each person's name and title.</p></div>
    <div class="step"><span class="n">3</span><h3>Connect your platform</h3><p>An admin signs in to Zoom, Microsoft 365, Google Workspace or Zoho once. MeetingBrand reads your directory — no employee has to sign up for anything.</p></div>
    <div class="step"><span class="n">4</span><h3>Deploy to everyone</h3><p>Mark who is active, per person or per department. Each employee's personal background lands in their own meeting app, and the panel shows who is on brand.</p></div>
  </div>
</div></section>

<section id="platforms" class="band"><div class="wrap">
  <h2>What "delivered" means on each platform</h2>
  <p class="lead narrow">No meeting platform lets a third party switch a person's active background by API — so we tell you exactly what happens where.</p>
  <div class="cards">
    <div class="card"><h3>Zoom</h3><p>Uploaded straight into each employee's own background library through Zoom's API. They pick it once and it stays; admins can require a branded background for the whole account.</p></div>
    <div class="card"><h3>Microsoft Teams</h3><p>Placed in the Teams background gallery on Windows and Mac through your IT tools (Intune, Jamf) or our lightweight agent. Teams Premium tenants can set it as the required background.</p></div>
    <div class="card"><h3>Google Meet</h3><p>Published to the Meet gallery for every department from the Admin console, plus a Chrome extension that applies the background automatically for managed browsers.</p></div>
    <div class="card"><h3>Zoho Meeting</h3><p>Every employee gets a personal link with their background and one-click instructions; the panel tracks who has set it up.</p></div>
  </div>
</div></section>

<section class="band alt"><div class="wrap two">
  <div><h2>Built for every customer-facing team.</h2><p>Give Sales, Support, Recruiting, Leadership and distributed teams a consistent presence in every call. Marketing sets the look, IT approves the connection once, and every new hire is on brand from their first call.</p></div>
  <div><h2>Your data stays yours.</h2><p>We read names, emails and titles from your directory to personalise backgrounds, and nothing else. Disconnect a platform and we delete what we synced. Details in the <a href="/privacy/">privacy policy</a>.</p></div>
</div></section>

<section id="early-access" class="band dark"><div class="wrap narrow center">
  <h2>Update once. Refresh everywhere.</h2>
  <p class="lead">Try the brand-set builder now, or write to us and we will set your company up personally during early access.</p>
  <div class="cta center"><a class="btn big cyan" href="{APP}">Create your brand set</a><a class="btn ghost big onink" href="mailto:{SUPPORT}?subject=MeetingBrand%20early%20access&body=Company%3A%20%0AMeeting%20platform(s)%3A%20%0AEmployees%3A%20">Request early access</a></div>
  <p class="muted small">We reply personally within two business days. No newsletter, no spam.</p>
</div></section>
'''
thanks=f'''<section class="band"><div class="wrap narrow"><h1>Thanks — we got it.</h1><p class="lead">We will reply from {SUPPORT} within two business days. Meanwhile, the <a href="/docs/">documentation</a> shows what setup looks like on each platform.</p><a class="btn" href="/">Back to MeetingBrand</a></div></section>'''
# ---------- docs
docs=f'''
<section class="band"><div class="wrap prose">
<h1>Documentation</h1>
<p class="lead">How MeetingBrand connects to each platform, what your employees see, and how to remove it. Written for the admin who connects the platform and for IT.</p>

<h2 id="getting-started">Getting started</h2>
<ol>
<li><strong>Create your brand set</strong> — open <a href="{APP}">the builder</a>, enter your company domain; review the logo, colors, scenes and sign treatments; set the name bar fields (name, title, department, company). The builder runs in your browser; nothing is stored on our servers during early access.</li>
<li><strong>Connect a platform</strong> — Integrations → choose Zoom, Microsoft Teams, Google Meet or Zoho Meeting → sign in as an administrator and approve the permissions listed below. MeetingBrand then imports your people (name, email, title, department). Integrations are rolling out to early-access customers platform by platform; write to <a href="mailto:{SUPPORT}">{SUPPORT}</a> to be scheduled.</li>
<li><strong>Assign and deploy</strong> — mark people or departments as active, choose their looks, and deploy. The People panel shows each person's status: delivered, waiting for a restart, needs the employee's one click, or blocked (with the reason).</li>
</ol>

<h2 id="zoom">Zoom</h2>
<p><strong>Permissions requested</strong> (admin-managed app): list users; upload and delete virtual background files for users; read and update account settings related to virtual backgrounds. A Zoom account owner or admin authorizes once for the whole account; employees see no prompt.</p>
<p><strong>What happens</strong>: each active employee's branded background is uploaded into their own Zoom virtual-background library (Zoom allows up to 10 files per user; we manage ours). After the upload the employee signs out and back in to Zoom, opens Settings → Video &amp; effects → Virtual backgrounds and picks the branded image once — Zoom remembers it. Admins can additionally turn on "Require users to always use virtual background" and disable personal uploads so the branded image is the only non-stock choice.</p>
<p><strong>Removing MeetingBrand</strong>: Zoom App Marketplace → Manage → Added Apps → MeetingBrand → Remove. MeetingBrand deletes the background files it uploaded and the directory data it synced for that account within 30 days (immediately on request to {SUPPORT}).</p>

<h2 id="teams">Microsoft Teams</h2>
<p><strong>Permissions requested</strong> (Microsoft Entra ID, multitenant): <em>User.Read.All</em> (application) to read your directory — names, emails, job titles, departments — plus sign-in for the admin. A tenant administrator grants consent once; employees see no prompt.</p>
<p><strong>What happens</strong>: Teams has no API for meeting backgrounds, so delivery goes to the employee's device. Choose one: (a) <strong>IT scripts</strong> — MeetingBrand generates an Intune platform script (Windows) and a shell script (macOS/Jamf) that place the person's background in the new-Teams gallery folder; (b) the <strong>MeetingBrand agent</strong>, a small signed helper installed from the employee's personal link. After Teams restarts, the branded image appears under Effects and avatars → Backgrounds; the employee selects it once and Teams keeps it. Tenants with <strong>Teams Premium</strong> can instead upload our images in the Teams admin center and set them as required per department — we generate the images and the policy assignment script.</p>
<p><strong>Removing MeetingBrand</strong>: Entra admin center → Enterprise applications → MeetingBrand → Delete (revokes our access). Delete the gallery files with the uninstall script we provide, or remove the agent from Add/Remove programs (Windows) or the Applications folder (macOS).</p>

<h2 id="meet">Google Meet</h2>
<p><strong>Permissions requested</strong>: <em>View users on your domain</em> (Admin SDK Directory, read-only) to import names, emails, titles and departments. A Google Workspace administrator with the Users › Read privilege authorizes once.</p>
<p><strong>What happens</strong>: Meet has no API for backgrounds. MeetingBrand produces the JPEG images (Meet's required format, 1920×1080) and a step-by-step runbook for the Admin console (Apps → Google Workspace → Google Meet → Meet video settings → Visual effects → custom images per organizational unit, up to 15). Employees then find the images in their Backgrounds panel. For managed Chrome browsers, the MeetingBrand Chrome extension (force-installed from the Admin console) applies the person's background automatically.</p>
<p><strong>Removing MeetingBrand</strong>: Google Admin → Security → API controls → Manage third-party app access → MeetingBrand → Remove; remove the custom images from Meet video settings; remove the extension from the Chrome force-install list.</p>

<h2 id="zoho">Zoho Meeting</h2>
<p><strong>Permissions requested</strong>: ZohoMeeting.manageOrg.READ, ZohoMeeting.user.READ, ZohoMeeting.department.READ — to identify the organization and import its members. A Zoho Meeting organization admin authorizes once.</p>
<p><strong>What happens</strong>: Zoho Meeting has no API or admin control for virtual backgrounds, so each employee receives a personal link and email with their background and four steps: turn on Virtual Background under Settings → My Settings, open the join page, choose "Select your background", upload the image and pick it. Zoho then uses it for all future meetings. Custom backgrounds are available on Zoho Meeting Standard and Professional editions.</p>
<p><strong>Removing MeetingBrand</strong>: Zoho Accounts → Security → Connected apps → MeetingBrand → Revoke. Employees can delete the image from their own background list.</p>

<h2 id="data">Data and security</h2>
<ul>
<li>We store: admin account details, the directory fields above, the OAuth tokens needed to keep your connection alive (encrypted at rest), your brand assets and the rendered background images.</li>
<li>We never read meeting content, recordings, chats or calendars.</li>
<li>Disconnecting a platform deletes its synced data; you can request full deletion at any time at <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</li>
<li>Full details: <a href="/privacy/">Privacy policy</a> · <a href="/terms/">Terms of service</a>.</li>
</ul>
</div></section>'''
# ---------- privacy
privacy=f'''
<section class="band"><div class="wrap prose">
<h1>Privacy policy</h1>
<p class="muted">Effective {TODAY}. This policy explains how MeetingBrand ("MeetingBrand", "we", "us") collects, uses and protects information.</p>
<h2>1. What MeetingBrand does</h2>
<p>MeetingBrand is a business service that creates branded virtual-meeting backgrounds and name bars for a company and delivers them to that company's employees' meeting applications (Zoom, Microsoft Teams, Google Meet, Zoho Meeting). Our customers are companies; the people whose data we process are their administrators and employees.</p>
<h2>2. Data we collect</h2>
<ul>
<li><strong>Brand-set builder</strong> — the builder at {SITE}{APP} runs in your browser. The domain you type is used to fetch that company's public logo and colors; the images you create are rendered on your device and are not uploaded to us during early access.</li>
<li><strong>Account data</strong> — the administrator's name, work email and company, given when requesting access or signing up.</li>
<li><strong>Directory data</strong> — when an administrator connects a platform, we import employees' display names, email addresses, job titles, departments and platform user identifiers, using the permissions shown on the platform's consent screen.</li>
<li><strong>Connection data</strong> — the OAuth tokens the platforms issue so the connection keeps working. They are encrypted at rest and never shown to anyone.</li>
<li><strong>Brand and image data</strong> — logos, colors, scenes and the background images we render for each person.</li>
<li><strong>Delivery records</strong> — which image was delivered to which person, when, and the result, so administrators can see who is on brand.</li>
<li><strong>Technical data</strong> — standard server logs (IP address, browser, timestamps) kept for security and up to 90 days. This website is hosted on GitHub Pages, which logs requests under <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub's privacy statement</a>; fonts are loaded from Google Fonts.</li>
</ul>
<p>We do not read meeting audio, video, recordings, chat messages, calendars or files.</p>
<h2>3. How we use it</h2>
<p>To render personalised backgrounds, deliver them to employees' meeting applications, show administrators delivery status, keep the platform connection alive, provide support, and secure the service. We do not sell personal data and we do not use it for advertising.</p>
<h2>4. Google API Services</h2>
<p>MeetingBrand's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. We use Google Workspace directory data only to import your organization's people into MeetingBrand for the purpose of personalising and delivering backgrounds; we do not transfer it to third parties except as needed to provide the service, do not use it for advertising, and do not allow humans to read it except with your permission, for security, or to comply with law.</p>
<h2>5. Sharing</h2>
<p>We share data only with the meeting platforms you connect (Zoom Video Communications, Microsoft, Google, Zoho — to deliver backgrounds and read your directory as authorized) and with our infrastructure providers under data-processing terms (website hosting: GitHub; application database and file storage: Supabase). We disclose data when the law requires it.</p>
<h2>6. Retention and deletion</h2>
<p>Directory and delivery data are kept while the platform connection is active. Disconnecting a platform deletes the data synced from it within 30 days; deleting your MeetingBrand account deletes everything within 30 days. Any administrator or employee can ask us to access, correct or delete their data at <a href="mailto:{SUPPORT}">{SUPPORT}</a>; we answer within 30 days.</p>
<h2>7. Security</h2>
<p>Data is encrypted in transit (TLS 1.2+) and at rest; OAuth tokens are stored encrypted with keys separate from the database; access is limited to staff who need it to operate the service; we log administrative access.</p>
<h2>8. International transfers</h2>
<p>Our providers process data in the EU and the United States under standard contractual clauses or equivalent safeguards.</p>
<h2>9. Children</h2>
<p>MeetingBrand is a business service and is not directed to anyone under 16.</p>
<h2>10. Changes</h2>
<p>We will post changes on this page and update the effective date; material changes are announced to administrators by email.</p>
<h2>11. Contact</h2>
<p><a href="mailto:{SUPPORT}">{SUPPORT}</a></p>
</div></section>'''
# ---------- terms
terms=f'''
<section class="band"><div class="wrap prose">
<h1>Terms of service</h1>
<p class="muted">Effective {TODAY}. These terms are an agreement between MeetingBrand ("MeetingBrand", "we") and the organization that uses the service ("you").</p>
<h2>1. The service</h2><p>MeetingBrand creates branded virtual-meeting backgrounds and name bars and delivers them to your employees' meeting applications through integrations you authorize. Delivery depends on each platform's capabilities, which we describe in the <a href="/docs/">documentation</a>; where a platform requires an action by the employee, we say so. The brand-set builder is provided as an early-access preview and may change.</p>
<h2>2. Your account and authorizations</h2><p>You confirm that the person connecting a platform is authorized to grant MeetingBrand the permissions shown on that platform's consent screen and to have us process your employees' directory data as described in the <a href="/privacy/">privacy policy</a>. You are responsible for keeping your credentials secure.</p>
<h2>3. Your content</h2><p>You own your logos, brand assets and the backgrounds we render from them. You grant us the rights needed to render, store and deliver them for you. You confirm you have the rights to the logos and images you use.</p>
<h2>4. Acceptable use</h2><p>Do not use the service to deliver content that is unlawful, infringing, deceptive or harassing; do not attempt to access other customers' data; do not resell the service without our written agreement.</p>
<h2>5. Fees</h2><p>Early-access accounts are free during the early-access period. Paid plans, their prices and billing terms will be published on this site before they apply to you; we will not charge you without your agreement.</p>
<h2>6. Third-party platforms</h2><p>Zoom, Microsoft Teams, Google Meet and Zoho Meeting are provided by their owners under their own terms. We are not responsible for changes they make to their products or APIs, and we may adjust or suspend an integration when a platform change requires it.</p>
<h2>7. Availability and support</h2><p>We aim for the service to be available at all times but do not guarantee it. Support is provided by email at <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</p>
<h2>8. Termination</h2><p>You may stop using the service and disconnect your platforms at any time; we then delete your data as described in the privacy policy. We may suspend or end accounts that breach these terms.</p>
<h2>9. Warranties and liability</h2><p>The service is provided "as is". To the extent permitted by law we exclude implied warranties, and our total liability for any claim is limited to the fees you paid us in the twelve months before the claim (or 100 USD if you paid none). Nothing limits liability that cannot be limited by law.</p>
<h2>10. Changes</h2><p>We may update these terms; we will post the new version here and notify administrators of material changes by email.</p>
<h2>11. Contact</h2><p><a href="mailto:{SUPPORT}">{SUPPORT}</a></p>
</div></section>'''
support=f'''
<section class="band"><div class="wrap prose">
<h1>Support</h1>
<p class="lead">Email <a href="mailto:{SUPPORT}">{SUPPORT}</a>. We answer within two business days; connection or delivery problems that block a rollout are answered the same business day.</p>
<h2>Before you write</h2>
<ul><li>The <a href="/docs/">documentation</a> explains what each platform can and cannot do, and how to remove MeetingBrand.</li><li>For a delivery problem, tell us the platform, the employee's status shown in the People panel, and whether the employee has restarted their meeting app.</li><li>For data requests (access, correction, deletion), write from the email address on the account or ask your administrator to.</li></ul>
<h2>Installing and removing</h2>
<p>Every integration can be removed from the platform's own admin console; step-by-step instructions are in the documentation for <a href="/docs/#zoom">Zoom</a>, <a href="/docs/#teams">Microsoft Teams</a>, <a href="/docs/#meet">Google Meet</a> and <a href="/docs/#zoho">Zoho Meeting</a>.</p>
</div></section>'''
notfound=f'''<section class="band"><div class="wrap narrow"><h1>Page not found</h1><p class="lead">The page may have moved. Start again from the <a href="/">home page</a>, the <a href="/docs/">documentation</a> or the <a href="{APP}">brand-set builder</a>.</p></div></section>'''
pages={
 "index.html":("MeetingBrand | Branded Virtual Backgrounds for Teams","Create realistic branded virtual backgrounds from your company website and deploy approved options across Zoom, Microsoft Teams, Google Meet and Zoho Meeting.",home,"/",LD),
 "thanks/index.html":("Thanks — MeetingBrand","We received your early-access request.",thanks,"/thanks/",""),
 "docs/index.html":("Documentation — MeetingBrand","How MeetingBrand connects to Zoom, Microsoft Teams, Google Meet and Zoho Meeting, what employees see, and how to remove it.",docs,"/docs/",""),
 "privacy/index.html":("Privacy policy — MeetingBrand","How MeetingBrand collects, uses, stores and deletes data from connected meeting platforms.",privacy,"/privacy/",""),
 "terms/index.html":("Terms of service — MeetingBrand","The agreement for using MeetingBrand.",terms,"/terms/",""),
 "support/index.html":("Support — MeetingBrand","How to reach MeetingBrand support and how to install or remove the integrations.",support,"/support/",""),
 "404.html":("Page not found — MeetingBrand","The page may have moved.",notfound,"/404.html",'<meta name="robots" content="noindex">'),
}
import re
def relativize(html, path):
    """Root-relative links -> relative, so the site works both at meetingbrand.com/ and under a GitHub project path."""
    pre = "../" * path.count("/")
    html = re.sub(r'(href|src)="/(?=[^/])', lambda m: f'{m.group(1)}="{pre}', html)   # "/assets/x" -> "assets/x" or "../assets/x"
    html = html.replace('href="/"', f'href="{pre or "./"}"')                           # home link
    return html
for path,(t,d,b,p,x) in pages.items():
    os.makedirs(os.path.dirname(path) or ".",exist_ok=True)
    open(path,"w",encoding="utf-8").write(relativize(layout(t,d,b,p,x), path))
css=f'''
:root{{--ink:{INK};--vio:{VIO};--vio-h:{VIOH};--cyan:{CYAN};--cloud:{CLOUD};--slate:{SLATE};--mist:{MIST};--white:{WHITE}}}
*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}
body{{margin:0;font-family:'Inter',Arial,Helvetica,sans-serif;color:var(--ink);background:var(--white);line-height:1.6;font-size:17px}}
h1,h2,h3{{color:var(--ink);letter-spacing:-0.02em;line-height:1.12;margin:0 0 .5em}}
h1{{font-size:clamp(40px,5.6vw,64px);font-weight:800;line-height:1.06}}h2{{font-size:clamp(26px,3.2vw,36px);font-weight:700}}h3{{font-size:22px;font-weight:700}}
p{{margin:0 0 1em}}a{{color:var(--vio)}}a:hover{{color:var(--vio-h)}}
:focus-visible{{outline:3px solid var(--cyan);outline-offset:3px}}
.skip{{position:absolute;left:-9999px;top:8px;background:var(--ink);color:#fff;padding:8px 12px;border-radius:8px;z-index:20}}.skip:focus{{left:8px}}
.wrap{{max-width:1160px;margin:0 auto;padding:0 24px}}.narrow{{max-width:760px}}.center{{text-align:center;margin-left:auto;margin-right:auto}}.lead{{font-size:20px;color:var(--ink);line-height:1.55}}.lead.narrow{{max-width:760px}}
.muted{{color:var(--slate)}}.small{{font-size:14px}}.eyebrow{{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--vio);font-weight:700;margin-bottom:18px}}
.top{{position:sticky;top:0;background:rgba(255,255,255,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--mist);z-index:10}}
.nav{{display:flex;align-items:center;justify-content:space-between;height:72px;gap:24px}}.nav nav{{display:flex;align-items:center;gap:24px;flex-wrap:wrap}}.nav nav a{{color:var(--ink);text-decoration:none;font-weight:500}}.nav nav a:hover{{color:var(--vio)}}
.logo{{display:inline-flex;align-items:center;line-height:0}}.logo img{{width:170px;height:auto;display:block}}
.btn{{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--vio);color:#fff!important;text-decoration:none!important;padding:11px 20px;border-radius:16px;font-weight:700;border:1px solid var(--vio);cursor:pointer;font-family:inherit;font-size:16px;transition:background-color 160ms ease,transform 160ms ease}}.btn:hover{{background:var(--vio-h);border-color:var(--vio-h)}}.btn.big{{padding:16px 26px;font-size:17px}}
.btn.ghost{{background:transparent;color:var(--ink)!important;border-color:var(--mist)}}.btn.ghost:hover{{background:var(--cloud);border-color:var(--slate)}}
.btn.cyan{{background:var(--cyan);border-color:var(--cyan);color:var(--ink)!important}}.btn.cyan:hover{{background:#22CBE9;border-color:#22CBE9}}
.btn.onink{{color:#fff!important;border-color:rgba(255,255,255,.35)}}.btn.onink:hover{{background:rgba(255,255,255,.08);border-color:#fff}}
.hero{{padding:88px 0 72px;background:linear-gradient(180deg,#fff 0%,var(--cloud) 100%)}}.herogrid{{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:48px;align-items:center}}.hero .lead{{max-width:600px}}.cta{{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0 18px}}.cta.center{{justify-content:center}}.trust{{color:var(--slate);font-weight:500}}
.heroart{{position:relative;border-radius:24px;overflow:hidden;box-shadow:0 10px 30px rgba(3,20,54,.12);aspect-ratio:16/9;background:var(--ink)}}.heroart img{{width:100%;height:100%;object-fit:cover;display:block}}
.namebar{{position:absolute;left:20px;bottom:20px;background:#fff;color:var(--ink);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 24px rgba(3,20,54,.18);font-size:14px;line-height:1.25}}.namebar b{{font-weight:700;font-size:15px}}.namebar span{{color:var(--slate);font-size:12.5px}}
.band{{padding:80px 0}}.band.alt{{background:var(--cloud)}}.band.dark{{background:var(--ink);color:#fff}}.band.dark h2,.band.dark .lead{{color:#fff}}.band.dark .muted{{color:#B7C0D0}}
.three{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px}}.feature h2{{font-size:24px}}.feature p{{color:var(--slate);margin:0}}
.scenes{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:48px}}.scenes figure{{margin:0}}.scenes img{{width:100%;height:auto;display:block;border-radius:16px;border:1px solid var(--mist)}}.scenes figcaption{{font-size:13px;color:var(--slate);margin-top:8px;letter-spacing:.04em;text-transform:uppercase;font-weight:600}}
.steps{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin-top:32px}}.step{{background:#fff;border:1px solid var(--mist);border-radius:24px;padding:26px;box-shadow:0 10px 30px rgba(3,20,54,.06)}}.step .n{{display:inline-flex;width:34px;height:34px;border-radius:10px;background:var(--cyan);color:var(--ink);font-weight:800;align-items:center;justify-content:center;margin-bottom:14px}}.step h3{{font-size:19px}}.step p{{margin:0;font-size:15.5px;color:var(--slate)}}
.cards{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:32px}}.card{{background:var(--cloud);border-radius:24px;padding:30px}}.card p{{margin:0;font-size:16px;color:var(--slate)}}.card h3{{color:var(--vio)}}
.two{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px}}.two p{{color:var(--slate)}}
.prose{{max-width:820px}}.prose h1{{font-size:clamp(34px,4.5vw,48px)}}.prose h2{{font-size:24px;margin-top:40px}}.prose ul,.prose ol{{padding-left:22px}}.prose li{{margin-bottom:8px}}.prose p,.prose li{{color:#2B3A55}}
.foot{{background:var(--ink);color:#C5CCDB;padding:56px 0 36px;margin-top:40px}}.foot a{{color:#fff;text-decoration:none;display:block;margin-bottom:8px}}.foot a:hover{{color:var(--cyan)}}.foot .logo{{margin-bottom:14px}}.foot .tag{{color:#C5CCDB;font-weight:600}}.foot h4{{margin:0 0 12px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8A96A5}}.fgrid{{display:grid;grid-template-columns:2fr 1fr 1fr 1.4fr;gap:32px;margin-bottom:32px}}.foot .muted{{color:#8A96A5}}.foot .muted a{{display:inline;color:#C5CCDB}}
@media(max-width:900px){{.herogrid,.three,.scenes,.steps,.cards,.two,.fgrid{{grid-template-columns:1fr}}.nav nav a:not(.btn){{display:none}}.nav nav .btn{{white-space:nowrap;padding:9px 14px;font-size:14px}}.hero{{padding:56px 0 40px}}.band{{padding:56px 0}}.logo img{{width:140px}}}}
'''
open("styles.css","w").write(css)
open("robots.txt","w").write(f"User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n")
urls=["/","/docs/","/privacy/","/terms/","/support/"]
open("sitemap.xml","w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+"".join(f"<url><loc>{SITE}{u}</loc><lastmod>2026-09-08</lastmod></url>" for u in urls)+"</urlset>\n")
open("CNAME","w").write(DOMAIN+"\n")
open(".nojekyll","w").write("")
print("site generated:", sorted(p for p in pages))
