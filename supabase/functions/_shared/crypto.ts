// _shared/crypto.ts — AES-256-GCM token vault crypto + HMAC-signed OAuth state, WebCrypto only.
//
// Root key: MB_TOKEN_KEY = base64 of 32 random bytes (`openssl rand -base64 32`).
// Two sub-keys are derived with HKDF-SHA256 so the same root never serves two algorithms:
//   info "mb-token-vault/aes-256-gcm/v1" → AES-256-GCM (token encryption)
//   info "mb-oauth-state/hmac-sha256/v1" → HMAC-SHA256 (OAuth state signing)
//
// CIPHERTEXT FORMAT (what lands in priv.integration_tokens.*_enc, a bytea):
//   hex( 0x01 | iv[12] | aes-gcm(plaintext) || tag[16] )   — lowercase hex, version byte 0x01 first.
// Hex was chosen (not base64) because the vault RPCs in 005-integrations.sql take
// `*_hex text` and call decode(…, 'hex') / encode(…, 'hex'); no driver has to guess bytea escaping.

import { decodeTokenKey } from "./env.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = 0x01;

export class CryptoError extends Error {}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new CryptoError("bad hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Root key material from a base64 string (32 bytes) — throws CryptoError if malformed. */
export function rootKeyBytes(b64: string): Uint8Array {
  const k = decodeTokenKey(b64);
  if (!k) throw new CryptoError("MB_TOKEN_KEY must be base64 of exactly 32 bytes");
  return k;
}

async function hkdf(root: Uint8Array, info: string, algo: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("meetingbrand"), info: enc.encode(info) },
    base,
    algo,
    false,
    usages,
  );
}

export interface VaultKeys {
  aes: CryptoKey;
  hmac: CryptoKey;
}

/** Derive both sub-keys once per request (cheap; keys are not extractable). */
export async function deriveKeys(tokenKeyB64: string): Promise<VaultKeys> {
  const root = rootKeyBytes(tokenKeyB64);
  const [aes, hmac] = await Promise.all([
    hkdf(root, "mb-token-vault/aes-256-gcm/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    hkdf(root, "mb-oauth-state/hmac-sha256/v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]),
  ]);
  return { aes, hmac };
}

/** Encrypt a UTF-8 string → hex(version|iv|ciphertext+tag). */
export async function encryptToHex(keys: VaultKeys, plaintext: string, aad = "mb-token"): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 }, keys.aes, enc.encode(plaintext)),
  );
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return toHex(out);
}

/** Decrypt hex(version|iv|ciphertext+tag) → UTF-8 string. Throws CryptoError on tamper/format/key mismatch. */
export async function decryptFromHex(keys: VaultKeys, hex: string, aad = "mb-token"): Promise<string> {
  const bytes = fromHex(hex);
  if (bytes.length < 1 + 12 + 16) throw new CryptoError("ciphertext too short");
  if (bytes[0] !== VERSION) throw new CryptoError(`unsupported ciphertext version ${bytes[0]}`);
  const iv = bytes.slice(1, 13);
  const ct = bytes.slice(13);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 }, keys.aes, ct);
    return dec.decode(pt);
  } catch {
    throw new CryptoError("decrypt failed (wrong key or tampered ciphertext)");
  }
}

// ---------------- OAuth state: HMAC-signed JSON with a TTL ----------------

export interface OAuthState {
  org_id: string;
  user_id: string;
  nonce: string;
  ts: number; // unix ms when signed
}
export const STATE_TTL_MS = 10 * 60 * 1000;

/** state = b64url(json) + "." + b64url(hmac). Stateless: TTL + signature, no server-side nonce store. */
export async function signState(keys: VaultKeys, payload: Omit<OAuthState, "nonce" | "ts"> & Partial<Pick<OAuthState, "nonce" | "ts">>): Promise<string> {
  const st: OAuthState = {
    org_id: payload.org_id,
    user_id: payload.user_id,
    nonce: payload.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(16))),
    ts: payload.ts ?? Date.now(),
  };
  const body = b64url(enc.encode(JSON.stringify(st)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.hmac, enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

export type StateVerdict = { ok: true; state: OAuthState } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "future" };

/** Verify signature (constant-time via WebCrypto verify) then TTL. */
export async function verifyState(keys: VaultKeys, token: string, now = Date.now(), ttlMs = STATE_TTL_MS): Promise<StateVerdict> {
  const parts = (token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let mac: Uint8Array;
  try {
    mac = fromB64url(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify("HMAC", keys.hmac, mac as BufferSource, enc.encode(parts[0]));
  if (!valid) return { ok: false, reason: "bad_signature" };
  let st: OAuthState;
  try {
    st = JSON.parse(dec.decode(fromB64url(parts[0])));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof st?.org_id !== "string" || typeof st?.user_id !== "string" || typeof st?.ts !== "number" || typeof st?.nonce !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (st.ts > now + 60_000) return { ok: false, reason: "future" };
  if (now - st.ts > ttlMs) return { ok: false, reason: "expired" };
  return { ok: true, state: st };
}
