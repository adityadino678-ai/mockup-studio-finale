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
};

/** JSON response helper shared by every endpoint (Astro endpoints return a `Response`). */
export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...responseInit, headers });
}
