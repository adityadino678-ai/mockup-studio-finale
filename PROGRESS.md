# Mockup Studio — Build Progress Checklist

Persistent record of completed and remaining work. Updated as phases complete.

## Phase 1 — Foundation ✅
- [x] Next.js 15 + TS strict + Tailwind v4 + shadcn-style UI kit on the sage/forest palette
- [x] 12-section navigation shell + Overview with real data and honest empty states
- [x] Dexie (IndexedDB) schema v1+v2, metadata/blobs split, repository layer
- [x] Image pipeline: validation (type/size/empty), sanitize, decode, thumbnails, alpha detection
- [x] Dev server verified serving all routes

## Phase 2 — Core editing ✅
- [x] Design Library: multi-upload, drag&drop, search, tag filter, rename/tags, duplicate, download, delete w/ confirm, multi-select → batch
- [x] Mockup Library: upload w/ category, favorites, search/filters, multi-select, details
- [x] Mockup Editor: Konva canvas, move/resize/rotate/flip/stretch, numeric inputs, center-align, opacity, undo/redo, dirty indicator, save, save-as-template, template apply, zoom/fit, full-res PNG export, render-to-library, behind-mockup mode
- [x] Shared compositing engine verified pixel-accurate (editor = batch = export)
- [x] Placements persist per design×mockup pair (verified across reload)

## Phase 3 — Batch workflow ✅
- [x] Batch Studio: designs × mockups matrix with exact counts, variant rule, placement template, skip-existing dedupe, live per-item status, cancel, retry item, delete job
- [x] Sequential renderer w/ UI yields; interrupted-job recovery on reload
- [x] Background removal: flood-key (pure, tested) + AI MODNet in Web Worker (CDN-loaded transformers.js); before/after, retries, original preserved
- [x] Ink variants: white/black generation (alpha-preserving recolor), manual upload override, review UI, per-design default selection

## Phase 4 — Templates & exports ✅
- [x] Templates page: create, edit/rename, duplicate, delete, search, categories, version bump on save
- [x] Placement templates apply to many designs (verified width 20%→35%)
- [x] Export Center: fflate ZIP, documented structure, manifest.json, archive re-read verification, missing-asset reporting, per-run history
- [x] ZIP verified on disk (PowerShell opened the archive and checked entries/manifest)

## Phase 5 — Products & listings ✅
- [x] Server-side Printify client + catalog/products routes (confirm-gated, honest 503 when unconfigured)
- [x] Product Builder: local drafts, live blueprint/variants/print-areas when configured, artwork upload path, explicit confirm
- [x] Listings: drafts CRUD, bulk-generate from designs, Etsy constraint validation (title/tags/price), status filters, duplicate

## Phase 6 — AI SEO + assistant ✅
- [x] Server-side AI provider abstraction (OpenAI-compatible), json-mode SEO route with Etsy-constraint sanitization, no fabricated stats
- [x] SEO Studio: inputs → keywords by intent, angles, titles, description, tags; save as template; create listing draft; honest unconfigured state
- [x] Assistant panel: real quick-action navigation, provider-gated Q&A, never claims actions it didn't perform

## Phase 7 — QA ✅ (in progress → final pass)
- [x] `tsc --noEmit` clean (strict)
- [x] ESLint: 0 errors, 0 warnings
- [x] Production build passing (20 routes)
- [x] Vitest: 27/27 (placement math, flood-key, validation, filename safety, persistence, dedupe, recovery)
- [x] Playwright E2E: 14/14 acceptance tests passing (full suite green)
- [x] Final E2E green run (14/14, 3.3m)
- [x] Final report delivered

## Not implemented (deliberate, honest)
- Etsy live submission (needs registered OAuth app; drafts + validation ready)
- Perspective/warp transforms (Konva cannot do true perspective; no fake controls)
- Cloud sync / multi-user (architecture leaves a seam: repository layer + server route handlers)
