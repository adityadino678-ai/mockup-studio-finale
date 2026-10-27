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

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_ANON_KEY must be set. Run: wrangler secret put SUPABASE_URL / SUPABASE_ANON_KEY",
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Server-side client with service-role key for admin operations.
 * NEVER expose this to the browser.
 */
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export const supabaseAdmin =
  SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
    : null;
