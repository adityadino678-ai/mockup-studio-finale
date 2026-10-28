import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";
import { json } from "@/lib/server/env";

/**
 * Debug endpoint: reports what `getSecret()` returns for each Supabase secret
 * (plus PRINTIFY_API_KEY as a working control), without leaking the values.
 *
 * Deployed Worker: https://mockup-studio.adityadino678.workers.dev
 * Route: GET /api/debug/secrets
 */
export const prerender = false;

function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** Mask a secret value: never return the real value, only presence/shape. */
function mask(value: string | undefined | null): {
  present: boolean;
  length: number | null;
  masked: string;
} {
  if (!value) {
    return { present: false, length: null, masked: "<undefined>" };
  }
  const len = value.length;
  if (len <= 8) {
    return { present: true, length: len, masked: "*".repeat(len) };
  }
  const head = value.slice(0, 4);
  const tail = value.slice(-4);
  return {
    present: true,
    length: len,
    masked: `${head}${"*".repeat(len - 8)}${tail}`,
  };
}

export const GET: APIRoute = ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }

  const secretNames = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE",
    "PRINTIFY_API_KEY", // control: known to work
  ];

  const results: Record<string, { present: boolean; length: number | null; masked: string }> = {};

  for (const name of secretNames) {
    const value = getSecret(name);
    results[name] = mask(value);
    console.log(`[debug/secrets] getSecret("${name}") => present=${results[name].present} length=${results[name].length}`);
  }

  return json({
    ok: true,
    checkedAt: Date.now(),
    note: "Values are masked. `present` means getSecret() returned a non-empty string.",
    secrets: results,
  });
};
