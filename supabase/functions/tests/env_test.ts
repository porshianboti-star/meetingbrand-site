// deno test -A tests/  — secrets validation + the 503 not_configured body.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeTokenKey, notConfiguredBody, supabaseEnv, zoomEnv } from "../_shared/env.ts";
import { b64url } from "../_shared/crypto.ts";

const ALL = ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "MB_TOKEN_KEY", "MB_APP_URL", "ZOOM_REDIRECT_URI", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
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
