import { getSecret } from "astro:env/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-request Supabase clients.
 *
 * Two rules drive this module:
 *
 * 1. It must never read a secret at MODULE LOAD. On Cloudflare Workers the
 *    binding only exists while a request is being handled, and `getSecret()`
 *    has no value outside that window. An earlier version exported
 *    `const supabase = ...` and every route that imported it was dead on the
 *    deployed Worker.
 * 2. It prefers the binding on `locals.runtime.env`, then falls back to
 *    `getSecret()` so `astro dev` (where there is no Workers runtime) reads
 *    `.env` and works too.
 *
 * The anon key is a publishable key by design; it is only ever used server-side
 * here, and the service-role key is used by admin operations and never leaves
 * the server.
 */

export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE?: string;
}

export interface AuthClients {
  /** Anon client: sign-up, sign-in and token verification. */
  client: SupabaseClient | null;
  /** Service-role client: admin user creation. Never expose to the browser. */
  admin: SupabaseClient | null;
  configured: boolean;
  serviceRole: boolean;
  url: string | null;
}

type LocalsLike = { runtime?: { env?: Partial<SupabaseEnv> } } | undefined;

function runtimeEnv(locals: unknown): Partial<SupabaseEnv> {
  return (locals as LocalsLike)?.runtime?.env ?? {};
}

function fromSecrets(key: keyof SupabaseEnv): string | undefined {
  try {
    if (key === "SUPABASE_URL") return getSecret("SUPABASE_URL") ?? undefined;
    if (key === "SUPABASE_ANON_KEY") return getSecret("SUPABASE_ANON_KEY") ?? undefined;
    return getSecret("SUPABASE_SERVICE_ROLE") ?? undefined;
  } catch {
    // `astro:env/server` throws when a secret is read outside a request on the
    // Workers runtime. Treat that as "not configured" instead of crashing.
    return undefined;
  }
}

function read(key: keyof SupabaseEnv, locals: unknown): string | undefined {
  return runtimeEnv(locals)[key] || fromSecrets(key);
}

/** No session persistence: these clients live for exactly one request. */
function makeClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function authClients(locals?: unknown): AuthClients {
  const url = read("SUPABASE_URL", locals) ?? null;
  const anon = read("SUPABASE_ANON_KEY", locals) ?? null;
  const service = read("SUPABASE_SERVICE_ROLE", locals) ?? null;

  return {
    client: url && anon ? makeClient(url, anon) : null,
    admin: url && service ? makeClient(url, service) : null,
    configured: Boolean(url && anon),
    serviceRole: Boolean(url && service),
    url,
  };
}
