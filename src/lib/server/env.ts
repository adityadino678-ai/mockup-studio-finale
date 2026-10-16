/**
 * Server-only environment access.
 *
 * Astro loads `.env` files into `import.meta.env`; this helper keeps the
 * lookup in one place and falls back to `process.env` so the same modules keep
 * working under vitest and plain `node dist/server/entry.mjs`.
 */
function read(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return value ?? process.env[name];
}

export const serverEnv = {
  printifyApiKey: () => read("PRINTIFY_API_KEY"),
  etsyApiKey: () => read("ETSY_API_KEY"),
  etsyAccessToken: () => read("ETSY_ACCESS_TOKEN"),
  etsyShopId: () => read("ETSY_SHOP_ID"),
  aiApiKey: () => read("AI_API_KEY"),
  aiBaseUrl: () => read("AI_BASE_URL"),
  aiModel: () => read("AI_MODEL"),
  openaiApiKey: () => read("OPENAI_API_KEY"),
};

/** JSON response helper shared by every endpoint (Astro returns a `Response`). */
export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...responseInit, headers });
}
