#!/usr/bin/env python3
"""MeetingBrand marketing site generator — static HTML, no build step, GitHub Pages. Run: python3 gen-site.py
Brand: the complete kit (brand-final-v3): Deep Ink #031436 · Signal Violet #5739FB · Pulse Cyan #00BDDF · Cloud · Slate · Mist · Inter.
Copy: 04-messaging/website-copy.md + messaging-framework.md. V94-9 (2026-09-30): every platform claim says what the product does TODAY
(Teams via the MeetingBrand Agent, Meet via the Chrome extension, Zoom + directory sync coming; the unbuilt fourth platform is not named anywhere)."""
import os, datetime, json, glob, re, shutil, hashlib
INK="#031436"; VIO="#5739FB"; VIOH="#4528E8"; CYAN="#00BDDF"; CLOUD="#F5F7FB"; SLATE="#667085"; MIST="#DDE3EE"; WHITE="#FFFFFF"
DOMAIN="meetingbrand.com"; SITE="https://meetingbrand.com"; SUPPORT="support@meetingbrand.com"; APP="/app/"
TODAY=datetime.date(2026,9,8).strftime("%B %-d, %Y")
BB="/Users/motty/branded-background"
# ---------- v97 (daily rooms): the room list, the product build and the facts date are READ from the product build /app/ will serve
# (the highest gated outputs/presence-product-demo-vNN.html, or MB_APP_PIN) — nothing is hand-edited when a daily room ships.
def pick_app():
    cands=[]
    for p in glob.glob(f"{BB}/outputs/presence-product-demo-v*.html"):
        m=re.search(r"-v(\d+)\.html$",p)
        if m: cands.append((int(m.group(1)),p))
    pin=os.environ.get("MB_APP_PIN")            # MB_APP_PIN=76 python3 gen-site.py -> deploy that version even if newer builds exist in outputs/
    if pin: cands=[c for c in cands if c[0]<=int(pin)]
    f=os.environ.get("MB_APP_FILE")             # a SITE DRY RUN of an unshipped build (e.g. add-room --dry): MB_APP_FILE=<dir>/presence-product-demo-v98.html MB_ROOMS_SRC=<dir>/rooms — never commit its output
    if f: return (int(re.search(r"-v(\d+)\.html$",f).group(1)),f)
    return max(cands) if cands else (None,None)
APP_N,APP_SRC=pick_app()
_APP_HTML=open(APP_SRC if APP_SRC else "app/index.html",encoding="utf-8").read()
def _product_rooms(h):
    a=h.index("const SCENES=["); b=h.index("\n];",a)
    built=[(m.group(1),m.group(2)) for m in re.finditer(r'\n \{id:"([a-z0-9]+)",name:"([^"]*)",src:',h[a:b])]
    A_="const DAILY_ROOMS=/*mb-daily-rooms*/"; B_="/*/mb-daily-rooms*/;"
    daily=json.loads(h[h.index(A_)+len(A_):h.index(B_)]) if A_ in h else []
    return built,daily
BUILT_ROOMS,DAILY_ROOMS=_product_rooms(_APP_HTML)   # [(id,name)] x 22, then the daily rooms [{id,name,src,logo,walls,row,added,v}]
N_ROOMS=len(BUILT_ROOMS)+len(DAILY_ROOMS)
PRODUCT_BUILD=re.search(r'<meta name="mb-version" content="(v\d+)">',_APP_HTML).group(1)   # the /app/ build the facts are read from (SCENES + DAILY_ROOMS = rooms, STYLES = 14 treatments, STARTER = 3 looks)
_PD=re.search(r"\nversion: v\d+ \((\d{4})-(\d\d)-(\d\d)\)\n",_APP_HTML)
FACTS_DATE=max(datetime.date(2026,10,10),datetime.date(*map(int,_PD.groups())) if _PD else datetime.date(2026,10,10))   # the facts change with the build (a daily room changes the room count) -> the build's own date
FACTS_DATE_STR=FACTS_DATE.strftime("%B %-d, %Y")
PRIVACY_DATE=datetime.date(2026,9,30)  # the privacy page changed on this date (V94-9: platform list + builder storage + deletion by request)
TERMS_DATE=datetime.date(2026,9,30)    # the terms changed on this date (V94-9: third-party platform list)
# ---------- cloud config: ONE source of truth, BB/engine/mb-config.json (read by build-vNN.py and by this generator).
# Empty supabaseUrl/supabaseAnonKey = the Supabase project does not exist yet -> every cloud page renders its "not connected yet" state.
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
PLATFORMS="Microsoft Teams, Google Meet and Zoom"
# V94-9 one voice: the delivery state of each platform TODAY, read from product build v93 (Agent card, Meet block renderExtConnect, the
# 'Coming soon' chooser cards). Every hero/step/FAQ/llms.txt sentence about delivery is built from these strings.
DELIVERY_TODAY="Microsoft Teams via the MeetingBrand Agent, Google Meet via the MeetingBrand Chrome extension; Zoom and directory sync are coming"
MEET_TODAY="today from the admin's own browser, and for every employee after the extension's Chrome Web Store listing"
# SEO batch 1 (2026-10-19, skill meetingbrand-seo §1 priority 1): one landing page per head term. Listed here because the sitewide footer
# links all of them (a page linked only from topical pages stayed "unknown to Google" on the sister product).
LANDING_LINKS=[("/teams-background-with-logo/","Teams background with logo"),("/zoom-background-with-logo/","Zoom background with logo"),
               ("/google-meet-background-with-logo/","Google Meet background with logo"),("/virtual-background-generator/","Virtual background generator"),
               # SEO batch 2 (2026-10-20, priority 2)
               ("/teams-custom-background-without-premium/","Teams custom background without Premium"),("/deploy-teams-backgrounds-intune/","Deploy Teams backgrounds with Intune"),
               ("/zoom-background-with-name-and-title/","Zoom background with name and title"),("/branded-virtual-background/","Branded virtual background")]
INDEXNOW_KEY="98dbdcee2efbd8cb930743fa951caddb"   # served at /<key>.txt; ~/ceo/tools/indexnow.py site "meetingbrand"

# ---------- GEO (2026-09-27): ONE source for every product fact an answer engine may quote. Each fact is written once here and rendered
# identically on the home page, /docs/, /support/, llms.txt and the FAQPage JSON-LD (json.dumps of the same strings). Read the shipped build
# before changing a number: SCENES (rooms), STYLES (sign treatments), STARTER (starter set) live in BB/outputs/presence-product-demo-vNN.html.
import html as _html
DEFINITION=("MeetingBrand is a web application that creates branded virtual backgrounds for video meetings from a company's website. "
 "An admin signs up with a work email; MeetingBrand fetches the company's public logo and brand colors from that domain, mounts the logo as a physical sign in any of "+str(N_ROOMS)+" built-in office rooms, "
 "adds an optional name bar with each employee's name and title, and exports every background as a 1920×1080 image that works in Microsoft Teams, Google Meet, Zoom and any other meeting app that accepts custom backgrounds. "
 "Delivery is built in for Microsoft Teams through the MeetingBrand Agent and for Google Meet through the MeetingBrand Chrome extension ("+MEET_TODAY+"); Zoom delivery and directory sync are coming. "
 "MeetingBrand is free during early access and is made by the team behind CompanyCard (company-card.com) and ProSignature (prosignature.co).")
assert f"any of {N_ROOMS} built-in office rooms" in DEFINITION   # v95/v96: the definition sentence names the room count; v97: computed from the product
BUILTIN_ROOMS_V96=["City open space","Walnut executive wall","Tel Aviv sunset window","Stone & slats lounge","Tel Aviv beach window","Concrete gallery night","Manhattan skyline window","Forest window",
       "Concrete corner loft","Brick creative loft","Navy executive study","Marble reception","Glass office corridor","Travertine lounge","Concrete open office","Oak skyline office",
       "Charcoal wall oak office","Arched-window loft lounge","Sunset tower office","Alpine lake executive office",
       "Farmhouse meadow studio","Stone farmhouse study"]
TREATMENTS=["Wall sign","Wall sticker","Silver letters","Brass letters","Oak letters","Washed wood","Black letters","Illuminated","Glass signage","Metal plaque","Backlit plate","3D acrylic","LED signage","Wallpaper"]
assert [n for _,n in BUILT_ROOMS]==BUILTIN_ROOMS_V96,("the 22 built-in rooms never change",[n for _,n in BUILT_ROOMS])
ROOMS=BUILTIN_ROOMS_V96+[r["name"] for r in DAILY_ROOMS]   # v97: + one daily room per product version, read from the product
ROOM_IDS=[i for i,_ in BUILT_ROOMS]+[r["id"] for r in DAILY_ROOMS]
assert len(ROOMS)==N_ROOMS==len(set(ROOM_IDS)),len(ROOMS)
assert f"any of {len(ROOMS)} built-in office rooms" in DEFINITION
STARTERS=["Concrete corner loft","Brick creative loft","Navy executive study"]
PLATFORM_STATUS={
 "teams":"Live. The MeetingBrand Agent for Windows and macOS places the company's background in each person's Teams background gallery; IT installs it once with the Intune or Jamf script generated in the app, and people added by CSV are matched by e-mail. The employee picks the background once and Teams keeps it. The builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt. Directory sync from Microsoft 365 is coming.",
 "meet":"Live from the admin's browser. The MeetingBrand Chrome extension applies the branded background to the camera in Google Meet; today it is connected from the admin's own browser, because enrollment uses the admin's key. For every employee it follows the Chrome Web Store listing, which is not published yet: then an admin force-installs it for managed Chrome from the Google Admin console. Until then the extension is a developer package in the app.",
 "zoom":"Coming. The Zoom integration — uploading the background into each employee's own Zoom background library — is built and awaits approval of its Zoom App Marketplace app. Today each person downloads the 1920×1080 PNG and sets it once in Zoom.",
}
FACTS=[
 ("Category","Branded virtual background software for video meetings (Microsoft Teams, Google Meet, Zoom)."),
 ("Input","Your company website. Sign up with a work email and MeetingBrand fetches the public logo and brand colors from that domain; you can also upload a logo."),
 ("Rooms",f"{len(ROOMS)} built-in office rooms: "+", ".join(ROOMS)+"."),
 ("Sign treatments",f"{len(TREATMENTS)}: "+", ".join(TREATMENTS)+"."),
 ("Starter set",f"{len(STARTERS)} backgrounds rendered automatically in your brand at signup: "+", ".join(STARTERS)+"."),
 ("Name bar","Optional, per employee: name, title, department and company, on the downloaded background. The backgrounds the Agent and the extension deliver are the company look without a personal name bar."),
 ("Output","1920×1080 PNG download per background, for any meeting app that accepts custom backgrounds."),
 ("Microsoft Teams",PLATFORM_STATUS["teams"]),
 ("Google Meet",PLATFORM_STATUS["meet"]),
 ("Zoom",PLATFORM_STATUS["zoom"]),
 ("People","Add people by CSV (name, email, title, department) from My team → Upload users. Directory sync from Microsoft 365 (Entra ID), Google Workspace and Zoom is coming."),
 ("Share pages","Any background can be published as a public page at meetingbrand.com/b/?s=<slug> — “<Company> — official meeting background” — with a preview, the date and an embed badge for the company website. The full-resolution file stays inside the workspace."),
 ("Price","Free during early access."),
 ("Data","Application data is stored with Supabase in Frankfurt (EU) with row-level access controls; this website is hosted on GitHub Pages. MeetingBrand never reads meeting audio, video, chat or calendars."),
 ("Company",f"Made by the team behind CompanyCard (company-card.com, digital business cards) and ProSignature (prosignature.co, email signatures). Support: {SUPPORT}."),
 ("Verified",f"{FACTS_DATE_STR}, against product build {PRODUCT_BUILD} at {DOMAIN}{APP}."),
]
FAQ=[
 ("What is MeetingBrand?",DEFINITION),
 ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
 ("Which meeting platforms does MeetingBrand deliver to?","Today: Microsoft Teams, through the MeetingBrand Agent (installed by Intune or Jamf), and Google Meet, through the MeetingBrand Chrome extension ("+MEET_TODAY+"). Zoom is coming: the integration is built and awaits approval of its Zoom App Marketplace app. Directory sync is coming; people are added by CSV today. Every background can also be downloaded as a 1920×1080 PNG and used in any meeting app that accepts custom backgrounds."),
 ("How does MeetingBrand create a background from a website?",f"You sign up with a work email. MeetingBrand fetches your company's public logo and brand colors from that domain, renders {len(STARTERS)} starter backgrounds in your brand automatically, and lets you pick from {len(ROOMS)} built-in rooms and {len(TREATMENTS)} sign treatments — brass, oak, backlit, LED, glass and more — with your logo mounted as a physical sign in the scene. Every background exports as a 1920×1080 image."),
 ("Can an employee's background be applied automatically, without the employee doing anything?","Only on Google Meet, where the MeetingBrand Chrome extension applies the branded background to the camera automatically ("+MEET_TODAY+"). On Microsoft Teams the MeetingBrand Agent places the image in the person's background gallery and they pick it once; Teams keeps it. No meeting platform lets a third party switch a person's active background by API, so MeetingBrand does not claim to."),
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
<footer class="foot"><div class="wrap"><div class="fgrid"><div>{LOGO_REV}<p class="tag">Every meeting. On brand.</p></div><div><h4>Product</h4><a href="/#how">How it works</a><a href="/rooms/">Background rooms</a><a href="/#platforms">Platforms</a><a href="{APP}">Create MeetingBrand</a><a href="/small-business/">For small businesses</a><a href="/docs/">Documentation</a></div><div><h4>Backgrounds</h4>{"".join(f'<a href="{u}">{n}</a>' for u,n in LANDING_LINKS)}</div><div><h4>Company</h4><a href="/support/">Support</a><a href="/privacy/">Privacy policy</a><a href="/terms/">Terms of service</a></div><div><h4>Contact</h4><a href="mailto:{SUPPORT}">{SUPPORT}</a><p class="muted small">Sister products: <a href="https://company-card.com">company-card.com</a> · <a href="https://prosignature.co">prosignature.co</a></p></div></div><p class="muted small">© 2026 MeetingBrand. Zoom is a trademark of Zoom Video Communications, Inc.; Microsoft Teams of Microsoft Corporation; Google Meet of Google LLC. MeetingBrand is not affiliated with or endorsed by them.</p></div></footer>
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
  <p class="lead">MeetingBrand creates realistic virtual backgrounds from your company website and delivers the approved ones to your team: {DELIVERY_TODAY}.</p>
  <div class="cta"><a class="btn big" href="{APP}">Create MeetingBrand</a><a class="btn ghost big" href="#how">See how it works</a></div>
  <p class="trust">Free during early access. No design work. No off-brand calls.</p>
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
    <div class="feature"><h2>Roll out once. Stay consistent everywhere.</h2><p>Approve the company look in one place. Where the MeetingBrand Agent (Teams) or the Chrome extension (Meet) is installed, a new approved background reaches people without sending files or setup instructions — and every background also downloads as a 1920×1080 file for any meeting app.</p></div>
  </div>
  <div class="scenes">
    <figure><img src="/assets/virtual-background-corner-office-loft.jpg" alt="Company sign on a concrete wall in a corner office over the city — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Concrete corner loft</figcaption></figure>
    <figure><img src="/assets/virtual-background-sunset-window.jpg" alt="Company sign beside a sunset window over the Tel Aviv beach — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Tel Aviv sunset window</figcaption></figure>
    <figure><img src="/assets/virtual-background-marble-reception.jpg" alt="Company sign on a marble reception wall — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Marble reception</figcaption></figure>
  </div>
  <div class="scenes pair">
    <figure><img src="/assets/virtual-background-farmhouse-meadow-studio.jpg" alt="Company sign on a white wall in a farmhouse studio with glass doors open onto green meadows — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Farmhouse meadow studio</figcaption></figure>
    <figure><img src="/assets/virtual-background-stone-farmhouse-study.jpg" alt="Company sign on a white wall in a stone farmhouse study overlooking a wheat field — a MeetingBrand background" width="1600" height="900" loading="lazy"><figcaption>Stone farmhouse study</figcaption></figure>
  </div>
  <p class="more"><a href="/rooms/">See all {N_ROOMS} rooms →</a></p>
</div></section>

<section id="how" class="band alt"><div class="wrap">
  <h2>How it works</h2>
  <p class="lead narrow">From domain to rollout in minutes.</p>
  <div class="steps">
    <div class="step"><span class="n">1</span><h3>Connect your brand</h3><p>Type your domain. MeetingBrand pulls the logo and colors and mounts your sign on real office scenes — brushed metal, brass, oak, backlit, LED and more.</p></div>
    <div class="step"><span class="n">2</span><h3>Pick the looks</h3><p>Choose the scenes and sign treatments for the company. Add a name bar with each person's name and title.</p></div>
    <div class="step"><span class="n">3</span><h3>Add your people</h3><p>Upload a CSV with name, email, title and department — no employee has to sign up for anything. Directory sync from Microsoft 365, Google Workspace and Zoom is coming.</p></div>
    <div class="step"><span class="n">4</span><h3>Deliver it</h3><p>Teams: IT installs the MeetingBrand Agent once (Intune or Jamf); each person picks it once. Meet: the Chrome extension applies it — from the admin's browser today, for everyone after its store listing. Zoom: coming; download the file meanwhile.</p></div>
  </div>
</div></section>

<section id="platforms" class="band"><div class="wrap">
  <h2>What "delivered" means on each platform</h2>
  <p class="lead narrow">No meeting platform lets a third party switch a person's active background by API — so we tell you exactly what happens where.</p>
  <div class="cards">
    <div class="card"><h3>Microsoft Teams</h3><p>Today: the MeetingBrand Agent, installed once by IT through Intune or Jamf, places the background in the Teams gallery on Windows and Mac; each person picks it once and Teams keeps it. Coming: directory sync from Microsoft 365. Teams Premium tenants can also upload the image in the Teams admin center and require it.</p>{status_p("teams")}</div>
    <div class="card"><h3>Google Meet</h3><p>Today: the MeetingBrand Chrome extension applies the background to the camera automatically, in the admin's own browser. Coming: force-install for every managed Chrome from the Google Admin console once the extension is listed on the Chrome Web Store, and directory sync from Google Workspace.</p>{status_p("meet")}</div>
    <div class="card"><h3>Zoom</h3><p>Today: each person downloads the 1920×1080 file and sets it once in Zoom. Coming: MeetingBrand uploads it straight into each employee's own Zoom background library; they pick it once and it stays.</p>{status_p("zoom")}</div>
    <div class="card"><h3>Any other meeting app</h3><p>Every background downloads as a 1920×1080 PNG, with the optional name bar, and works in any meeting app that accepts a custom background image.</p></div>
  </div>
</div></section>

<section class="band alt"><div class="wrap two">
  <div><h2>Built for every customer-facing team.</h2><p>Give Sales, Support, Recruiting, Leadership and distributed teams a consistent presence in every call. Marketing sets the look, IT installs the MeetingBrand Agent once, and every new hire can be on brand from their first call.</p><p>Small business or self-employed? <a href="/small-business/">MeetingBrand for small businesses</a>: the price for a 5-person team, the setup steps and the answers to the usual questions.</p></div>
  <div><h2>Your data stays yours.</h2><p>We use the names, emails, titles and departments you add to personalise backgrounds, and nothing else. Ask us and we delete your workspace. Details in the <a href="/privacy/">privacy policy</a>.</p></div>
</div></section>

<section id="faq" class="band"><div class="wrap prose faq">
  <h2>Frequently asked questions</h2>
  {faq_html()}
  {VERIFIED_LINE}
</div></section>

<section id="early-access" class="band dark"><div class="wrap narrow center">
  <h2>Update once. Refresh everywhere.</h2>
  <p class="lead">Try the brand-set builder now — free during early access — or write to us and we will set your company up personally.</p>
  <div class="cta center"><a class="btn big cyan" href="{APP}">Create MeetingBrand</a><a class="btn ghost big onink" href="mailto:{SUPPORT}?subject=MeetingBrand%20early%20access&body=Company%3A%20%0AMeeting%20platform(s)%3A%20%0AEmployees%3A%20">Request early access</a></div>
  <p class="muted small">We reply personally within two business days. No newsletter, no spam.</p>
</div></section>
'''
thanks=f'''<section class="band"><div class="wrap narrow"><h1>Thanks — we got it.</h1><p class="lead">We will reply from {SUPPORT} within two business days. Meanwhile, the <a href="/docs/">documentation</a> shows what setup looks like on each platform.</p><a class="btn" href="/">Back to MeetingBrand</a></div></section>'''
# ---------- docs
docs=f'''
<section class="band"><div class="wrap prose">
<h1>Documentation</h1>
<p class="lead">How MeetingBrand delivers to each platform today, what is coming, what your employees see, and how to remove it. Written for the admin and for IT.</p>
<p>{_t(DEFINITION)}</p>
{facts_table()}
{VERIFIED_LINE}

<h2 id="getting-started">Getting started</h2>
<ol>
<li><strong>Create MeetingBrand</strong> — open <a href="{APP}">the builder</a>, enter your company domain; review the logo, colors, scenes and sign treatments; set the name bar fields (name, title, department, company). Backgrounds are rendered in your browser; your brand kit and the backgrounds you save are stored with your account (see Data and security below).</li>
<li><strong>Add your people</strong> — My team → Upload users → upload a CSV with name, email, title and department. Directory sync from Microsoft 365 (Entra ID), Google Workspace and Zoom is coming; when it opens, MeetingBrand imports your people (name, email, title, department) with the permissions listed below. Write to <a href="mailto:{SUPPORT}">{SUPPORT}</a> to be scheduled for early access.</li>
<li><strong>Deliver</strong> — Microsoft Teams: IT installs the MeetingBrand Agent with the Intune or Jamf script generated in My team (it carries your organization's enrollment key); each device is matched to a person by e-mail. Google Meet: the MeetingBrand Chrome extension, {MEET_TODAY}. Zoom and any other app: download the 1920×1080 PNG and set it once. My team shows each person's status: delivered, waiting for a restart, needs the employee's one click, or blocked (with the reason).</li>
</ol>

<h2 id="zoom">Zoom</h2>
{status_p("zoom")}
<p><strong>Today</strong>: each person downloads the 1920×1080 PNG from MeetingBrand and adds it once under Zoom Settings → Video &amp; effects → Virtual backgrounds; Zoom remembers it.</p>
<p><strong>When the Zoom integration opens — permissions it will request</strong> (admin-managed app): list users; upload and delete virtual background files for users; read and update account settings related to virtual backgrounds. A Zoom account owner or admin authorizes once for the whole account; employees see no prompt.</p>
<p><strong>What will happen then</strong>: each active employee's branded background is uploaded into their own Zoom virtual-background library (Zoom allows up to 10 files per user; we manage ours). After the upload the employee signs out and back in to Zoom, opens Settings → Video &amp; effects → Virtual backgrounds and picks the branded image once — Zoom remembers it. Admins can additionally turn on "Require users to always use virtual background" and disable personal uploads so the branded image is the only non-stock choice.</p>
<p><strong>Removing MeetingBrand</strong> (once the integration is added): Zoom App Marketplace → Manage → Added Apps → MeetingBrand → Remove. MeetingBrand deletes the background files it uploaded and the directory data it synced for that account within 30 days (immediately on request to {SUPPORT}).</p>

<h2 id="teams">Microsoft Teams</h2>
{status_p("teams")}
<p><strong>What happens today</strong>: Teams has no API for meeting backgrounds, so delivery goes to the employee's device through the <strong>MeetingBrand Agent</strong>, a small helper for Windows and macOS. IT installs it once with the Intune (Windows) or Jamf (macOS) script generated in My team, which carries your organization's enrollment key (it can also be installed by hand with that key). The Agent matches each device to a person by the signed-in e-mail, so people added by CSV are covered. The builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt. After Teams restarts, the branded image appears under Effects and avatars → Backgrounds; the employee selects it once and Teams keeps it, and later changes arrive without another step. Tenants with <strong>Teams Premium</strong> can also upload the downloaded image in the Teams admin center and set it as required.</p>
<p><strong>Coming — directory sync from Microsoft 365</strong>. Permissions it will request (Microsoft Entra ID, multitenant): <em>User.Read.All</em> (application) to read your directory — names, emails, job titles, departments — plus sign-in for the admin. A tenant administrator grants consent once; employees see no prompt.</p>
<p><strong>Removing MeetingBrand</strong>: remove the Agent from Add/Remove programs (Windows) or the Applications folder (macOS), and revoke the device in My team. Once directory sync is connected: Entra admin center → Enterprise applications → MeetingBrand → Delete (revokes our access).</p>

<h2 id="meet">Google Meet</h2>
{status_p("meet")}
<p><strong>What happens today</strong>: Meet has no API for backgrounds and does not remember a choice. The MeetingBrand Chrome extension applies the branded background to the camera in Google Meet automatically. Today it is connected from the admin's own browser in My team, because enrollment uses the admin's key; the extension is a developer package in the app until its Chrome Web Store listing is published. Anyone can also download the 1920×1080 PNG and upload it in Meet's backgrounds panel.</p>
<p><strong>Coming</strong>: once the extension is listed on the Chrome Web Store, an admin force-installs it for every managed Chrome from the Google Admin console, so it applies for every employee. Directory sync from Google Workspace will request <em>View users on your domain</em> (Admin SDK Directory, read-only) to import names, emails, titles and departments; a Google Workspace administrator with the Users › Read privilege authorizes once.</p>
<p><strong>Removing MeetingBrand</strong>: remove the extension from Chrome (or, once force-installed, from the Chrome force-install list in the Google Admin console). Once directory sync is connected: Google Admin → Security → API controls → Manage third-party app access → MeetingBrand → Remove.</p>


<h2 id="data">Data and security</h2>
<ul>
<li>We store: admin account details, the people fields you add (name, email, title, department), your brand assets, the rendered background images and delivery records; once directory sync is connected, also the OAuth tokens needed to keep it alive (encrypted at rest).</li>
<li>We never read meeting content, recordings, chats or calendars.</li>
<li>You can request full deletion at any time at <a href="mailto:{SUPPORT}">{SUPPORT}</a>; once directory sync is connected, disconnecting a platform deletes its synced data.</li>
<li>Full details: <a href="/privacy/">Privacy policy</a> · <a href="/terms/">Terms of service</a>.</li>
</ul>
</div></section>'''
# ---------- privacy
privacy=f'''
<section class="band"><div class="wrap prose">
<h1>Privacy policy</h1>
<p class="muted">Effective {PRIVACY_DATE.strftime("%B %-d, %Y")}. This policy explains how MeetingBrand ("MeetingBrand", "we", "us") collects, uses and protects information.</p>
<h2>1. What MeetingBrand does</h2>
<p>MeetingBrand is a business service that creates branded virtual-meeting backgrounds and name bars for a company and delivers them to that company's employees' meeting applications (Microsoft Teams and Google Meet today; Zoom is coming). Our customers are companies; the people whose data we process are their administrators and employees.</p>
<h2>2. Data we collect</h2>
<ul>
<li><strong>Brand-set builder</strong> — the builder at {SITE}{APP} runs in your browser. The domain you type is used to fetch that company's public logo and colors; the images you create are rendered on your device. When you are signed in, the backgrounds you save, their previews and the files prepared for delivery are stored with your account (section 7).</li>
<li><strong>Account data</strong> — the administrator's name, work email and company, given when requesting access or signing up. You can sign up with a work email and password or with Sign in with Google (which shares only your Google email address and basic profile with us). The domain of your work email is used to identify your company and fetch its public brand (section 7).</li>
<li><strong>People data</strong> — the names, email addresses, job titles and departments an administrator adds by CSV. Once directory sync is available and an administrator connects a platform, we import employees' display names, email addresses, job titles, departments and platform user identifiers, using the permissions shown on the platform's consent screen.</li>
<li><strong>Connection data</strong> — once a platform is connected, the OAuth tokens it issues so the connection keeps working. They are encrypted at rest and never shown to anyone.</li>
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
<p>We share data only with the meeting platforms you connect (Zoom Video Communications, Microsoft, Google — to deliver backgrounds and read your directory as authorized) and with our infrastructure providers under data-processing terms (website hosting: GitHub; application database and file storage: Supabase). We disclose data when the law requires it.</p>
<h2>6. Where your data lives</h2>
<p>Account, brand, background, directory and delivery data are stored with our database and file-storage provider, <a href="https://supabase.com/privacy">Supabase</a>, in its Frankfurt (EU) region, protected by industry-standard security and row-level access controls so that each company's data is visible only to that company's users. This website and the application page are hosted on <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub Pages</a>. Usage events (for example that a brand was fetched or a background was downloaded) are recorded with a random device session identifier and, when you are signed in, your user identifier, so we can see where the product works and where it fails; they are never sold or used for advertising.</p>
<h2>7. Account data and deletion</h2>
<p>When you sign up, the domain of your work email (for example <em>acme.com</em>) is used to fetch your company's public logo and colors from its public website and to create your brand kit; nothing is read from your mailbox. Your brand kit and the backgrounds you save are stored with your account so they can be reused, updated and deployed to your people.</p>
<ul>
<li><strong>Deletion by request</strong> — write to <a href="mailto:{SUPPORT}">{SUPPORT}</a> from the email address on the account and we delete it, or send you a copy of your data, within 30 days. Deletion permanently removes your login, your profile and, when you are the last user of your company workspace, the workspace itself with its brand kit, backgrounds, uploaded logos, people data and delivery records. A self-serve delete button in the application is planned.</li>
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
<p class="muted">Effective {TERMS_DATE.strftime("%B %-d, %Y")}. These terms are an agreement between MeetingBrand ("MeetingBrand", "we") and the organization that uses the service ("you").</p>
<h2>1. The service</h2><p>MeetingBrand creates branded virtual-meeting backgrounds and name bars and delivers them to your employees' meeting applications through integrations you authorize. Delivery depends on each platform's capabilities, which we describe in the <a href="/docs/">documentation</a>; where a platform requires an action by the employee, we say so. The brand-set builder is provided as an early-access preview and may change.</p>
<h2>2. Your account and authorizations</h2><p>You confirm that the person connecting a platform is authorized to grant MeetingBrand the permissions shown on that platform's consent screen and to have us process your employees' directory data as described in the <a href="/privacy/">privacy policy</a>. You are responsible for keeping your credentials secure.</p>
<h2>3. Your content</h2><p>You own your logos, brand assets and the backgrounds we render from them. You grant us the rights needed to render, store and deliver them for you. You confirm you have the rights to the logos and images you use.</p>
<h2>4. Acceptable use</h2><p>Do not use the service to deliver content that is unlawful, infringing, deceptive or harassing; do not attempt to access other customers' data; do not resell the service without our written agreement.</p>
<h2>5. Fees</h2><p>Early-access accounts are free during the early-access period. Paid plans, their prices and billing terms will be published on this site before they apply to you; we will not charge you without your agreement.</p>
<h2>6. Third-party platforms</h2><p>Microsoft Teams, Google Meet and Zoom are provided by their owners under their own terms. We are not responsible for changes they make to their products or APIs, and we may adjust or suspend an integration when a platform change requires it.</p>
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
<p>Every integration can be removed from the device, the browser or the platform's own admin console; step-by-step instructions are in the documentation for <a href="/docs/#teams">Microsoft Teams</a>, <a href="/docs/#meet">Google Meet</a> and <a href="/docs/#zoom">Zoom</a>.</p>
<h2>About MeetingBrand</h2>
<p>{_t(DEFINITION)}</p>
<p class="muted small">The full fact sheet (rooms, sign treatments, per-platform delivery status, price, where data lives) is on the <a href="/#what">home page</a> and in the <a href="/docs/">documentation</a>; facts verified {FACTS_DATE_STR}.</p>
</div></section>'''
# ---------- /small-business/ (GEO 2026-09-29): the direct answer to the small-business prompts probed in ChatGPT ("same branded Zoom and Teams
# background with the logo", "tool to make branded virtual backgrounds for a small business team", "free tool ... from our logo for Google Meet and
# Teams"). Every number below is derived from the constants above; the price is the numeric form of the FACTS "Price" row (free during early access).
SMB_DATE=datetime.date(2026,9,29)
SMB_MODIFIED=datetime.date(2026,9,30)  # V94-9: delivery copy made to match the product today
PRICE_PER_PERSON_USD=0                # FACTS "Price" = "Free during early access." -> $0 per person; change BOTH together
SMB_TEAM=5                            # the team size quoted on the page and in llms.txt
SMB_TOTAL_USD=SMB_TEAM*PRICE_PER_PERSON_USD
SMB_MATH=f"{SMB_TEAM} people × ${PRICE_PER_PERSON_USD} per person = ${SMB_TOTAL_USD}"
SMB_WHO="small businesses, self-employed professionals and small teams"
SMB_ANSWER=(f"MeetingBrand gives a small business the same branded virtual background for every employee — your logo mounted as a sign in a realistic office, with each person's name and title — "
 f"for Microsoft Teams, Google Meet and Zoom, built from your company website with no design work. "
 f"It is free during early access, so a {SMB_TEAM}-person team pays ${SMB_TOTAL_USD} ({SMB_MATH}), and there is no seat minimum.")
SMB_SCOPE=("It is made for "+SMB_WHO+". What it does not do: it does not deliver to Zoom automatically yet (the Zoom integration awaits approval of its Zoom App Marketplace app, so in Zoom each person uploads the 1920×1080 image), "
 "the Chrome extension for Google Meet runs "+MEET_TODAY+", "
 "it cannot switch anyone's active background by API because no meeting platform allows that, and it never reads meeting audio, video, chat or calendars.")
SMB_WHY=[
 ("Free for a small team",f"Free during early access: {SMB_MATH}. There is no seat minimum; one person can sign up and create backgrounds."),
 ("No design work",f"Sign up with a work email and MeetingBrand fetches your public logo and brand colors from that domain and renders {len(STARTERS)} starter backgrounds automatically ({', '.join(STARTERS)}). You can also upload a logo."),
 ("Same look, personal name bar","The whole team can use the same branded scene; the optional name bar adds each employee's name, title, department and company."),
 ("Real rooms, not wallpaper",f"{len(ROOMS)} built-in office rooms and {len(TREATMENTS)} sign treatments (brass, oak, backlit, LED, glass and more), with the logo mounted as a physical sign in the scene."),
 ("One file for every meeting app","Every background exports as a 1920×1080 PNG that works in Microsoft Teams, Google Meet, Zoom and any other meeting app that accepts custom backgrounds."),
 ("Delivery built in for Teams and Meet","Microsoft Teams through the MeetingBrand Agent (installed by the Intune or Jamf script generated in the app) and Google Meet through the MeetingBrand Chrome extension ("+MEET_TODAY+"). People are added by CSV (name, email, title, department)."),
]
SMB_STEPS=[
 ("Create your brand",f"Open {DOMAIN}{APP} and sign up with your work email. MeetingBrand fetches your logo and brand colors from your domain and renders {len(STARTERS)} starter backgrounds. With a personal email, type your website instead, or upload a logo."),
 ("Pick the look",f"Choose from {len(ROOMS)} rooms and {len(TREATMENTS)} sign treatments, and turn on the name bar (name, title, department, company)."),
 ("Add your team","My team → Upload users → upload a CSV with name, email, title and department."),
 ("Deliver it","Microsoft Teams: install the MeetingBrand Agent with the Intune or Jamf script generated in the app; each person picks the background once in Teams and Teams keeps it. Google Meet: the MeetingBrand Chrome extension applies the background to the camera automatically, "+MEET_TODAY+"; until then each person can upload the 1920×1080 PNG in Meet. Zoom or any other app: download the 1920×1080 PNG and upload it in that app's background settings."),
]
SMB_FAQ=[
 ("How can a small company give all its employees the same branded Zoom and Teams background with the logo?",
  f"Create the background once in MeetingBrand from your company website: it fetches your logo and brand colors, mounts the logo as a sign in one of {len(ROOMS)} office rooms and adds each employee's name and title. "
  "Add your people by CSV. For Microsoft Teams, the MeetingBrand Agent (installed by the Intune or Jamf script generated in the app) places each person's background in the Teams background gallery; they pick it once and Teams keeps it. "
  "For Zoom, each person uploads the 1920×1080 PNG in Zoom today; automatic Zoom delivery is built and awaits approval of its Zoom App Marketplace app. "
  f"MeetingBrand is free during early access ({SMB_MATH})."),
 ("What tool makes branded virtual backgrounds for a small business team?",
  f"MeetingBrand (meetingbrand.com) is a web application built for this. It creates branded virtual backgrounds from your company website — logo and brand colors — in {len(ROOMS)} built-in office rooms with {len(TREATMENTS)} sign treatments, adds an optional per-employee name bar, "
  "exports 1920×1080 images for Microsoft Teams, Google Meet, Zoom and any app that accepts custom backgrounds, and delivers them to Microsoft Teams (the MeetingBrand Agent) and Google Meet (the MeetingBrand Chrome extension). "
  f"It is free during early access, with no seat minimum."),
 ("Is there a free tool to create a company virtual background from our logo for Google Meet and Teams?",
  f"Yes. MeetingBrand is free during early access. Sign up with your work email and it fetches your logo from your website (or you upload one), renders {len(STARTERS)} starter backgrounds in your brand colors and exports each background as a 1920×1080 PNG that Google Meet and Teams accept. "
  "It also delivers them: the MeetingBrand Chrome extension applies the background automatically in Google Meet ("+MEET_TODAY+"), and the MeetingBrand Agent places it in the Microsoft Teams background gallery."),
 (f"How much does MeetingBrand cost for a {SMB_TEAM}-person team?",
  f"${SMB_TOTAL_USD} during early access: {SMB_MATH}. There is no seat minimum; one person can sign up alone."),
 ("Does MeetingBrand deliver backgrounds to Zoom automatically?",
  "Not yet. The Zoom integration — uploading the background into each employee's own Zoom background library — is built and awaits approval of its Zoom App Marketplace app. Until then, download the 1920×1080 PNG from MeetingBrand and upload it once in Zoom's background settings; Zoom remembers it."),
 ("Can a self-employed person without a company email domain use MeetingBrand?",
  "Yes. Sign up with any email; with a personal address such as Gmail, MeetingBrand asks for your website to fetch the logo and colors, and you can upload a logo instead."),
]
SMB_KEYS=["Input","Rooms","Sign treatments","Starter set","Name bar","Output","People","Microsoft Teams","Google Meet","Zoom","Data"]
SMB_FACTS=[("Made for",SMB_WHO[0].upper()+SMB_WHO[1:]+"."),(f"Price for {SMB_TEAM} people",f"${SMB_TOTAL_USD} during early access ({SMB_MATH})."),("Seat minimum","None. One person can sign up and create backgrounds.")]+[(k,dict(FACTS)[k]) for k in SMB_KEYS]
def smb_facts_table():
    rows="".join(f'<tr><th scope="row">{_t(k)}</th><td>{_t(v)}</td></tr>' for k,v in SMB_FACTS)
    return f'<table class="facts"><caption>MeetingBrand for small businesses, verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}</caption><tbody>{rows}</tbody></table>'
SMB_PATH="/small-business/"
SMB_TITLE="Branded Meeting Backgrounds for Small Businesses — MeetingBrand"
SMB_DESC=f"Branded Zoom, Microsoft Teams and Google Meet backgrounds for small businesses, made from your logo. Free during early access: a {SMB_TEAM}-person team pays ${SMB_TOTAL_USD}."
SMB_LD='<script type="application/ld+json">'+json.dumps({"@context":"https://schema.org","@graph":[
 {"@type":"WebPage","@id":f"{SITE}{SMB_PATH}#webpage","url":f"{SITE}{SMB_PATH}","name":SMB_TITLE,"description":SMB_DESC,"isPartOf":{"@id":f"{SITE}/#site"},"about":{"@id":f"{SITE}/#org"},"datePublished":SMB_DATE.isoformat(),"dateModified":SMB_MODIFIED.isoformat(),"publisher":{"@id":f"{SITE}/#org"}},
 {"@type":"FAQPage","@id":f"{SITE}{SMB_PATH}#faq","mainEntity":[{"@type":"Question","name":q,"acceptedAnswer":{"@type":"Answer","text":a}} for q,a in SMB_FAQ]},
 {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"MeetingBrand","item":f"{SITE}/"},{"@type":"ListItem","position":2,"name":"Small businesses","item":f"{SITE}{SMB_PATH}"}]},
]},ensure_ascii=False,separators=(",",":")).replace("</","<\\/")+'</script>'
smb=f'''
<section class="band"><div class="wrap prose">
<p class="eyebrow">MeetingBrand for small businesses</p>
<h1>Branded meeting backgrounds for small businesses</h1>
<p class="lead">{_t(SMB_ANSWER)}</p>
<p>{_t(SMB_SCOPE)}</p>
<div class="cta"><a class="btn big" href="{APP}">Create MeetingBrand</a><a class="btn ghost big" href="/docs/">Read the documentation</a></div>

<h2 id="why">Why small businesses pick MeetingBrand</h2>
<ul>{"".join(f"<li><strong>{_t(h)}.</strong> {_t(b)}</li>" for h,b in SMB_WHY)}</ul>

<h2 id="setup">How to set it up for your team</h2>
<ol>{"".join(f"<li><strong>{_t(h)}.</strong> {_t(b)}</li>" for h,b in SMB_STEPS)}</ol>

<h2 id="facts">Facts</h2>
{smb_facts_table()}

<div class="faq" id="faq">
<h2>Small-business questions</h2>
{"".join(f'<div class="faq-item"><h3>{_t(q)}</h3><p>{_t(a)}</p></div>' for q,a in SMB_FAQ)}
</div>
{VERIFIED_LINE}
<p class="muted small">Delivery details per platform, permissions and how to remove MeetingBrand: <a href="/docs/">documentation</a>. Questions: <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</p>
</div></section>'''
# ---------- SEO batch 1 (2026-10-19): four landing pages, one per head term (skill meetingbrand-seo §1, priority 1). Every number and every
# platform sentence is built from the constants above (ROOMS, TREATMENTS, STARTERS, PLATFORM_STATUS, FACTS, MEET_TODAY) — one voice. The visible
# FAQ and the FAQPage JSON-LD are rendered from the same (q,a) tuples; _one_voice_guard() re-reads both from the HTML and compares them.
# The CTA opens the real generator at /app/ (no generator page without a generator). Images are the six real product exports in /assets/
# (demo brands ProSignature and MeetingBrand only); each caption must be a room name from ROOMS.
LP_DATE=datetime.date(2026,10,19)   # batch 1; batch-2 entries carry their own date=
R,T,S=len(ROOMS),len(TREATMENTS),len(STARTERS)
F=dict(FACTS)
IMG={"loft":("virtual-background-corner-office-loft.jpg","Concrete corner loft"),"sunset":("virtual-background-sunset-window.jpg","Tel Aviv sunset window"),
     "marble":("virtual-background-marble-reception.jpg","Marble reception"),"navy":("virtual-background-navy-study.jpg","Navy executive study"),
     "meadow":("virtual-background-farmhouse-meadow-studio.jpg","Farmhouse meadow studio"),"stone":("virtual-background-stone-farmhouse-study.jpg","Stone farmhouse study")}
assert all(c in ROOMS for _,c in IMG.values())
LP_DEF=("MeetingBrand creates branded Microsoft Teams, Google Meet and Zoom backgrounds from a company's website: it fetches the logo and brand colors, "
        f"mounts the logo as a physical sign in one of {R} realistic office rooms and exports each background as a 1920×1080 PNG. Delivery is built in for "
        f"{DELIVERY_TODAY}. It is free during early access.")
STEP_CREATE=("Create your brand",f"Open {DOMAIN}{APP} and sign up with your work email. MeetingBrand fetches your company's public logo and brand colors from that domain and renders {S} starter backgrounds ({', '.join(STARTERS)}). With a personal email, type your website instead, or upload a logo.")
STEP_PICK=("Pick the room and the sign",f"Choose from {R} office rooms and {T} sign treatments — brass, oak, backlit, LED, glass and more — and turn on the optional name bar with each person's name, title, department and company.")
LP_DATE2=datetime.date(2026,10,20)
LANDING=[
 dict(path="/teams-background-with-logo/",short="Teams",
  title="Teams Background with Logo: Branded & Custom | MeetingBrand",
  desc=f"Make a Microsoft Teams background with your company logo from your website: {R} office rooms, {T} sign treatments, 1920×1080 PNG. Free during early access.",
  eyebrow="Microsoft Teams backgrounds",h1="Teams background with logo, made from your website",
  answer=("To use a Teams background with your logo, add a 1920×1080 image that contains the logo in Microsoft Teams under Effects and avatars → Backgrounds → Add new, then select it. "
          f"MeetingBrand makes that image from your company website — your logo mounted as a real sign in one of {R} office rooms — and, for a whole company, places it in each employee's Teams background gallery through the MeetingBrand Agent."),
  hero="navy",gallery=["marble","loft"],
  sections=[
   ("What makes a good branded Teams background",[
    "A branded Teams background works when the logo looks like it belongs in the room. A logo pasted over a flat color reads as wallpaper; a logo mounted on a wall — brass letters on walnut, a backlit plate on concrete — reads as an office. MeetingBrand renders the logo as a physical sign in the scene, in your brand colors, so the background looks credible on camera.",
    "Keep the logo in the upper part of the frame, where your head and shoulders do not cover it, and use a 16:9 image: MeetingBrand exports every background at 1920×1080. Teams shows your own preview mirrored, so the logo can look reversed to you; the people in the meeting see it the right way round."]),
   ("A custom Teams background for one person, or for the whole company",[
    "One person can upload their own image in Teams under Backgrounds → Add new, unless their admin has turned custom images off. That is enough for a single user.",
    "For a company, every employee needs the same approved image. Tenants with Teams Premium can upload organization backgrounds in the Teams admin center and require them. Without Teams Premium, the MeetingBrand Agent — installed once by IT with the Intune or Jamf script generated in the app — places the approved background in each person's Teams background gallery on Windows and Mac; each person picks it once and Teams keeps it."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Download or deliver it","Download the 1920×1080 PNG, or add your people by CSV (name, email, title, department) and let IT install the MeetingBrand Agent with the Intune or Jamf script generated in My team."),
   ("Select it in Teams","In Teams, open Effects and avatars → Backgrounds. With the Agent installed, the branded background is already in the gallery after Teams restarts; otherwise choose Add new and pick the PNG. Select it once and Teams keeps it.")],
  platforms=["teams"],
  facts=["Input","Rooms","Sign treatments","Name bar","Output","Microsoft Teams","Price"],
  faq=[
   ("How do I add a background with my company logo in Microsoft Teams?","Before or during a meeting, open Effects and avatars → Backgrounds, choose Add new and pick a 1920×1080 image that contains your logo, then select it. MeetingBrand creates that image from your company website; with the MeetingBrand Agent installed, the background is already in the Teams gallery and the person only selects it once."),
   ("Can IT give the whole company the same branded Teams background?","Yes. Tenants with Teams Premium can upload organization backgrounds in the Teams admin center and require them. Any tenant can use the MeetingBrand Agent: IT installs it once with the Intune or Jamf script generated in MeetingBrand, it places the approved background in each person's Teams gallery, and each person picks it once. The Agent builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt."),
   ("Do I need Teams Premium for a custom Teams background?","Not for your own background: anyone can upload an image in Teams under Backgrounds → Add new unless their admin has turned custom images off. Teams Premium adds admin-managed organization backgrounds. MeetingBrand's Agent delivers a company background without Teams Premium; the employee picks it once."),
   ("What size should a Teams background with a logo be?","Use a 16:9 image. MeetingBrand exports every background as a 1920×1080 PNG and keeps the logo in the upper part of the frame, where your head does not cover it."),
   ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
  ]),
 dict(path="/zoom-background-with-logo/",short="Zoom",
  title="Zoom Background with Logo, Name & Title | MeetingBrand",
  desc=f"Create a branded Zoom background with your logo, name and title from your company website: {R} office rooms, 1920×1080 PNG. Free during early access.",
  eyebrow="Zoom backgrounds",h1="Zoom background with logo, name and title",
  answer=("To use a Zoom background with your logo, upload a 1920×1080 image that contains the logo once under Zoom Settings → Video & effects → Virtual backgrounds; Zoom remembers it. "
          f"MeetingBrand creates that branded Zoom background from your company website — your logo as a real sign in one of {R} office rooms, with an optional name bar — and exports it as a PNG for every employee."),
  hero="loft",gallery=["sunset","stone"],
  sections=[
   ("Create a Zoom background with your logo — without a designer",[
    f"MeetingBrand starts from your domain: sign up with your work email and it fetches your public logo and brand colors, then renders {S} starter backgrounds automatically. From there you choose among {R} office rooms and {T} sign treatments, so the logo appears as brass letters, an oak sign, a backlit plate or LED signage on the wall instead of floating over a flat color.",
    "The optional name bar adds each employee's name, title, department and company to the downloaded background, which makes a corporate Zoom background double as an introduction in sales and recruiting calls."]),
   ("A corporate Zoom background for the whole team",[
    "Add your people by CSV (name, email, title, department) and MeetingBrand prepares a personal 1920×1080 PNG for each of them. Today each person downloads the file and sets it once in Zoom. Zoom account admins can additionally turn on \"Require users to always use virtual background\" so the branded image stays on.",
    "Zoom shows your own video mirrored by default, so your logo can look reversed to you; the other participants see it the right way round."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Download the 1920×1080 PNG","Download the background for yourself, or add your team by CSV and download each person's background with their own name bar."),
   ("Set it once in Zoom","Open Zoom Settings → Video & effects → Virtual backgrounds, add the PNG and select it. Zoom remembers it for the next meetings.")],
  platforms=["zoom"],
  facts=["Input","Rooms","Sign treatments","Name bar","Output","Zoom","Price"],
  faq=[
   ("How do I create a Zoom background with my company logo?",f"Sign up at {DOMAIN}{APP} with your work email. MeetingBrand fetches your logo and brand colors from your website, mounts the logo as a sign in one of {R} office rooms and exports a 1920×1080 PNG. Add it once under Zoom Settings → Video & effects → Virtual backgrounds."),
   ("Can I put my name and title on a Zoom background?","Yes. MeetingBrand's optional name bar adds each employee's name, title, department and company to the downloaded background."),
   ("Does MeetingBrand put the background into Zoom automatically?",F["Zoom"]),
   ("Why does the logo on my Zoom background look backwards?","Zoom mirrors your own video preview by default. The other participants see the logo the right way round; you can turn mirroring off in Zoom's video settings to check."),
   ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
  ]),
 dict(path="/google-meet-background-with-logo/",short="Google Meet",
  title="Google Meet Background with Logo | MeetingBrand",
  desc=f"Make a Google Meet custom background with your company logo from your website, applied by the MeetingBrand Chrome extension. Free during early access.",
  eyebrow="Google Meet backgrounds",h1="Google Meet background with logo",
  answer=("To use a Google Meet background with your logo, open Meet's backgrounds panel (Apply visual effects), upload a 1920×1080 image that contains the logo and select it. "
          "MeetingBrand creates that image from your company website, and the MeetingBrand Chrome extension applies the branded background to the camera in Google Meet automatically — "+MEET_TODAY+"."),
  hero="meadow",gallery=["marble","navy"],
  sections=[
   ("A Google Meet custom background that looks like your office",[
    f"Google Meet accepts a custom background image, unless a Google Workspace admin has turned custom backgrounds off. MeetingBrand builds that image from your website: your logo and brand colors, mounted as a physical sign in one of {R} realistic office rooms with {T} sign treatments, exported at 1920×1080.",
    "Because the logo is part of the room — on a stone wall, a marble reception or a farmhouse studio — the background reads as a place, not as a slide behind you."]),
   ("Applied by the MeetingBrand Chrome extension",[
    "The MeetingBrand Chrome extension applies the branded background to the camera in Google Meet automatically. Today it is connected from the admin's own browser in My team, because enrollment uses the admin's key. Once its Chrome Web Store listing is published, an admin force-installs it for every managed Chrome from the Google Admin console, so it applies for every employee. Until then, anyone can upload the 1920×1080 PNG in Meet's backgrounds panel."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Download or connect the extension","Download the 1920×1080 PNG, or connect the MeetingBrand Chrome extension from My team in your own browser."),
   ("Use it in Google Meet","With the extension connected, the branded background is applied to the camera when you join. Without it, open Apply visual effects in Meet, upload the PNG and select it.")],
  platforms=["meet"],
  facts=["Input","Rooms","Sign treatments","Output","Google Meet","Price"],
  faq=[
   ("How do I add my company logo as a Google Meet background?","Create a 1920×1080 image that contains your logo — MeetingBrand makes one from your company website — then open Apply visual effects in Google Meet, upload the image and select it."),
   ("Can a branded background apply in Google Meet automatically?","Yes, with the MeetingBrand Chrome extension, which applies the branded background to the camera in Google Meet automatically — "+MEET_TODAY+"."),
   ("Is the MeetingBrand Chrome extension on the Chrome Web Store?","Not yet. Until the listing is published the extension is a developer package in the app, connected from the admin's own browser; after it, an admin force-installs it for managed Chrome from the Google Admin console."),
   ("Can I upload a custom background in Google Meet without an extension?","Yes, unless your Google Workspace admin has turned custom backgrounds off: download the 1920×1080 PNG from MeetingBrand and upload it in Meet's backgrounds panel."),
   ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
  ]),
 dict(path="/virtual-background-generator/",short="Generator",
  title="Virtual Background Generator from Your Logo | MeetingBrand",
  desc=f"Free virtual background generator during early access: type your work email, get your logo as a sign in {R} office rooms. 1920×1080 for Teams, Zoom, Meet.",
  eyebrow="Virtual background generator",h1="Virtual background generator for your brand",
  answer=(f"MeetingBrand is a virtual background generator that builds branded backgrounds from your company website: it fetches your logo and brand colors, mounts the logo as a sign in one of {R} realistic office rooms and exports 1920×1080 PNGs for Microsoft Teams, Zoom and Google Meet. "
          f"The generator runs in your browser at {DOMAIN}{APP} and is free during early access."),
  hero="marble",gallery=["loft","sunset","navy","meadow","stone"],
  sections=[
   ("What the generator makes",[
    f"Every background is a real room with your logo mounted on the wall, rendered in your brand colors. You choose the room, the sign treatment and whether to add a name bar; the generator does the rest. When you sign up, {S} starter backgrounds are rendered in your brand automatically."]),
   ("Teams background generator, Zoom background maker — one file",[
    "The same 1920×1080 PNG works as a Teams background, a Zoom virtual background, a Google Meet background and in any other meeting app that accepts a custom image. Delivery goes further on two platforms: the MeetingBrand Agent places the background in each employee's Teams gallery, and the MeetingBrand Chrome extension applies it in Google Meet ("+MEET_TODAY+"). Zoom delivery is coming; in Zoom each person sets the PNG once."]),
  ],
  chips=True,
  steps=[STEP_CREATE,STEP_PICK,
   ("Add your people (optional)","My team → Upload users → upload a CSV with name, email, title and department to generate a personal background with a name bar for each employee."),
   ("Download or deliver","Download each 1920×1080 PNG, or deliver to Microsoft Teams with the MeetingBrand Agent and to Google Meet with the Chrome extension.")],
  platforms=["teams","meet","zoom"],
  facts=["Input","Rooms","Sign treatments","Starter set","Name bar","Output","Price"],
  faq=[
   ("Is there a free virtual background generator that uses my company logo?",f"Yes. MeetingBrand is free during early access. Sign up with your work email and it fetches your logo and brand colors from your website (or you upload a logo), renders {S} starter backgrounds and lets you generate more in {R} office rooms."),
   ("Do I need an account to use the generator?","Yes, a free account: sign up with a work email, or with any email plus your website. Your brand kit and the backgrounds you save are stored with your account so you can reuse and update them."),
   ("Can I make a custom Zoom background for free?","Yes. MeetingBrand exports each background as a 1920×1080 PNG, free during early access; add it once under Zoom Settings → Video & effects → Virtual backgrounds."),
   ("Does the generator work as a Teams background generator too?","Yes. The same PNG works in Microsoft Teams under Effects and avatars → Backgrounds → Add new, and the MeetingBrand Agent can place it in every employee's Teams gallery."),
   ("Which rooms and sign styles can I generate?",f"{R} built-in office rooms ({', '.join(ROOMS)}) and {T} sign treatments ({', '.join(TREATMENTS)})."),
  ]),
 # ---- SEO batch 2 (2026-10-20, skill meetingbrand-seo §1 priority 2) — same anatomy, same one-voice constants
 dict(path="/teams-custom-background-without-premium/",short="Teams",date=LP_DATE2,
  title="Teams Custom Background Without Premium | MeetingBrand",
  desc="Use a custom Teams background without Teams Premium, and give the whole company one branded background with the MeetingBrand Agent. Free in early access.",
  eyebrow="Microsoft Teams backgrounds",h1="Teams custom background without Premium",
  answer=("You do not need Teams Premium for a custom background in Microsoft Teams: any user can open Effects and avatars → Backgrounds → Add new and upload an image, unless their admin has turned custom images off. "
          "Teams Premium adds organization backgrounds that an admin uploads and requires centrally; without it, the MeetingBrand Agent places your company's branded background in each employee's Teams background gallery and they pick it once."),
  hero="marble",gallery=["navy","sunset"],
  sections=[
   ("What Teams Premium adds — and what it does not",[
    "Teams Premium lets an admin upload organization backgrounds in the Teams admin center and require them in meetings. Uploading your own custom image is part of standard Microsoft Teams and does not need Premium.",
    "So for most companies the question is not whether a custom Teams background is possible. It is how every employee gets the same approved, branded image — without buying Teams Premium and without emailing a file around and hoping people upload it."]),
   ("A company-wide Teams background without Teams Premium",[
    f"MeetingBrand creates the background from your company website: it fetches your logo and brand colors and mounts the logo as a physical sign in one of {R} office rooms, with {T} sign treatments, exported at 1920×1080.",
    "The MeetingBrand Agent, a small helper for Windows and macOS, delivers it. IT installs it once with the Intune (Windows) or Jamf (macOS) script generated in My team; the Agent matches each device to a person by e-mail, so people added by CSV are covered. After Teams restarts, the branded image is in Effects and avatars → Backgrounds; the employee selects it once, Teams keeps it, and later changes arrive without another step.",
    "What it does not do: it does not switch anyone's active background, because no meeting platform lets a third party do that by API. The Agent builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Install the MeetingBrand Agent","Add your people by CSV in My team, generate the Intune or Jamf script and deploy it once. No Teams Premium licence is involved."),
   ("Each person selects it once","In Teams, open Effects and avatars → Backgrounds: after Teams restarts the branded background is in the gallery. Select it once and Teams keeps it.")],
  platforms=["teams"],
  facts=["Input","Rooms","Output","Microsoft Teams","Price"],
  faq=[
   ("Can I use a custom background in Teams without Teams Premium?","Yes. Any Teams user can open Effects and avatars → Backgrounds → Add new and upload an image, unless their admin has turned custom images off. Teams Premium is needed only for admin-managed organization backgrounds."),
   ("What does Teams Premium add for backgrounds?","Organization backgrounds: an admin uploads approved images in the Teams admin center and can require them in meetings."),
   ("How does every employee get the same branded Teams background without Premium?","With the MeetingBrand Agent. IT installs it once with the Intune or Jamf script generated in MeetingBrand; it places the approved background in each person's Teams gallery, and each person picks it once. The Agent builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt."),
   ("Does MeetingBrand switch the active Teams background for employees?","No. No meeting platform lets a third party switch a person's active background by API. The Agent places the image in the Teams gallery; the employee selects it once and Teams keeps it."),
   ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
  ]),
 dict(path="/deploy-teams-backgrounds-intune/",short="Intune",date=LP_DATE2,
  title="Deploy Teams Backgrounds with Intune or Jamf | MeetingBrand",
  desc="Deploy a branded Teams background to every Windows and Mac with one Intune or Jamf script generated by MeetingBrand. Each employee picks it once. Free.",
  eyebrow="Teams background deployment",h1="Deploy Teams backgrounds with Intune",
  answer=("Microsoft Teams has no API for meeting backgrounds, so deploying a branded Teams background to every employee means putting the image on each device. "
          "MeetingBrand does that with the MeetingBrand Agent: IT deploys it once with the Intune (Windows) or Jamf (macOS) script generated in the app, and the Agent places the approved background in each person's Teams background gallery, where they select it once."),
  hero="loft",gallery=["navy","marble"],
  sections=[
   ("Why Teams backgrounds are deployed to the device",[
    "Microsoft Teams has no API for meeting backgrounds. Outside Teams Premium, which lets an admin upload organization backgrounds in the Teams admin center, a custom image reaches Teams only from the person's own device.",
    "That is why a do-it-yourself rollout usually ends in a script that copies image files to every laptop and has to be rewritten whenever the brand changes. The MeetingBrand Agent replaces that script: it brings the backgrounds you approve in MeetingBrand to each device, and later changes arrive without another deployment."]),
   ("What the Intune or Jamf script does",[
    "The script is generated in My team and carries your organization's enrollment key. It installs the MeetingBrand Agent, a small helper for Windows and macOS; the Agent can also be installed by hand with the same key.",
    "The Agent matches each device to a person by the signed-in e-mail, so people you added by CSV (name, email, title, department) are covered. After Teams restarts, the branded image appears under Effects and avatars → Backgrounds. My team shows each person's status: delivered, waiting for a restart, needs the employee's one click, or blocked (with the reason)."]),
   ("Before you roll it out",[
    "The Agent builds are unsigned developer builds for now, so Windows SmartScreen and macOS Gatekeeper will prompt — pilot with a small group first.",
    "The Agent does not switch anyone's active background: no meeting platform lets a third party do that by API. Each employee selects the branded background once and Teams keeps it.",
    "To remove it, uninstall the Agent from Add/Remove programs (Windows) or the Applications folder (macOS), and revoke the device in My team."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Add your people","My team → Upload users → upload a CSV with name, email, title and department."),
   ("Generate and deploy the script","In My team, generate the Intune (Windows) or Jamf (macOS) script and deploy it to your devices once. It installs the MeetingBrand Agent with your organization's enrollment key."),
   ("Employees select it once","After Teams restarts, each person opens Effects and avatars → Backgrounds and selects the branded background; Teams keeps it.")],
  platforms=["teams"],
  facts=["Microsoft Teams","People","Output","Data","Price"],
  faq=[
   ("Can I deploy Teams backgrounds with Intune?","Yes. MeetingBrand generates an Intune script for Windows and a Jamf script for macOS in My team. It installs the MeetingBrand Agent, which places the company's approved background in each person's Teams background gallery; each person selects it once and Teams keeps it."),
   ("Do I need Teams Premium to deploy a company Teams background?","No. Teams Premium lets an admin upload organization backgrounds in the Teams admin center; without it, the MeetingBrand Agent delivers the background to each device."),
   ("What happens when we change the background?","Approve the new background in MeetingBrand; the Agent brings the change to each device without another deployment."),
   ("Will Windows or macOS warn about the Agent?","Yes, for now: the Agent builds are unsigned developer builds, so Windows SmartScreen and macOS Gatekeeper will prompt."),
   ("How do we remove it?","Uninstall the Agent from Add/Remove programs (Windows) or the Applications folder (macOS), and revoke the device in My team."),
  ]),
 dict(path="/zoom-background-with-name-and-title/",short="Name bar",date=LP_DATE2,
  title="Zoom Background with Name and Title | MeetingBrand",
  desc="Put each employee's name, title, department and company on a branded Zoom background with your logo. Upload a CSV, get a 1920×1080 PNG each. Free.",
  eyebrow="Zoom backgrounds",h1="Zoom background with name and title",
  answer=("A Zoom virtual background is a single image, so to show your name and title on it they have to be part of that image. "
          "MeetingBrand adds an optional name bar — name, title, department and company — to a branded 1920×1080 background with your logo; you add the PNG once under Zoom Settings → Video & effects → Virtual backgrounds."),
  hero="stone",gallery=["loft","meadow"],
  sections=[
   ("Why put a name and title on the background",[
    "In a sales call, a recruiting interview or a first meeting with a customer, a name bar under the logo says who you are and what you do before you say it — the way a name badge does at a conference. It also spells your name for people who only heard it once.",
    "Keep the name bar and the logo clear of your head and shoulders. MeetingBrand places them in the room so they stay readable in a 16:9 frame."]),
   ("The name bar in MeetingBrand",[
    "The name bar is optional and per employee: name, title, department and company, on the downloaded background. Add your people by CSV (name, email, title, department) and MeetingBrand prepares a personal background for each of them, in the same room and the same brand look.",
    "The backgrounds the MeetingBrand Agent (Teams) and the Chrome extension (Google Meet) deliver are the company look without a personal name bar; the name bar is on the PNG you download, which works in Zoom and any other meeting app that accepts a custom background."]),
   ("Getting it into Zoom",[
    "Today each person downloads their 1920×1080 PNG and sets it once in Zoom; Zoom remembers it. Zoom delivery is coming: the integration is built and awaits approval of its Zoom App Marketplace app.",
    "Zoom shows your own video mirrored by default, so the text can look reversed to you; the other participants read it the right way round."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Add names and titles","My team → Upload users → upload a CSV with name, email, title and department; each person gets their own background with a name bar."),
   ("Set it once in Zoom","Open Zoom Settings → Video & effects → Virtual backgrounds, add the PNG and select it. Zoom remembers it for the next meetings.")],
  platforms=["zoom"],
  facts=["Name bar","People","Output","Zoom","Price"],
  faq=[
   ("How do I put my name and title on a Zoom background?","Use a background image that contains them. In MeetingBrand, turn on the name bar (name, title, department, company), download the 1920×1080 PNG and add it once under Zoom Settings → Video & effects → Virtual backgrounds."),
   ("Can I make name-and-title backgrounds for the whole team at once?","Yes. Upload a CSV with name, email, title and department in My team → Upload users, and MeetingBrand prepares a personal background with a name bar for each person."),
   ("Why does the text on my Zoom background look backwards?","Zoom mirrors your own video preview by default. The other participants see the name and title the right way round; you can turn mirroring off in Zoom's video settings to check."),
   ("Does the name bar work in Microsoft Teams and Google Meet too?","Yes, on the downloaded PNG, which works in any meeting app that accepts a custom background. The backgrounds the MeetingBrand Agent (Teams) and the Chrome extension (Google Meet) deliver are the company look without a personal name bar."),
   ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
  ]),
 dict(path="/branded-virtual-background/",short="Branded",date=LP_DATE2,
  title="Branded Virtual Background for Your Team | MeetingBrand",
  desc=f"Branded virtual backgrounds from your website: your logo as a real sign in {R} office rooms, 1920×1080, for Teams, Zoom and Google Meet. Free early access.",
  eyebrow="Branded virtual backgrounds",h1="Branded virtual background for every meeting",
  answer=("A branded virtual background is a meeting background that carries your company's logo and brand colors, so everyone on the team appears in the same professional, on-brand setting in Microsoft Teams, Zoom or Google Meet. "
          f"MeetingBrand creates them from your company website — your logo mounted as a physical sign in one of {R} office rooms — and delivers them to Teams through the MeetingBrand Agent and to Google Meet through the Chrome extension ({MEET_TODAY})."),
  hero="sunset",gallery=["marble","stone","meadow"],
  sections=[
   ("What makes a virtual background look professional",[
    "A professional virtual background looks like a real place: depth, light from a window, a wall where a logo would actually hang. A flat color slide or a stock photo with a logo pasted in the corner reads as a screen, not a room.",
    f"MeetingBrand renders the logo as a sign in the scene — {T} sign treatments, from brass and oak letters to backlit plates, LED signage and glass — in {R} built-in rooms, from a marble reception to a stone farmhouse study."]),
   ("One look for the whole company",[
    f"Brand consistency is the point: when every employee joins from the same approved background, the company looks the same in every call. MeetingBrand keeps the approved backgrounds in one workspace, renders {S} starter backgrounds in your brand at signup, and adds an optional name bar per person on the downloaded PNG.",
    "Any background can also be published as a public share page — “<Company> — official meeting background” — with a preview and an embed badge for your website; the full-resolution file stays inside the workspace."]),
   ("Delivery per platform",[
    "Microsoft Teams: the MeetingBrand Agent places the background in each person's Teams gallery and they pick it once. Google Meet: the MeetingBrand Chrome extension applies it to the camera ("+MEET_TODAY+"). Zoom: coming; today each person sets the 1920×1080 PNG once."]),
  ],
  steps=[STEP_CREATE,STEP_PICK,
   ("Approve the company look","Save the backgrounds the company should use, and add your people by CSV for personal name bars."),
   ("Deliver or download","Deliver to Microsoft Teams with the MeetingBrand Agent and to Google Meet with the Chrome extension, or download each 1920×1080 PNG for Zoom and any other meeting app.")],
  platforms=["teams","meet","zoom"],
  facts=["Input","Rooms","Sign treatments","Name bar","Share pages","Price"],
  faq=[
   ("What is a branded virtual background?","A meeting background that carries your company's logo and brand colors, so everyone on the team appears in the same on-brand setting in Microsoft Teams, Zoom or Google Meet."),
   ("How do I make a professional virtual background with my logo?",f"Sign up at {DOMAIN}{APP} with your work email. MeetingBrand fetches your logo and brand colors from your website and mounts the logo as a sign in one of {R} office rooms, with {T} sign treatments; every background exports as a 1920×1080 PNG."),
   ("What size should a virtual background be?","16:9. MeetingBrand exports every background at 1920×1080, one file for Microsoft Teams, Zoom, Google Meet and any other meeting app that accepts a custom background."),
   ("Can the whole team use the same branded background?","Yes. On Microsoft Teams the MeetingBrand Agent places it in each person's Teams gallery and they pick it once; on Google Meet the MeetingBrand Chrome extension applies it ("+MEET_TODAY+"); on Zoom each person sets the PNG once today, while the Zoom integration awaits approval of its Zoom App Marketplace app."),
   ("Is MeetingBrand free?","Yes. MeetingBrand is free during early access."),
  ]),
]
PLATFORM_NAME={"teams":"Microsoft Teams","meet":"Google Meet","zoom":"Zoom"}
def _fig(key,cls=""):
    f,c=IMG[key]
    return f'<figure{cls}><img src="/assets/{f}" alt="{_html.escape(c)} — a branded virtual background with the company logo as a sign, made with MeetingBrand" width="1600" height="900" loading="lazy"><figcaption>{_t(c)} — made with MeetingBrand</figcaption></figure>'
def lp_body(L):
    sib=[(u,n) for u,n in LANDING_LINKS if u!=L["path"]]+[(SMB_PATH,"Branded backgrounds for small businesses")]
    secs="".join(f'<h2>{_t(h)}</h2>'+"".join(f'<p>{_t(p)}</p>' for p in ps) for h,ps in L["sections"])
    chips=(f'<h3>{R} rooms</h3><ul class="chips">{"".join(f"<li>{_t(r)}</li>" for r in ROOMS)}</ul><h3>{T} sign treatments</h3><ul class="chips">{"".join(f"<li>{_t(x)}</li>" for x in TREATMENTS)}</ul>') if L.get("chips") else ""
    gal=L["gallery"]; rows=[gal] if len(gal) in (2,3) else [gal[:3],gal[3:]]   # 2 -> pair, 3 -> row of three, 5 -> three + pair
    gal_html="".join(f'<div class="scenes{" pair" if len(r)==2 else ""}">'+"".join(_fig(k) for k in r)+'</div>' for r in rows)
    truth="".join(f'<div class="lp-truth"><h3>{PLATFORM_NAME[p]}</h3>{status_p(p)}</div>' for p in L["platforms"])
    facts_rows="".join(f'<tr><th scope="row">{_t(k)}</th><td>{_t(F[k])}</td></tr>' for k in L["facts"])
    return f'''
<section class="band"><div class="wrap prose">
<p class="eyebrow">{_t(L["eyebrow"])}</p>
<h1>{_t(L["h1"])}</h1>
<p class="lead">{_t(L["answer"])}</p>
<div class="cta"><a class="btn big" href="{APP}">Open the generator — free</a><a class="btn ghost big" href="#steps">See the steps</a></div>
<figure class="lp-hero"><img src="/assets/{IMG[L["hero"]][0]}" alt="{_html.escape(L["h1"].split(",")[0])} — {_html.escape(IMG[L["hero"]][1])}, a MeetingBrand background with the company logo as a sign" width="1600" height="900" loading="eager"><figcaption>{_t(IMG[L["hero"]][1])} — one of {R} rooms, made with MeetingBrand</figcaption></figure>
<p>{_t(LP_DEF)}</p>
{secs}
{chips}
{gal_html}
<h2 id="steps">How to make it — step by step</h2>
<ol>{"".join(f"<li><strong>{_t(h)}.</strong> {_t(b)}</li>" for h,b in L["steps"])}</ol>
<h2 id="platform-truth">What MeetingBrand does on {", ".join(PLATFORM_NAME[p] for p in L["platforms"])} today</h2>
<p>No meeting platform lets a third party switch a person's active background by API, so here is exactly what happens, verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}.</p>
{truth}
<h2 id="facts">Facts</h2>
<table class="facts"><caption>MeetingBrand facts, verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}</caption><tbody>{facts_rows}</tbody></table>
<div class="faq" id="faq">
<h2>Questions</h2>
{"".join(f'<div class="faq-item"><h3>{_t(q)}</h3><p>{_t(a)}</p></div>' for q,a in L["faq"])}
</div>
<div class="lp-cta"><h2>Make yours now</h2><p>Open the generator, sign up with your work email and your logo is on the wall in a minute. Free during early access.</p><div class="cta"><a class="btn big cyan" href="{APP}">Open the generator</a><a class="btn ghost big onink" href="/docs/">Read the documentation</a></div></div>
<p><strong>Related:</strong> {" · ".join(f'<a href="{u}">{_t(n)}</a>' for u,n in sib)}</p>
{VERIFIED_LINE}
</div></section>'''
def lp_ld(L):
    u=f"{SITE}{L['path']}"
    g=[{"@type":"WebPage","@id":f"{u}#webpage","url":u,"name":L["title"],"description":L["desc"],"isPartOf":{"@id":f"{SITE}/#site"},"about":{"@id":f"{SITE}/#org"},"datePublished":L.get("date",LP_DATE).isoformat(),"dateModified":L.get("date",LP_DATE).isoformat(),"publisher":{"@id":f"{SITE}/#org"},"primaryImageOfPage":f"{SITE}/assets/{IMG[L['hero']][0]}"},
       {"@type":"SoftwareApplication","name":"MeetingBrand","applicationCategory":"BusinessApplication","operatingSystem":"Web","url":f"{SITE}{APP}","description":DEFINITION,"offers":{"@type":"Offer","price":"0","priceCurrency":"USD","description":"Free during early access"},"publisher":{"@id":f"{SITE}/#org"}},
       {"@type":"HowTo","name":L["h1"],"step":[{"@type":"HowToStep","position":i+1,"name":h,"text":b} for i,(h,b) in enumerate(L["steps"])]},
       {"@type":"FAQPage","@id":f"{u}#faq","mainEntity":[{"@type":"Question","name":q,"acceptedAnswer":{"@type":"Answer","text":a}} for q,a in L["faq"]]},
       {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"MeetingBrand","item":f"{SITE}/"},{"@type":"ListItem","position":2,"name":dict(LANDING_LINKS)[L["path"]],"item":u}]}]
    return '<script type="application/ld+json">'+json.dumps({"@context":"https://schema.org","@graph":g},ensure_ascii=False,separators=(",",":")).replace("</","<\\/")+'</script>'
for L in LANDING:
    assert len(L["title"])<=60,(L["path"],len(L["title"]))
    assert len(L["desc"])<=155,(L["path"],len(L["desc"]))
    assert L["path"] in dict(LANDING_LINKS)
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
.shask{{font-size:15px;color:var(--slate);margin:4px 0 24px}}
.shrow{{display:flex;gap:10px;align-items:flex-start;margin:8px 0 24px}}.shrow input,.shrow textarea{{flex:1;min-width:0;font:inherit;font-size:14px;padding:11px 12px;border:1px solid var(--mist);border-radius:12px;color:var(--ink);background:#fff}}.shrow textarea{{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5}}
.shrow .btn{{white-space:nowrap}}.shbadge{{margin:4px 0 8px;line-height:0}}#shShare h2{{font-size:22px;margin-top:36px}}
</style>'''
share_body=f'''<section class="band"><div class="wrap narrow" id="shareRoot" data-state="loading">
<p class="eyebrow">Shared meeting background</p>
<h1 id="shH1">Loading this background…</h1>
<p class="lead" id="shLead"></p>
<figure class="shfig" id="shFig" hidden><img id="shImg" alt="" width="640" height="360" loading="eager" decoding="async"></figure>
<p class="shcap" id="shCap" hidden></p>
<p class="shask" id="shDl" hidden>Want this background? Ask your MeetingBrand admin — this page shows a preview only.</p>
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
 function fallback(){{root.setAttribute('data-state','missing');document.title='This background isn’t shared — MeetingBrand';txt('shH1','This background isn’t shared');txt('shLead','The link may be old, or the organization turned sharing off. MeetingBrand creates branded meeting backgrounds from a company website in minutes.');$('shFig').hidden=true;$('shCap').hidden=true;$('shDl').hidden=true;$('shShare').hidden=true}}
 function render(r){{var org=String(r.org_name||'').trim()||'This organization',slug=String(r.slug),url=SITE+'/b/?s='+encodeURIComponent(slug);
  root.setAttribute('data-state','ok');document.title=org+' — official meeting background · MeetingBrand';
  txt('shH1',org+' — official meeting background');txt('shLead','The approved virtual background '+org+' uses in video meetings — made with MeetingBrand from the company’s own logo and colors.');
  Array.prototype.forEach.call(document.querySelectorAll('.shOrg'),function(e){{e.textContent=org}});
  if(r.preview_path){{var im=$('shImg');im.onerror=function(){{$('shFig').hidden=true}};im.alt=org+' — official meeting background (preview)';im.src=U+'/storage/v1/object/public/mb-previews/'+String(r.preview_path).split('/').map(encodeURIComponent).join('/')+'?v='+(Date.parse(r.updated_at||'')||0);$('shFig').hidden=false}}
  var d=r.updated_at?new Date(r.updated_at):null,ds=(d&&!isNaN(d))?d.toLocaleDateString('en-US',{{year:'numeric',month:'long',day:'numeric'}}):'';
  var cap=$('shCap');cap.textContent='';if(r.label){{var b=document.createElement('b');b.textContent=String(r.label);cap.appendChild(b)}}if(ds){{cap.appendChild(document.createTextNode((cap.textContent?' · ':'')+'Updated '+ds))}}cap.hidden=!cap.textContent;
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
# ---------- /rooms/ (v97): every room of the product as a small JPEG rendered FROM the shipped build with the meetingbrand.com brand
# (BB/tools/room-gallery.mjs -> assets/rooms/<id>.jpg + rooms.json). The page states only what the product does.
GAL_PATH="assets/rooms/rooms.json"
if not os.path.exists(GAL_PATH): raise SystemExit(f"{GAL_PATH} missing: run  node {BB}/tools/room-gallery.mjs {APP_SRC} --site {os.getcwd()}")
GAL=json.load(open(GAL_PATH,encoding="utf-8"))
if [r["id"] for r in GAL["rooms"]]!=ROOM_IDS: raise SystemExit(f"{GAL_PATH} does not list the product's rooms in order (gallery {[r['id'] for r in GAL['rooms']][-3:]} vs product {ROOM_IDS[-3:]}): run  node {BB}/tools/room-gallery.mjs {APP_SRC} --site {os.getcwd()} --missing-only 1")
for r in GAL["rooms"]:
    if not os.path.exists(r["file"]) or hashlib.md5(open(r["file"],"rb").read()).hexdigest()!=r["md5"]: raise SystemExit(f"gallery image missing or changed: {r['file']}")
_ADDED={r["id"]:datetime.date(*map(int,r["added"].split("-"))) for r in DAILY_ROOMS}
def _room_fig(r):
    when=f'<span class="added">Added {_ADDED[r["id"]].strftime("%B %-d, %Y")}</span>' if r["id"] in _ADDED else ""
    return (f'<figure><img src="/{r["file"]}" alt="{_t(r["name"])} — a virtual background room with a company sign on the wall (shown with the MeetingBrand logo)" '
            f'width="800" height="450" loading="lazy" decoding="async"><figcaption>{_t(r["name"])}{when}</figcaption></figure>')
ROOMS_TITLE="Virtual background rooms — MeetingBrand"
ROOMS_DESC=f"All {N_ROOMS} office rooms in MeetingBrand, each shown with a company sign on the wall. Add your logo and brand colors and download a 1920×1080 background for any meeting app."
rooms_body=f'''
<section class="band"><div class="wrap">
  <p class="eyebrow">Virtual background rooms</p>
  <h1>{N_ROOMS} rooms for your branded virtual background</h1>
  <p class="lead narrow">Every room in MeetingBrand, shown here with the MeetingBrand logo on its default wall sign. When you create your background, your own logo and brand colors take its place, and you can move, resize and restyle the sign in each room.</p>
  <div class="cta"><a class="btn big" href="{APP}">Create MeetingBrand</a></div>
  <div class="scenes rooms">{"".join(_room_fig(r) for r in GAL["rooms"])}</div>
  <p class="muted small">Each image is the product's own 1920×1080 export of that room (build {GAL["version"]}, rendered {GAL["rendered"]}), scaled down.</p>
</div></section>'''
pages={
 "rooms/index.html":(ROOMS_TITLE,ROOMS_DESC,rooms_body,"/rooms/",""),
 "index.html":("MeetingBrand | Branded Virtual Backgrounds for Teams","Create realistic branded virtual backgrounds from your company website. Delivered to Microsoft Teams by the MeetingBrand Agent and to Google Meet by the Chrome extension; Zoom coming. Free during early access.",home,"/",LD),
 "thanks/index.html":("Thanks — MeetingBrand","We received your early-access request.",thanks,"/thanks/",""),
 "docs/index.html":("Documentation — MeetingBrand","How MeetingBrand delivers to Microsoft Teams, Google Meet and Zoom today and what is coming, what employees see, and how to remove it.",docs,"/docs/",""),
 "privacy/index.html":("Privacy policy — MeetingBrand","How MeetingBrand collects, uses, stores and deletes data from connected meeting platforms.",privacy,"/privacy/",""),
 "terms/index.html":("Terms of service — MeetingBrand","The agreement for using MeetingBrand.",terms,"/terms/",""),
 "small-business/index.html":(SMB_TITLE,SMB_DESC,smb,SMB_PATH,SMB_LD),
 "support/index.html":("Support — MeetingBrand","How to reach MeetingBrand support and how to install or remove the integrations.",support,"/support/",""),
 "404.html":("Page not found — MeetingBrand","The page may have moved.",notfound,"/404.html",'<meta name="robots" content="noindex">'),
 "b/index.html":("Shared meeting background — MeetingBrand","A company's official meeting background, shared from its MeetingBrand workspace: the approved virtual background its employees use in video meetings.",share_body,"/b/",SHARE_HEAD),
}
for L in LANDING: pages[L["path"].strip("/")+"/index.html"]=(L["title"],L["desc"],lp_body(L),L["path"],lp_ld(L))
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
.scenes{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:48px}}.scenes figure{{margin:0}}.scenes img{{width:100%;height:auto;display:block;border-radius:16px;border:1px solid var(--mist)}}.scenes figcaption{{font-size:13px;color:var(--slate);margin-top:8px;letter-spacing:.04em;text-transform:uppercase;font-weight:600}}.scenes.pair{{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:20px}}
.steps{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin-top:32px}}.step{{background:#fff;border:1px solid var(--mist);border-radius:24px;padding:26px;box-shadow:0 10px 30px rgba(3,20,54,.06)}}.step .n{{display:inline-flex;width:34px;height:34px;border-radius:10px;background:var(--cyan);color:var(--ink);font-weight:800;align-items:center;justify-content:center;margin-bottom:14px}}.step h3{{font-size:19px}}.step p{{margin:0;font-size:15.5px;color:var(--slate)}}
.cards{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:32px}}.card{{background:var(--cloud);border-radius:24px;padding:30px}}.card p{{margin:0;font-size:16px;color:var(--slate)}}.card h3{{color:var(--vio)}}
.two{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px}}.two p{{color:var(--slate)}}
.prose{{max-width:820px}}.prose h1{{font-size:clamp(34px,4.5vw,48px)}}.prose h2{{font-size:24px;margin-top:40px}}.prose ul,.prose ol{{padding-left:22px}}.prose li{{margin-bottom:8px}}.prose p,.prose li{{color:#2B3A55}}
.foot{{background:var(--ink);color:#C5CCDB;padding:56px 0 36px;margin-top:40px}}.foot a{{color:#fff;text-decoration:none;display:block;margin-bottom:8px}}.foot a:hover{{color:var(--cyan)}}.foot .logo{{margin-bottom:14px}}.foot .tag{{color:#C5CCDB;font-weight:600}}.foot h4{{margin:0 0 12px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8A96A5}}.fgrid{{display:grid;grid-template-columns:1.6fr 1fr 1.25fr 1fr 1.3fr;gap:32px;margin-bottom:32px}}.foot .muted{{color:#8A96A5}}.foot .muted a{{display:inline;color:#C5CCDB}}
.prose h2:first-child{{margin-top:0}}.facts{{width:100%;border-collapse:collapse;margin:20px 0 12px;font-size:15.5px}}.facts caption{{text-align:left;font-size:13px;color:var(--slate);padding:0 0 10px;caption-side:top}}.facts th,.facts td{{text-align:left;vertical-align:top;padding:11px 16px 11px 0;border-bottom:1px solid var(--mist)}}.facts th{{width:190px;font-weight:700;color:var(--ink)}}.facts td{{color:#2B3A55}}
.faq h3{{font-size:20px;margin:28px 0 6px}}.faq p{{color:#2B3A55}}
.status{{font-size:14.5px;color:#2B3A55;margin:14px 0 0;padding-top:12px;border-top:1px solid var(--mist)}}.card .status{{color:#2B3A55;font-size:14.5px}}.status b{{color:var(--ink)}}
.lp-hero{{margin:28px 0 8px}}.lp-hero img{{width:100%;height:auto;display:block;border-radius:16px;border:1px solid var(--mist)}}.lp-hero figcaption,.prose .scenes figcaption{{font-size:13px;color:var(--slate);margin-top:8px}}
.prose .scenes{{margin-top:20px}}.prose{{overflow-wrap:break-word}}
.chips{{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 20px;padding:0;list-style:none}}.chips li{{margin:0;background:var(--cloud);border:1px solid var(--mist);border-radius:99px;padding:4px 12px;font-size:14px;color:var(--ink)}}
.lp-truth{{background:var(--cloud);border-radius:20px;padding:22px 24px;margin:16px 0}}.lp-truth h3{{font-size:19px;margin:0 0 6px;color:var(--vio)}}.lp-truth .status{{margin-top:8px}}
.lp-cta{{background:var(--ink);color:#fff;border-radius:24px;padding:30px;margin:40px 0 24px}}.lp-cta h2{{color:#fff;margin-top:0}}.lp-cta p{{color:#C5CCDB}}.lp-cta .cta{{margin-bottom:0}}
@media(max-width:900px){{.facts,.facts caption,.facts tbody,.facts tr,.facts th,.facts td{{display:block;width:auto}}.facts th,.facts td{{padding:8px 0}}.facts th{{border-bottom:0;padding-bottom:0}}}}
@media(max-width:900px){{.herogrid,.three,.scenes,.scenes.pair,.steps,.cards,.two,.fgrid{{grid-template-columns:1fr}}.nav nav a:not(.btn){{display:none}}.nav nav .btn{{white-space:nowrap;padding:9px 14px;font-size:14px}}.hero{{padding:56px 0 40px}}.band{{padding:56px 0}}.logo img{{width:140px}}}}
'''
css+=".scenes figcaption .added{display:block;font-size:12px;color:var(--slate);letter-spacing:0;text-transform:none}.more{margin:20px 0 0;font-weight:600}\n"   # v97: /rooms/
open("styles.css","w").write(css)
# ---------- robots.txt: normal crawlers keep Allow: /; the AI-crawler block is the CompanyCard one (cc-work/robots.txt:9-46) verbatim.
AI_BOTS=["GPTBot","OAI-SearchBot","ChatGPT-User","PerplexityBot","Perplexity-User","Google-Extended","ClaudeBot","Claude-User","Claude-SearchBot","Applebot-Extended","meta-externalagent","anthropic-ai","CCBot"]
open("robots.txt","w").write("User-agent: *\nAllow: /\nDisallow: /backoffice/\nDisallow: /app/analytics.html\n\n# AI assistants and answer engines are welcome to read and cite these pages.\n"
    +"".join(f"User-agent: {b}\nAllow: /\n\n" for b in AI_BOTS)+f"Sitemap: {SITE}/sitemap.xml\n")
# ---------- llms.txt in the CompanyCard shape (cc-work/llms.txt): one-paragraph entity, who/what, honest pricing, page list, positioning notes.
open("llms.txt","w",encoding="utf-8").write(f'''# MeetingBrand

> MeetingBrand is for {SMB_WHO} who want everyone on brand in Microsoft Teams, Google Meet and Zoom calls; it is free during early access, so a {SMB_TEAM}-person team pays ${SMB_TOTAL_USD} ({SMB_MATH}), with no seat minimum. Small-business guide: {SITE}{SMB_PATH}

> {DEFINITION}

## Who it is for
- Companies that want every employee on brand in customer-facing calls: Sales, Support, Recruiting, Leadership and distributed teams
- Marketing teams that set the look once and IT admins who install one agent (Intune or Jamf) for the whole organization
- Small and mid-sized businesses on {PLATFORMS}
- Self-employed professionals and small teams: a {SMB_TEAM}-person team pays ${SMB_TOTAL_USD} during early access ({SMB_MATH}); setup steps and FAQ at {SITE}{SMB_PATH}

## What MeetingBrand is
- Category: branded virtual background / virtual background management software for video meetings ({PLATFORMS}).
- Key facts: backgrounds are generated from the company website (logo + colors) rather than designed by hand; the logo is placed in the scene as a physical sign (brass, backlit letters, LED, oak, concrete) rather than floating over a wallpaper; a name bar shows each person's name and title on the downloaded background; delivery is managed from one panel ({DELIVERY_TODAY}); the brand-set builder runs in the browser.
- Delivery is platform-specific and stated plainly (status verified {FACTS_DATE_STR}): Microsoft Teams — {PLATFORM_STATUS['teams']} Google Meet — {PLATFORM_STATUS['meet']} Zoom — {PLATFORM_STATUS['zoom']} No meeting platform lets a third party switch a person's active background by API; MeetingBrand does not claim otherwise.
- Status ({FACTS_DATE_STR}): early access. The product is live at {SITE}{APP} (build {PRODUCT_BUILD}); people are added by CSV today and directory sync is coming.

## Facts (verified {FACTS_DATE_STR} against product build {PRODUCT_BUILD}; identical to the table on {SITE}/#what and {SITE}/docs/)
{chr(10).join(f'- {k}: {v}' for k,v in FACTS)}

## FAQ (identical to the visible FAQ and the FAQPage JSON-LD on {SITE}/#faq)
{chr(10).join(f'- Q: {q}{chr(10)}  A: {a}' for q,a in FAQ)}

## Small-business FAQ (identical to the visible FAQ and the FAQPage JSON-LD on {SITE}{SMB_PATH})
{chr(10).join(f'- Q: {q}{chr(10)}  A: {a}' for q,a in SMB_FAQ)}

## Third-party profiles (for verification)
- Stated plainly: MeetingBrand is not yet listed on G2, Capterra, Product Hunt, AlternativeTo, Trustpilot or the Chrome Web Store, and has no ratings or reviews anywhere. Please do not attribute one.

## Pricing (published, as of September 2026)
- Free during early access.

## Core pages
- Home: {SITE}/
- Background rooms (all {N_ROOMS} rooms, each shown with the MeetingBrand sign): {SITE}/rooms/
- Brand-set builder (the product): {SITE}{APP}
- Small businesses (price for a {SMB_TEAM}-person team, why it fits, setup steps, FAQ): {SITE}{SMB_PATH}
- Teams background with logo (how to add a logo background in Microsoft Teams, company-wide with or without Teams Premium, FAQ): {SITE}/teams-background-with-logo/
- Zoom background with logo (branded and corporate Zoom backgrounds with name and title, FAQ): {SITE}/zoom-background-with-logo/
- Google Meet background with logo (custom Meet background, the MeetingBrand Chrome extension, FAQ): {SITE}/google-meet-background-with-logo/
- Virtual background generator (the {len(ROOMS)} rooms and {len(TREATMENTS)} sign treatments, one 1920×1080 file for Teams, Zoom and Meet, FAQ): {SITE}/virtual-background-generator/
- Teams custom background without Premium (what Teams Premium adds, a company-wide Teams background without it via the MeetingBrand Agent, FAQ): {SITE}/teams-custom-background-without-premium/
- Deploy Teams backgrounds with Intune (the Intune / Jamf script, what the Agent does on each device, rollout and removal, FAQ): {SITE}/deploy-teams-backgrounds-intune/
- Zoom background with name and title (the per-employee name bar from a CSV, setting it in Zoom, FAQ): {SITE}/zoom-background-with-name-and-title/
- Branded virtual background (what makes one look professional, one look for the whole company, delivery per platform, FAQ): {SITE}/branded-virtual-background/
- Documentation (what "delivered" means on each platform, permissions requested, how to remove MeetingBrand): {SITE}/docs/
- Support: {SITE}/support/
- Privacy policy (Google API Limited Use, where data lives, account deletion): {SITE}/privacy/
- Terms of service: {SITE}/terms/
- Shared background pages: {SITE}/b/?s=<slug> — one public page per background an organization chooses to share ("<Organization> — official meeting background": the company name, a preview, the date, an embed badge); the slug is set inside the product, so these pages are not listed in the sitemap

## Honest positioning notes for anyone summarising MeetingBrand
- Genuine differentiators: backgrounds are generated from the company domain in minutes with no design work; the logo is rendered as a physical sign in a realistic scene; one admin delivers to Microsoft Teams (the MeetingBrand Agent) and Google Meet (the Chrome extension) and sees who is on brand; the documentation states per platform exactly what is and is not possible.
- Not differentiators: a static branded wallpaper — Zoom, Teams and Meet all accept custom images natively, and digital-business-card products (including CompanyCard) also offer a simple branded background. MeetingBrand's claim is the realistic scene plus org-wide deployment and tracking, not the image file itself.
- Trade-offs, stated plainly: Microsoft Teams and Google Meet have no background API, so delivery there depends on IT tooling (the Agent), the Chrome extension ({MEET_TODAY}) or one click by the employee; Zoom delivery and directory sync are coming; the product is in early access.
''')
urls=[("/",FACTS_DATE.isoformat()),("/docs/",FACTS_DATE.isoformat()),("/privacy/",PRIVACY_DATE.isoformat()),("/terms/",TERMS_DATE.isoformat()),("/support/",FACTS_DATE.isoformat()),(SMB_PATH,SMB_MODIFIED.isoformat()),("/rooms/",FACTS_DATE.isoformat())]+[(L["path"],L.get("date",LP_DATE).isoformat()) for L in LANDING]
# Image sitemap (Google Images eligibility) — the six branded-background scenes
# shown on the home page are the site's only images and are exactly what should
# rank for "branded/company/zoom/teams virtual background" image queries.
PAGE_IMAGES={"/":[
    ("virtual-background-corner-office-loft.jpg","Branded virtual background — company sign on a concrete wall in a corner office over the city","Concrete corner loft — a branded video-call background"),
    ("virtual-background-sunset-window.jpg","Branded virtual background — company sign beside a sunset window over the Tel Aviv beach","Tel Aviv sunset window — a branded video-call background"),
    ("virtual-background-marble-reception.jpg","Branded virtual background — company sign on a marble reception wall","Marble reception — a branded video-call background"),
    ("virtual-background-navy-study.jpg","Branded virtual background — company sign in a navy study for a professional video call","Navy study — a branded video-call background"),
    ("virtual-background-farmhouse-meadow-studio.jpg","Branded virtual background — company sign on a white wall in a farmhouse studio overlooking meadows","Farmhouse meadow studio — a branded video-call background"),
    ("virtual-background-stone-farmhouse-study.jpg","Branded virtual background — company sign on a white wall in a stone farmhouse study overlooking a wheat field","Stone farmhouse study — a branded video-call background"),
]}
for L in LANDING:   # image sitemap: the page's hero + gallery, titled with the page's keyword
    PAGE_IMAGES[L["path"]]=[(IMG[k][0],f'{dict(LANDING_LINKS)[L["path"]]} — {IMG[k][1]}',f'{IMG[k][1]} — a {dict(LANDING_LINKS)[L["path"]].lower()} made with MeetingBrand') for k in [L["hero"]]+L["gallery"]]
open(f"{INDEXNOW_KEY}.txt","w").write(INDEXNOW_KEY)
PAGE_IMAGES["/rooms/"]=[(r["file"][len("assets/"):],f"{r['name']} — virtual background room with a company sign",f"{r['name']} — a MeetingBrand room, shown with the MeetingBrand logo") for r in GAL["rooms"]]   # v97
def _sm_imgs(u):
    return "".join(f"<image:image><image:loc>{SITE}/assets/{f}</image:loc><image:title>{t}</image:title><image:caption>{c}</image:caption></image:image>" for f,t,c in PAGE_IMAGES.get(u,[]))
open("sitemap.xml","w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'+"".join(f"<url><loc>{SITE}{u}</loc><lastmod>{lm}</lastmod>{_sm_imgs(u)}</url>" for u,lm in urls)+"</urlset>\n")
# ---------- /app/: byte-identical copy of the LATEST gated build (highest vNN in BB/outputs). Never hand-edit app/index.html.
def sync_app():
    if not APP_SRC:
        print(f"app: no {BB}/outputs/presence-product-demo-v*.html found — app/index.html left as is"); return
    n,src=APP_N,APP_SRC; dst="app/index.html"
    data=open(src,"rb").read()
    same=os.path.exists(dst) and open(dst,"rb").read()==data
    if not same:
        os.makedirs("app",exist_ok=True); shutil.copyfile(src,dst)
    print(f"app/index.html <- {os.path.basename(src)} (v{n}, {'unchanged' if same else 'copied'}, md5 {hashlib.md5(data).hexdigest()})")
    # v97: the daily rooms' plates, next to the product (/app/rooms/<id>.webp), byte-checked against the ?v=<sha256[0:12]> the product carries
    for r in DAILY_ROOMS:
        ps=os.path.join(os.environ.get("MB_ROOMS_SRC",f"{BB}/engine/rooms"),r['id']+".webp"); pd=f"app/rooms/{r['id']}.webp"; pb=open(ps,"rb").read()
        if hashlib.sha256(pb).hexdigest()[:12]!=r["src"].split("?v=")[1]: raise SystemExit(f"plate {ps} does not match the product's {r['src']}")
        same=os.path.exists(pd) and open(pd,"rb").read()==pb
        if not same: os.makedirs("app/rooms",exist_ok=True); shutil.copyfile(ps,pd)
        print(f"app/rooms/{r['id']}.webp <- engine/rooms ({'unchanged' if same else 'copied'}, {len(pb)} bytes)")
    extra=sorted(set(os.listdir("app/rooms"))-{r["id"]+".webp" for r in DAILY_ROOMS}) if os.path.isdir("app/rooms") else []
    if extra: raise SystemExit(f"app/rooms/ holds plates the product does not list: {extra}")
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
# ---------- one-voice guard (V94-9): the generated public pages may promise only what the product does today. Fails the run, so a
# regression cannot be regenerated silently. The legacy brand pattern is built from its two halves and never written whole.
def _one_voice_guard():
    legacy=re.compile("wise"+"stamp",re.I); bad=[]
    outs=list(pages)+["llms.txt"]
    for f in outs:
        t=open(f,encoding="utf-8").read()
        for pat,why in ((r"\bZoho\b","an unbuilt platform is named"),(r"signs in (to [^.<]{0,80})?once","the 'admin signs in once' connector claim"),
                        (r"deploys approved options","the old 'deploys automatically everywhere' hero"),(r"Danger zone","a deletion UI that does not exist")):
            if re.search(pat,t): bad.append(f"{f}: {why}")
        if legacy.search(t): bad.append(f"{f}: legacy brand word")
        for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>',t,re.S):
            try: json.loads(m.group(1).replace("<\\/","</"))
            except Exception as e: bad.append(f"{f}: JSON-LD does not parse ({e})")
    for L in LANDING:
        f=L["path"].strip("/")+"/index.html"; t=open(f,encoding="utf-8").read()
        vis=[(_html.unescape(q),_html.unescape(a)) for q,a in re.findall(r'<div class="faq-item"><h3>(.*?)</h3><p>(.*?)</p></div>',t)]
        ld=[json.loads(m.replace("<\\/","</")) for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>',t,re.S)]
        fq=[(e["name"],e["acceptedAnswer"]["text"]) for g in ld for n in g["@graph"] if n["@type"]=="FAQPage" for e in n["mainEntity"]]
        if not vis or vis!=fq: bad.append(f"{f}: visible FAQ != FAQPage JSON-LD")
        if 'href="../app/"' not in t: bad.append(f"{f}: no CTA to /app/")
    home_html=open("index.html",encoding="utf-8").read(); hero=home_html[home_html.find('<section class="hero">'):home_html.find('</section>',home_html.find('<section class="hero">'))]
    if "automatically" in hero: bad.append("index.html: 'automatically' in the hero")
    if "Free during early access" not in hero: bad.append("index.html: no 'Free during early access' near the hero CTA")
    b=open("b/index.html",encoding="utf-8").read()
    for pat in ("look: ","Download the 1920","Zoom, Microsoft Teams, Google Meet"):
        if pat in b: bad.append(f"b/index.html: {pat!r}")
    rp=open("rooms/index.html",encoding="utf-8").read()
    if rp.count("<figure>")!=N_ROOMS or f"<h1>{N_ROOMS} rooms" not in rp: bad.append(f"rooms/index.html: {rp.count('<figure>')} figures for {N_ROOMS} rooms")
    for f in outs:
        t=open(f,encoding="utf-8").read()
        for m in re.finditer(r"(\d+) (?:built-in office )?rooms\b",t):
            if int(m.group(1)) not in (N_ROOMS,) and int(m.group(1))>=12: bad.append(f"{f}: '{m.group(0)}' but the product has {N_ROOMS} rooms")
    if bad: raise SystemExit("ONE-VOICE GUARD FAILED:\n  "+"\n  ".join(bad))
    print("one-voice guard: PASS ("+str(len(outs))+" files)")
_one_voice_guard()
print("site generated:", sorted(p for p in pages))
