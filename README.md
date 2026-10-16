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

Optional integrations live in `.env.local` (copy `.env.example`):

```bash
PRINTIFY_API_KEY=...      # live Printify catalog + product creation
AI_API_KEY=...            # any OpenAI-compatible provider (AI SEO + assistant)
AI_BASE_URL=...           # default: https://api.openai.com/v1
AI_MODEL=...              # default: gpt-4o-mini
```

**Everything in the core workflow works without any API key.**

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build (`node dist/server/entry.mjs`) |
| `npm run lint` | ESLint (typescript-eslint + eslint-plugin-astro) |
| `npm run typecheck` | `astro check` — strict TS across `.ts`, `.tsx` and `.astro` |
| `npm run test` | Unit/integration tests (27 tests) |
| `npm run test:e2e` | End-to-end acceptance tests (14 tests, needs `npx playwright install chromium` once) |
| `npm run astro` | Any Astro CLI command (`astro add`, `astro info`, …) |


## The workflow

1. **Designs** — upload one or many PNG/JPEG/WebP files (drag & drop, 40 MB limit). Everything persists in IndexedDB and survives refreshes. Tag, rename, duplicate, download, delete with confirmation.
2. **Mockups** — upload product photos, organize by category, favorite, multi-select.
3. **Mockup Editor** — place artwork with the same compositing math used for exports: move, resize, rotate, flip, stretch, opacity, center-align, numeric inputs, undo/redo, unsaved-changes indicator, zoom/fit. Optional "design behind mockup" mode for transparent garment PNGs. Save per design×mockup pair, save as template, export a full-resolution PNG.
4. **Background removal** — two engines, both fully local: *flood-key* (instant, solid backgrounds) and *AI segmentation* (MODNet via transformers.js, MIT license, ~25 MB model downloaded once and cached). Before/after comparison with transparency readout, retries, download; the original is always preserved.
5. **Ink variants** — white-ink and black-ink versions per design: auto-generated as alpha-preserving flat recolors (presented for review, replaceable with your own file), independently stored and selectable in the editor and batches.
6. **Batch Studio** — pick N designs × M mockups, see the exact combination count, choose variant rule and placement template, run with live per-item status (real counts, never estimates), cancel, retry single items, and skip combinations that already have renders. Interrupted jobs recover as retryable failures.
7. **Templates** — placement templates (from the editor or built manually), mockup collections, ink rules, listing and SEO templates. Create, rename, edit, duplicate, version, search, apply to many designs with a preview of the settings.
8. **Product Builder** — local product drafts; with `PRINTIFY_API_KEY` the live Printify blueprint catalog loads (real variants, print areas, providers). Product creation requires an explicit confirm step; nothing is published automatically.
9. **Listings** — Etsy-ready drafts with validation against Etsy's documented limits (title ≤ 140 chars, ≤ 13 tags of ≤ 20 chars, price rules). Bulk-generate drafts from designs; duplicate; status-separated views.
10. **AI SEO Studio** — with an AI key: keyword ideas by intent, product/audience/seasonal angles, title drafts, description, tags — all editable, never fabricating search volume or sales data; save as template or spin into a listing draft. Without a key: honest setup instructions.
11. **Export Center** — real ZIP (fflate) with `MockupStudio_Export/<Design>/original.png`, ink variants, `mockups/`, `listing/`, and a `manifest.json`. The archive is re-read and verified before success is reported; missing assets are listed, not hidden.
12. **Activity** — a log of what actually happened (uploads, saves, batches, exports, errors).

## Architecture notes

- **Astro 5 (SSR via `@astrojs/node`) + React 19 islands + TypeScript strict + Tailwind v4.** Every page is a thin `.astro` route that renders one React island; the shell and the view live in a single React tree (`src/routes/*.tsx`) because islands cannot nest and the views need Radix context from `TooltipProvider`.
- **API routes** are Astro endpoints (`src/pages/api/**/*.ts`) exporting `GET`/`POST` as `APIRoute` and returning a plain `Response`. Secrets are read server-side through `src/lib/server/env.ts`.
- **One compositing engine** (`src/lib/canvas/compose.ts`): the Konva editor, the batch renderer and the export compositor all call the same `computeGeometry`/`drawPlacement` math, so the rendered output provably matches the editor preview — exports are full-resolution composites, never screenshots.
- **Transforms are mockup-relative** (fractions of mockup dimensions), so placements survive canvas resize and transfer across mockups via templates.
- **Storage**: Dexie (IndexedDB) with metadata and blobs in separate tables; a future server-side migration only needs to swap the repository layer. Schema is versioned (v2 added render-provenance indexes).
- **Secrets never reach the browser**: Printify and AI calls go through server endpoints (`src/pages/api/**`) reading env vars server-side; the client only ever receives `configured: true/false` plus results.
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
- 27 unit/integration tests + 14 E2E acceptance tests, lint clean, `astro check` clean, production build passing and the built server verified on every route.

## Known limitations (honest)

- **The project must live outside OneDrive.** It now runs from `C:\Users\hp\Projects\Mockup Studio 2.0`; the old copy under `OneDrive\Documents\ANTIGRAVITY PROJECTS` was removed. OneDrive turns build caches into cloud placeholders and breaks `node_modules` resolution, so keep the folder out of synced directories.

- **Printify / Etsy / AI** are fully wired server-side but were **not verified live** in this environment — no credentials. Their UIs show real, unconfigured setup states. Etsy listing *submission* is deliberately not implemented as a live call yet (drafts + validation only) because Etsy's v3 OAuth flow needs app registration; the workspace is ready for it.
- The AI background-removal model (MODNet) is trained for **photos of people/products**; for flat artwork on solid backgrounds the flood-key engine is faster and usually better. `Xenova/u2net` was gated (HTTP 401) at build time, so MODNet is the shipped default.
- Perspective/warp editing is **not** offered — Konva cannot do true perspective transforms, and fake controls are worse than none.
- Batch rendering is single-threaded by design (reliability over throughput); very large jobs still complete with live status and can be cancelled.
- Data lives in the browser profile that created it (IndexedDB is per-profile).

## Security

- API keys are server-side only (`.env.local`, git-ignored; verified no key material in client bundles — covered by an E2E test).
- File uploads validated (type, size, emptiness); filenames sanitized against traversal (`sanitizeFilename`).
- No network calls leave the machine in the core workflow; background-removal models load from jsDelivr/HuggingFace only when you use the AI engine.
