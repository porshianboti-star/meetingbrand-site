// _shared/events.ts — best-effort funnel events into mb.events (003-events.sql). Never throws.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

export async function recordEvent(sb: SupabaseClient, event: string, userId: string | null, props: Record<string, unknown> = {}): Promise<void> {
  try {
    await sb.from("events").insert({ product: "meetingbrand", event: event.slice(0, 64), user_id: userId, path: "/functions", props });
  } catch {
    // analytics must never break an integration call
  }
}
