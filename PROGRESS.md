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

---

## Printify Studio (Oct 2026)

A new tab that turns a folder of designs into a batch of Printify listings:
pick the product, pick the colours, choose which colours print with the black
ink, place the artwork, and create one product per design.

### What was built

- [x] **Designs tab** - upload, designs auto-split into two rows ("no ink
      variants" / "has ink variants"), checkbox selection that IS the batch
      scope, inline bulk background removal with a progress bar, and the
      wipe animation that shows the real artwork becoming the cutout.
- [x] **Colors tab** - the live Printify catalogue (2,889 products) with
      instant search and a derived category filter, print-provider choice,
      size selection, one colour set per row, and a black-ink / white-ink
      assignment per colour.
- [x] **Design panel tab** - print-area picker, width / rotation / centre
      controls, a draggable print-area preview, a per-design placement
      override, and the create-listing flow with a per-design result list.
- [x] **The Printify contract, established against a live shop** and pinned by
      `npm run spike:printify` (12 checks, deletes what it creates).
- [x] Pure-function core in `src/lib/printify/` with unit tests, because CI
      has no Printify key and the unit tests are the only safety net.

### The three findings that changed the design

1. **Printify rewrites `print_areas[].variant_ids`** to swallow any variant no
   group named, and an incomplete partition makes it print the WRONG artwork
   on a variant - proven by sampling the generated mockup pixels. The app now
   always builds a complete partition over every variant.
2. **The catalogue is a SUBSET of the product's variants** (6/30 lists 132,
   the product has 137). The extras belong to colours the catalogue hides, so
   they are unreachable and disabled - but they land in the last print area.
3. **Background removal reported success when it removed nothing.** The check
   used the output's total transparency, which is 1.0 for an
   already-transparent artwork AND for a solid-colour artwork whose artwork
   was erased. The engine now reports the fraction of pixels whose alpha
   CHANGED, and the UI refuses both cases.

### What the parallel audit found and what was done about it

Six read-only auditors (browser QA, Printify contract, state integrity, risk
and cost, accessibility, rendering performance) reviewed the feature. Fixed
afterwards:

- The white-ink group was given the black-ink artwork whenever no colour was
  marked black - the artwork is now chosen by the group's INK LABEL, never by
  its position.
- "Create on Printify" would have created a product for every design in the
  library. It now creates only the ticked ones, skips designs that already
  have a product, and verifies each created product really carries the
  artwork it was meant to (the create response carries the whole product, so
  this costs no extra calls).
- One colour click re-rendered all 144 swatches (63-108 renders, 24-189 ms).
  The swatches are memoised and share one stable handler: now ~0 ms.
- The blueprint grid rendered no product photos, because the API returns
  `images[]` and the code read `image`.
- The wave's travelling edge animated `left`, forcing a layout per frame per
  card (~20x the layout work of a transform).
- The catalogue cache was a 5 MB IndexedDB record, more than half of it the
  HTML description the app never renders.
- Every input in the new tabs had no accessible name; the swatches and the
  print-area preview were pointer-only.
- The global `* { border-color }` rule was unlayered, which silently killed
  every Tailwind border-colour utility in the whole app.

### Gates

- [x] `npm run lint` - 0 errors
- [x] `npm run typecheck` - 0 errors
- [x] `npm run test` - 171 unit tests
- [x] `npm run test:e2e` - 18 acceptance tests
- [x] `npm run build` - `/printify-studio` prerendered
- [x] `npm run spike:printify` - 12/12 contract checks against a live shop
- [x] End-to-end in the browser: two real Printify drafts created, the black
      ink verified on the black colour and the white ink on the white one by
      sampling the generated mockup pixels; the test drafts then deleted.

### Known limits (honest)

- Colour swatches use the real hexes from an existing Printify product for
  that colourway, or a built-in table when there is none. The table covers
  the common names; an unknown name is flagged rather than guessed.
- The print-area preview shows the area and the artwork inside it. Printify
  does not publish where that area sits on the garment, so the position on
  the shirt is an approximation, and the UI says so.
- A design smaller than the print area is not upscaled: extra pixels carry no
  detail, so the print is as sharp as the source allows.
- One product per design, created sequentially. A batch of 50 designs is 50
  uploads plus 50 product creates against Printify's publish limit of 200 per
  30 minutes.
