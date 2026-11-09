import { getSecret } from "astro:env/server";

/**
 * Server-only environment access.
 *
 * `getSecret()` is implemented by the adapter, so the same code works in every
 * runtime: locally it reads `.env.local` / `.dev.vars`, and on Cloudflare it
 * reads the value set by `wrangler secret put`. That is why this module exists
 * instead of scattered `process.env` reads — `process.env` does not exist in
 * the Workers runtime.
 */
export const serverEnv = {
  printifyApiKey: () => getSecret("PRINTIFY_API_KEY"),
  etsyApiKey: () => getSecret("ETSY_API_KEY"),
  etsyAccessToken: () => getSecret("ETSY_ACCESS_TOKEN"),
  etsyShopId: () => getSecret("ETSY_SHOP_ID"),
  aiApiKey: () => getSecret("AI_API_KEY"),
  aiBaseUrl: () => getSecret("AI_BASE_URL"),
  aiModel: () => getSecret("AI_MODEL"),
  openaiApiKey: () => getSecret("OPENAI_API_KEY"),
  // Email (Resend) and billing (Razorpay). Both are optional, like every other
  // key: the launch-readiness report only says whether they are PRESENT, never
  // what they contain.
  resendApiKey: () => getSecret("RESEND_API_KEY"),
  resendFrom: () => getSecret("RESEND_FROM"),
  razorpayKeyId: () => getSecret("RAZORPAY_KEY_ID"),
  razorpayKeySecret: () => getSecret("RAZORPAY_KEY_SECRET"),
  // Supabase Auth/sync. The service-role key is optional; auth needs only the
  // project URL plus the anon key.
  supabaseUrl: () => getSecret("SUPABASE_URL"),
  supabaseAnonKey: () => getSecret("SUPABASE_ANON_KEY"),
  supabaseServiceRole: () => getSecret("SUPABASE_SERVICE_ROLE"),
};

/** JSON response helper shared by every endpoint (Astro endpoints return a `Response`). */
export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  // These responses vary by credential headers (x-ai-key / x-printify-key / …).
  // Never let a browser or intermediary cache them.
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...responseInit, headers });
}
