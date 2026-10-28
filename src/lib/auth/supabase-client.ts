"use server";

import { createClient } from "@supabase/supabase-js";

/**
 * Shape of the Cloudflare bindings exposed on `locals.runtime.env`.
 * Only the Supabase bindings are declared here; the binding object may carry
 * other keys (ASSETS, KV namespaces, etc.).
 */
export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE?: string;
}

/**
 * Factory: create Supabase clients from the Cloudflare `env` binding.
 *
 * Reads secrets directly from `env` (passed in from `locals.runtime.env`)
 * instead of `getSecret()`. Secrets are only available during request
 * handling in Cloudflare Workers, not at module load time, so creating the
 * clients per-request from `locals.runtime.env` is the reliable pattern.
 *
 * Returns `null` for any client whose secrets aren't configured, so
 * callers can answer with a proper JSON 503 instead of crashing.
 */
export function createSupabaseClients(env: SupabaseEnv) {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE;

  const client = url && anon ? createClient(url, anon) : null;
  const admin = url && service ? createClient(url, service) : null;

  return { client, admin };
}
