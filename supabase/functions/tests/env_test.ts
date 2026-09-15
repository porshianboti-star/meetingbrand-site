// deno test -A tests/  — secrets validation + the 503 not_configured body.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeTokenKey, defaultGoogleRedirectUri, defaultMsRedirectUri, googleEnv, msEnv, notConfiguredBody, PLATFORM_SECRET_NAMES, supabaseEnv, zoomEnv } from "../_shared/env.ts";
import { b64url } from "../_shared/crypto.ts";

const ALL = ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL", "ZOOM_REDIRECT_URI", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_REDIRECT_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
function clear() {
  for (const n of ALL) Deno.env.delete(n);
}

Deno.test("decodeTokenKey: std + url-safe base64, exactly 32 bytes", () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const std = btoa(String.fromCharCode(...raw));
  assertEquals(decodeTokenKey(std)?.length, 32);
  assertEquals(decodeTokenKey(b64url(raw))?.length, 32);
  assertEquals(decodeTokenKey(" " + std + "\n"), decodeTokenKey(std));
  assertEquals(decodeTokenKey(btoa("short")), null);
  assertEquals(decodeTokenKey("***"), null);
});

Deno.test("zoomEnv: lists every missing secret (no throw)", () => {
  clear();
  const r = zoomEnv();
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.missing, ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  const body = notConfiguredBody(r.ok ? [] : r.missing);
  assertEquals(body.error, "not_configured");
  assert(body.detail.includes("supabase secrets set ZOOM_CLIENT_ID=…"));
});

Deno.test("zoomEnv: invalid key / app url are reported by name", () => {
  clear();
  Deno.env.set("ZOOM_CLIENT_ID", "id");
  Deno.env.set("ZOOM_CLIENT_SECRET", "secret");
  Deno.env.set("MB_TOKEN_KEY", "not-32-bytes");
  Deno.env.set("MB_APP_URL", "meetingbrand.com/app/");
  const r = zoomEnv();
  assertEquals(r.ok, false);
  if (!r.ok) {
    assert(r.missing.some((m) => m.startsWith("MB_TOKEN_KEY (")));
    assert(r.missing.some((m) => m.startsWith("MB_APP_URL (")));
  }
  clear();
});

Deno.test("zoomEnv + supabaseEnv: happy path derives the redirect uri from SUPABASE_URL", () => {
  clear();
  Deno.env.set("ZOOM_CLIENT_ID", "id");
  Deno.env.set("ZOOM_CLIENT_SECRET", "secret");
  Deno.env.set("MB_TOKEN_KEY", b64url(crypto.getRandomValues(new Uint8Array(32))));
  Deno.env.set("MB_APP_URL", "https://meetingbrand.com/app/");
  Deno.env.set("SUPABASE_URL", "https://ohobtgbyrlczfdztzvqi.supabase.co/");
  Deno.env.set("SUPABASE_ANON_KEY", "anon");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
  const z = zoomEnv();
  assert(z.ok);
  if (z.ok) assertEquals(z.env.redirectUri, "https://ohobtgbyrlczfdztzvqi.supabase.co/functions/v1/mb-oauth-zoom/callback");
  const s = supabaseEnv();
  assert(s.ok);
  if (s.ok) assertEquals(s.env.url, "https://ohobtgbyrlczfdztzvqi.supabase.co");
  clear();
});

Deno.test("msEnv / googleEnv: per-platform missing lists (platform credentials first, then the shared app secrets); PLATFORM_SECRET_NAMES matches", () => {
  clear();
  const m = msEnv();
  assertEquals(m.ok, false);
  if (!m.ok) assertEquals(m.missing, ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  const g = googleEnv();
  assertEquals(g.ok, false);
  if (!g.ok) assertEquals(g.missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals([...PLATFORM_SECRET_NAMES.teams], ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals([...PLATFORM_SECRET_NAMES.meet], ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);
  assertEquals([...PLATFORM_SECRET_NAMES.zoom], ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL"]);

  // the shared app secrets set: only the platform pair is missing; a Zoom secret never leaks into another platform's list
  Deno.env.set("MB_TOKEN_KEY", b64url(crypto.getRandomValues(new Uint8Array(32))));
  Deno.env.set("MB_APP_URL", "https://meetingbrand.com/app/");
  Deno.env.set("ZOOM_CLIENT_ID", "z");
  Deno.env.set("ZOOM_CLIENT_SECRET", "z");
  const m2 = msEnv();
  if (!m2.ok) assertEquals(m2.missing, ["MS_CLIENT_ID", "MS_CLIENT_SECRET"]);
  const g2 = googleEnv();
  if (!g2.ok) assertEquals(g2.missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  assertEquals(zoomEnv().ok, true);

  Deno.env.set("MS_CLIENT_ID", "m");
  Deno.env.set("MS_CLIENT_SECRET", "m");
  Deno.env.set("GOOGLE_CLIENT_ID", "g");
  Deno.env.set("GOOGLE_CLIENT_SECRET", "g");
  Deno.env.set("SUPABASE_URL", "https://x.supabase.co/");
  const m3 = msEnv();
  assert(m3.ok);
  if (m3.ok) assertEquals(m3.env.redirectUri, "https://x.supabase.co/functions/v1/mb-oauth-ms/callback");
  const g3 = googleEnv();
  assert(g3.ok);
  if (g3.ok) assertEquals(g3.env.redirectUri, "https://x.supabase.co/functions/v1/mb-oauth-google/callback");
  Deno.env.set("MS_REDIRECT_URI", "https://custom/ms");
  Deno.env.set("GOOGLE_REDIRECT_URI", "https://custom/g");
  assertEquals(defaultMsRedirectUri(), "https://custom/ms");
  assertEquals(defaultGoogleRedirectUri(), "https://custom/g");
  clear();
});
