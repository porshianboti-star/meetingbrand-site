// mb-brand/html.ts — byte sniffing, charset, script stripping and a cheap extraction of logo candidates / icons / og tags.
// The app keeps its own (richer) DOM parser; what we return is the script-stripped HTML for it plus a server-side list so a
// client without DOMParser (or a future lite caller) still gets candidates. Everything here is regex over <= 2 MB of text.

export function sniffCharset(head: string, contentType: string | null): string {
  const fromCt = /charset\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(contentType || "");
  if (fromCt) return fromCt[1].toLowerCase();
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : "utf-8";
}

export function decodeText(bytes: Uint8Array, contentType: string | null): string {
  const probe = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const cs = sniffCharset(probe, contentType);
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** text/html by header (when present) AND by bytes: a markup document, not JSON / PDF / an image / a script. */
export function looksLikeHtml(bytes: Uint8Array, contentType: string | null): boolean {
  if (contentType) {
    const ct = contentType.split(";")[0].trim().toLowerCase();
    if (ct && ct !== "text/html" && ct !== "application/xhtml+xml") return false;
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048)).replace(/^﻿|^\xEF\xBB\xBF/, "").replace(/^\s+/, "").toLowerCase();
  if (!head.startsWith("<")) return false;
  if (/^<\?xml[^>]*>\s*<(svg|rss|feed|urlset)/.test(head)) return false;
  return /^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|!--|\?xml)/.test(head) || /<(html|head|body|meta|title|link|div|header)[\s>]/.test(head);
}

/** Every <script> block but JSON-LD (data the client parser reads) is removed; an unterminated <script drops the rest of the document.
 * Single pass with indexOf (review: the former regex pair backtracked quadratically on "<script " repeated — minutes of CPU on 2 MB). */
export function stripScripts(html: string): string {
  const lower = html.toLowerCase();
  let out = "", pos = 0;
  for (;;) {
    const i = lower.indexOf("<script", pos);
    if (i < 0) { out += html.slice(pos); break; }
    const c = lower.charCodeAt(i + 7); // a tag start only when "<script" is followed by whitespace, ">" or "/"
    if (!(c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || Number.isNaN(c))) { out += html.slice(pos, i + 7); pos = i + 7; continue; }
    const gt = lower.indexOf(">", i);
    if (gt < 0) { out += html.slice(pos, i); break; } // an unterminated tag: nothing after it survives
    const attrs = lower.slice(i + 7, gt);
    const close = lower.indexOf("</script", gt + 1);
    const closeEnd = close < 0 ? -1 : lower.indexOf(">", close);
    if (/(?:^|[\s"'])type\s*=\s*["']?\s*application\/ld\+json/.test(attrs) && !/(?:^|[\s"'])src\s*=/.test(attrs)) { // fix review: a real `type` attribute (not data-type / itemtype), and never a block that also has a src
      if (closeEnd < 0) { out += html.slice(pos); break; }
      out += html.slice(pos, closeEnd + 1); pos = closeEnd + 1; continue; // JSON-LD kept verbatim
    }
    out += html.slice(pos, i);
    if (closeEnd < 0) break; // an unterminated script: the rest is dropped
    pos = closeEnd + 1;
  }
  return out;
}

export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  let m: RegExpExecArray | null;
  const body = tag.replace(/^<\s*[a-zA-Z][\w:-]*/, "").replace(/\/?>\s*$/, "");
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    if (k in out) continue;
    out[k] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

export interface Cand { src: string; score: number; kind: string }
export interface Icon { src: string; kind: "apple-touch" | "icon" | "manifest"; sizes: string | null }
export interface Extract {
  logos: Cand[];
  icons: Icon[];
  manifest: string | null;
  og: { image: string | null; logo: string | null; site_name: string | null; title: string | null };
  title: string | null;
}

function abs(u: string | undefined, base: URL): string | null {
  if (!u) return null;
  const t = u.trim();
  if (!t || t.length > 2000) return null;
  try {
    const r = new URL(t, base);
    if (r.protocol !== "https:" && r.protocol !== "http:") return null;
    r.hash = "";
    return r.href;
  } catch {
    return null;
  }
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}

/** Logo candidates (JSON-LD Organization logo 10, og:logo / link rel=logo 7, header/nav <img> scored, og:image named logo 4),
 * icons (apple-touch / icon / manifest) and the og / title names. Capped, de-duplicated, absolute URLs. */
export function extract(html: string, base: URL): Extract {
  const text = html.slice(0, 1_500_000);
  const logos = new Map<string, Cand>();
  const push = (u: string | null, score: number, kind: string) => {
    if (!u) return;
    const cur = logos.get(u);
    if (!cur || cur.score < score) logos.set(u, { src: u, score, kind });
  };
  // JSON-LD
  const ld = /<script\b[^>]*type\s*=\s*["']?\s*application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  let nLd = 0;
  while ((m = ld.exec(text)) && nLd++ < 12) {
    try {
      const j = JSON.parse(m[1].trim());
      const nodes: unknown[] = [];
      const walk = (n: unknown, d: number) => {
        if (!n || typeof n !== "object" || d > 4) return;
        if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
        const o = n as Record<string, unknown>;
        nodes.push(o);
        if (Array.isArray(o["@graph"])) (o["@graph"] as unknown[]).forEach((x) => walk(x, d + 1));
        if (o.publisher && typeof o.publisher === "object") walk(o.publisher, d + 1);
        if (o.brand && typeof o.brand === "object") walk(o.brand, d + 1);
      };
      walk(j, 0);
      for (const n of nodes as Record<string, unknown>[]) {
        const t = String(n["@type"] || "");
        if (!/Organization|Corporation|Brand|WebSite|LocalBusiness|Store|Company/i.test(t)) continue;
        const lg = n.logo;
        if (typeof lg === "string") push(abs(lg, base), 10, "jsonld");
        else if (lg && typeof lg === "object") {
          const o = lg as Record<string, unknown>;
          push(abs(String(o.url || o["@id"] || o.contentUrl || ""), base), 10, "jsonld");
        }
        if (typeof n.image === "string" && /logo/i.test(n.image)) push(abs(n.image, base), 7, "jsonld-image");
      }
    } catch { /* not JSON */ }
  }
  // meta / link / title
  const og: Extract["og"] = { image: null, logo: null, site_name: null, title: null };
  let title: string | null = null;
  const icons: Icon[] = [];
  let manifest: string | null = null;
  const tm = /<title\b[^>]*>([^<]{0,300})/i.exec(text);
  if (tm) title = tm[1].replace(/\s+/g, " ").trim() || null;
  const tagRe = /<(meta|link)\b[^>]*>/gi;
  let nTags = 0;
  while ((m = tagRe.exec(text)) && nTags++ < 600) {
    const a = attrs(m[0]);
    if (m[1].toLowerCase() === "meta") {
      const key = (a.property || a.name || a.itemprop || "").toLowerCase();
      const c = a.content;
      if (!c) continue;
      if (key === "og:logo" || key === "logo") { og.logo = og.logo || abs(c, base); push(abs(c, base), 7, "og:logo"); }
      else if (key === "og:image" || key === "og:image:url" || key === "twitter:image") { og.image = og.image || abs(c, base); if (/logo/i.test(c)) push(abs(c, base), 4, "og:image"); }
      else if (key === "og:site_name" || key === "application-name" || key === "apple-mobile-web-app-title") og.site_name = og.site_name || c.slice(0, 120);
      else if (key === "og:title") og.title = og.title || c.slice(0, 200);
    } else {
      const rel = (a.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
      const href = abs(a.href, base);
      if (!href) continue;
      if (rel.includes("logo") || (a.itemprop || "").toLowerCase() === "logo") push(href, 7, "link:logo");
      if (rel.includes("manifest")) manifest = manifest || href;
      if (rel.some((r) => r.includes("apple-touch-icon"))) icons.push({ src: href, kind: "apple-touch", sizes: a.sizes || null });
      else if (rel.includes("icon")) icons.push({ src: href, kind: "icon", sizes: a.sizes || null });
      if (rel.includes("preload") && (a.as || "").toLowerCase() === "image" && /logo/i.test(a.href || "")) push(href, 4, "preload");
    }
  }
  // header / nav / home-link <img>
  const regions: Array<[number, number]> = [];
  for (const tag of ["header", "nav"]) {
    const re = new RegExp("<" + tag + "\\b[^>]*>", "gi");
    let k = 0, mm: RegExpExecArray | null;
    while ((mm = re.exec(text)) && k++ < 6) {
      const close = text.toLowerCase().indexOf("</" + tag, mm.index);
      regions.push([mm.index, close < 0 ? mm.index + 60_000 : close]);
    }
  }
  const inRegion = (i: number) => regions.some(([a, b]) => i >= a && i <= b);
  const imgRe = /<img\b[^>]*>/gi;
  let nImg = 0;
  while ((m = imgRe.exec(text)) && nImg++ < 120) {
    const a = attrs(m[0]);
    let src = a.src || "";
    if (!src || /^data:/i.test(src) || /placeholder|spacer|blank\.|lazy\.(gif|png)/i.test(src)) src = a["data-src"] || a["data-lazy-src"] || a["data-original"] || "";
    if (!src && (a.srcset || a["data-srcset"])) { const parts = (a.srcset || a["data-srcset"]).split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean); if (parts.length) src = parts[parts.length - 1]; }
    if (!src || /^data:/i.test(src)) continue;
    const meta = ((a.alt || "") + " " + (a.class || "") + " " + (a.id || "") + " " + src).toLowerCase();
    let sc = 0;
    if (/logo/.test(meta)) sc += 3;
    if (inRegion(m.index)) sc += 2;
    if (/\.svg(\?|$)/i.test(src)) sc += 2; else if (/\.png(\?|$)/i.test(src)) sc += 1;
    if (/sprite|placeholder|pixel|spacer|blank|avatar|badge|customer|client|partner|trusted|marquee/.test(meta)) sc -= 3;
    if (/favicon|apple-touch|icon-\d|\/icons?\//.test(meta)) sc -= 2;
    const w = parseInt(a.width || "0", 10);
    if (w && w < 24) sc -= 2; else if (w >= 40 && w <= 800) sc += 1;
    if (nImg <= 15) sc += 1;
    if (sc >= 3) push(abs(src, base), sc, "img");
  }
  const list = Array.from(logos.values()).sort((x, y) => y.score - x.score).slice(0, 12);
  const seenIcon = new Set<string>();
  const iconList = icons.filter((i) => (seenIcon.has(i.src) ? false : (seenIcon.add(i.src), true))).slice(0, 12);
  return { logos: list, icons: iconList, manifest, og, title };
}

export interface ManifestIcon { src: string; sizes: string | null }

/** The icons of a web-app manifest (already fetched and vetted by the caller), largest first. */
export function manifestIcons(jsonText: string, base: URL): ManifestIcon[] {
  try {
    const j = JSON.parse(jsonText);
    const ics = Array.isArray(j?.icons) ? j.icons : [];
    const out: ManifestIcon[] = [];
    for (const ic of ics.slice(0, 20)) {
      if (!ic || typeof ic !== "object") continue;
      const src = abs(String((ic as Record<string, unknown>).src || ""), base);
      if (!src) continue;
      const sizes = (ic as Record<string, unknown>).sizes;
      out.push({ src, sizes: typeof sizes === "string" ? sizes.slice(0, 40) : null });
    }
    const px = (s: string | null) => { const m = /(\d+)x(\d+)/i.exec(s || ""); return m ? Number(m[1]) : 0; };
    return dedupe(out.map((o) => o.src)).map((s) => out.find((o) => o.src === s)!).sort((a, b) => px(b.sizes) - px(a.sizes)).slice(0, 8);
  } catch {
    return [];
  }
}
