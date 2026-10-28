"use server";

/**
 * Supabase client for server-side auth and sync.
 *
 * The project URL and anon key come from server secrets (never exposed to
 * the browser). Browser-side clients use the anon key + RLS for row-level
 * access control.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/**
 * Returns null (instead of throwing) when secrets aren't configured, so
 * endpoints can answer with a proper JSON 503 rather than crashing with an
 * empty body. Callers must guard on null.
 */
export const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

/**
 * Server-side client with service-role key for admin operations.
 * NEVER expose this to the browser. Null when not configured.
 */
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
    : null;
