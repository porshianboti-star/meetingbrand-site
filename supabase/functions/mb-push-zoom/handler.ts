// mb-push-zoom — upload one exported background into each chosen employee's Zoom library.
//
//   POST  Bearer <user access token>   {"background_id": "<uuid>", "employee_ids": ["<uuid>", …]}  (≤ 50)
//   → admin of the org → the background must belong to the org and have an export
//     (mb.backgrounds.export_asset_id → mb.brand_assets in bucket mb-exports)
//   → download the PNG/JPG once with the service role → preflight GET /accounts/me/settings once
//   → per employee (sequential, 200 ms apart): mb.pushes row keyed org:employee:background
//       queued → pushing → awaiting_client | blocked | failed   (queued again on 429/5xx = retry later;
//       a Zoom DAILY rate limit or a dead token stops the loop — the rest are queued without calling Zoom)
//   → 200 summary. Zoom has NO activate endpoint: after "awaiting_client" the employee signs out/in
//     and picks the image once (PLAN-integrations §3.1). We never claim more than that.

import { notConfiguredBody, supabaseEnv, zoomEnv } from "../_shared/env.ts";
import { HttpError, json, readJson, serveFn, sleep } from "../_shared/http.ts";
import { requireOrgAdmin, requireUser, serviceClient } from "../_shared/auth.ts";
import { deriveKeys } from "../_shared/crypto.ts";
import {
  backgroundFilename,
  getAccessToken,
  isReconnectFailure,
  loadZoomIntegration,
  markNeedsReconnect,
  MAX_UPLOAD_BYTES,
  mimeFromPath,
  ZoomApi,
  ZoomError,
  zoomErrorToHttp,
} from "../_shared/zoom.ts";
import { recordEvent } from "../_shared/events.ts";

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export const MAX_EMPLOYEES_PER_CALL = 50;
export const SPACING_MS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Push rows in one of these states are already delivered → the call is idempotent for them. */
const DELIVERED_STATES = new Set(["pushed", "awaiting_client", "available", "selected"]);
const IN_PROGRESS_WINDOW_MS = 2 * 60 * 1000;

export type PushOutcome =
  | "pushed" // uploaded → awaiting_client (employee picks it once)
  | "already_pushed" // idempotent skip
  | "in_progress" // another call is pushing this pair right now
  | "blocked" // library full / feature disabled / plan
  | "failed" // permanent Zoom error
  | "retry" // 429 / 5xx — call again later
  | "needs_reconnect"
  | "unknown_employee";

export interface PushResult {
  employee_id: string;
  outcome: PushOutcome;
  state?: string;
  remote_file_id?: string;
  error?: string;
  freed_files?: number;
}

interface EmployeeRow {
  id: string;
  ext_id: string;
  email: string | null;
  name: string | null;
  active: boolean;
}

interface PushRow {
  id: string;
  state: string;
  attempts: number;
  remote_file_id: string | null;
  updated_at: string;
}

export function makeHandler(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleepImpl = deps.sleepImpl ?? sleep;

  return serveFn("mb-push-zoom", async (req, { log }) => {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");

    const sbEnv = supabaseEnv();
    if (!sbEnv.ok) return json(req, 503, notConfiguredBody(sbEnv.missing));

    // ---------------------------------------------------------------- who
    const user = await requireUser(req, sbEnv.env, fetchImpl);
    const sb = serviceClient(sbEnv.env, fetchImpl);
    const admin = await requireOrgAdmin(sb, user);
    // Zoom secrets are checked only after the caller is known: unauthenticated probes get 401, admins get the precise 503.
    const zEnv = zoomEnv();
    if (!zEnv.ok) return json(req, 503, notConfiguredBody(zEnv.missing));
    const orgId = admin.org_id;

    // ---------------------------------------------------------------- input
    const body = await readJson<{ background_id?: unknown; employee_ids?: unknown }>(req);
    const backgroundId = typeof body.background_id === "string" ? body.background_id : "";
    if (!UUID_RE.test(backgroundId)) throw new HttpError(400, "bad_request", "background_id must be a uuid");
    if (!Array.isArray(body.employee_ids) || body.employee_ids.length === 0) throw new HttpError(400, "bad_request", "employee_ids must be a non-empty array of uuids");
    const employeeIds = [...new Set(body.employee_ids.filter((x): x is string => typeof x === "string"))];
    if (employeeIds.length !== body.employee_ids.length || employeeIds.some((id) => !UUID_RE.test(id))) {
      throw new HttpError(400, "bad_request", "employee_ids must be unique uuids");
    }
    if (employeeIds.length > MAX_EMPLOYEES_PER_CALL) {
      throw new HttpError(400, "too_many", `at most ${MAX_EMPLOYEES_PER_CALL} employees per call`, { max: MAX_EMPLOYEES_PER_CALL, given: employeeIds.length });
    }

    const integ = await loadZoomIntegration(sb, orgId);
    if (!integ || integ.status === "disconnected") throw new HttpError(409, "not_connected", "connect Zoom first (mb-oauth-zoom?action=start)");
    if (integ.status === "needs_reconnect") throw new HttpError(409, "needs_reconnect", "the Zoom authorization expired or was revoked — reconnect");

    // ---------------------------------------------------------------- background + export file
    const { data: bg, error: bgErr } = await sb.from("backgrounds").select("id, label, slug, export_asset_id").eq("id", backgroundId).eq("org_id", orgId).maybeSingle();
    if (bgErr) throw new HttpError(500, "db_error", `backgrounds lookup failed: ${bgErr.message}`);
    if (!bg) throw new HttpError(404, "background_not_found", "no such background in this workspace");
    if (!bg.export_asset_id) throw new HttpError(409, "no_export", "this background has no 1920×1080 export yet — export it in the app first");

    const { data: asset, error: asErr } = await sb.from("brand_assets").select("id, bucket, storage_path, mime, bytes, sha256").eq("id", bg.export_asset_id).eq("org_id", orgId).maybeSingle();
    if (asErr) throw new HttpError(500, "db_error", `brand_assets lookup failed: ${asErr.message}`);
    if (!asset) throw new HttpError(409, "no_export", "the export asset row is missing — export the background again");
    if (asset.bucket !== "mb-exports") throw new HttpError(409, "bad_export_bucket", `export must live in mb-exports (found ${asset.bucket})`);
    // The service role reads the bucket with RLS bypassed, so the path itself is the only guard:
    // it must be a plain "<this org>/<segment>/…" path. The DB check pins only the first segment;
    // storage-js does not encode the path, so "org/../other-org/x.png" would be normalised by fetch
    // into another org's object. Refuse dot segments, empty segments and anything but safe chars.
    if (!isSafeOrgStoragePath(asset.storage_path, orgId)) {
      log.warn("export_path_rejected", { org_id: orgId, asset_id: asset.id });
      throw new HttpError(409, "bad_export_path", "the export's storage path is not inside this workspace's folder — export the background again");
    }
    const mime = mimeFromPath(asset.storage_path, asset.mime);
    if (!mime) throw new HttpError(409, "bad_export_type", "Zoom accepts png / jpg / gif only");

    const { data: blob, error: dlErr } = await sb.storage.from("mb-exports").download(asset.storage_path);
    if (dlErr || !blob) throw new HttpError(409, "export_missing", `could not download the export: ${dlErr?.message ?? "empty"}`);
    const fileBytes = new Uint8Array(await blob.arrayBuffer());
    if (fileBytes.byteLength === 0) throw new HttpError(409, "export_missing", "the export file is empty");
    if (fileBytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(409, "export_too_large", `export is ${fileBytes.byteLength} bytes; Zoom's limit is 15 MB`);
    const filename = backgroundFilename(bg.label ?? bg.slug, mime);

    // ---------------------------------------------------------------- employees
    const { data: empRows, error: empErr } = await sb.from("employees").select("id, ext_id, email, name, active").in("id", employeeIds).eq("org_id", orgId).eq("platform", "zoom");
    if (empErr) throw new HttpError(500, "db_error", `employees lookup failed: ${empErr.message}`);
    const byId = new Map<string, EmployeeRow>((empRows ?? []).map((e: EmployeeRow) => [e.id, e]));

    const results: PushResult[] = [];
    const counts: Record<PushOutcome, number> = { pushed: 0, already_pushed: 0, in_progress: 0, blocked: 0, failed: 0, retry: 0, needs_reconnect: 0, unknown_employee: 0 };
    const record = (r: PushResult) => {
      results.push(r);
      counts[r.outcome]++;
    };

    // ---------------------------------------------------------------- token + preflight (once)
    const keys = await deriveKeys(zEnv.env.tokenKeyB64);
    let api: ZoomApi;
    let preflight: { enabled: boolean | null; detail: string };
    try {
      const token = await getAccessToken({ sb, keys, env: zEnv.env, fetchImpl, log, now, sleepImpl }, integ);
      api = new ZoomApi(token, { fetchImpl, log, sleepImpl });
      preflight = await api.accountVirtualBackgroundEnabled();
    } catch (e) {
      if (isReconnectFailure(e)) await markNeedsReconnect(sb, integ.id, e instanceof Error ? e.message : String(e));
      throw zoomErrorToHttp(e, log);
    }
    log.info("preflight", { org_id: orgId, enabled: preflight.enabled, detail: preflight.detail });

    // ---------------------------------------------------------------- per-employee push
    const setPush = async (id: string, patch: Record<string, unknown>) => {
      const { error } = await sb.from("pushes").update(patch).eq("id", id);
      if (error) log.error("push_update_failed", { push_id: id, message: error.message });
    };

    // Once Zoom says the token is dead or the DAILY limit is hit, every further call would fail the same
    // way: the remaining employees get a queued row (so the tab shows them) and no Zoom call.
    let stopped: { outcome: "needs_reconnect" | "retry"; error: string } | null = null;
    for (let i = 0; i < employeeIds.length; i++) {
      const employeeId = employeeIds[i];
      const emp = byId.get(employeeId);
      if (!emp) {
        record({ employee_id: employeeId, outcome: "unknown_employee", error: "not a Zoom employee of this workspace" });
        continue;
      }
      if (stopped) {
        const key = `${orgId}:${emp.id}:${bg.id}`;
        const { data: prev } = await sb.from("pushes").select("id, state, attempts").eq("idempotency_key", key).maybeSingle();
        const p = prev as { id: string; state: string; attempts: number } | null;
        if (p && DELIVERED_STATES.has(p.state)) {
          record({ employee_id: emp.id, outcome: "already_pushed", state: p.state });
          continue;
        }
        await sb.from("pushes").upsert(
          { org_id: orgId, employee_id: emp.id, background_id: bg.id, platform: "zoom", state: "queued", idempotency_key: key, error: stopped.error, attempts: p?.attempts ?? 0 },
          { onConflict: "idempotency_key" },
        );
        record({ employee_id: emp.id, outcome: stopped.outcome, state: "queued", error: stopped.error });
        continue;
      }

      const key = `${orgId}:${emp.id}:${bg.id}`;
      const { data: existing, error: exErr } = await sb.from("pushes").select("id, state, attempts, remote_file_id, updated_at").eq("idempotency_key", key).maybeSingle();
      if (exErr) {
        record({ employee_id: emp.id, outcome: "failed", error: `db: ${exErr.message}` });
        continue;
      }
      const prev = existing as PushRow | null;
      if (prev && DELIVERED_STATES.has(prev.state)) {
        record({ employee_id: emp.id, outcome: "already_pushed", state: prev.state, remote_file_id: prev.remote_file_id ?? undefined });
        continue;
      }
      if (prev && prev.state === "pushing" && now() - Date.parse(prev.updated_at) < IN_PROGRESS_WINDOW_MS) {
        record({ employee_id: emp.id, outcome: "in_progress", state: "pushing" });
        continue;
      }

      // account-level preflight said no → nothing to upload, every row is blocked
      if (preflight.enabled === false) {
        const { error } = await sb.from("pushes").upsert(
          { org_id: orgId, employee_id: emp.id, background_id: bg.id, platform: "zoom", state: "blocked", idempotency_key: key, error: "virtual backgrounds are disabled at the Zoom account level (Account Settings → In Meeting (Advanced) → Virtual background)", attempts: (prev?.attempts ?? 0) + 1 },
          { onConflict: "idempotency_key" },
        );
        record({ employee_id: emp.id, outcome: "blocked", state: "blocked", error: error ? `db: ${error.message}` : "account virtual background disabled" });
        continue;
      }

      const { data: row, error: rowErr } = await sb
        .from("pushes")
        .upsert(
          { org_id: orgId, employee_id: emp.id, background_id: bg.id, platform: "zoom", state: "pushing", idempotency_key: key, error: null, attempts: (prev?.attempts ?? 0) + 1 },
          { onConflict: "idempotency_key" },
        )
        .select("id")
        .single();
      if (rowErr || !row) {
        record({ employee_id: emp.id, outcome: "failed", error: `db: ${rowErr?.message ?? "no push row"}` });
        continue;
      }

      let freed = 0;
      try {
        let uploaded;
        try {
          uploaded = await api.uploadVirtualBackground(emp.ext_id, fileBytes, filename, mime);
        } catch (e) {
          // 10-file cap: remove files WE uploaded earlier for this user (other backgrounds), then try once more
          if (e instanceof ZoomError && e.cls.kind === "blocked" && e.cls.code === "library_full_or_limit") {
            freed = await freeOurOldFiles(sb, api, emp, bg.id, log);
            if (freed === 0) throw e;
            uploaded = await api.uploadVirtualBackground(emp.ext_id, fileBytes, filename, mime);
          } else throw e;
        }
        await setPush(row.id, {
          state: "awaiting_client",
          remote_file_id: uploaded.id,
          error: null,
          evidence: { file: { id: uploaded.id, name: uploaded.name ?? filename, size: uploaded.size ?? fileBytes.byteLength, type: uploaded.type ?? mime }, sha256: asset.sha256 ?? null, uploaded_at: new Date(now()).toISOString(), freed_files: freed },
        });
        record({ employee_id: emp.id, outcome: "pushed", state: "awaiting_client", remote_file_id: uploaded.id, freed_files: freed || undefined });
      } catch (e) {
        if (e instanceof ZoomError) {
          const cls = e.cls;
          if (cls.kind === "needs_reconnect") {
            await markNeedsReconnect(sb, integ.id, cls.detail);
            await setPush(row.id, { state: "queued", error: cls.detail });
            record({ employee_id: emp.id, outcome: "needs_reconnect", state: "queued", error: cls.detail });
            stopped = { outcome: "needs_reconnect", error: "Zoom authorization lost during this call — reconnect and push again" };
            continue;
          }
          if (cls.kind === "retry") {
            await setPush(row.id, { state: "queued", error: cls.detail });
            record({ employee_id: emp.id, outcome: "retry", state: "queued", error: cls.detail });
            if (cls.code === "daily_limit") {
              // Zoom's daily quota is exhausted until 00:00 UTC — nothing more will succeed in this call
              stopped = { outcome: "retry", error: `Zoom daily rate limit reached — push again later. ${cls.detail}` };
              continue;
            }
            if (cls.retryAfterMs) await sleepImpl(Math.min(cls.retryAfterMs, 5000));
          } else {
            const state = cls.kind === "blocked" ? "blocked" : "failed";
            await setPush(row.id, { state, error: cls.detail });
            record({ employee_id: emp.id, outcome: state, state, error: cls.detail });
          }
        } else {
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
          await setPush(row.id, { state: "failed", error: msg });
          record({ employee_id: emp.id, outcome: "failed", state: "failed", error: msg });
        }
      }

      if (i < employeeIds.length - 1) await sleepImpl(SPACING_MS);
    }

    await recordEvent(sb, "background_pushed", user.id, { platform: "zoom", org_id: orgId, background_id: bg.id, ...counts });
    log.info("push_done", { org_id: orgId, background_id: bg.id, ...counts });
    return json(req, 200, {
      background_id: bg.id,
      file: { name: filename, bytes: fileBytes.byteLength, mime },
      preflight,
      counts,
      results,
      next_step: "Zoom has no API to select a background. Each employee signs out and back in to the Zoom client, then picks the image once (Settings → Background & effects); it stays selected afterwards.",
    });
  });
}

/** "<orgId>/<seg>/…": every segment is [A-Za-z0-9._-]+, never "." / ".." / empty, ≤ 512 chars total. */
export function isSafeOrgStoragePath(path: unknown, orgId: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  const segs = path.split("/");
  if (segs.length < 2 || segs[0] !== orgId) return false;
  return segs.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..");
}

/**
 * Zoom counts at most 10 cloud files per user. When an upload is refused for that reason, delete the
 * files WE uploaded earlier for this employee (tracked in pushes.remote_file_id, other backgrounds only)
 * and mark those pushes as superseded. Returns how many files were removed (0 = nothing to free).
 */
async function freeOurOldFiles(sb: ReturnType<typeof serviceClient>, api: ZoomApi, emp: EmployeeRow, keepBackgroundId: string, log: { warn: (e: string, f?: Record<string, unknown>) => void }): Promise<number> {
  const { data, error } = await sb.from("pushes").select("id, remote_file_id").eq("employee_id", emp.id).eq("platform", "zoom").neq("background_id", keepBackgroundId).not("remote_file_id", "is", null);
  if (error || !data?.length) return 0;
  const rows = data as Array<{ id: string; remote_file_id: string }>;
  try {
    await api.deleteVirtualBackgrounds(emp.ext_id, rows.map((r) => r.remote_file_id));
  } catch (e) {
    log.warn("free_old_files_failed", { employee_id: emp.id, message: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  await sb.from("pushes").update({ state: "failed", remote_file_id: null, error: "removed from the employee's Zoom library to make room for a newer background (Zoom allows 10 files per user)" }).in("id", rows.map((r) => r.id));
  return rows.length;
}

export const handler = makeHandler();
