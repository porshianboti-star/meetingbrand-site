// mb-agent — the MeetingBrand Agent's backend (PLAN-active-push §2: enroll → device token → poll → Teams file-drop → report)
// AND the Meet extension's (PLAN §1.3/§3: the force-installed Chrome/Edge extension enrolls with the same org key,
// polls the same endpoints with os 'chrome'|'edge' and platform 'meet', and reports applied|unavailable|error).
// One function, the action is the last path segment (…/mb-agent/enroll) — `?action=` works too.
//
//   POST /enroll      {orgKey, deviceId, os: windows|macos|chrome|edge, hostname?, localIdentity?, version?, employeeEmail?}
//                     (the extension sends os = its host browser, hostname = "Chrome 152 · macOS"-style description,
//                      version = the extension version, employeeEmail from managed config / the product page /
//                      chrome.identity — see the extension's background.js)
//                     → the key is looked up by sha256 (enrollment_key_use RPC: not revoked, ≤ 60 enrollments/min/key)
//                     → the org; the person is matched by employeeEmail (case-insensitive) when given, else by
//                       localIdentity when it looks like an e-mail; no match → an agent row WITHOUT employee
//                       (state "unmatched": the admin binds it later with mb.bind_agent)
//                     → the (org, device) row is created or refreshed (a revoked device re-enrolling with a valid key
//                       is un-revoked — the admin holds both levers) with a fresh device token
//                     → 200 {deviceToken, tokenExpiresAt, agentId, employee:{id,email,name,active}|null, state, pollSeconds}
//                     401 bad key · 410 revoked key · 429 rate-limited (per key: 60/min; per source IP: 30 refused
//                     keys per 10 min, counted in this isolate only — see FailureLimiter)
//   GET  /assignments Bearer <deviceToken>   [?platform=teams|meet — default: meet for chrome/edge devices, teams otherwise]
//                     platform meet (the extension): ONE item — the first wanted background (assigned_bg in order, else the
//                       org's starters) that has a 1920×1080 export, JPEG (export_jpg_asset_id) preferred over PNG
//                       (export_asset_id; Meet's native upload accepts both — the JPEG-only rule was the admin-console
//                       gallery's) → {platform:'meet', backgroundId, guid, label, imageUrl (signed, 1 h), mime, pngUrl (= imageUrl,
//                       kept for symmetry), thumbUrl, sha256, bytes, action:'apply'}; other 'meet' push rows of the employee in a
//                       removable state → action:'remove' (the extension drops its cache); pushes rows platform 'meet',
//                       key org:employee:background:meet. The image is the same file for every employee of the org
//                       (Meet has no per-employee file name), signed per device.
//                     platform teams (the OS agent):
//                     → for the agent's employee (active = true): every background of employees.assigned_bg — or the
//                       org's starter backgrounds when it is empty — that has a 1920×1080 export
//                       → {platform:'teams', backgroundId, guid (uuid v5 of org:employee:background — the file name),
//                          label 'MeetingBrand - <label>', pngUrl (signed, 1 h), thumbUrl (signed | null), sha256, bytes,
//                          action:'write'}; unassigned pairs that were written before → action:'remove'
//                     → creates mb.pushes rows (platform teams, state queued, key org:employee:background:teams) for new
//                       pairs; re-queues failed/blocked ones
//                     → rotates the device token when < 30 days remain (the reply then carries a new deviceToken)
//                     401 bad/expired token · 410 revoked (body lists every written pair as action:'remove')
//   POST /report      Bearer  {items:[{backgroundId, state, evidence?, platform?}]}
//                     agent states: written|verified|restart_needed|removed|blocked|error
//                     → mb.agent_reports + mb.pushes.state (written/verified → available, restart_needed → pushed,
//                       removed → failed 'removed…', blocked → blocked, error → failed) + events push_delivered / push_failed
//                       / push_removed {platform:'teams', via:'agent'}
//                     extension states (platform meet): applied|unavailable|error, evidence {url, technique, meetVersionHint,
//                       browser, fps, segMs, message} → applied → selected (rung A), unavailable → pushed + the reason,
//                       error → failed; events carry {platform:'meet', via:'extension'}
//                     an item for a pair that was never assigned (on that platform) is rejected per item; a state that the
//                     device's kind may not report is rejected per item; 422 when nothing in the batch was accepted
//   POST /heartbeat   Bearer  {version?, teamsRunning?}  → last_seen_at + version
//
// Auth is the device token only (no user session): every table write goes through the service role, every row
// is pinned to the agent's org / employee. CORS headers are harmless here (native client) and stay for symmetry.

import { notConfiguredBody, supabaseEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn } from "../_shared/http.ts";
import { serviceClient } from "../_shared/auth.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import { isSafeOrgStoragePath, UUID_RE } from "../_shared/platform.ts";
import { recordEvent } from "../_shared/events.ts";
import {
  AGENT_OS,
  asEmail,
  assignmentGuid,
  type BackgroundRow,
  cleanEvidence,
  type DeliveryPlatform,
  ENROLL_RATE_LIMIT_PER_MIN,
  isAgentOs,
  isExpired,
  KEY_RE,
  mapReportState,
  MAX_REPORT_ITEMS,
  MEET_PLATFORM,
  newDeviceToken,
  pickEmployee,
  platformForOs,
  POLL_SECONDS,
  pushKey,
  type PushRow,
  type ReportState,
  reportStatesFor,
  sha256Hex,
  shapeAssignments,
  shapeMeetAssignment,
  shouldRotate,
  SIGNED_URL_TTL_S,
  TEAMS_PLATFORM,
  tileLabel,
  TOKEN_RE,
  TOKEN_TTL_MS,
} from "../_shared/agent.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Failed-/enroll limiter (per source IP, in this isolate); a fresh one per handler so tests are independent. */
  enrollFailures?: FailureLimiter;
}

/**
 * Best-effort brake on /enroll guessing: after ENROLL_FAILS_PER_WINDOW refused keys from one source IP within
 * ENROLL_FAIL_WINDOW_MS the isolate answers 429 without touching the database. Successful enrollments never count
 * (a whole office rolling out behind one NAT is unaffected); the key's 192 bits make guessing hopeless anyway —
 * this only keeps garbage away from the RPC. Memory-bounded: the map is pruned on every hit.
 */
export const ENROLL_FAILS_PER_WINDOW = 30;
export const ENROLL_FAIL_WINDOW_MS = 10 * 60_000;
export class FailureLimiter {
  private hits = new Map<string, { n: number; since: number }>();
  constructor(private max = ENROLL_FAILS_PER_WINDOW, private windowMs = ENROLL_FAIL_WINDOW_MS) {}
  /** True when this source must be refused right now. */
  limited(key: string, now: number): boolean {
    const h = this.hits.get(key);
    if (!h) return false;
    if (now - h.since >= this.windowMs) {
      this.hits.delete(key);
      return false;
    }
    return h.n >= this.max;
  }
  /** Count one failure for this source. */
  fail(key: string, now: number): void {
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (now - v.since >= this.windowMs) this.hits.delete(k);
      if (this.hits.size > 10_000) this.hits.clear();
    }
    const h = this.hits.get(key);
    if (!h || now - h.since >= this.windowMs) this.hits.set(key, { n: 1, since: now });
    else h.n++;
  }
}

/** The caller's source IP as seen by the edge (first x-forwarded-for hop), or "?" when the platform sends none. */
export function sourceIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0].trim();
  if (/^[0-9a-f.:]{3,45}$/i.test(first)) return first.toLowerCase();
  const real = (req.headers.get("x-real-ip") ?? "").trim();
  return /^[0-9a-f.:]{3,45}$/i.test(real) ? real.toLowerCase() : "?";
}

export const EXPORT_BUCKET = "mb-exports";
const ACTIONS = new Set(["enroll", "assignments", "report", "heartbeat"]);

interface AgentRow {
  id: string;
  org_id: string;
  employee_id: string | null;
  device_id: string;
  os: string;
  version: string | null;
  token_expires_at: string | null;
  revoked_at: string | null;
}
interface EmployeeRow {
  id: string;
  platform: string;
  email: string | null;
  name: string | null;
  active: boolean;
  assigned_bg: string[] | null;
}
interface AssetRow {
  id: string;
  bucket: string;
  storage_path: string;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
}

/** The action from the path (…/mb-agent/<action>) or ?action=. */
export function actionOf(url: URL): string {
  const segs = url.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  if (last && last !== "mb-agent") return last;
  return url.searchParams.get("action") ?? "";
}

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const enrollFailures = deps.enrollFailures ?? new FailureLimiter();

  return serveFn("mb-agent", async (req, { log }) => {
    const url = new URL(req.url);
    const action = actionOf(url);
    if (!ACTIONS.has(action)) throw new HttpError(404, "unknown_action", "use /enroll, /assignments, /report or /heartbeat");
    const wantMethod = action === "assignments" ? "GET" : "POST";
    if (req.method !== wantMethod) throw new HttpError(405, "method_not_allowed", `use ${wantMethod}`);

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));
    const sb = serviceClient(sbEnv.env, fetchImpl);

    // ================================================================ /enroll
    if (action === "enroll") {
      const ip = sourceIp(req);
      if (enrollFailures.limited(ip, now())) {
        log.warn("enroll_source_limited", { ip });
        throw new HttpError(429, "rate_limited", "too many refused enrollment attempts from this address — retry later", { retry_after_ms: ENROLL_FAIL_WINDOW_MS });
      }
      const refuse = (status: number, code: string, detail: string, extra?: Record<string, unknown>) => {
        enrollFailures.fail(ip, now());
        return new HttpError(status, code, detail, extra);
      };
      const body = await readJson<Record<string, unknown>>(req);
      const orgKey = typeof body.orgKey === "string" ? body.orgKey.trim() : "";
      if (!KEY_RE.test(orgKey)) throw refuse(401, "bad_key", "orgKey must be an enrollment key (mbk_…)");
      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) throw new HttpError(400, "bad_request", "deviceId must be 1–128 chars of [A-Za-z0-9._:-]");
      const os = typeof body.os === "string" ? body.os.trim().toLowerCase() : "";
      if (!isAgentOs(os)) throw new HttpError(400, "bad_request", `os must be one of ${AGENT_OS.join(", ")}`);
      const hostname = str(body.hostname, 200);
      const localIdentity = str(body.localIdentity, 320);
      const version = str(body.version, 40);
      const explicitEmail = body.employeeEmail === undefined || body.employeeEmail === null || body.employeeEmail === "" ? null : asEmail(body.employeeEmail);
      if (body.employeeEmail !== undefined && body.employeeEmail !== null && body.employeeEmail !== "" && !explicitEmail) throw new HttpError(400, "bad_request", "employeeEmail must be an e-mail address");

      // ---- key → org (one RPC: existence, revocation, rate window)
      const keyHash = await sha256Hex(orgKey);
      const { data: keyRows, error: keyErr } = await sb.rpc("enrollment_key_use", { p_key_hash: keyHash, p_limit: ENROLL_RATE_LIMIT_PER_MIN });
      if (keyErr) throw new HttpError(500, "db_error", `enrollment key lookup failed: ${keyErr.message}`);
      const key = (Array.isArray(keyRows) ? keyRows[0] : keyRows) as { key_id: string; key_org_id: string; revoked: boolean; limited: boolean } | undefined;
      if (!key) {
        log.warn("enroll_bad_key", { device_id: deviceId, ip });
        throw refuse(401, "bad_key", "unknown enrollment key");
      }
      if (key.revoked) throw refuse(410, "key_revoked", "this enrollment key was revoked — ask the workspace admin for a new one");
      if (key.limited) throw new HttpError(429, "rate_limited", `at most ${ENROLL_RATE_LIMIT_PER_MIN} enrollments per minute per key — retry later`, { retry_after_ms: 60_000 });
      const orgId = key.key_org_id;

      // ---- employee match (explicit e-mail wins; else the local identity when it is an e-mail)
      const email = explicitEmail ?? asEmail(localIdentity);
      let employee: EmployeeRow | null = null;
      if (email) {
        const { data: emps, error: empErr } = await sb.from("employees").select("id, platform, email, name, active, assigned_bg").eq("org_id", orgId).ilike("email", escapeLike(email));
        if (empErr) throw new HttpError(500, "db_error", `employees lookup failed: ${empErr.message}`);
        employee = pickEmployee((emps ?? []) as EmployeeRow[]);
      }

      // ---- create / refresh the agent row
      const token = newDeviceToken();
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(now() + TOKEN_TTL_MS).toISOString();
      const nowIso = new Date(now()).toISOString();
      const { data: prevRows, error: prevErr } = await sb.from("agents").select("id, employee_id, revoked_at").eq("org_id", orgId).eq("device_id", deviceId).limit(1);
      if (prevErr) throw new HttpError(500, "db_error", `agents lookup failed: ${prevErr.message}`);
      const prev = (prevRows ?? [])[0] as { id: string; employee_id: string | null; revoked_at: string | null } | undefined;
      const patch: Record<string, unknown> = {
        os,
        hostname,
        local_identity: localIdentity,
        version,
        token_hash: tokenHash,
        token_expires_at: expiresAt,
        enrolled_at: nowIso,
        last_seen_at: nowIso,
        revoked_at: null,
      };
      // a match replaces the binding; no match keeps whatever the admin bound before (never downgrades to unmatched)
      if (employee) patch.employee_id = employee.id;
      let agentId: string;
      if (prev) {
        const { error } = await sb.from("agents").update(patch).eq("id", prev.id);
        if (error) throw new HttpError(500, "db_error", `agents update failed: ${error.message}`);
        agentId = prev.id;
        if (!employee && prev.employee_id) {
          const { data: kept } = await sb.from("employees").select("id, platform, email, name, active, assigned_bg").eq("id", prev.employee_id).eq("org_id", orgId).limit(1);
          employee = ((kept ?? [])[0] as EmployeeRow | undefined) ?? null;
        }
      } else {
        const { data: ins, error } = await sb.from("agents").insert({ org_id: orgId, device_id: deviceId, employee_id: employee?.id ?? null, ...patch }).select("id");
        if (error) throw new HttpError(500, "db_error", `agents insert failed: ${error.message}`);
        agentId = ((ins ?? [])[0] as { id: string } | undefined)?.id ?? "";
        if (!agentId) throw new HttpError(500, "db_error", "agents insert returned no id");
      }

      const state = employee ? "matched" : "unmatched";
      await recordEvent(sb, "agent_enrolled", null, { org_id: orgId, agent_id: agentId, os, matched: !!employee, re_enrolled: !!prev, revived: !!prev?.revoked_at, via: "agent" });
      log.info("enrolled", { org_id: orgId, agent_id: agentId, os, state, re_enrolled: !!prev });
      return json(req, 200, {
        deviceToken: token,
        tokenExpiresAt: expiresAt,
        agentId,
        employee: employee ? { id: employee.id, email: employee.email, name: employee.name, active: employee.active } : null,
        state,
        detail: employee ? undefined : `no employee of this workspace has the e-mail ${email ?? "(none given)"} — the files wait until the admin binds this device to a person (My team → Agents)`,
        pollSeconds: POLL_SECONDS,
      });
    }

    // ================================================================ device-token auth for everything else
    const { agent, tokenHash } = await requireAgent(req, sb, now());

    // ================================================================ /assignments
    if (action === "assignments") {
      const nowIso = new Date(now()).toISOString();
      const orgId = agent.org_id;
      const platform = deliveryPlatform(url.searchParams.get("platform"), agent.os);
      let employee: EmployeeRow | null = null;
      if (agent.employee_id) {
        const { data, error } = await sb.from("employees").select("id, platform, email, name, active, assigned_bg").eq("id", agent.employee_id).eq("org_id", orgId).limit(1);
        if (error) throw new HttpError(500, "db_error", `employees lookup failed: ${error.message}`);
        employee = ((data ?? [])[0] as EmployeeRow | undefined) ?? null;
      }
      const revoked = !!agent.revoked_at;

      if (!employee) {
        if (revoked) throw new HttpError(410, "revoked", "this device was revoked — remove every MeetingBrand file you wrote and stop polling", { assignments: [], action: "remove_all" });
        await sb.from("agents").update({ last_seen_at: nowIso }).eq("id", agent.id);
        return json(req, 200, { agentId: agent.id, employee: null, state: "unmatched", assignments: [], skipped: [], pollSeconds: POLL_SECONDS, detail: "no person is bound to this device yet — the admin binds it in My team → Agents" });
      }

      // ---- what should be there
      const assigned = (employee.assigned_bg ?? []).filter((x) => typeof x === "string" && UUID_RE.test(x));
      let starters: string[] = [];
      if (!assigned.length && employee.active && !revoked) {
        const { data, error } = await sb.from("backgrounds").select("id").eq("org_id", orgId).eq("state->>starter", "true").order("created_at", { ascending: true }).limit(10);
        if (error) throw new HttpError(500, "db_error", `starter lookup failed: ${error.message}`);
        starters = ((data ?? []) as Array<{ id: string }>).map((b) => b.id);
      }
      const ids = [...new Set([...assigned, ...starters])];
      let backgrounds: BackgroundRow[] = [];
      if (ids.length) {
        const { data, error } = await sb.from("backgrounds").select("id, label, slug, export_asset_id, thumb_asset_id, export_jpg_asset_id").eq("org_id", orgId).in("id", ids);
        if (error) throw new HttpError(500, "db_error", `backgrounds lookup failed: ${error.message}`);
        backgrounds = (data ?? []) as BackgroundRow[];
      }
      const { data: pushRows, error: pErr } = await sb.from("pushes").select("id, background_id, state").eq("org_id", orgId).eq("employee_id", employee.id).eq("platform", platform);
      if (pErr) throw new HttpError(500, "db_error", `pushes lookup failed: ${pErr.message}`);
      const existing = (pushRows ?? []) as PushRow[];

      // ---------------------------------------------------------- meet: one composited look per employee
      if (platform === MEET_PLATFORM) {
        const m = shapeMeetAssignment({ assigned, starters, backgrounds, existing, active: employee.active, revoked });
        const items: Array<Record<string, unknown>> = [];
        for (const bgId of m.remove) items.push({ platform: MEET_PLATFORM, backgroundId: bgId, guid: await assignmentGuid(orgId, employee.id, bgId), action: "remove" });
        if (revoked) {
          throw new HttpError(410, "revoked", "this device was revoked — stop applying the background, drop the cached image and stop polling", { assignments: items, action: "remove_all" });
        }
        const notReady: string[] = [];
        if (m.apply) {
          const { data, error } = await sb.from("brand_assets").select("id, bucket, storage_path, mime, bytes, sha256").eq("org_id", orgId).eq("id", m.apply.assetId).limit(1);
          if (error) throw new HttpError(500, "db_error", `brand_assets lookup failed: ${error.message}`);
          const img = ((data ?? [])[0] as AssetRow | undefined) ?? null;
          const signed = img ? await signExport(sb, log, orgId, img, m.apply.bg.id) : null;
          if (!signed) notReady.push(m.apply.bg.id);
          else {
            let thumbUrl: string | null = null;
            if (m.apply.bg.thumb_asset_id) {
              const { data: t } = await sb.from("brand_assets").select("id, bucket, storage_path, mime, bytes, sha256").eq("org_id", orgId).eq("id", m.apply.bg.thumb_asset_id).limit(1);
              const thumb = ((t ?? [])[0] as AssetRow | undefined) ?? null;
              if (thumb && thumb.bucket === EXPORT_BUCKET && isSafeOrgStoragePath(thumb.storage_path, orgId)) {
                const { data: ts } = await sb.storage.from(EXPORT_BUCKET).createSignedUrl(thumb.storage_path, SIGNED_URL_TTL_S);
                thumbUrl = ts?.signedUrl ?? null;
              }
            }
            items.push({
              platform: MEET_PLATFORM,
              backgroundId: m.apply.bg.id,
              guid: await assignmentGuid(orgId, employee.id, m.apply.bg.id),
              label: tileLabel(m.apply.bg.label ?? m.apply.bg.slug),
              imageUrl: signed.url,
              mime: m.apply.mime,
              pngUrl: signed.url,
              thumbUrl,
              sha256: signed.sha,
              bytes: signed.bytes,
              action: "apply",
            });
          }
        }
        const handed = new Set(items.filter((i) => i.action === "apply").map((i) => i.backgroundId as string));
        const queue = m.queue.filter((id) => handed.has(id));
        if (queue.length) {
          const rows = queue.map((bgId) => ({ org_id: orgId, employee_id: employee!.id, background_id: bgId, platform: MEET_PLATFORM, state: "queued", idempotency_key: pushKey(orgId, employee!.id, bgId, MEET_PLATFORM), agent_id: agent.id, error: null }));
          const { error } = await sb.from("pushes").upsert(rows, { onConflict: "idempotency_key" });
          if (error) log.error("pushes_queue_failed", { org_id: orgId, platform: MEET_PLATFORM, message: error.message });
        }
        const rotated = await touchAndRotate(sb, log, agent, tokenHash, nowIso, now());
        log.info("assignments", { org_id: orgId, agent_id: agent.id, employee_id: employee.id, platform: MEET_PLATFORM, apply: handed.size, remove: m.remove.length, skipped: m.skipped.length + notReady.length, queued: queue.length, rotated: !!rotated });
        return json(req, 200, {
          agentId: agent.id,
          employee: { id: employee.id, email: employee.email, name: employee.name, active: employee.active },
          state: employee.active ? "matched" : "inactive",
          platform: MEET_PLATFORM,
          assignments: items,
          skipped: [...m.skipped, ...notReady],
          expiresAt: new Date(now() + SIGNED_URL_TTL_S * 1000).toISOString(),
          pollSeconds: POLL_SECONDS,
          ...(rotated ?? {}),
        });
      }

      // ---------------------------------------------------------- teams: every wanted look as a tile pair
      const shaped = shapeAssignments({ assigned, starters, backgrounds, existing, active: employee.active, revoked });

      // ---- removes (also the whole answer for a revoked device)
      const items: Array<Record<string, unknown>> = [];
      for (const bgId of shaped.remove) {
        items.push({ platform: "teams", backgroundId: bgId, guid: await assignmentGuid(orgId, employee.id, bgId), action: "remove" });
      }
      if (revoked) {
        throw new HttpError(410, "revoked", "this device was revoked — remove the files listed in `assignments` (and any other MeetingBrand file you wrote), then stop polling", { assignments: items, action: "remove_all" });
      }

      // ---- assets of the writes (export + thumb), sha256 computed and stored when missing
      const assetIds = shaped.write.flatMap((b) => [b.export_asset_id, b.thumb_asset_id]).filter((x): x is string => !!x);
      const assets = new Map<string, AssetRow>();
      if (assetIds.length) {
        const { data, error } = await sb.from("brand_assets").select("id, bucket, storage_path, mime, bytes, sha256").eq("org_id", orgId).in("id", assetIds);
        if (error) throw new HttpError(500, "db_error", `brand_assets lookup failed: ${error.message}`);
        for (const a of (data ?? []) as AssetRow[]) assets.set(a.id, a);
      }
      const notReady: string[] = [];
      for (const bg of shaped.write) {
        const png = assets.get(bg.export_asset_id!);
        if (!png || png.bucket !== EXPORT_BUCKET || !isSafeOrgStoragePath(png.storage_path, orgId)) {
          log.warn("export_unusable", { org_id: orgId, background_id: bg.id, asset_id: bg.export_asset_id });
          notReady.push(bg.id);
          continue;
        }
        const thumb = bg.thumb_asset_id ? assets.get(bg.thumb_asset_id) : undefined;
        const thumbOk = !!thumb && thumb.bucket === EXPORT_BUCKET && isSafeOrgStoragePath(thumb.storage_path, orgId);
        const signed = await signExport(sb, log, orgId, png, bg.id);
        if (!signed) {
          notReady.push(bg.id);
          continue;
        }
        let thumbUrl: string | null = null;
        if (thumbOk) {
          const { data: ts } = await sb.storage.from(EXPORT_BUCKET).createSignedUrl(thumb!.storage_path, SIGNED_URL_TTL_S);
          thumbUrl = ts?.signedUrl ?? null;
        }
        items.push({
          platform: "teams",
          backgroundId: bg.id,
          guid: await assignmentGuid(orgId, employee.id, bg.id),
          label: tileLabel(bg.label ?? bg.slug),
          pngUrl: signed.url,
          thumbUrl,
          sha256: signed.sha,
          bytes: signed.bytes,
          action: "write",
        });
      }

      // ---- queued push rows for new / re-queued pairs (only for pairs actually handed out)
      const handed = new Set(items.filter((i) => i.action === "write").map((i) => i.backgroundId as string));
      const queue = shaped.queue.filter((id) => handed.has(id));
      if (queue.length) {
        const rows = queue.map((bgId) => ({
          org_id: orgId,
          employee_id: employee!.id,
          background_id: bgId,
          platform: "teams",
          state: "queued",
          idempotency_key: pushKey(orgId, employee!.id, bgId),
          agent_id: agent.id,
          error: null,
        }));
        const { error } = await sb.from("pushes").upsert(rows, { onConflict: "idempotency_key" });
        if (error) log.error("pushes_queue_failed", { org_id: orgId, message: error.message });
      }

      // ---- token rotation + heartbeat
      const rotated = await touchAndRotate(sb, log, agent, tokenHash, nowIso, now());

      log.info("assignments", { org_id: orgId, agent_id: agent.id, employee_id: employee.id, platform: TEAMS_PLATFORM, write: handed.size, remove: shaped.remove.length, skipped: shaped.skipped.length + notReady.length, queued: queue.length, rotated: !!rotated });
      return json(req, 200, {
        agentId: agent.id,
        employee: { id: employee.id, email: employee.email, name: employee.name, active: employee.active },
        state: employee.active ? "matched" : "inactive",
        platform: TEAMS_PLATFORM,
        assignments: items,
        skipped: [...shaped.skipped, ...notReady],
        expiresAt: new Date(now() + SIGNED_URL_TTL_S * 1000).toISOString(),
        pollSeconds: POLL_SECONDS,
        ...(rotated ?? {}),
      });
    }

    if (agent.revoked_at) throw new HttpError(410, "revoked", "this device was revoked — remove every MeetingBrand file you wrote and stop polling");

    // ================================================================ /report
    if (action === "report") {
      const body = await readJson<{ items?: unknown }>(req);
      if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, "bad_request", "items must be a non-empty array");
      if (body.items.length > MAX_REPORT_ITEMS) throw new HttpError(400, "too_many", `at most ${MAX_REPORT_ITEMS} items per report`, { max: MAX_REPORT_ITEMS, given: body.items.length });
      if (!agent.employee_id) throw new HttpError(409, "unmatched", "this device is not bound to a person yet — nothing can have been assigned to it");
      const orgId = agent.org_id;
      const nowIso = new Date(now()).toISOString();

      const defaultPlatform = platformForOs(agent.os);
      const via = defaultPlatform === MEET_PLATFORM ? "extension" : "agent";
      const results: Array<{ backgroundId: string; ok: boolean; state?: string; error?: string }> = [];
      for (const raw of body.items as unknown[]) {
        const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const bgId = typeof it.backgroundId === "string" ? it.backgroundId.toLowerCase() : "";
        const state = typeof it.state === "string" ? it.state : "";
        let platform: DeliveryPlatform;
        try {
          platform = deliveryPlatform(typeof it.platform === "string" ? it.platform : null, agent.os);
        } catch {
          results.push({ backgroundId: bgId || "?", ok: false, error: "platform must be teams or meet" });
          continue;
        }
        const allowed = reportStatesFor(platform);
        if (!UUID_RE.test(bgId) || !(allowed as readonly string[]).includes(state)) {
          results.push({ backgroundId: bgId || "?", ok: false, error: `each item needs a uuid backgroundId and a state in ${allowed.join("|")} (platform ${platform})` });
          continue;
        }
        const evidence = cleanEvidence(it.evidence);
        const { data: pr, error: prErr } = await sb.from("pushes").select("id, state").eq("idempotency_key", pushKey(orgId, agent.employee_id, bgId, platform)).eq("org_id", orgId).limit(1);
        if (prErr) throw new HttpError(500, "db_error", `pushes lookup failed: ${prErr.message}`);
        const push = ((pr ?? [])[0] as { id: string; state: string } | undefined) ?? null;
        if (!push) {
          results.push({ backgroundId: bgId, ok: false, error: "unknown_assignment: this background was never handed to this device" });
          continue;
        }
        const mapped = mapReportState(state as ReportState, evidence);
        const { error: repErr } = await sb.from("agent_reports").insert({ agent_id: agent.id, push_id: push.id, state, evidence });
        if (repErr) throw new HttpError(500, "db_error", `agent_reports insert failed: ${repErr.message}`);
        const { error: updErr } = await sb.from("pushes").update({
          state: mapped.pushState,
          error: mapped.error,
          agent_id: agent.id,
          evidence: { ...(evidence ?? {}), via, agent_id: agent.id, os: agent.os, agent_version: agent.version, report: state, reported_at: nowIso },
        }).eq("id", push.id);
        if (updErr) throw new HttpError(500, "db_error", `pushes update failed: ${updErr.message}`);
        await recordEvent(sb, mapped.event, null, { platform, via, org_id: orgId, agent_id: agent.id, employee_id: agent.employee_id, background_id: bgId, report: state, state: mapped.pushState });
        results.push({ backgroundId: bgId, ok: true, state: mapped.pushState });
      }
      await sb.from("agents").update({ last_seen_at: nowIso }).eq("id", agent.id);
      const accepted = results.filter((r) => r.ok).length;
      log.info("report", { org_id: orgId, agent_id: agent.id, accepted, rejected: results.length - accepted });
      if (!accepted) throw new HttpError(422, "no_valid_items", "no item in this report matched an assignment of this device", { results });
      return json(req, 200, { agentId: agent.id, accepted, rejected: results.length - accepted, results, pollSeconds: POLL_SECONDS });
    }

    // ================================================================ /heartbeat
    const body = await readJson<Record<string, unknown>>(req);
    const patch: Record<string, unknown> = { last_seen_at: new Date(now()).toISOString() };
    const version = str(body.version, 40);
    if (version) patch.version = version;
    const { error } = await sb.from("agents").update(patch).eq("id", agent.id);
    if (error) throw new HttpError(500, "db_error", `agents update failed: ${error.message}`);
    return json(req, 200, { ok: true, agentId: agent.id, state: agent.employee_id ? "matched" : "unmatched", pollSeconds: POLL_SECONDS });
  });
}

/** Bearer device token → the agent row (401 on missing/malformed/unknown/expired). Revocation is decided by the caller (410). */
async function requireAgent(req: Request, sb: SupabaseClient, nowMs: number): Promise<{ agent: AgentRow; tokenHash: string }> {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const token = m ? m[1].trim() : "";
  if (!TOKEN_RE.test(token)) throw new HttpError(401, "unauthorized", "a device token (mbd_…) is required");
  const tokenHash = await sha256Hex(token);
  const { data, error } = await sb.from("agents").select("id, org_id, employee_id, device_id, os, version, token_expires_at, revoked_at").eq("token_hash", tokenHash).limit(1);
  if (error) throw new HttpError(500, "db_error", `agents lookup failed: ${error.message}`);
  const agent = ((data ?? [])[0] as AgentRow | undefined) ?? null;
  if (!agent) throw new HttpError(401, "unauthorized", "unknown device token — enroll again");
  if (!agent.revoked_at && isExpired(agent.token_expires_at, nowMs)) throw new HttpError(401, "token_expired", "the device token expired — enroll again with the org key");
  return { agent, tokenHash };
}

/** ?platform= / item.platform → teams|meet; absent → what the device's os implies. */
export function deliveryPlatform(v: string | null | undefined, os: string): DeliveryPlatform {
  const p = (v ?? "").trim().toLowerCase();
  if (!p) return platformForOs(os);
  if (p === TEAMS_PLATFORM || p === MEET_PLATFORM) return p;
  throw new HttpError(400, "bad_request", "platform must be teams or meet");
}

/** Signed URL + sha256 (computed and stored on the asset row once) for one export asset; null when it is unusable. */
async function signExport(sb: SupabaseClient, log: { warn: (e: string, f?: Record<string, unknown>) => void }, orgId: string, asset: AssetRow | undefined, bgId: string): Promise<{ url: string; sha: string; bytes: number | null } | null> {
  if (!asset || asset.bucket !== EXPORT_BUCKET || !isSafeOrgStoragePath(asset.storage_path, orgId)) {
    log.warn("export_unusable", { org_id: orgId, background_id: bgId, asset_id: asset?.id ?? null });
    return null;
  }
  let sha = asset.sha256 && /^[0-9a-f]{64}$/i.test(asset.sha256) ? asset.sha256.toLowerCase() : null;
  let bytes = asset.bytes;
  if (!sha) {
    const { data: blob, error: dlErr } = await sb.storage.from(EXPORT_BUCKET).download(asset.storage_path);
    if (dlErr || !blob) {
      log.warn("export_download_failed", { org_id: orgId, asset_id: asset.id, message: dlErr?.message ?? "empty" });
      return null;
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (!buf.byteLength) return null;
    sha = await sha256Hex(buf);
    bytes = buf.byteLength;
    const { error: upErr } = await sb.from("brand_assets").update({ sha256: sha, bytes }).eq("id", asset.id);
    if (upErr) log.warn("sha_store_failed", { asset_id: asset.id, message: upErr.message });
  }
  const { data: signed, error: sErr } = await sb.storage.from(EXPORT_BUCKET).createSignedUrl(asset.storage_path, SIGNED_URL_TTL_S);
  if (sErr || !signed?.signedUrl) {
    log.warn("sign_failed", { asset_id: asset.id, message: sErr?.message ?? "no url" });
    return null;
  }
  return { url: signed.signedUrl, sha, bytes };
}

/** last_seen_at now; a new device token when < 30 days remain (only handed out once it is stored). */
async function touchAndRotate(sb: SupabaseClient, log: { error: (e: string, f?: Record<string, unknown>) => void }, agent: AgentRow, tokenHash: string, nowIso: string, nowMs: number): Promise<{ deviceToken: string; tokenExpiresAt: string } | null> {
  const patch: Record<string, unknown> = { last_seen_at: nowIso };
  let rotated: { deviceToken: string; tokenExpiresAt: string } | null = null;
  if (shouldRotate(agent.token_expires_at, nowMs)) {
    const t = newDeviceToken();
    patch.token_hash = await sha256Hex(t);
    patch.token_expires_at = new Date(nowMs + TOKEN_TTL_MS).toISOString();
    rotated = { deviceToken: t, tokenExpiresAt: patch.token_expires_at as string };
  }
  const { error: seenErr } = await sb.from("agents").update(patch).eq("id", agent.id).eq("token_hash", tokenHash);
  if (seenErr) {
    log.error("agent_touch_failed", { agent_id: agent.id, message: seenErr.message });
    rotated = null; // never hand out a token that was not stored
  }
  return rotated;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** PostgREST `ilike` pattern for an exact (case-insensitive) match: escape the LIKE metacharacters. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const handler = makeHandler();
