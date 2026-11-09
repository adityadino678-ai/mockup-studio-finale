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

// The public origin, e.g. `https://listbulkly.com`. Optional and build-time:
// when it is set, app pages emit a canonical + og:url; when it is unset (today,
// because no custom domain is bought yet) they emit none. It must never be a
// `*.workers.dev` address — see `src/lib/site.ts`.
const optionalPublic = { context: "client", access: "public", optional: true };

// `output: "static"` is deliberate. Every view reads its data from the
// visitor's own IndexedDB, so no page depends on request state - all 8 pages
// prerender to static HTML and are served straight from Cloudflare's CDN.
// Only the ten `/api/**` endpoints render on demand, via `prerender = false`
// in each of them, because they must reach Printify/AI secrets server-side.
export default defineConfig({
  output: "static",
  adapter: cloudflare(),
  integrations: [react()],
  server: { port: 3000 },
  // The Astro dev toolbar is off on purpose.
  //
  // Its a11y audit imports `axobject-query` from inside `astro`, which Vite
  // pre-bundles as CJS and then fails to link: every page that loads it throws
  // `does not provide an export named 'AXObjectRoles'`. That is a page error,
  // so it lands in the middle of React hydration and leaves the view inert.
  // It adds nothing to this app's workflow, so it is disabled.
  devToolbar: { enabled: false },
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
      SUPABASE_URL: envField.string(optionalSecret),
      SUPABASE_ANON_KEY: envField.string(optionalSecret),
      SUPABASE_SERVICE_ROLE: envField.string(optionalSecret),
      RESEND_API_KEY: envField.string(optionalSecret),
      RESEND_FROM: envField.string(optionalSecret),
      RAZORPAY_KEY_ID: envField.string(optionalSecret),
      RAZORPAY_KEY_SECRET: envField.string(optionalSecret),
      PUBLIC_SITE_URL: envField.string(optionalPublic),
    },
  },
  vite: {
    plugins: [tailwindcss()],
    // ML segmentation worker is an ES worker (dynamic onnxruntime-web import).
    worker: { format: "es" },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
      // One React, always. react-konva ships its own reconciler and can resolve
      // a second copy of `react`; its hooks then read `ReactSharedInternals.H`
      // from a copy no renderer ever filled in, and rendering a Stage throws
      // `Cannot read properties of null (reading 'useRef')`, which unmounts the
      // whole page. Deduping keeps every importer on the same module.
      dedupe: ["react", "react-dom"],
    },
    // Pre-bundle the browser dependencies a page may need on its first request.
    //
    // Vite discovers dependencies lazily: the first page that imports one asks
    // for a hash, Vite re-optimises the bundle, and the in-flight request
    // answers `504 (Outdated Optimize Dep)`. The island's dynamic import then
    // rejects, so the React tree never hydrates and the page stays as inert
    // server HTML - every button dead, nothing on screen reacting.
    //
    // What is NOT in this list matters just as much: never add `react`,
    // `react-dom` or `react-dom/client`. Pre-bundling React itself makes Vite
    // emit a second copy of `react` next to the one react-dom already pulled
    // in, and the two copies disagree about the current hook dispatcher - the
    // same `useRef` crash, this time on every page using framer-motion or
    // react-konva. Dev only; production ships prebuilt chunks either way.
    optimizeDeps: {
      include: [
        "framer-motion",
        "fflate",
        "dexie",
        "dexie-react-hooks",
        "zustand",
        "lucide-react",
        "sonner",
        "clsx",
        "tailwind-merge",
        "class-variance-authority",
        "react-markdown",
        "remark-gfm",
        "rehype-highlight",
        "konva",
        "react-konva",
        "use-image",
        "@supabase/supabase-js",
        "@radix-ui/react-checkbox",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-label",
        "@radix-ui/react-popover",
        "@radix-ui/react-progress",
        "@radix-ui/react-scroll-area",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-slider",
        "@radix-ui/react-slot",
        "@radix-ui/react-switch",
        "@radix-ui/react-tabs",
        "@radix-ui/react-tooltip",
      ],
    },
  },
});
