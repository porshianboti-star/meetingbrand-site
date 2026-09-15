// mb-oauth-ms — Supabase Edge Function entry point. Logic lives in handler.ts (unit-testable without a server).
import { handler } from "./handler.ts";

Deno.serve(handler);
