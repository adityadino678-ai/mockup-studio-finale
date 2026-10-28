"use server";

/**
 * Supabase client for server-side auth and sync.
 *
 * The project URL and anon key come from server secrets (never exposed to
 * the browser). Browser-side clients use the anon key + RLS for row-level
 * access control.
 */

import { createClient } from "@supabase/supabase-js";
import { getSecret } from "astro:env/server";

/**
 * Returns null (instead of throwing) when secrets aren't configured, so
 * endpoints can answer with a proper JSON 503 rather than crashing with an
 * empty body. Callers must guard on null.
 */
export const supabase = (() => {
  const url = getSecret("SUPABASE_URL");
  const anon = getSecret("SUPABASE_ANON_KEY");
  return url && anon ? createClient(url, anon) : null;
})();

/**
 * Server-side client with service-role key for admin operations.
 * NEVER expose this to the browser. Null when not configured.
 */
export const supabaseAdmin = (() => {
  const url = getSecret("SUPABASE_URL");
  const service = getSecret("SUPABASE_SERVICE_ROLE");
  return url && service ? createClient(url, service) : null;
})();