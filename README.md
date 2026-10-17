# Mockup Studio

A premium, local-first workspace for print-on-demand sellers: upload designs, place them on mockup photos in a real editor, batch-generate combinations, create ink variants, remove backgrounds, reuse templates, and export organized ZIP archives — all stored in your browser, no account required.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

Or from the folder one level up, without touching the terminal commands yourself:

| File | What it does |
|---|---|
| `../start.cmd` | Checks Node, installs deps on first run, opens the browser and starts the dev server |
| `../setup.cmd` | Installs dependencies only |

Optional integrations can be connected two ways:

1. **In the app (recommended):** open **Settings → API connections**. Paste your
   Printify key, then pick an AI **provider** (NVIDIA NIM,
   OpenRouter, Groq, Cerebras, Together, Google Gemini, Mistral, DeepSeek,
   Fireworks, xAI, OpenAI, Anthropic, a local Ollama server, or any custom
   OpenAI-compatible endpoint). The **Load models** button fetches that
   provider's live model list and tags free models `free`; choose one and press
   **Test connection**. You can keep a key per provider and switch the active
   model from the assistant panel without losing the others. Keys are stored only
   in your browser's IndexedDB and attached to the relevant requests — never
   saved on the server.
2. **On the server** (`.env.local` / `wrangler secret put`):

```bash
PRINTIFY_API_KEY=...      # live Printify catalog + product creation
AI_API_KEY=...            # any OpenAI-compatible provider (AI SEO + assistant)
AI_BASE_URL=...           # default: https://api.openai.com/v1
AI_MODEL=...              # default: gpt-4o-mini
```

A browser-saved key takes precedence over a server key when both are present.

**Everything in the core workflow works without any API key.**

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run deploy` | Build and publish to Cloudflare Workers |
| `npm run lint` | ESLint (typescript-eslint + eslint-plugin-astro) |
| `npm run typecheck` | `astro check` — strict TS across `.ts`, `.tsx` and `.astro` |
| `npm run test` | Unit/integration tests (95 tests) |
| `npm run test:e2e` | End-to-end acceptance tests (17 tests, needs `npx playwright install chromium` once) |
| `npm run astro` | Any Astro CLI command (`astro add`, `astro info`, …) |

## Deploying to Cloudflare

The production build targets **Cloudflare Workers** via `@astrojs/cloudflare`.

```powershell
npx wrangler login     # one time
npm run deploy         # build + wrangler deploy
```

The app is published to `https://mockup-studio.adityadino678.workers.dev`.

**How it is shaped:** `output: "static"`, because no page depends on request
state — every view reads its data from the visitor's own IndexedDB. So all 13
pages prerender to static HTML and are served directly from Cloudflare's CDN,
and `dist/_routes.json` excludes them from the Worker. Only the nine `/api/**`
endpoints run on demand, each opting in with `export const prerender = false`.

**Secrets:** none are required and none are deployed by default. The whole core
workflow runs without any key, and the AI/Printify panels show an honest
"not configured" state. To enable them in production:

```powershell
npx wrangler secret put PRINTIFY_API_KEY
npx wrangler secret put AI_API_KEY
```

Secrets are read through `getSecret()` from `astro:env/server`, which is
adapter-provided, so the same code works locally, on Workers, and would survive
a switch to another adapter. Locally, copy `.dev.vars.example` to `.dev.vars`.



## The workflow

1. **Designs** — upload one or many PNG/JPEG/WebP files (drag & drop, 40 MB limit). Everything persists in IndexedDB and survives refreshes. Tag, rename, duplicate, download, delete with confirmation.
2. **Mockups** — upload product photos, organize by category, favorite, multi-select.
3. **Mockup Editor** — place artwork with the same compositing math used for exports: move, resize, rotate, flip, stretch, opacity, center-align, numeric inputs, undo/redo, unsaved-changes indicator, zoom/fit. Optional "design behind mockup" mode for transparent garment PNGs. Save per design×mockup pair, save as template, export a full-resolution PNG.
4. **Background removal** — two engines, both fully local: *flood-key* (instant, solid backgrounds) and *AI segmentation* (MODNet via transformers.js, MIT license, ~25 MB model downloaded once and cached). Before/after comparison with transparency readout, retries, download; the original is always preserved.
5. **Ink variants** — white-ink and black-ink versions per design: auto-generated as alpha-preserving flat recolors (presented for review, replaceable with your own file), independently stored and selectable in the editor and batches.
6. **Batch Studio** — pick N designs × M mockups, see the exact combination count, choose variant rule and placement template, run with live per-item status (real counts, never estimates), cancel, retry single items, and skip combinations that already have renders. Interrupted jobs recover as retryable failures.
7. **Templates** — placement templates (from the editor or built manually), mockup collections, ink rules, listing and SEO templates. Create, rename, edit, duplicate, version, search, apply to many designs with a preview of the settings.
8. **Product Builder** — local product drafts; with `PRINTIFY_API_KEY` the live Printify blueprint catalog loads (real variants, print areas, providers). Product creation requires an explicit confirm step; nothing is published automatically. Printify's 100-variant-per-product limit is enforced in the UI, the agent tool, and the endpoint.
9. **Listings** — Etsy-ready drafts with validation against Etsy's documented limits (title ≤ 140 chars, ≤ 13 tags of ≤ 20 chars, price rules). Bulk-generate drafts from designs; duplicate; status-separated views.
10. **AI SEO Studio** — with an AI key: keyword ideas by intent, product/audience/seasonal angles, title drafts, description, tags — all editable, never fabricating search volume or sales data; save as template or spin into a listing draft. Without a key: honest setup instructions.
11. **Export Center** — real ZIP (fflate) with `MockupStudio_Export/<Design>/original.png`, ink variants, `mockups/`, `listing/`, and a `manifest.json`. The archive is re-read and verified before success is reported; missing assets are listed, not hidden.
12. **Activity** — a log of what actually happened (uploads, saves, batches, exports, errors).
13. **Agent** — a Hermes-style chat surface at `/agent`: sessions rail, streaming transcript with markdown + syntax highlighting, collapsible reasoning blocks, a combined provider/model picker with favorites and a reasoning-effort pill, and an approximate token/context meter. The agent can really run twelve tools — explain a workflow, summarize or list the local library, browse the live Printify catalog, draft listing copy, propose a batch job, make a single mockup, save a placement (optionally as a template), make an ink variant, remove a background, save an image you attached in chat as a design or mockup, and create a Printify product — shown as expandable activity cards; the seven writing tools write nothing until you click Create. When a model answers in prose without calling a tool, a keyword intent router still runs the obvious tool so the agent acts instead of only talking, and a `?debug=1` flag on the URL opens a raw-SSE capture drawer for provider issues. A model's effort hint is only sent when the model is flagged as a reasoning model (e.g. o-series, gpt-5, deepseek-reasoner, `:thinking`), and threads are auto-titled by the active model. Voice in/out uses the Web Speech API when the browser offers it (dictation into the composer, optional read-aloud replies), sending while a reply streams queues the message instead of interrupting it, and a right-hand workspace rail lists real batch jobs, exports, and listing drafts read live from IndexedDB. Conversations persist in this browser's IndexedDB. Replies stream over SSE from `/api/ai/chat`; without an AI provider the composer is disabled and points at Settings.

## Architecture notes

- **Astro 5 (`output: "static"` via `@astrojs/cloudflare`) + React 19 islands + TypeScript strict + Tailwind v4.** Every page is a thin `.astro` route that renders one React island; the shell and the view live in a single React tree (`src/routes/*.tsx`) because islands cannot nest and the views need Radix context from `TooltipProvider`.
- **API routes** are Astro endpoints (`src/pages/api/**/*.ts`) exporting `GET`/`POST` as `APIRoute` and returning a plain `Response`. Secrets are read server-side through `src/lib/server/env.ts`.
- **One compositing engine** (`src/lib/canvas/compose.ts`): the Konva editor, the batch renderer and the export compositor all call the same `computeGeometry`/`drawPlacement` math, so the rendered output provably matches the editor preview — exports are full-resolution composites, never screenshots.
- **Transforms are mockup-relative** (fractions of mockup dimensions), so placements survive canvas resize and transfer across mockups via templates.
- **Storage**: Dexie (IndexedDB) with metadata and blobs in separate tables; a future server-side migration only needs to swap the repository layer. Schema is versioned (v2 added render-provenance indexes; v3 added the agent-chat `conversations` / `messages` tables).
- **Secrets never ship in the bundle.** Integration keys are either pasted by the
  user in Settings (kept in that browser's IndexedDB, sent only as per-request
  headers to the app's own API routes) or set server-side as secrets. Printify and
  AI calls always go through server endpoints (`src/pages/api/**`), so keys are
  never called from the client directly and never appear in client chunks.
- **Client routing** is a thin History-API shim (`src/lib/client/nav.tsx`) providing `Link`, `useRouter`, `usePathname` and `useSearchParams`, so components navigate without a router dependency.
- **Background removal** runs a Web Worker for the AI engine; the flood-key algorithm is a pure, unit-tested function.
- **Batch rendering** is sequential on the main thread with event-loop yields — item statuses are the source of truth, and the UI stays responsive.

## Verified during development

- Uploads persist across reloads (manual browser QA + E2E).
- Editor compositing verified at pixel level (render contains design pixels at the transformed position over the mockup background, at full mockup resolution).
- Batch: 4/4 items done; re-run reuses renders (no duplicates); interrupted jobs recover.
- Background removal verified at pixel level (corner alpha 0, artwork alpha 255, original untouched) for both engines.
- Ink variants verified at pixel level (white = 255,255,255; black = 0,0,0; alpha preserved; original intact).
- Export ZIP inspected on disk: exact folder structure, correct per-design files, accurate manifest (counts, provenance, missing-asset notes), archive re-verified programmatically.
- Template: created → survived refresh → applied to another design (placement width changed 20% → template's 35%).
- 112 unit/integration tests + 17 E2E acceptance tests, lint clean, `astro check` clean, production build passing and the built server verified on every route.

## Known limitations (honest)

- **The project must live outside OneDrive.** It now runs from `C:\Users\hp\Projects\Mockup Studio 2.0`; the old copy under `OneDrive\Documents\ANTIGRAVITY PROJECTS` was removed. OneDrive turns build caches into cloud placeholders and breaks `node_modules` resolution, so keep the folder out of synced directories.

- **Printify / AI** are wired to the live provider APIs and can be connected from
  **Settings → API connections** (bring your own key). The AI section is a
  provider picker: choose a provider, paste its key, **Load models** to fetch the
  live list (free models tagged from the provider's own pricing where available),
  then **Test connection**. Free tags are best-effort — OpenRouter's real pricing
  is authoritative, other providers use id conventions or their advertised free
  tier. Neither was **verified against a real account** in this environment; Etsy
  listing *submission* is deliberately not implemented as a live call yet (drafts
  + validation only) because Etsy's v3 OAuth flow needs app registration; the
  workspace is ready for it.
- The AI background-removal model (MODNet) is trained for **photos of people/products**; for flat artwork on solid backgrounds the flood-key engine is faster and usually better. `Xenova/u2net` was gated (HTTP 401) at build time, so MODNet is the shipped default.
- **The Agent chat is complete through milestone M4, and the agent can now do the whole manual workflow.** Replies stream from `/api/ai/chat` over SSE, and the twelve tools run against real local data (tool-activity cards, a Create/Cancel confirm step before any of the seven writing actions, and model-written thread titles): batch-render, single mockup render, save placement/template, ink variant, background removal, save a chat image, and create a Printify product, plus read-only explain/summarize/list/browse/draft. A keyword intent router keeps weak models acting, and voice, steering, and the workspace rail are in place. Printify product creation sends every required field (`print_provider_id`, integer-cent prices, string artwork ids) and resolves the blueprint/provider/variants from a product type without inventing ids. The streaming and tool-calling paths have not been exercised against a real provider account in this environment (they need a pasted key), so they are covered by unit tests over synthetic SSE rather than a live call; voice relies on browser Web Speech support and is hidden where that is absent.
- Perspective/warp editing is **not** offered — Konva cannot do true perspective transforms, and fake controls are worse than none.
- Batch rendering is single-threaded by design (reliability over throughput); very large jobs still complete with live status and can be cancelled.
- Data lives in the browser profile that created it (IndexedDB is per-profile).

## Security

- API keys are never bundled into client code. A visitor may paste their own keys
  in Settings (stored in their browser's IndexedDB); those are only ever sent as
  headers to the app's own `/api/**` routes, which proxy to the provider. Server
  keys live in `.env.local` / Wrangler secrets (git-ignored); no key material is
  present in client bundles (covered by an E2E test).
- The `/api/integrations/test` endpoint makes a read-only probe and persists nothing. `/api/integrations/models` proxies a provider's public model list (read-only, nothing persisted).
- File uploads validated (type, size, emptiness); filenames sanitized against traversal (`sanitizeFilename`).
- No network calls leave the machine in the core workflow; background-removal models load from jsDelivr/HuggingFace only when you use the AI engine.
