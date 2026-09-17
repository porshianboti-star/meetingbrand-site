// _shared/agent.ts — the pure parts of the MeetingBrand Agent backend (mb-agent): key/token formats and hashing,
// the deterministic Teams GUID, assignment shaping and the report → pushes.state mapping. No network, no Deno APIs
// beyond WebCrypto, so every rule here is unit-tested without a server (tests/agent_test.ts).
//
// Secrets: the org enrollment key ('mbk_' + 32 url-safe chars) and the device token ('mbd_' + 40 url-safe chars)
// are shown to their holder once; the database keeps only hex sha256 (enrollment_keys.key_hash, agents.token_hash).

import { b64url } from "./crypto.ts";

export const KEY_PREFIX = "mbk_";
export const TOKEN_PREFIX = "mbd_";
export const KEY_RE = /^mbk_[A-Za-z0-9_-]{32}$/;
export const TOKEN_RE = /^mbd_[A-Za-z0-9_-]{40}$/;

export const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;
export const ROTATE_BELOW_MS = 30 * 24 * 3600 * 1000;
export const POLL_SECONDS = 14400;
export const SIGNED_URL_TTL_S = 3600;
export const ENROLL_RATE_LIMIT_PER_MIN = 60;
export const MAX_REPORT_ITEMS = 50;

/** Fixed v5 namespace for MeetingBrand Teams tile GUIDs (never change: the GUID is the on-disk file name). */
export const MB_GUID_NAMESPACE = "6d3b2e1a-4c5f-4a9e-8b7d-0f1e2d3c4b5a";

const enc = new TextEncoder();

export async function sha256Hex(s: string | Uint8Array): Promise<string> {
  const bytes = typeof s === "string" ? enc.encode(s) : s;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 'mbd_' + 40 url-safe chars (30 random bytes → 40 base64url chars, no padding). */
export function newDeviceToken(): string {
  return TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(30)));
}

/** True when the token has less than ROTATE_BELOW_MS left (or no expiry at all). */
export function shouldRotate(expiresAt: string | null | undefined, now: number): boolean {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(t)) return true;
  return t - now < ROTATE_BELOW_MS;
}

export function isExpired(expiresAt: string | null | undefined, now: number): boolean {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  return !Number.isFinite(t) || t <= now;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBytes(u: string): Uint8Array {
  if (!UUID_RE.test(u)) throw new Error("bad uuid");
  const hex = u.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** RFC 4122 v5 (SHA-1) uuid of `name` under `namespace`, lower-case canonical form. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const ns = uuidBytes(namespace);
  const nm = enc.encode(name);
  const input = new Uint8Array(ns.length + nm.length);
  input.set(ns, 0);
  input.set(nm, ns.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const b = h.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Teams tile GUID for one (org, employee, background): stable across polls, so a re-push byte-swaps the same file. */
export async function assignmentGuid(orgId: string, employeeId: string, backgroundId: string): Promise<string> {
  return (await uuidV5(MB_GUID_NAMESPACE, `${orgId.toLowerCase()}:${employeeId.toLowerCase()}:${backgroundId.toLowerCase()}`)).toUpperCase();
}

/** Tile label appended after the GUID (text after the GUID becomes the Teams tile label): ASCII, no path chars, ≤ 40. */
export function tileLabel(label: string | null | undefined): string {
  const base = (label ?? "").normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|$`'{}]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return base ? `MeetingBrand - ${base}` : "MeetingBrand";
}

export const TEAMS_PLATFORM = "teams";
export const MEET_PLATFORM = "meet";
/** Where a device delivers: the OS agent writes Teams tiles, the browser extension composites in Meet. */
export type DeliveryPlatform = "teams" | "meet";
export const AGENT_OS = ["windows", "macos", "chrome", "edge"] as const;
export type AgentOs = typeof AGENT_OS[number];
export function isAgentOs(v: unknown): v is AgentOs {
  return typeof v === "string" && (AGENT_OS as readonly string[]).includes(v);
}
/** The platform a device serves by default: browsers → meet, operating systems → teams. */
export function platformForOs(os: string): DeliveryPlatform {
  return os === "chrome" || os === "edge" ? MEET_PLATFORM : TEAMS_PLATFORM;
}
export function pushKey(orgId: string, employeeId: string, backgroundId: string, platform: DeliveryPlatform = TEAMS_PLATFORM): string {
  return `${orgId}:${employeeId}:${backgroundId}:${platform}`;
}

// ---------------------------------------------------------------- assignment shaping

export interface BackgroundRow {
  id: string;
  label: string | null;
  slug: string | null;
  export_asset_id: string | null;
  thumb_asset_id: string | null;
  /** 1920×1080 JPEG (kind export_jpg, 007) — preferred by the Meet extension when present; absent on older rows */
  export_jpg_asset_id?: string | null;
}
export interface PushRow {
  id: string;
  background_id: string;
  state: string;
}

/** A push row in one of these states was (or may have been) written on disk: unassigning it means a 'remove'. */
export const REMOVABLE_STATES = new Set(["queued", "pushing", "pushed", "awaiting_client", "available", "selected", "blocked"]);
/** A push row in one of these states gets re-queued when the pair is assigned again. */
export const REQUEUE_STATES = new Set(["failed", "blocked"]);

export interface Shaped {
  /** backgrounds to write, in the order they were assigned (already filtered to rows with an export) */
  write: BackgroundRow[];
  /** background ids whose files must go: unassigned pairs that were written before */
  remove: string[];
  /** background ids that were assigned but have no export yet (the app renders on demand) — reported, not written */
  skipped: string[];
  /** pair ids that need a queued pushes row (new pairs + re-queues) */
  queue: string[];
}

/**
 * Which (employee, background) pairs the agent must write and which it must remove.
 *   wanted   = employees.assigned_bg, or the org's starter backgrounds when it is empty; nothing when the employee is
 *              inactive or the agent is revoked
 *   write    = wanted ∩ backgrounds-with-export (order preserved)
 *   remove   = every existing 'teams' push of this employee whose background is not written now and whose state
 *              means a file may exist (REMOVABLE_STATES) — 'failed' rows (incl. rows already removed) are left alone
 */
export function shapeAssignments(p: {
  assigned: string[];
  starters: string[];
  backgrounds: BackgroundRow[];
  existing: PushRow[];
  active: boolean;
  revoked: boolean;
}): Shaped {
  const wanted = p.active && !p.revoked ? (p.assigned.length ? p.assigned : p.starters) : [];
  const byId = new Map(p.backgrounds.map((b) => [b.id, b]));
  const write: BackgroundRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const bg = byId.get(id);
    if (!bg) continue; // not this org's background (or deleted) — never written
    if (!bg.export_asset_id) {
      skipped.push(id);
      continue;
    }
    write.push(bg);
  }
  const writing = new Set(write.map((b) => b.id));
  const remove: string[] = [];
  const queue: string[] = [];
  const existingBy = new Map(p.existing.map((r) => [r.background_id, r]));
  for (const r of p.existing) {
    if (!writing.has(r.background_id) && REMOVABLE_STATES.has(r.state) && !remove.includes(r.background_id)) remove.push(r.background_id);
  }
  for (const b of write) {
    const r = existingBy.get(b.id);
    if (!r || REQUEUE_STATES.has(r.state)) queue.push(b.id);
  }
  return { write, remove, skipped, queue };
}

/**
 * The Meet extension applies ONE look per employee (the composited background): the first wanted background
 * (assigned_bg in order, else the org's starters) that has any 1920×1080 export — the JPEG (export_jpg_asset_id)
 * when the app rendered one, else the PNG (export_asset_id; Meet's native upload accepts PNG and JPEG, the JPEG-only
 * rule was the admin-console gallery's). Every other 'meet' push row of the employee in a removable state → remove.
 */
export function shapeMeetAssignment(p: {
  assigned: string[];
  starters: string[];
  backgrounds: BackgroundRow[];
  existing: PushRow[];
  active: boolean;
  revoked: boolean;
}): { apply: { bg: BackgroundRow; assetId: string; mime: "image/jpeg" | "image/png" } | null; remove: string[]; skipped: string[]; queue: string[] } {
  const wanted = p.active && !p.revoked ? (p.assigned.length ? p.assigned : p.starters) : [];
  const byId = new Map(p.backgrounds.map((b) => [b.id, b]));
  let apply: { bg: BackgroundRow; assetId: string; mime: "image/jpeg" | "image/png" } | null = null;
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const bg = byId.get(id);
    if (!bg) continue;
    if (apply) break; // one look only; later wanted ids are neither applied nor reported
    if (bg.export_jpg_asset_id) apply = { bg, assetId: bg.export_jpg_asset_id, mime: "image/jpeg" };
    else if (bg.export_asset_id) apply = { bg, assetId: bg.export_asset_id, mime: "image/png" };
    else skipped.push(id);
  }
  const remove: string[] = [];
  for (const r of p.existing) {
    if (r.background_id !== apply?.bg.id && REMOVABLE_STATES.has(r.state) && !remove.includes(r.background_id)) remove.push(r.background_id);
  }
  const queue: string[] = [];
  if (apply) {
    const r = p.existing.find((x) => x.background_id === apply!.bg.id);
    if (!r || REQUEUE_STATES.has(r.state)) queue.push(apply.bg.id);
  }
  return { apply, remove, skipped, queue };
}

// ---------------------------------------------------------------- report mapping

export const REPORT_STATES = ["written", "verified", "restart_needed", "removed", "blocked", "error", "applied", "unavailable"] as const;
export type ReportState = typeof REPORT_STATES[number];
/** The states each kind of device may report (an OS agent never says 'applied'; a browser never 'written'). */
export const AGENT_REPORT_STATES: readonly ReportState[] = ["written", "verified", "restart_needed", "removed", "blocked", "error"];
export const EXTENSION_REPORT_STATES: readonly ReportState[] = ["applied", "unavailable", "error"];
export function reportStatesFor(platform: DeliveryPlatform): readonly ReportState[] {
  return platform === MEET_PLATFORM ? EXTENSION_REPORT_STATES : AGENT_REPORT_STATES;
}

export interface ReportEvidence {
  path?: string;
  sha256?: string;
  bytes?: number;
  thumbBytes?: number;
  teamsRunning?: boolean;
  message?: string;
  /** extension: the Meet page (origin + path only, query stripped), the technique that ran, Meet's build hint */
  url?: string;
  technique?: string;
  meetVersionHint?: string;
  browser?: string;
  fps?: number;
  segMs?: number;
}

/**
 * Agent report → pushes.state (005's state machine):
 *   written / verified → available   (the tile is in the employee's gallery; they pick it once)
 *   restart_needed     → pushed      (files on disk; Teams must be relaunched before the tile shows)
 *   removed            → failed + error 'removed…'  (same convention as the Zoom library-full removal)
 *   blocked            → blocked + the agent's reason (no FDA on macOS 27, folder not writable, …)
 *   error              → failed + the agent's message
 * Extension report (platform meet) → pushes.state:
 *   applied            → selected    (the composited stream is what Meet sends — rung A, "Delivered — forced (extension)")
 *   unavailable        → pushed      (the image is cached on the device but not applied: toggle off, Meet's own effect
 *                                     on, no WebGL/WASM, no camera yet — the reason is in `error`)
 *   error              → failed + the extension's message
 */
export function mapReportState(state: ReportState, evidence: ReportEvidence | null | undefined): { pushState: "available" | "pushed" | "blocked" | "failed" | "selected"; error: string | null; event: "push_delivered" | "push_removed" | "push_failed" } {
  const msg = (evidence?.message ?? "").toString().trim().slice(0, 500);
  switch (state) {
    case "applied":
      return { pushState: "selected", error: null, event: "push_delivered" };
    case "unavailable":
      return { pushState: "pushed", error: msg ? `not applied: ${msg}` : "not applied (no reason given by the extension)", event: "push_delivered" };
    case "written":
    case "verified":
      return { pushState: "available", error: null, event: "push_delivered" };
    case "restart_needed":
      return { pushState: "pushed", error: null, event: "push_delivered" };
    case "removed":
      return { pushState: "failed", error: msg ? `removed by the agent: ${msg}` : "removed by the agent (background unassigned)", event: "push_removed" };
    case "blocked":
      return { pushState: "blocked", error: msg || "blocked on the device (no reason given by the agent)", event: "push_failed" };
    case "error":
      return { pushState: "failed", error: msg || "agent error (no message)", event: "push_failed" };
  }
}

/** Keep only the evidence fields we document, with caps (the jsonb column is capped at 8 KB by the schema). */
export function cleanEvidence(v: unknown): ReportEvidence | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: ReportEvidence = {};
  if (typeof o.path === "string") out.path = o.path.slice(0, 512);
  if (typeof o.sha256 === "string" && /^[0-9a-f]{64}$/i.test(o.sha256)) out.sha256 = o.sha256.toLowerCase();
  if (typeof o.bytes === "number" && Number.isFinite(o.bytes) && o.bytes >= 0) out.bytes = Math.floor(o.bytes);
  if (typeof o.thumbBytes === "number" && Number.isFinite(o.thumbBytes) && o.thumbBytes >= 0) out.thumbBytes = Math.floor(o.thumbBytes);
  if (typeof o.teamsRunning === "boolean") out.teamsRunning = o.teamsRunning;
  if (typeof o.message === "string") out.message = o.message.slice(0, 500);
  if (typeof o.url === "string") out.url = safeUrl(o.url);
  if (typeof o.technique === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(o.technique)) out.technique = o.technique;
  if (typeof o.meetVersionHint === "string") out.meetVersionHint = o.meetVersionHint.replace(/[^\x20-\x7e]/g, "").slice(0, 80);
  if (typeof o.browser === "string") out.browser = o.browser.replace(/[^\x20-\x7e]/g, "").slice(0, 80);
  if (typeof o.fps === "number" && Number.isFinite(o.fps) && o.fps >= 0) out.fps = Math.round(o.fps * 10) / 10;
  if (typeof o.segMs === "number" && Number.isFinite(o.segMs) && o.segMs >= 0) out.segMs = Math.round(o.segMs * 100) / 100;
  return out;
}

/** Origin + path of a reported page URL, query and fragment dropped (a Meet URL's query can carry invite tokens). */
export function safeUrl(v: string): string {
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return (u.origin + u.pathname).slice(0, 512);
  } catch {
    return "";
  }
}

/**
 * Lower-cased e-mail or null when the string does not look like one (used for employeeEmail and localIdentity).
 * The character set is deliberately narrow: the value becomes a PostgREST `ilike` filter, where `*` is a wildcard
 * that no escaping can neutralise (PostgREST rewrites it to `%` unconditionally) — so `*`, `%`, `\`, quotes and
 * PostgREST's reserved `,()` are rejected outright instead of letting a key holder enumerate the roster with `*@*.*`.
 */
export const EMAIL_RE = /^[a-z0-9.!#$&'+\/=?^_{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export function asEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t.length <= 320 && EMAIL_RE.test(t) ? t : null;
}

/** Which employee row wins when several rows share the e-mail (one person can come from CSV and a directory). */
export const EMPLOYEE_PLATFORM_ORDER = ["teams", "csv", "meet", "zoom", "zoho"] as const;
export function pickEmployee<T extends { platform: string; active: boolean }>(rows: T[]): T | null {
  if (!rows.length) return null;
  const rank = (r: T) => {
    const i = (EMPLOYEE_PLATFORM_ORDER as readonly string[]).indexOf(r.platform);
    return (i < 0 ? 99 : i) * 2 + (r.active ? 0 : 1); // same platform: the active row first
  };
  return [...rows].sort((a, b) => rank(a) - rank(b))[0];
}
