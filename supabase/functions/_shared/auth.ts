// _shared/auth.ts — who is calling (Supabase user) and are they an admin of an mb org.
//
// requireUser: verifies the Bearer by asking GoTrue itself (GET /auth/v1/user with the anon apikey),
//              so a forged/expired JWT is rejected by the auth server, not by us.
// requireOrgAdmin: service-role client (schema mb) → mb.profiles row → {org_id, role}; 403 unless admin.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import type { SupabaseEnv } from "./env.ts";
import { HttpError } from "./http.ts";

export interface AuthUser {
  id: string;
  email: string | null;
}
export interface OrgMember extends AuthUser {
  org_id: string;
  role: "admin" | "member";
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Verify the caller's access token against GoTrue. Throws HttpError 401. */
export async function requireUser(req: Request, env: SupabaseEnv, fetchImpl: typeof fetch = fetch): Promise<AuthUser> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthorized", "missing Bearer token");
  // The service-role / anon keys are not user sessions; refuse them explicitly.
  if (token === env.serviceRoleKey || token === env.anonKey) throw new HttpError(401, "unauthorized", "a user session token is required");
  let res: Response;
  try {
    res = await fetchImpl(`${env.url}/auth/v1/user`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    throw new HttpError(502, "auth_unreachable", `auth server unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, "unauthorized", "invalid or expired session");
  if (!res.ok) throw new HttpError(502, "auth_error", `auth server returned ${res.status}`);
  const u = await res.json().catch(() => null) as { id?: string; email?: string } | null;
  if (!u?.id) throw new HttpError(401, "unauthorized", "invalid session");
  return { id: u.id, email: u.email ?? null };
}

/** Service-role client bound to schema mb (RLS bypass — every write path goes through here). */
export function serviceClient(env: SupabaseEnv, fetchImpl?: typeof fetch): SupabaseClient {
  // Database is `any` here, so the "mb" schema type parameter carries no information — collapse it
  // to the plain SupabaseClient type the rest of the code passes around.
  return createClient(env.url, env.serviceRoleKey, {
    db: { schema: "mb" },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "mb-edge/1" }, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
  }) as unknown as SupabaseClient;
}

/** The caller's mb.profiles row. Throws HttpError 403 when they have no MeetingBrand profile. */
export async function requireOrgMember(sb: SupabaseClient, user: AuthUser): Promise<OrgMember> {
  const { data, error } = await sb.from("profiles").select("org_id, role").eq("id", user.id).maybeSingle();
  if (error) throw new HttpError(500, "db_error", `profiles lookup failed: ${error.message}`);
  if (!data?.org_id) throw new HttpError(403, "no_workspace", "this account has no MeetingBrand workspace");
  return { ...user, org_id: data.org_id as string, role: data.role as "admin" | "member" };
}

/** 403 unless the caller is an admin of their org. */
export async function requireOrgAdmin(sb: SupabaseClient, user: AuthUser): Promise<OrgMember> {
  const m = await requireOrgMember(sb, user);
  if (m.role !== "admin") throw new HttpError(403, "forbidden", "only workspace admins can manage integrations");
  return m;
}
