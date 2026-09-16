// deno test -A tests/  — AES-256-GCM vault round-trip + HMAC-signed OAuth state.
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { b64url, CryptoError, decryptFromHex, deriveKeys, encryptToHex, fromHex, signState, STATE_TTL_MS, verifyState } from "../_shared/crypto.ts";

const KEY_A = b64url(crypto.getRandomValues(new Uint8Array(32)));
const KEY_B = b64url(crypto.getRandomValues(new Uint8Array(32)));

Deno.test("vault: encrypt → hex(0x01|iv|ct+tag) → decrypt round-trips", async () => {
  const keys = await deriveKeys(KEY_A);
  const secret = "eyJhbGciOiJIUzUxMiIsInYiOiIyLjAiLCJraWQiOiIxIn0.refresh-token-with-unicode-ñ-🔐";
  const hex = await encryptToHex(keys, secret);
  assert(/^[0-9a-f]+$/.test(hex), "lowercase hex only");
  const bytes = fromHex(hex);
  assertEquals(bytes[0], 0x01, "version byte");
  assertEquals(bytes.length, 1 + 12 + new TextEncoder().encode(secret).length + 16, "iv 12 + tag 16");
  assertEquals(await decryptFromHex(keys, hex), secret);
});

Deno.test("vault: two encryptions of the same plaintext differ (random iv)", async () => {
  const keys = await deriveKeys(KEY_A);
  assertNotEquals(await encryptToHex(keys, "same"), await encryptToHex(keys, "same"));
});

Deno.test("vault: wrong key, tampered byte, wrong aad, bad version → CryptoError", async () => {
  const a = await deriveKeys(KEY_A);
  const b = await deriveKeys(KEY_B);
  const hex = await encryptToHex(a, "top-secret");
  await assertRejects(() => decryptFromHex(b, hex), CryptoError);
  const flipped = hex.slice(0, -2) + (hex.endsWith("00") ? "01" : "00");
  await assertRejects(() => decryptFromHex(a, flipped), CryptoError);
  await assertRejects(() => decryptFromHex(a, hex, "other-aad"), CryptoError);
  await assertRejects(() => decryptFromHex(a, "02" + hex.slice(2)), CryptoError, "version");
  await assertRejects(() => decryptFromHex(a, "0102"), CryptoError, "short");
  await assertRejects(() => decryptFromHex(a, "zz"), CryptoError, "hex");
});

Deno.test("vault: accepts Postgres '\\x…' bytea text prefix", async () => {
  const keys = await deriveKeys(KEY_A);
  const hex = await encryptToHex(keys, "pg");
  assertEquals(await decryptFromHex(keys, "\\x" + hex), "pg");
});

Deno.test("deriveKeys rejects a key that is not 32 bytes", async () => {
  await assertRejects(() => deriveKeys(b64url(new Uint8Array(16))), CryptoError);
  await assertRejects(() => deriveKeys("not base64!!"), CryptoError);
});

Deno.test("state: sign → verify carries org/user, nonce and ts", async () => {
  const keys = await deriveKeys(KEY_A);
  const t0 = 1_800_000_000_000;
  const token = await signState(keys, { org_id: "org-1", user_id: "user-1", ts: t0 });
  assertEquals(token.split(".").length, 2);
  const v = await verifyState(keys, token, t0 + 1000);
  assert(v.ok);
  if (v.ok) {
    assertEquals(v.state.org_id, "org-1");
    assertEquals(v.state.user_id, "user-1");
    assertEquals(v.state.ts, t0);
    assert(v.state.nonce.length >= 16);
  }
});

Deno.test("state: expires after 10 minutes, rejects the future, rejects other keys and tampering", async () => {
  const a = await deriveKeys(KEY_A);
  const b = await deriveKeys(KEY_B);
  const t0 = 1_800_000_000_000;
  const token = await signState(a, { org_id: "org-1", user_id: "user-1", ts: t0 });
  assertEquals(STATE_TTL_MS, 600_000);
  assertEquals((await verifyState(a, token, t0 + STATE_TTL_MS)).ok, true, "exactly at the TTL is still valid");
  const late = await verifyState(a, token, t0 + STATE_TTL_MS + 1);
  assertEquals(late.ok, false);
  if (!late.ok) assertEquals(late.reason, "expired");
  const early = await verifyState(a, token, t0 - 61_000);
  if (!early.ok) assertEquals(early.reason, "future");
  const other = await verifyState(b, token, t0);
  if (!other.ok) assertEquals(other.reason, "bad_signature");
  // swap the payload for another org, keep the mac
  const [body, mac] = token.split(".");
  const forged = b64url(new TextEncoder().encode(JSON.stringify({ org_id: "org-2", user_id: "user-1", nonce: "x".repeat(22), ts: t0 }))) + "." + mac;
  const f = await verifyState(a, forged, t0);
  if (!f.ok) assertEquals(f.reason, "bad_signature");
  assertEquals((await verifyState(a, body, t0)).ok, false, "missing mac");
  assertEquals((await verifyState(a, "", t0)).ok, false);
  const m = await verifyState(a, "a.b.c", t0);
  if (!m.ok) assertEquals(m.reason, "malformed");
});

Deno.test("state platform binding: a state minted for one connector cannot finish another; pre-v2 states (no platform) still pass", async () => {
  const { stateForPlatform } = await import("../_shared/crypto.ts");
  const keys = await deriveKeys(b64url(crypto.getRandomValues(new Uint8Array(32))));
  const teams = await verifyState(keys, await signState(keys, { org_id: "o", user_id: "u", platform: "teams" }));
  assert(teams.ok && teams.state.platform === "teams");
  assert(teams.ok && stateForPlatform(teams.state, "teams") && !stateForPlatform(teams.state, "zoom"));
  const legacy = await verifyState(keys, await signState(keys, { org_id: "o", user_id: "u" }));
  assert(legacy.ok && legacy.state.platform === undefined && stateForPlatform(legacy.state, "meet"));
});
