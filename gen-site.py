#!/usr/bin/env python3
"""MeetingBrand marketing site generator — static HTML, no build step, GitHub Pages. Run: python3 gen-site.py
Brand: the complete kit (brand-final-v3): Deep Ink #031436 · Signal Violet #5739FB · Pulse Cyan #00BDDF · Cloud · Slate · Mist · Inter.
Copy: 04-messaging/website-copy.md + messaging-framework.md (Zoho Meeting added: the product supports it)."""
import os, datetime, json, glob, re, shutil, hashlib
INK="#031436"; VIO="#5739FB"; VIOH="#4528E8"; CYAN="#00BDDF"; CLOUD="#F5F7FB"; SLATE="#667085"; MIST="#DDE3EE"; WHITE="#FFFFFF"
DOMAIN="meetingbrand.com"; SITE="https://meetingbrand.com"; SUPPORT="support@meetingbrand.com"; APP="/app/"
TODAY=datetime.date(2026,9,8).strftime("%B %-d, %Y")
FACTS_DATE=datetime.date(2026,9,27)   # the day the product facts (FACTS/FAQ below) were verified against the shipped build; move it ONLY when a fact changes
FACTS_DATE_STR=FACTS_DATE.strftime("%B %-d, %Y")
PRODUCT_BUILD="v93"                   # the /app/ build the facts were read from (SCENES = 16 rooms, STYLES = 14 treatments, STARTER = 3 looks)
PRIVACY_DATE=datetime.date(2026,9,9)   # the privacy page changed on this date (account data + deletion sections); terms keep TODAY
# ---------- cloud config: ONE source of truth, BB/engine/mb-config.json (read by build-vNN.py and by this generator).
# Empty supabaseUrl/supabaseAnonKey = the Supabase project does not exist yet -> every cloud page renders its "not connected yet" state.
BB="/Users/motty/branded-background"
CFG_PATH=f"{BB}/engine/mb-config.json"
CFG_KEYS=("supabaseUrl","supabaseAnonKey","googleClientId","ga4Id","supabaseJs","product","schema")
CFG={"supabaseUrl":"","supabaseAnonKey":"","googleClientId":"","ga4Id":"","supabaseJs":"2.116.0","product":"meetingbrand","schema":"public"}
try:
    CFG.update({k:str(v) for k,v in json.load(open(CFG_PATH,encoding="utf-8")).items() if k in CFG_KEYS})
    print("config:", CFG_PATH, "->", "CONNECTED" if CFG["supabaseUrl"] and CFG["supabaseAnonKey"] else "OFFLINE (supabaseUrl/supabaseAnonKey empty)")
except FileNotFoundError:
    print("config:", CFG_PATH, "missing -> OFFLINE values")
CONNECTED=bool(CFG["supabaseUrl"] and CFG["supabaseAnonKey"])
MB_CONFIG_BLOCK='<script id="mb-config">window.__MB='+json.dumps({k:CFG[k] for k in CFG_KEYS},separators=(",",":"))+';</script>'
LOGO=f'<a class="logo" href="/" aria-label="MeetingBrand home"><img src="/assets/logo.png" alt="MeetingBrand" width="170" height="33"></a>'
LOGO_REV=f'<a class="logo" href="/" aria-label="MeetingBrand home"><img src="/assets/logo-reversed.png" alt="MeetingBrand" width="170" height="35"></a>'
PLATFORMS="Zoom, Microsoft Teams, Google Meet and Zoho Meeting"

# ---------- GEO (2026-09-27): ONE source for every product fact an answer engine may quote. Each fact is written once here and rendered
# identically on the home page, /docs/, /support/, llms.txt and the FAQPage JSON-LD (json.dumps of the same strings). Read the shipped build
# before changing a number: SCENES (rooms), STYLES (sign treatments), STARTER (starter set) live in BB/outputs/presence-product-demo-vNN.html.
import html as _html
DEFINITION=("MeetingBrand is a web application that creates branded virtual backgrounds for video meetings from a company's website. "
 "An admin signs up with a work email; MeetingBrand fetches the company's public logo and brand colors from that domain, mounts the logo as a physical sign in any of 16 built-in office rooms, "
 "adds an optional name bar with each employee's name and title, and exports every background as a 1920×1080 image that works in Microsoft Teams, Google Meet, Zoom and any other meeting app that accepts custom backgrounds. "
 "Delivery to employees is built in for Microsoft Teams and Google Meet today, with Zoom coming. "
 "MeetingBrand is free during early access and is made by the team behind CompanyCard (company-card.com) and ProSignature (prosignature.co).")
ROOMS=["City open space","Walnut executive wall","Tel Aviv sunset window","Stone & slats lounge","Tel Aviv beach window","Concrete gallery night","Manhattan skyline window","Forest window",
       "Concrete corner loft","Brick creative loft","Navy executive study","Marble reception","Glass office corridor","Travertine lounge","Concrete open office","Oak skyline office"]
TREATMENTS=["Wall sign","Wall sticker","Silver letters","Brass letters","Oak letters","Washed wood","Black letters","Illuminated","Glass signage","Metal plaque","Backlit plate","3D acrylic","LED signage","Wallpaper"]
STARTERS=["Concrete corner loft","Brick creative loft","Navy executive study"]
PLATFORM_STATUS={
 "teams":"Live. The MeetingBrand Agent for Windows and macOS places each person's background in the Teams background gallery; it is installed by the Intune or Jamf script generated in the app. The employee picks the background once and Teams keeps it. The builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt.",
 "meet":"Live for connected browsers. The MeetingBrand Chrome extension applies the person's branded background to their camera automatically in Google Meet; a person connects their browser from the app. Force-install for managed Chrome from the Google Admin console follows the Chrome Web Store listing, which is pending; until then the extension is provided as a developer package from the app.",
 "zoom":"Coming. The Zoom integration — uploading the background into each employee's own Zoom background library — is built and awaits its Zoom App Marketplace listing.",
 "zoho":"Coming. Zoho Meeting delivery is not in the product yet.",
}
FACTS=[
 ("Category","Branded virtual background software for video meetings (Microsoft Teams, Google Meet, Zoom)."),
 ("Input","Your company website. Sign up with a work email and MeetingBrand fetches the public logo and brand colors from that domain; you can also upload a logo."),
 ("Rooms",f"{len(ROOMS)} built-in office rooms: "+", ".join(ROOMS)+"."),
 ("Sign treatments",f"{len(TREATMENTS)}: "+", ".join(TREATMENTS)+"."),
 ("Starter set",f"{len(STARTERS)} backgrounds rendered automatically in your brand at signup: "+", ".join(STARTERS)+"."),
 ("Name bar","Optional, per employee: name, title, department and company."),
 ("Output","1920×1080 PNG download per background; a JPEG is produced for Google Meet, which requires that format."),
 ("Microsoft Teams",PLATFORM_STATUS["teams"]),
 ("Google Meet",PLATFORM_STATUS["meet"]),
 ("Zoom",PLATFORM_STATUS["zoom"]),
 ("Zoho Meeting",PLATFORM_STATUS["zoho"]),
 ("People","Add people by CSV (name, email, title, department) from My team → Upload users. Directory sync from Google Workspace, Microsoft 365 (Entra ID) and Zoom is coming."),
 ("Share pages","Any background can be published as a public page at meetingbrand.com/b/?s=<slug> — “<Company> — official meeting background” — with a preview, the date and an embed badge for the company website. The full-resolution file stays inside the workspace."),
 ("Price","Free during early access."),
 ("Data","Application data is stored with Supabase in Frankfurt (EU) with row-level access controls; this website is hosted on GitHub Pages. MeetingBrand never reads meeting audio, video, chat or calendars."),
 ("Company",f"Made by the team behind CompanyCard (company-card.com, digital business cards) and ProSignature (prosignature.co, email signatures). Support: {SUPPORT}."),
 ("Verified",f"{FACTS_DATE_STR}, against product build {PRODUCT_BUILD} at {DOMAIN}{APP}."),
]
FAQ=[
 ("What is MeetingBrand?",DEFINITION),
 ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
 ("Which meeting platforms does MeetingBrand deliver to?","Today: Microsoft Teams, through the MeetingBrand Agent (installed by Intune or Jamf), and Google Meet, through the MeetingBrand Chrome extension. Zoom is coming: the integration is built and awaits its Zoom App Marketplace listing. Zoho Meeting is coming and is not in the product yet. Every background can also be downloaded as a 1920×1080 PNG and used in any meeting app that accepts custom backgrounds."),
 ("How does MeetingBrand create a background from a website?",f"You sign up with a work email. MeetingBrand fetches your company's public logo and brand colors from that domain, renders {len(STARTERS)} starter backgrounds in your brand automatically, and lets you pick from {len(ROOMS)} built-in rooms and {len(TREATMENTS)} sign treatments — brass, oak, backlit, LED, glass and more — with your logo mounted as a physical sign in the scene. Every background exports as a 1920×1080 image."),
 ("Can an employee's background be applied automatically, without the employee doing anything?","Only on Google Meet, where the MeetingBrand Chrome extension applies the branded background to the person's camera automatically. On Microsoft Teams the MeetingBrand Agent places the image in the person's background gallery and they pick it once; Teams keeps it. No meeting platform lets a third party switch a person's active background by API, so MeetingBrand does not claim to."),
 ("What is a MeetingBrand share page?","A public page at meetingbrand.com/b/?s=<slug> that shows a company's approved meeting background — “<Company> — official meeting background” — with a preview, the date and an embed badge for the company website. An admin turns it on per background from the Live preview in the app; the full-resolution file stays inside the workspace."),
 ("Where is MeetingBrand data stored?","With Supabase in Frankfurt (EU), protected by row-level access controls; this website is hosted on GitHub Pages. MeetingBrand reads names, emails, titles and departments to personalize backgrounds and never reads meeting audio, video, chat or calendars."),
]
def _t(x): return _html.escape(x,quote=False)
def facts_table():
    rows="".join(f'<tr><th scope="row">{_t(k)}</th><td>{_t(v)}</td></tr>' for k,v in FACTS)
    return f'<table class="facts"><caption>MeetingBrand facts, verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}</caption><tbody>{rows}</tbody></table>'
def faq_html():
    return "".join(f'<div class="faq-item"><h3>{_t(q)}</h3><p>{_t(a)}</p></div>' for q,a in FAQ)
def status_p(p):
    return f'<p class="status"><b>Status, {FACTS_DATE_STR}:</b> {_t(PLATFORM_STATUS[p])}</p>'
VERIFIED_LINE=f'<p class="muted small">Facts verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}. Written and maintained by the MeetingBrand team; this block changes only when a fact changes.</p>'
DEF_JSON=json.dumps(DEFINITION,ensure_ascii=False)
FAQ_LD=json.dumps({"@type":"FAQPage","@id":f"{SITE}/#faq","mainEntity":[{"@type":"Question","name":q,"acceptedAnswer":{"@type":"Answer","text":a}} for q,a in FAQ]},ensure_ascii=False,separators=(",",":"))
WEBPAGE_LD=json.dumps({"@type":"WebPage","@id":f"{SITE}/#webpage","url":f"{SITE}/","name":"MeetingBrand | Branded Virtual Backgrounds for Teams","isPartOf":{"@id":f"{SITE}/#site"},"about":{"@id":f"{SITE}/#org"},"datePublished":"2026-09-08","dateModified":FACTS_DATE.isoformat(),"publisher":{"@id":f"{SITE}/#org"}},ensure_ascii=False,separators=(",",":"))
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
<link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/apple-touch-icon-180.png">
<meta name="theme-color" content="{INK}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/styles.css">
{extra_head}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap nav">{LOGO}<nav aria-label="Main"><a href="/#how">How it works</a><a href="/#platforms">Platforms</a><a href="/docs/">Docs</a><a href="/support/">Support</a><a href="{APP}#login">Log in</a><a class="btn" href="{APP}">Create MeetingBrand</a></nav></div></header>
<main id="main">
{body}
</main>
<footer class="foot"><div class="wrap"><div class="fgrid"><div>{LOGO_REV}<p class="tag">Every meeting. On brand.</p></div><div><h4>Product</h4><a href="/#how">How it works</a><a href="/#platforms">Platforms</a><a href="{APP}">Create MeetingBrand</a><a href="/docs/">Documentation</a></div><div><h4>Company</h4><a href="/support/">Support</a><a href="/privacy/">Privacy policy</a><a href="/terms/">Terms of service</a></div><div><h4>Contact</h4><a href="mailto:{SUPPORT}">{SUPPORT}</a><p class="muted small">Sister products: <a href="https://company-card.com">company-card.com</a> · <a href="https://prosignature.co">prosignature.co</a></p></div></div><p class="muted small">© 2026 MeetingBrand. Zoom is a trademark of Zoom Video Communications, Inc.; Microsoft Teams of Microsoft Corporation; Google Meet of Google LLC; Zoho Meeting of Zoho Corporation. MeetingBrand is not affiliated with or endorsed by them.</p></div></footer>
</body>
</html>
'''
LD=f'''<script type="application/ld+json">{{"@context":"https://schema.org","@graph":[
{{"@type":"Organization","@id":"{SITE}/#org","name":"MeetingBrand","url":"{SITE}/","logo":"{SITE}/assets/logo.png","email":"{SUPPORT}","slogan":"Every meeting. On brand."}},
{{"@type":"WebSite","@id":"{SITE}/#site","url":"{SITE}/","name":"MeetingBrand","publisher":{{"@id":"{SITE}/#org"}}}},
{{"@type":"SoftwareApplication","name":"MeetingBrand","applicationCategory":"BusinessApplication","operatingSystem":"Web","url":"{SITE}/","description":{DEF_JSON},"offers":{{"@type":"Offer","price":"0","priceCurrency":"USD","description":"Free during early access"}},"publisher":{{"@id":"{SITE}/#org"}}}},
{WEBPAGE_LD},
{FAQ_LD}
]}}</script>'''
# ---------- home
home=f'''
<section class="hero"><div class="wrap herogrid">
  <div>
  <p class="eyebrow">Branded virtual backgrounds at company scale</p>
  <h1>Every meeting.<br>On brand.</h1>
  <p class="lead">MeetingBrand creates realistic virtual backgrounds from your company website and deploys approved options across {PLATFORMS} — automatically.</p>
  <div class="cta"><a class="btn big" href="{APP}">Create MeetingBrand</a><a class="btn ghost big" href="#how">See how it works</a></div>
  <p class="trust">No design work. No employee-by-employee setup. No off-brand calls.</p>
  </div>
  <div class="heroart" aria-hidden="true"><img src="/assets/virtual-background-navy-study.jpg" alt="" width="1600" height="900"><span class="namebar"><b>Dana Levi</b><span>Head of Sales · ProSignature</span></span></div>
</div></section>

<section id="what" class="band alt"><div class="wrap prose">
  <h2>What is MeetingBrand?</h2>
  <p class="lead">{_t(DEFINITION)}</p>
  {facts_table()}
  {VERIFIED_LINE}
</div></section>

<section class="band"><div class="wrap">
  <div class="three">
    <div class="feature"><h2>Paste your domain. Get your brand.</h2><p>MeetingBrand identifies your logo, colors and visual style, then turns them into a ready-to-use background collection — with a personal name bar for every employee.</p></div>
    <div class="feature"><h2>Real backgrounds, not branded wallpaper.</h2><p>Your logo belongs in the space. It should not float over it. MeetingBrand creates natural-looking environments — brass, backlit letters, LED, oak, concrete — that feel credible on camera.</p></div>
    <div class="feature"><h2>Roll out once. Stay consistent everywhere.</h2><p>Publish approved backgrounds centrally and update the whole organization without sending files or setup instructions. Titles change? The name bar updates everywhere.</p></div>
  </div>
  <div class="scenes">
    <figure><img src="/assets/virtual-background-corner-office-loft.jpg" alt="Company sign on a concrete wall in a corner office over the city — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Concrete corner loft</figcaption></figure>
    <figure><img src="/assets/virtual-background-sunset-window.jpg" alt="Company sign beside a sunset window over the Tel Aviv beach — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Tel Aviv sunset window</figcaption></figure>
    <figure><img src="/assets/virtual-background-marble-reception.jpg" alt="Company sign on a marble reception wall — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Marble reception</figcaption></figure>
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
    <div class="card"><h3>Zoom</h3><p>Uploaded straight into each employee's own background library through Zoom's API. They pick it once and it stays; admins can require a branded background for the whole account.</p>{status_p("zoom")}</div>
    <div class="card"><h3>Microsoft Teams</h3><p>Placed in the Teams background gallery on Windows and Mac through your IT tools (Intune, Jamf) or our lightweight agent. Teams Premium tenants can set it as the required background.</p>{status_p("teams")}</div>
    <div class="card"><h3>Google Meet</h3><p>Published to the Meet gallery for every department from the Admin console, plus a Chrome extension that applies the background automatically for managed browsers.</p>{status_p("meet")}</div>
    <div class="card"><h3>Zoho Meeting</h3><p>Every employee gets a personal link with their background and one-click instructions; the panel tracks who has set it up.</p>{status_p("zoho")}</div>
  </div>
</div></section>

<section class="band alt"><div class="wrap two">
  <div><h2>Built for every customer-facing team.</h2><p>Give Sales, Support, Recruiting, Leadership and distributed teams a consistent presence in every call. Marketing sets the look, IT approves the connection once, and every new hire is on brand from their first call.</p></div>
  <div><h2>Your data stays yours.</h2><p>We read names, emails and titles from your directory to personalise backgrounds, and nothing else. Disconnect a platform and we delete what we synced. Details in the <a href="/privacy/">privacy policy</a>.</p></div>
</div></section>

<section id="faq" class="band"><div class="wrap prose faq">
  <h2>Frequently asked questions</h2>
  {faq_html()}
  {VERIFIED_LINE}
</div></section>

<section id="early-access" class="band dark"><div class="wrap narrow center">
  <h2>Update once. Refresh everywhere.</h2>
  <p class="lead">Try the brand-set builder now, or write to us and we will set your company up personally during early access.</p>
  <div class="cta center"><a class="btn big cyan" href="{APP}">Create MeetingBrand</a><a class="btn ghost big onink" href="mailto:{SUPPORT}?subject=MeetingBrand%20early%20access&body=Company%3A%20%0AMeeting%20platform(s)%3A%20%0AEmployees%3A%20">Request early access</a></div>
  <p class="muted small">We reply personally within two business days. No newsletter, no spam.</p>
</div></section>
'''
thanks=f'''<section class="band"><div class="wrap narrow"><h1>Thanks — we got it.</h1><p class="lead">We will reply from {SUPPORT} within two business days. Meanwhile, the <a href="/docs/">documentation</a> shows what setup looks like on each platform.</p><a class="btn" href="/">Back to MeetingBrand</a></div></section>'''
# ---------- docs
docs=f'''
<section class="band"><div class="wrap prose">
<h1>Documentation</h1>
<p class="lead">How MeetingBrand connects to each platform, what your employees see, and how to remove it. Written for the admin who connects the platform and for IT.</p>
<p>{_t(DEFINITION)}</p>
{facts_table()}
{VERIFIED_LINE}

<h2 id="getting-started">Getting started</h2>
<ol>
<li><strong>Create MeetingBrand</strong> — open <a href="{APP}">the builder</a>, enter your company domain; review the logo, colors, scenes and sign treatments; set the name bar fields (name, title, department, company). Backgrounds are rendered in your browser; your brand kit and the backgrounds you save are stored with your account (see Data and security below).</li>
<li><strong>Add your people</strong> — My team → Upload users → upload a CSV with name, email, title and department. Directory sync from Google Workspace, Microsoft 365 (Entra ID) and Zoom is coming; once a platform is connected, MeetingBrand imports your people (name, email, title, department) with the permissions listed below. Write to <a href="mailto:{SUPPORT}">{SUPPORT}</a> to be scheduled for early access.</li>
<li><strong>Assign and deploy</strong> — mark people or departments as active, choose their looks, and deploy. The People panel shows each person's status: delivered, waiting for a restart, needs the employee's one click, or blocked (with the reason).</li>
</ol>

<h2 id="zoom">Zoom</h2>
{status_p("zoom")}
<p><strong>Permissions requested</strong> (admin-managed app): list users; upload and delete virtual background files for users; read and update account settings related to virtual backgrounds. A Zoom account owner or admin authorizes once for the whole account; employees see no prompt.</p>
<p><strong>What happens</strong>: each active employee's branded background is uploaded into their own Zoom virtual-background library (Zoom allows up to 10 files per user; we manage ours). After the upload the employee signs out and back in to Zoom, opens Settings → Video &amp; effects → Virtual backgrounds and picks the branded image once — Zoom remembers it. Admins can additionally turn on "Require users to always use virtual background" and disable personal uploads so the branded image is the only non-stock choice.</p>
<p><strong>Removing MeetingBrand</strong>: Zoom App Marketplace → Manage → Added Apps → MeetingBrand → Remove. MeetingBrand deletes the background files it uploaded and the directory data it synced for that account within 30 days (immediately on request to {SUPPORT}).</p>

<h2 id="teams">Microsoft Teams</h2>
{status_p("teams")}
<p><strong>Permissions requested</strong> (Microsoft Entra ID, multitenant): <em>User.Read.All</em> (application) to read your directory — names, emails, job titles, departments — plus sign-in for the admin. A tenant administrator grants consent once; employees see no prompt.</p>
<p><strong>What happens</strong>: Teams has no API for meeting backgrounds, so delivery goes to the employee's device. Choose one: (a) <strong>IT scripts</strong> — MeetingBrand generates an Intune platform script (Windows) and a shell script (macOS/Jamf) that place the person's background in the new-Teams gallery folder; (b) the <strong>MeetingBrand Agent</strong>, a small helper for Windows and macOS installed by the Intune or Jamf script generated in the app (or by hand with your organization's enrollment key); the builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt. After Teams restarts, the branded image appears under Effects and avatars → Backgrounds; the employee selects it once and Teams keeps it. Tenants with <strong>Teams Premium</strong> can instead upload our images in the Teams admin center and set them as required per department — we generate the images and the policy assignment script.</p>
<p><strong>Removing MeetingBrand</strong>: Entra admin center → Enterprise applications → MeetingBrand → Delete (revokes our access). Delete the gallery files with the uninstall script we provide, or remove the agent from Add/Remove programs (Windows) or the Applications folder (macOS).</p>

<h2 id="meet">Google Meet</h2>
{status_p("meet")}
<p><strong>Permissions requested</strong>: <em>View users on your domain</em> (Admin SDK Directory, read-only) to import names, emails, titles and departments. A Google Workspace administrator with the Users › Read privilege authorizes once.</p>
<p><strong>What happens</strong>: Meet has no API for backgrounds. MeetingBrand produces the JPEG images (Meet's required format, 1920×1080) and a step-by-step runbook for the Admin console (Apps → Google Workspace → Google Meet → Meet video settings → Visual effects → custom images per organizational unit, up to 15). Employees then find the images in their Backgrounds panel. The MeetingBrand Chrome extension applies the person's branded background to their camera automatically; a person connects their browser from the app, or — once the Chrome Web Store listing is published (pending) — an admin force-installs it for managed Chrome from the Admin console.</p>
<p><strong>Removing MeetingBrand</strong>: Google Admin → Security → API controls → Manage third-party app access → MeetingBrand → Remove; remove the custom images from Meet video settings; remove the extension from the Chrome force-install list.</p>

<h2 id="zoho">Zoho Meeting</h2>
{status_p("zoho")}
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
<p class="muted">Effective {PRIVACY_DATE.strftime("%B %-d, %Y")}. This policy explains how MeetingBrand ("MeetingBrand", "we", "us") collects, uses and protects information.</p>
<h2>1. What MeetingBrand does</h2>
<p>MeetingBrand is a business service that creates branded virtual-meeting backgrounds and name bars for a company and delivers them to that company's employees' meeting applications (Zoom, Microsoft Teams, Google Meet, Zoho Meeting). Our customers are companies; the people whose data we process are their administrators and employees.</p>
<h2>2. Data we collect</h2>
<ul>
<li><strong>Brand-set builder</strong> — the builder at {SITE}{APP} runs in your browser. The domain you type is used to fetch that company's public logo and colors; the images you create are rendered on your device and are not uploaded to us during early access.</li>
<li><strong>Account data</strong> — the administrator's name, work email and company, given when requesting access or signing up. You can sign up with a work email and password or with Sign in with Google (which shares only your Google email address and basic profile with us). The domain of your work email is used to identify your company and fetch its public brand (section 7).</li>
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
<p><strong>Sign in with Google.</strong> If you choose to sign in with Google, we request only your Google email address and basic profile (the <em>openid</em> and <em>email</em> scopes) to create and identify your account. Authorization happens directly between your browser and Google; your Google password is never seen by MeetingBrand. Google user data received this way is used only to sign you in, is not transferred to third parties except as necessary to provide the service, and is never used for advertising. You can revoke MeetingBrand's access at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<h2>5. Sharing</h2>
<p>We share data only with the meeting platforms you connect (Zoom Video Communications, Microsoft, Google, Zoho — to deliver backgrounds and read your directory as authorized) and with our infrastructure providers under data-processing terms (website hosting: GitHub; application database and file storage: Supabase). We disclose data when the law requires it.</p>
<h2>6. Where your data lives</h2>
<p>Account, brand, background, directory and delivery data are stored with our database and file-storage provider, <a href="https://supabase.com/privacy">Supabase</a>, in its Frankfurt (EU) region, protected by industry-standard security and row-level access controls so that each company's data is visible only to that company's users. This website and the application page are hosted on <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub Pages</a>. Usage events (for example that a brand was fetched or a background was downloaded) are recorded with a random device session identifier and, when you are signed in, your user identifier, so we can see where the product works and where it fails; they are never sold or used for advertising.</p>
<h2>7. Account data and deletion</h2>
<p>When you sign up, the domain of your work email (for example <em>acme.com</em>) is used to fetch your company's public logo and colors from its public website and to create your brand kit; nothing is read from your mailbox. Your brand kit and the backgrounds you save are stored with your account so they can be reused, updated and deployed to your people.</p>
<ul>
<li><strong>Self-serve deletion</strong> — you can delete your account at any time from Settings → Danger zone in the application. This permanently removes your login, your profile and, when you are the last user of your company workspace, the workspace itself with its brand kit, backgrounds, uploaded logos, directory data and delivery records.</li>
<li><strong>By request</strong> — write to <a href="mailto:{SUPPORT}">{SUPPORT}</a> from the email address on the account and we delete it for you, or send you a copy of your data, within 30 days.</li>
<li><strong>Retention</strong> — data is kept while your account is active. After deletion it is removed from live systems immediately and from backups within 30 days, except where the law requires us to keep it longer.</li>
</ul>
<h2>8. Retention and deletion of platform data</h2>
<p>Directory and delivery data are kept while the platform connection is active. Disconnecting a platform deletes the data synced from it within 30 days; deleting your MeetingBrand account deletes everything within 30 days. Any administrator or employee can ask us to access, correct or delete their data at <a href="mailto:{SUPPORT}">{SUPPORT}</a>; we answer within 30 days.</p>
<h2>9. Security</h2>
<p>Data is encrypted in transit (TLS 1.2+) and at rest; OAuth tokens are stored encrypted with keys separate from the database; access is limited to staff who need it to operate the service; we log administrative access.</p>
<h2>10. International transfers</h2>
<p>Our providers process data in the EU and the United States under standard contractual clauses or equivalent safeguards.</p>
<h2>11. Children</h2>
<p>MeetingBrand is a business service and is not directed to anyone under 16.</p>
<h2>12. Changes</h2>
<p>We will post changes on this page and update the effective date; material changes are announced to administrators by email.</p>
<h2>13. Contact</h2>
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
<h2>About MeetingBrand</h2>
<p>{_t(DEFINITION)}</p>
<p class="muted small">The full fact sheet (rooms, sign treatments, per-platform delivery status, price, where data lives) is on the <a href="/#what">home page</a> and in the <a href="/docs/">documentation</a>; facts verified {FACTS_DATE_STR}.</p>
</div></section>'''
notfound=f'''<section class="band"><div class="wrap narrow"><h1>Page not found</h1><p class="lead">The page may have moved. Start again from the <a href="/">home page</a>, the <a href="/docs/">documentation</a> or the <a href="{APP}">brand-set builder</a>.</p></div></section>'''
# ---------- /b/: the public Share page per background (product v93, 2026-09-27). One HTML shell, indexable, canonical /b/ (the slug is a
# query parameter, so the page is NOT in the sitemap); vanilla JS reads ?s=<slug>, calls the anonymous RPC mb.public_background(p_slug)
# (slug, label, look, org_name, preview_path, updated_at — only where backgrounds.is_public) and renders "<Org> — official meeting background"
# with the 640x360 preview from the public bucket mb-previews (?v=<updated_at> busts the CDN after a re-share). Unknown / unshared slug ->
# the friendly fallback with the same CTA (still 200; the shell keeps index,follow). The 1920x1080 file is never offered here: mb-exports is private.
# The badge (assets/badge-official-background.svg, 220x52) is written by this generator: Deep Ink plate, the kit symbol (assets/symbol.png embedded),
# "Official meeting background" + a small plain-text "MeetingBrand" (the wordmark is never retyped; the footer uses the image logo for the same reason).
import base64 as _b64
_SYMBOL_B64=_b64.b64encode(open("assets/symbol.png","rb").read()).decode("ascii")
BADGE_SVG=f'''<svg xmlns="http://www.w3.org/2000/svg" width="220" height="52" viewBox="0 0 220 52" role="img" aria-label="Official meeting background — MeetingBrand">
<rect x=".5" y=".5" width="219" height="51" rx="12" fill="{INK}" stroke="{VIO}"/>
<image x="10" y="10" width="32" height="32" href="data:image/png;base64,{_SYMBOL_B64}"/>
<text x="50" y="23" font-family="Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="11" font-weight="700" fill="{WHITE}" textLength="160" lengthAdjust="spacingAndGlyphs">Official meeting background</text>
<text x="50" y="39" font-family="Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="10.5" font-weight="600" fill="{CYAN}" letter-spacing=".2">MeetingBrand</text>
</svg>
'''
open("assets/badge-official-background.svg","w",encoding="utf-8").write(BADGE_SVG)
SHARE_HEAD=MB_CONFIG_BLOCK+'<meta name="robots" content="index,follow">'+f'''<style>
.shfig{{margin:28px 0 8px;border-radius:16px;overflow:hidden;border:1px solid var(--mist);background:var(--cloud);box-shadow:0 10px 30px rgba(3,20,54,.08)}}.shfig img{{width:100%;height:auto;display:block;aspect-ratio:16/9;object-fit:cover}}
.shcap{{font-size:14px;color:var(--slate);margin:0 0 20px}}.shcap b{{color:var(--ink);font-weight:600}}
.shnote{{background:var(--cloud);border-radius:16px;padding:16px 20px;margin:24px 0;font-size:15.5px;color:#2B3A55}}.shnote strong{{color:var(--ink)}}
.shrow{{display:flex;gap:10px;align-items:flex-start;margin:8px 0 24px}}.shrow input,.shrow textarea{{flex:1;min-width:0;font:inherit;font-size:14px;padding:11px 12px;border:1px solid var(--mist);border-radius:12px;color:var(--ink);background:#fff}}.shrow textarea{{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5}}
.shrow .btn{{white-space:nowrap}}.shbadge{{margin:4px 0 8px;line-height:0}}#shShare h2{{font-size:22px;margin-top:36px}}
</style>'''
share_body=f'''<section class="band"><div class="wrap narrow" id="shareRoot" data-state="loading">
<p class="eyebrow">Shared meeting background</p>
<h1 id="shH1">Loading this background…</h1>
<p class="lead" id="shLead"></p>
<figure class="shfig" id="shFig" hidden><img id="shImg" alt="" width="640" height="360" loading="eager" decoding="async"></figure>
<p class="shcap" id="shCap" hidden></p>
<div class="shnote" id="shDl" hidden><strong>Download the 1920×1080 file</strong> — the full-resolution background is delivered to <span class="shOrg"></span> employees inside their MeetingBrand workspace (Zoom, Microsoft Teams, Google Meet or Zoho Meeting), not from this page. This page shows a preview only; ask your MeetingBrand admin for the file.</div>
<div class="cta"><a class="btn big" href="{APP}">Create branded backgrounds for your team →</a><a class="btn ghost big" href="/">What is MeetingBrand?</a></div>
<div id="shShare" hidden>
<h2>Link to this page</h2>
<div class="shrow"><input type="text" id="shUrl" readonly aria-label="Link to this page"><button class="btn ghost" type="button" id="shUrlCopy">Copy</button></div>
<h2>Embed the badge on your website</h2>
<p class="muted small">Shows “<span class="shOrg"></span> — official meeting background” and links to this page.</p>
<div class="shbadge"><img src="/assets/badge-official-background.svg" alt="Official meeting background — MeetingBrand badge" width="220" height="52"></div>
<div class="shrow"><textarea id="shEmbed" readonly rows="3" spellcheck="false" aria-label="Embed badge HTML"></textarea><button class="btn ghost" type="button" id="shEmbedCopy">Copy</button></div>
</div>
</div></section>
<script>
(function(){{
 var C=window.__MB||{{}},U=String(C.supabaseUrl||''),K=String(C.supabaseAnonKey||''),SCH=String(C.schema||'mb'),SITE='{SITE}',BADGE=SITE+'/assets/badge-official-background.svg';
 var root=document.getElementById('shareRoot');function $(id){{return document.getElementById(id)}}function txt(id,s){{var e=$(id);if(e)e.textContent=s}}
 function esc(s){{return String(s==null?'':s).replace(/[&<>"']/g,function(c){{return {{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]}})}}
 function fallback(){{root.setAttribute('data-state','missing');document.title='This background isn’t shared — MeetingBrand';txt('shH1','This background isn’t shared');txt('shLead','The link may be old, or the organization turned sharing off. MeetingBrand creates branded meeting backgrounds from a company website in minutes and deploys them to every employee on Zoom, Microsoft Teams, Google Meet and Zoho Meeting.');$('shFig').hidden=true;$('shCap').hidden=true;$('shDl').hidden=true;$('shShare').hidden=true}}
 function render(r){{var org=String(r.org_name||'').trim()||'This organization',slug=String(r.slug),url=SITE+'/b/?s='+encodeURIComponent(slug);
  root.setAttribute('data-state','ok');document.title=org+' — official meeting background · MeetingBrand';
  txt('shH1',org+' — official meeting background');txt('shLead','The approved virtual background '+org+' uses in video meetings — made with MeetingBrand from the company’s own logo and colors.');
  Array.prototype.forEach.call(document.querySelectorAll('.shOrg'),function(e){{e.textContent=org}});
  if(r.preview_path){{var im=$('shImg');im.onerror=function(){{$('shFig').hidden=true}};im.alt=org+' — official meeting background (preview)';im.src=U+'/storage/v1/object/public/mb-previews/'+String(r.preview_path).split('/').map(encodeURIComponent).join('/')+'?v='+(Date.parse(r.updated_at||'')||0);$('shFig').hidden=false}}
  var d=r.updated_at?new Date(r.updated_at):null,ds=(d&&!isNaN(d))?d.toLocaleDateString('en-US',{{year:'numeric',month:'long',day:'numeric'}}):'';
  var cap=$('shCap');cap.textContent='';if(r.label){{var b=document.createElement('b');b.textContent=String(r.label);cap.appendChild(b)}}if(r.look&&String(r.look)!==String(r.label||'')){{cap.appendChild(document.createTextNode((r.label?' · ':'')+'look: '+String(r.look)))}}if(ds){{cap.appendChild(document.createTextNode((cap.textContent?' · ':'')+'Updated '+ds))}}cap.hidden=!cap.textContent;
  $('shDl').hidden=false;$('shShare').hidden=false;$('shUrl').value=url;
  $('shEmbed').value='<a href="'+url+'" rel="noopener"><img src="'+BADGE+'" alt="'+esc(org+' official meeting background — by MeetingBrand')+'" width="220" height="52" style="border:0"></a>';
 }}
 function copy(id,btn){{var el=$(id),v=el.value,was=btn.textContent,done=function(){{btn.textContent='Copied';setTimeout(function(){{btn.textContent=was}},1600)}};try{{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(done,function(){{el.select();done()}});else{{el.select();document.execCommand&&document.execCommand('copy');done()}}}}catch(e){{el.select()}}}}
 $('shUrlCopy').onclick=function(){{copy('shUrl',this)}};$('shEmbedCopy').onclick=function(){{copy('shEmbed',this)}};
 var s='';try{{s=new URLSearchParams(location.search).get('s')||''}}catch(e){{s=''}}
 if(!U||!K||!/^[a-z0-9_-]{{6,64}}$/.test(s)){{fallback();return}}
 fetch(U+'/rest/v1/rpc/public_background',{{method:'POST',headers:{{'apikey':K,'Authorization':'Bearer '+K,'Content-Type':'application/json','Content-Profile':SCH,'Accept-Profile':SCH}},body:JSON.stringify({{p_slug:s}})}})
  .then(function(r){{return r.ok?r.json():null}}).then(function(j){{var r=Array.isArray(j)?j[0]:j;if(!r||!r.slug){{fallback();return}}render(r)}}).catch(fallback);
}})();
</script>'''
pages={
 "index.html":("MeetingBrand | Branded Virtual Backgrounds for Teams","Create realistic branded virtual backgrounds from your company website and deploy approved options across Zoom, Microsoft Teams, Google Meet and Zoho Meeting.",home,"/",LD),
 "thanks/index.html":("Thanks — MeetingBrand","We received your early-access request.",thanks,"/thanks/",""),
 "docs/index.html":("Documentation — MeetingBrand","How MeetingBrand connects to Zoom, Microsoft Teams, Google Meet and Zoho Meeting, what employees see, and how to remove it.",docs,"/docs/",""),
 "privacy/index.html":("Privacy policy — MeetingBrand","How MeetingBrand collects, uses, stores and deletes data from connected meeting platforms.",privacy,"/privacy/",""),
 "terms/index.html":("Terms of service — MeetingBrand","The agreement for using MeetingBrand.",terms,"/terms/",""),
 "support/index.html":("Support — MeetingBrand","How to reach MeetingBrand support and how to install or remove the integrations.",support,"/support/",""),
 "404.html":("Page not found — MeetingBrand","The page may have moved.",notfound,"/404.html",'<meta name="robots" content="noindex">'),
 "b/index.html":("Shared meeting background — MeetingBrand","A company's official meeting background, shared from its MeetingBrand workspace: the approved virtual background its employees use on Zoom, Microsoft Teams, Google Meet and Zoho Meeting.",share_body,"/b/",SHARE_HEAD),
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
.prose h2:first-child{{margin-top:0}}.facts{{width:100%;border-collapse:collapse;margin:20px 0 12px;font-size:15.5px}}.facts caption{{text-align:left;font-size:13px;color:var(--slate);padding:0 0 10px;caption-side:top}}.facts th,.facts td{{text-align:left;vertical-align:top;padding:11px 16px 11px 0;border-bottom:1px solid var(--mist)}}.facts th{{width:190px;font-weight:700;color:var(--ink)}}.facts td{{color:#2B3A55}}
.faq h3{{font-size:20px;margin:28px 0 6px}}.faq p{{color:#2B3A55}}
.status{{font-size:14.5px;color:#2B3A55;margin:14px 0 0;padding-top:12px;border-top:1px solid var(--mist)}}.card .status{{color:#2B3A55;font-size:14.5px}}.status b{{color:var(--ink)}}
@media(max-width:900px){{.facts,.facts caption,.facts tbody,.facts tr,.facts th,.facts td{{display:block;width:auto}}.facts th,.facts td{{padding:8px 0}}.facts th{{border-bottom:0;padding-bottom:0}}}}
@media(max-width:900px){{.herogrid,.three,.scenes,.steps,.cards,.two,.fgrid{{grid-template-columns:1fr}}.nav nav a:not(.btn){{display:none}}.nav nav .btn{{white-space:nowrap;padding:9px 14px;font-size:14px}}.hero{{padding:56px 0 40px}}.band{{padding:56px 0}}.logo img{{width:140px}}}}
'''
open("styles.css","w").write(css)
# ---------- robots.txt: normal crawlers keep Allow: /; the AI-crawler block is the CompanyCard one (cc-work/robots.txt:9-46) verbatim.
AI_BOTS=["GPTBot","OAI-SearchBot","ChatGPT-User","PerplexityBot","Perplexity-User","Google-Extended","ClaudeBot","Claude-User","Claude-SearchBot","Applebot-Extended","meta-externalagent","anthropic-ai","CCBot"]
open("robots.txt","w").write("User-agent: *\nAllow: /\nDisallow: /backoffice/\nDisallow: /app/analytics.html\n\n# AI assistants and answer engines are welcome to read and cite these pages.\n"
    +"".join(f"User-agent: {b}\nAllow: /\n\n" for b in AI_BOTS)+f"Sitemap: {SITE}/sitemap.xml\n")
# ---------- llms.txt in the CompanyCard shape (cc-work/llms.txt): one-paragraph entity, who/what, honest pricing, page list, positioning notes.
open("llms.txt","w",encoding="utf-8").write(f'''# MeetingBrand

> {DEFINITION}

## Who it is for
- Companies that want every employee on brand in customer-facing calls: Sales, Support, Recruiting, Leadership and distributed teams
- Marketing teams that set the look once and IT admins who approve one platform connection for the whole organization
- Small and mid-sized businesses on {PLATFORMS}

## What MeetingBrand is
- Category: branded virtual background / virtual background management software for video meetings (Zoom, Microsoft Teams, Google Meet, Zoho Meeting).
- Key facts: backgrounds are generated from the company website (logo + colors) rather than designed by hand; the logo is placed in the scene as a physical sign (brass, backlit letters, LED, oak, concrete) rather than floating over a wallpaper; a name bar shows each person's name and title; deployment is org-wide from one panel; the brand-set builder runs in the browser.
- Delivery is platform-specific and stated plainly (status verified {FACTS_DATE_STR}): Microsoft Teams — {PLATFORM_STATUS['teams']} Google Meet — {PLATFORM_STATUS['meet']} Zoom — {PLATFORM_STATUS['zoom']} Zoho Meeting — {PLATFORM_STATUS['zoho']} No meeting platform lets a third party switch a person's active background by API; MeetingBrand does not claim otherwise.
- Status ({FACTS_DATE_STR}): early access. The product is live at {SITE}{APP} (build {PRODUCT_BUILD}); people are added by CSV today and directory sync is coming.

## Facts (verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}; identical to the table on {SITE}/#what and {SITE}/docs/)
{chr(10).join(f'- {k}: {v}' for k,v in FACTS)}

## FAQ (identical to the visible FAQ and the FAQPage JSON-LD on {SITE}/#faq)
{chr(10).join(f'- Q: {q}{chr(10)}  A: {a}' for q,a in FAQ)}

## Third-party profiles (for verification)
- Stated plainly: MeetingBrand is not yet listed on G2, Capterra, Product Hunt, AlternativeTo, Trustpilot or the Chrome Web Store, and has no ratings or reviews anywhere. Please do not attribute one.

## Pricing (published, as of September 2026)
- Free during early access.

## Core pages
- Home: {SITE}/
- Brand-set builder (the product): {SITE}{APP}
- Documentation (what "delivered" means on each platform, permissions requested, how to remove MeetingBrand): {SITE}/docs/
- Support: {SITE}/support/
- Privacy policy (Google API Limited Use, where data lives, account deletion): {SITE}/privacy/
- Terms of service: {SITE}/terms/
- Shared background pages: {SITE}/b/?s=<slug> — one public page per background an organization chooses to share ("<Organization> — official meeting background": the company name, a preview, the date, an embed badge); the slug is set inside the product, so these pages are not listed in the sitemap

## Honest positioning notes for anyone summarising MeetingBrand
- Genuine differentiators: backgrounds are generated from the company domain in minutes with no design work; the logo is rendered as a physical sign in a realistic scene; one admin deploys to the whole organization and sees who is on brand; the documentation states per platform exactly what is and is not possible.
- Not differentiators: a static branded wallpaper — Zoom, Teams and Meet all accept custom images natively, and digital-business-card products (including CompanyCard) also offer a simple branded background. MeetingBrand's claim is the realistic scene plus org-wide deployment and tracking, not the image file itself.
- Trade-offs, stated plainly: Microsoft Teams, Google Meet and Zoho Meeting have no background API, so delivery there depends on IT tooling, an admin-console step or one click by the employee; the product is in early access and integrations are being rolled out to customers one platform at a time.
''')
urls=[("/",FACTS_DATE.isoformat()),("/docs/",FACTS_DATE.isoformat()),("/privacy/",PRIVACY_DATE.isoformat()),("/terms/","2026-09-08"),("/support/",FACTS_DATE.isoformat())]
# Image sitemap (Google Images eligibility) — the four branded-background scenes
# shown on the home page are the site's only images and are exactly what should
# rank for "branded/company/zoom/teams virtual background" image queries.
PAGE_IMAGES={"/":[
    ("virtual-background-corner-office-loft.jpg","Branded virtual background — company sign on a concrete wall in a corner office over the city","Concrete corner loft — a branded video-call background"),
    ("virtual-background-sunset-window.jpg","Branded virtual background — company sign beside a sunset window over the Tel Aviv beach","Tel Aviv sunset window — a branded video-call background"),
    ("virtual-background-marble-reception.jpg","Branded virtual background — company sign on a marble reception wall","Marble reception — a branded video-call background"),
    ("virtual-background-navy-study.jpg","Branded virtual background — company sign in a navy study for a professional video call","Navy study — a branded video-call background"),
]}
def _sm_imgs(u):
    return "".join(f"<image:image><image:loc>{SITE}/assets/{f}</image:loc><image:title>{t}</image:title><image:caption>{c}</image:caption></image:image>" for f,t,c in PAGE_IMAGES.get(u,[]))
open("sitemap.xml","w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'+"".join(f"<url><loc>{SITE}{u}</loc><lastmod>{lm}</lastmod>{_sm_imgs(u)}</url>" for u,lm in urls)+"</urlset>\n")
# ---------- /app/: byte-identical copy of the LATEST gated build (highest vNN in BB/outputs). Never hand-edit app/index.html.
def sync_app():
    cands=[]
    for p in glob.glob(f"{BB}/outputs/presence-product-demo-v*.html"):
        m=re.search(r"-v(\d+)\.html$",p)
        if m: cands.append((int(m.group(1)),p))
    if not cands:
        print(f"app: no {BB}/outputs/presence-product-demo-v*.html found — app/index.html left as is"); return
    pin=os.environ.get("MB_APP_PIN")            # MB_APP_PIN=76 python3 gen-site.py -> deploy that version even if newer builds exist in outputs/
    if pin: cands=[c for c in cands if c[0]<=int(pin)]
    n,src=max(cands); dst="app/index.html"
    data=open(src,"rb").read()
    same=os.path.exists(dst) and open(dst,"rb").read()==data
    if not same:
        os.makedirs("app",exist_ok=True); shutil.copyfile(src,dst)
    print(f"app/index.html <- {os.path.basename(src)} (v{n}, {'unchanged' if same else 'copied'}, md5 {hashlib.md5(data).hexdigest()})")
sync_app()
# ---------- cloud tool pages (noindex, not in the sitemap, disallowed in robots): back office + funnel analytics.
# Both read url/key from the inline #mb-config block above; empty values render the "not connected yet" state.
def tool_layout(title, body, path, extra_head=""):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>{title}</title>
<link rel="icon" href="/assets/favicon.ico" sizes="any"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="{INK}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/styles.css">
{MB_CONFIG_BLOCK}
<style>
.tool{{max-width:980px;margin:0 auto;padding:34px 24px 70px}}.tool h1{{font-size:28px;margin-bottom:4px}}.tool h1 span{{color:var(--vio)}}.sub{{color:var(--slate);font-size:14px;margin-bottom:22px}}
.tcard{{background:#fff;border:1px solid var(--mist);border-radius:16px;padding:20px;margin-bottom:16px}}
.tool input{{font:600 14px Inter,Arial,sans-serif;border:1.5px solid var(--mist);border-radius:10px;padding:10px 13px;outline:none;background:#fff;color:var(--ink);width:300px;max-width:100%}}.tool input:focus{{border-color:var(--vio)}}
.tool button{{font:700 14px Inter,Arial,sans-serif;border:0;border-radius:10px;padding:10px 18px;cursor:pointer;background:var(--vio);color:#fff}}.tool button:hover{{background:var(--vio-h)}}.tool button:disabled{{background:var(--mist);color:var(--slate);cursor:not-allowed}}
.tool button.ghost{{background:#fff;color:var(--ink);border:1.5px solid var(--mist)}}.tool button.ghost:hover{{background:var(--cloud)}}.tool button.danger{{background:#B3261E}}.tool button.danger:hover{{background:#8E1D17}}
.tool label{{font:700 12px Inter,Arial,sans-serif;color:var(--slate);display:block;margin-bottom:6px;letter-spacing:.06em;text-transform:uppercase}}
.row{{display:flex;gap:10px;flex-wrap:wrap;align-items:center}}
.tool table{{border-collapse:collapse;width:100%;font-size:13.5px;margin-top:8px}}.tool th,.tool td{{border-bottom:1px solid var(--mist);padding:10px;text-align:left;vertical-align:top}}.tool th{{font:700 12px Inter,Arial,sans-serif;color:var(--slate);text-transform:uppercase;letter-spacing:.05em}}
.pill{{display:inline-block;background:#EEEBFF;color:var(--vio);border-radius:99px;font:700 11px Inter,Arial,sans-serif;padding:3px 9px}}.pill.free{{background:var(--cloud);color:var(--slate)}}
.tool .muted{{color:var(--slate);font-size:12.5px}}#msg{{font:600 13px Inter,Arial,sans-serif;margin-left:10px}}
.notice{{background:#FFF7E6;border:1px solid #F5D48A;color:#7A4B00;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:14.5px;line-height:1.5}}.notice b{{color:#5C3800}}.notice code{{background:#fff;border:1px solid #F5D48A;border-radius:6px;padding:1px 6px;font-size:13px}}
.err{{display:none;background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C;border-radius:12px;padding:12px 16px;margin-bottom:16px}}
.ok{{color:#0F7A3D}}.bad{{color:#B3261E}}
.status{{display:inline-flex;align-items:center;gap:8px;font:600 13px Inter,Arial,sans-serif;color:var(--slate)}}.status i{{width:10px;height:10px;border-radius:50%;background:var(--mist);display:inline-block}}.status.on i{{background:#22C55E}}.status.off i{{background:#F59E0B}}
</style>
{extra_head}
</head>
<body>
<header class="top"><div class="wrap nav">{LOGO}<nav aria-label="Main"><a href="/">Site</a><a href="{APP}">App</a><a href="/backoffice/">Back office</a><a href="/app/analytics.html">Analytics</a></nav></div></header>
<main class="tool">
{body}
</main>
</body>
</html>
'''
NOT_CONNECTED='''<div class="notice" id="notconnected" hidden><b>Not connected yet.</b> The MeetingBrand Supabase project has not been created, so this page has no database to talk to. Once the owner creates it (org <code>companycard</code>, region Frankfurt, name <code>meetingbrand</code>), put its URL and anon key in <code>branded-background/engine/mb-config.json</code>, run <code>python3 gen-site.py</code> and this page connects on the next deploy.</div>'''
backoffice=f'''
<h1>Meeting<span>Brand</span> · Back office</h1>
<p class="sub">Workspaces &amp; data management. Deletions are permanent and remove the login, the workspace row, its brand kit, backgrounds, invites and directory data. <span class="status" id="conn"><i></i><span>checking…</span></span></p>
{NOT_CONNECTED}
<div class="tcard" id="signinCard">
<label>Owner sign-in (the RPCs are granted to signed-in users only)</label>
<div class="row"><input id="email" type="email" placeholder="owner email" autocomplete="username"><input id="pw" type="password" placeholder="password" autocomplete="current-password"><button id="btnSignin" onclick="signIn()">Sign in</button><button class="ghost" id="btnSignout" onclick="signOut()" hidden>Sign out</button><span id="who" class="muted"></span></div>
</div>
<div class="tcard">
<label>Owner key</label>
<div class="row"><input id="key" type="password" placeholder="mb-owner-…" autocomplete="off"><button id="btnLoad" onclick="saveKeyAndLoad()">Load workspaces</button><span id="msg"></span></div>
<p class="muted" style="margin:8px 0 0">The key is the row in <code>priv.owner_keys</code>; it is kept in this browser only.</p>
</div>
<div class="tcard" id="listCard" hidden>
<div class="row" style="justify-content:space-between"><b id="count"></b><button class="ghost" onclick="load()">↻ Refresh</button></div>
<table id="tbl"><thead><tr><th>Workspace / domain</th><th>Plan</th><th>Users</th><th>Backgrounds</th><th>Created</th><th></th></tr></thead><tbody id="rows"></tbody></table>
</div>
<script>
(function(){{
const $=id=>document.getElementById(id);
const C=window.__MB||{{}}; const SUPA=(C.supabaseUrl||'').replace(/\\/$/,''); const ANON=C.supabaseAnonKey||'';
const CONNECTED=!!(SUPA&&ANON);
const KEYLS='mb_owner_key', TOKSS='mb_owner_token';
$('key').value=localStorage.getItem(KEYLS)||'';
function msg(t,ok){{$('msg').textContent=t;$('msg').className=ok?'ok':'bad';}}
function esc(s){{return String(s==null?'':s).replace(/[&<>"']/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));}}
function setConn(){{const el=$('conn'); el.className='status '+(CONNECTED?'on':'off'); el.querySelector('span').textContent=CONNECTED?('connected · '+SUPA.replace(/^https?:\\/\\//,'')):'OFFLINE — not connected yet';}}
function token(){{try{{return sessionStorage.getItem(TOKSS)||''}}catch(e){{return ''}}}}
async function rpc(fn,body){{
 if(!CONNECTED) throw 'OFFLINE: no Supabase project configured';
 const t=token(); if(!t) throw 'Sign in first — owner RPCs are granted to authenticated users only';
 const r=await fetch(SUPA+'/rest/v1/rpc/'+fn,{{method:'POST',headers:{{'Content-Type':'application/json','apikey':ANON,'Authorization':'Bearer '+t,'Content-Profile':(window.__MB.schema||'public'),'Accept-Profile':(window.__MB.schema||'public')}},body:JSON.stringify(body)}});
 const txt=await r.text(); let j; try{{j=txt?JSON.parse(txt):null}}catch(e){{j=null}}
 if(!r.ok) throw (j&&(j.message||j.error||j.msg))||('HTTP '+r.status);
 return j;
}}
window.signIn=async function(){{
 if(!CONNECTED){{msg('OFFLINE — nothing to sign in to');return}}
 msg('Signing in…',1);
 try{{
  const r=await fetch(SUPA+'/auth/v1/token?grant_type=password',{{method:'POST',headers:{{'Content-Type':'application/json','apikey':ANON}},body:JSON.stringify({{email:$('email').value.trim(),password:$('pw').value}})}});
  const j=await r.json(); if(!r.ok||!j.access_token) throw (j.error_description||j.msg||j.error||('HTTP '+r.status));
  sessionStorage.setItem(TOKSS,j.access_token); $('pw').value='';
  $('who').textContent='signed in as '+(j.user&&j.user.email||''); $('btnSignout').hidden=false; msg('Signed in ✓',1);
 }}catch(e){{msg(String(e));}}
}};
window.signOut=function(){{sessionStorage.removeItem(TOKSS);$('who').textContent='';$('btnSignout').hidden=true;$('listCard').hidden=true;msg('Signed out',1);}};
window.saveKeyAndLoad=function(){{localStorage.setItem(KEYLS,$('key').value.trim());load();}};
window.load=async function(){{
 msg('Loading…',1);
 try{{
  const accounts=await rpc('owner_list_accounts',{{k:$('key').value.trim()}})||[];
  const rows=accounts.map(a=>{{const label=a.domain||a.name||a.company||a.id; const users=(a.users||[]);
   return `<tr>
   <td><b>${{esc(a.name||a.company||'—')}}</b><div class="muted">${{esc(a.domain||'')}}</div><div class="muted">${{esc(a.id)}}</div></td>
   <td><span class="pill ${{(a.plan||'free')==='free'?'free':''}}">${{esc(a.plan||'free')}}</span></td>
   <td>${{users.map(u=>`${{esc(u.email||'')}} <span class="pill">${{esc(u.role||'')}}</span>`).join('<br>')||'—'}}</td>
   <td>${{esc(a.backgrounds!=null?a.backgrounds:(a.signatures!=null?a.signatures:'—'))}}</td>
   <td class="muted">${{esc((a.created_at||'').slice(0,10))}}</td>
   <td><button class="danger" data-id="${{esc(a.id)}}" data-label="${{esc(label)}}">Delete</button></td></tr>`}}).join('');
  $('rows').innerHTML=rows||'<tr><td colspan="6" class="muted">No workspaces.</td></tr>';
  $('rows').querySelectorAll('button.danger').forEach(b=>b.addEventListener('click',()=>del(b.dataset.id,b.dataset.label)));
  $('count').textContent=accounts.length+' workspaces'; $('listCard').hidden=false; msg('Loaded ✓',1);
 }}catch(e){{msg(String(e));}}
}};
async function del(id,label){{
 const typed=prompt('This permanently deletes the workspace, its users, brand kit, backgrounds and data.\\n\\nType the workspace identifier to confirm:\\n'+label);
 if(typed===null) return;
 if(typed.trim()!==label){{msg('Confirmation text did not match — nothing deleted');return}}
 try{{const n=await rpc('owner_delete_account',{{k:$('key').value.trim(),acc:id}}); msg('Deleted ✓ ('+n+' users removed)',1); load();}}catch(e){{msg(String(e));}}
}}
setConn();
if(!CONNECTED){{$('notconnected').hidden=false; ['btnSignin','btnLoad','email','pw','key'].forEach(i=>$(i).disabled=true); msg('OFFLINE — waiting for the Supabase project');}}
else if(token()){{$('btnSignout').hidden=false;$('who').textContent='session restored';}}
document.body.dataset.connected=CONNECTED?'1':'0';
}})();
</script>'''
analytics=f'''
<div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:18px">
<div><h1>Product <span>funnel</span></h1><p class="sub" style="margin:0">signup → brand fetched → background generated → downloaded → deployed, then the money path. <span class="status" id="conn"><i></i><span>checking…</span></span></p></div>
<div class="row" id="ranges"><button class="ghost rbtn" data-d="1" type="button">Today</button><button class="ghost rbtn" data-d="7" type="button">7 days</button><button class="ghost rbtn" data-d="30" type="button">30 days</button><button class="rbtn on" data-d="36500" type="button">All time</button></div>
</div>
{NOT_CONNECTED}
<div class="notice" id="signin" hidden><b>Sign in required.</b> Open <a href="{APP}#login">the app</a>, log in, then reload this page. Any signed-in user can read the funnel (the RPC returns counts only, never rows).</div>
<div class="err" id="err"></div>
<h2 style="font-size:18px;margin:0 0 10px">Activation</h2>
<div id="funnel"></div>
<h2 style="font-size:18px;margin:26px 0 10px">Money path</h2>
<div id="money"></div>
<div class="tcard" id="otherCard" hidden><b>Other events in the window</b><table><thead><tr><th>Event</th><th>Total</th><th>Uniques</th></tr></thead><tbody id="other"></tbody></table></div>
<p class="muted" style="margin-top:18px;line-height:1.6">Numbers are <b>unique visitors</b> (by device session; signed-in actions count by user). The grey figure in each row is total events. Percentages are conversion from <b>signup</b>. Sessions whose id starts with <code>qa-</code> are test traffic and are excluded by <code>funnel_stats</code>. Data updates live — refresh to see new events.</p>
<style>
.step{{background:#fff;border:1px solid var(--mist);border-radius:16px;padding:16px 20px;margin-bottom:10px;display:grid;grid-template-columns:34px 1fr auto auto;gap:14px;align-items:center}}
.step .n{{width:34px;height:34px;border-radius:50%;background:var(--ink);color:var(--cyan);font-weight:700;display:grid;place-items:center}}
.step .t b{{display:block;color:var(--ink);font-size:16px}}.step .t span{{color:var(--slate);font-size:13px}}
.step .num{{font-weight:800;font-size:28px;color:var(--ink);min-width:70px;text-align:right}}.step .cv{{font-size:13px;font-weight:700;color:var(--slate);min-width:96px;text-align:right}}.step .cv.good{{color:#0F7A3D}}
.bar{{grid-column:2/5;height:8px;border-radius:6px;background:var(--cloud);overflow:hidden}}.bar i{{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--cyan),var(--vio))}}
.step.dim .num,.step.dim .cv{{color:var(--mist)}}
</style>
<script>
(function(){{
const C=window.__MB||{{}}; const SUPA=(C.supabaseUrl||'').replace(/\\/$/,''); const KEY=C.supabaseAnonKey||'';
const CONNECTED=!!(SUPA&&KEY);
const STEPS=[
 ["signup","Signed up","Created an account with a work email + password or Google (base step)"],
 ["brand_fetched","Brand fetched","connectBrand resolved a logo or a palette for the signup domain (source, fetch_ms, logo, colors in props)"],
 ["background_generated","Background generated","The starter set or a new look was rendered in the org's colors and logo"],
 ["background_downloaded","Background downloaded","The delivery event — a 1920×1080 background left the browser"],
 ["deploy_clicked","Deploy clicked","\\"Deploy to all\\" pressed for a platform (platform, count in props)"]
];
const MONEY=[
 ["view_upgrade","Viewed upgrade","Opened the plans view"],
 ["pay_intent","Pay intent","Chose a plan and billing period (plan, billing, value, per_month, currency)"],
 ["pay_click","Pay click","Pressed pay — mock:true until a payment processor exists; the CEO 'first non-mock pay_click' rule applies"]
];
const $=id=>document.getElementById(id);
function setConn(){{const el=$('conn'); el.className='status '+(CONNECTED?'on':'off'); el.querySelector('span').textContent=CONNECTED?('connected · '+SUPA.replace(/^https?:\\/\\//,'')):'OFFLINE — not connected yet';}}
function render(target,steps,by,base,dim){{
 let html='';
 steps.forEach((s,i)=>{{
  const d=by[s[0]]||{{total:0,uniques:0}}; const has=!dim&&by[s[0]];
  const pct=base?Math.round(d.uniques/base*100):0; const w=base?Math.max(2,d.uniques/base*100):2;
  html+='<div class="step'+(dim?' dim':'')+'"><div class="n">'+(i+1)+'</div><div class="t"><b>'+s[1]+'</b><span>'+s[2]+'</span></div>'
   +'<div class="cv'+(has&&i>0&&pct>=20?' good':'')+'">'+(dim?'—':(i===0&&target==='funnel'?(d.total+' total'):(pct+'% · '+d.total+' total')))+'</div>'
   +'<div class="num">'+(dim?'—':d.uniques)+'</div><div class="bar"><i style="width:'+(dim?2:w)+'%"></i></div></div>';
 }});
 $(target).innerHTML=html;
}}
function draw(rows){{
 const by={{}}; (rows||[]).forEach(r=>{{by[r.event]=r}});
 const base=(by.signup||{{}}).uniques||0;
 render('funnel',STEPS,by,base,false); render('money',MONEY,by,base,false);
 const known=new Set(STEPS.concat(MONEY).map(s=>s[0]));
 const other=(rows||[]).filter(r=>!known.has(r.event)).sort((a,b)=>b.total-a.total);
 $('other').innerHTML=other.map(r=>'<tr><td><code>'+r.event+'</code></td><td>'+r.total+'</td><td>'+r.uniques+'</td></tr>').join('');
 $('otherCard').hidden=!other.length;
}}
function hasSession(){{
 try{{const ref=(SUPA.match(/^https?:\\/\\/([^.]+)\\./)||[])[1]; return !!(ref&&localStorage.getItem('sb-'+ref+'-auth-token'));}}catch(e){{return false}}
}}
function load(days){{
 if(!CONNECTED) return;
 fetch(SUPA+'/rest/v1/rpc/funnel_stats',{{method:'POST',headers:{{apikey:KEY,'Content-Type':'application/json','Content-Profile':(window.__MB.schema||'public'),'Accept-Profile':(window.__MB.schema||'public')}},body:JSON.stringify({{p_days:days}})}})
 .then(r=>r.json()).then(rows=>{{ if(!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0,160)); draw(rows); $('err').style.display='none'; }})
 .catch(e=>{{$('err').textContent='Could not load stats: '+e.message; $('err').style.display='block';}});
}}
document.querySelectorAll('.rbtn').forEach(b=>b.addEventListener('click',()=>{{document.querySelectorAll('.rbtn').forEach(x=>{{x.classList.remove('on');x.classList.add('ghost')}}); b.classList.add('on'); b.classList.remove('ghost'); load(+b.dataset.d);}}));
setConn(); document.body.dataset.connected=CONNECTED?'1':'0';
if(!CONNECTED){{ $('notconnected').hidden=false; render('funnel',STEPS,{{}},0,true); render('money',MONEY,{{}},0,true); document.querySelectorAll('.rbtn').forEach(b=>b.disabled=true); }}
else if(!hasSession()){{ $('signin').hidden=false; render('funnel',STEPS,{{}},0,true); render('money',MONEY,{{}},0,true); }}
else load(36500);
}})();
</script>'''
for path,(t,b,p) in {"backoffice/index.html":("Back office — MeetingBrand",backoffice,"/backoffice/"),"app/analytics.html":("Funnel analytics — MeetingBrand",analytics,"/app/analytics.html")}.items():
    os.makedirs(os.path.dirname(path),exist_ok=True)
    open(path,"w",encoding="utf-8").write(relativize(tool_layout(t,b,p),path))
print("tool pages:", "backoffice/index.html app/analytics.html", "->", "CONNECTED" if CONNECTED else "OFFLINE ('not connected yet' state)")
WRITE_CNAME=True  # flip to True (and push) once GoDaddy DNS points at GitHub Pages; until then the preview lives at porshianboti-star.github.io/meetingbrand-site/
if WRITE_CNAME: open("CNAME","w").write(DOMAIN+"\n")
elif os.path.exists("CNAME"): os.remove("CNAME")
open(".nojekyll","w").write("")
print("site generated:", sorted(p for p in pages))
