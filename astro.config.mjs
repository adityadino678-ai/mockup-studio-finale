// @ts-check
import { defineConfig, envField } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Every integration key is an optional server-side secret. None of them are
 * required: the whole core workflow runs without any key, and the UI reports an
 * honest "not configured" state when one is missing.
 *
 * Secrets are read through `getSecret()` in `src/lib/server/env.ts`, which the
 * adapter implements — locally from `.env.local` / `.dev.vars`, and on
 * Cloudflare from `wrangler secret put` at runtime.
 */
const optionalSecret = { context: "server", access: "secret", optional: true };

// `output: "static"` is deliberate. Every view reads its data from the
// visitor's own IndexedDB, so no page depends on request state — all 12 pages
// prerender to static HTML and are served straight from Cloudflare's CDN.
// Only the five `/api/**` endpoints render on demand, via `prerender = false`
// in each of them, because they must reach Printify/AI secrets server-side.
export default defineConfig({
  output: "static",
  adapter: cloudflare(),
  integrations: [react()],
  server: { port: 3000 },
  // Every image in this app is a user-uploaded blob held in IndexedDB, handled
  // entirely in the browser. Astro's image pipeline (sharp) would never run on
  // Cloudflare's runtime, so opt out of it explicitly.
  image: { service: { entrypoint: "astro/assets/services/noop" } },
  env: {
    schema: {
      PRINTIFY_API_KEY: envField.string(optionalSecret),
      ETSY_API_KEY: envField.string(optionalSecret),
      ETSY_ACCESS_TOKEN: envField.string(optionalSecret),
      ETSY_SHOP_ID: envField.string(optionalSecret),
      AI_API_KEY: envField.string(optionalSecret),
      AI_BASE_URL: envField.string(optionalSecret),
      AI_MODEL: envField.string(optionalSecret),
      OPENAI_API_KEY: envField.string(optionalSecret),
      // Fallback key for the hosted background-removal APIs (remove.bg /
      // PhotoRoom). Optional: the visitor's own key is sent per request.
      BG_REMOVE_API_KEY: envField.string(optionalSecret),
    },
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
  },
});
