import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env || {};
  const check = (name: string) => {
    const val = env[name];
    return { present: !!val, length: val?.length ?? null, masked: val ? val.slice(0, 10) + "..." : "<undefined>" };
  };
  return new Response(JSON.stringify({
    ok: true,
    checkedAt: Date.now(),
    envKeys: Object.keys(env),
    secrets: {
      SUPABASE_URL: check("SUPABASE_URL"),
      SUPABASE_ANON_KEY: check("SUPABASE_ANON_KEY"),
      SUPABASE_SERVICE_ROLE: check("SUPABASE_SERVICE_ROLE"),
      PRINTIFY_API_KEY: check("PRINTIFY_API_KEY"),
    }
  }), {
    headers: { "Content-Type": "application/json" }
  });
};