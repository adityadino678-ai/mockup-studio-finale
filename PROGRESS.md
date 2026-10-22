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

## Printify Studio, second pass (Oct 2026)

The user reported three things: the ink-variant split was invisible, the
background remover did nothing on a real photo, and the artwork could not be
placed the way Printify places it.

### 1. The rows are always visible

`designs-tab.tsx` and `placement-tab.tsx` used to do `if (list.length === 0)
return null`, so an EMPTY row was never rendered and the split between "no
ink variants" and "has ink variants" was invisible. Both rows now always
render, each with its heading, its count and a one-line empty state that
explains where the missing row comes from.

The split logic itself was always correct - a design moves to the ink row the
moment it gets an ink variant - and that was verified live by giving a design
a white ink variant and watching it move.

The Design panel tab now has the same two galleries at the top, and the
listing (title, price, "Ready to create", "Create on Printify") stays below
them, unchanged.

### 2. Background removal works on real photos

Two engines, and the rule that picks between them now lives in one place
(`src/lib/printify/remove-background.ts`):

| Flood-key result | Outcome |
|---|---|
| removed >= 2% and transparency <= 98% | success, `flood-key` (flat artwork) |
| removed >= 2% and transparency > 98% | fail - the artwork WAS the background. Not escalated: the AI engine cannot help and it would cost a 25 MB download to fail the same way. |
| removed < 2% | escalate to `ai-segmenter` - this is a photograph |

`removed` is the fraction of pixels whose ALPHA CHANGED, never the output's
total transparency. That distinction is the whole fix: an artwork that was
already transparent scores 100% transparency without a pixel being touched,
and a solid-colour artwork scores 100% because the artwork itself was erased.

Measured on a real noisy photograph through the real UI: flood-key found
nothing, the run escalated, the model download was announced, and the AI
engine removed 42% of the pixels at the original 400x400 resolution.

The stage is queued rather than replaced, so each message stays up for at
least 900 ms. Without that, React's state coalescing swallowed "Downloading
the background model (~25 MB, first use only)" - the exact message that stops
a 90-second wait from looking like a freeze.

Also fixed in the AI worker: a non-RGBA model output was copied into the
artwork-sized buffer at the model's own resolution, so the content landed in
the top-left corner and the rest of the image was transparent. It now
resamples through a canvas.

### 3. Printify-style placement

`src/lib/printify/snap.ts` is the pure core, `print-area-preview.tsx` is the
React surface. Snap thresholds are in SCREEN PIXELS (7px), not fractions of
the area, so the feel is identical at any zoom.

- Drag to move, with the grab offset recorded so the artwork does not jump.
- A round rotation handle in the artwork's ROTATED frame, so at 90 degrees it
  sits on the right edge.
- The centre snap is the symmetry: the artwork's centre locks to 0.5 and a
  guide appears. The edges snap to the area's edges.
- Rotation snaps to every 15 degrees.
- Shift disables snapping. Arrows move, Shift+arrows resize, Alt+arrows
  rotate.

The artwork's position is `translate(-50%,-50%) translate((x-0.5)*W,(y-0.5)*H)
rotate(a)`. Positioning it with `left:50%` PLUS an absolute translate
double-counts the offset and throws the artwork out of the print area - a bug
the prototype caught before it could ship.

Measured on the real component: a 4px drag lands on 0.5 snapped and 0.513
free (Shift held); a rotation to 88 degrees lands on 90 degrees with a "90"
badge, and 89 degrees free.

### 4. The adjustment panel

Clicking a card opens a SEPARATE panel holding nothing but the placement:
the preview, the print-area picker, width, rotation, centre X and Y, and the
"apply to this design / to every design" choice. No title template, no
price, no colour list, no results - a panel that mixes the two is how a user
ends up editing the wrong thing.

### 5. An app-wide defect found on the way

The global `* { border-color: ... }` rule was UNLAYERED, so it beat Tailwind's
`@layer utilities` and silently killed every `border-border-strong`,
`border-forest` and `focus-visible:border-forest` in the app. It now lives in
`@layer base`.
### Gates

- [x] `npm run lint` - 0 errors
- [x] `npm run typecheck` - 0 errors
- [x] `npm run test` - 223 unit tests
- [x] `npm run test:e2e` - 19 acceptance tests, local AND production
- [x] `npm run build` - `/printify-studio` prerendered
- [x] Deployed to https://mockup-studio.adityadino678.workers.dev, then the
      same 19 e2e tests re-run against the deployed Worker

### Two flakes fixed on the way

- **The dev server reloads the page when it re-optimises a lazy import**, and
  a reload resets the React state - so a test that depends on an open panel
  or a selected tab lost it. `toleratingReload()` in `e2e/workflow.spec.ts`
  retries the interaction. The app is fine: production serves static files
  and has no Vite.
- **A cold Vite optimizer pushed the first page load past the assertion
  timeouts**, so the suite failed on "the app shell did not hydrate" with no
  application error anywhere. `e2e/global-setup.ts` now visits every route
  once, with a real browser, before the suite starts.

### Known limits (honest)

- The AI background removal downloads a ~25 MB model (MODNet) from a CDN on
  the first run. The download is announced, but it is still a download.
- The print-area preview shows the area and the artwork inside it. Printify
  does not publish where that area sits on the garment, so the position on
  the shirt is an approximation, and the UI says so.
- One product per design, created sequentially. A batch of 50 designs is 50
  uploads plus 50 product creates against Printify's publish limit of 200 per
  30 minutes.

---

## Printify Studio, third pass (Oct 2026)

Two complaints: "the background remover is not working", and "it's not
separating the non ink variation designs and ink variation designs according
to one product".

Both were reproduced before anything was changed.

### 1. The background remover

The Designs page (`/designs` -> Actions -> Remove background) offered
**only** the flood-key engine, which can remove one flat colour. On a real
photograph it removed 1% and said "1% of pixels now transparent - little
transparency detected". The Printify Studio's own Designs tab already had a
working auto-engine, so the two entry points behaved completely differently -
and the one a user reaches from their artwork library did nothing.

**The engine that does the work.** `removeBackgroundAuto` now runs three
engines, cheapest first:

| Flood-key result | Next |
|---|---|
| removed >= 2% and transparency <= 98% | done - the flat artwork case |
| removed >= 2% and transparency > 98% | **fail** - the artwork WAS the background. Not escalated: the AI engine cannot help and it would cost a 25 MB download to fail the same way. |
| removed < 2% | try the **border model** |

The border model is a genuinely different method and it is new. The flood key
matches ONE flat colour from the border, so on a studio backdrop that fades
it removes a ragged patch and leaves the rest. The border model estimates
the background from the image border and takes that estimate ALONG each row
and column, so a gradient is followed rather than matched against a single
colour. The removal is restricted to the pixels CONNECTED to the border,
which is what keeps a white shape inside the artwork from being erased.

Measured on a studio sweep (bright at the top, darker at the bottom - a
seamless paper lit from one side):

| Engine | Background left opaque | Subject |
|---|---|---|
| border-model | **0%** | intact |
| flood-key | 63% | intact |

It is instant, deterministic and needs no network, so it is the engine that
still works when the AI model cannot be downloaded. The AI segmenter
(MODNet) is still the fallback for a photograph with a busy background, and
its ~25 MB download is announced rather than left to look like a freeze.

Both entry points now use the same engine: the Designs page dialog and the
agent's `remove_background` tool.

### 2. The separation follows the product

The design split was a global property of the design:

```ts
const row = design.whiteInkAssetId || design.blackInkAssetId ? "ink" : "plain";
```

The product's colour groups were a separate, hand-made choice. The two were
independent, and when they disagreed the product was silently wrong. I
reproduced it by moving all four of the product's colours into the ink
group; the studio then reported, for the design without ink artwork:

> flat-design: 132 variant(s) are not in any group
> flat-design: no variants match the selected colours and sizes

That design would have printed on NOTHING, and the message says nothing
about why.

The split is now derived from the ONE selected product
(`src/lib/printify/design-colours.ts`):

- A design WITH ink artwork prints the ink artwork on the ink colours and its
  main artwork on the plain ones.
- A design WITHOUT ink artwork prints its main artwork on EVERY colour of
  the product. Its artwork is not "wrong" on the ink colours - it is simply
  not tuned for them, so that is reported, not hidden.
- A design is in the "Has ink variants" group only when it has an ink
  artwork **that this product's colours actually need**. For a product whose
  ink group is empty, no design needs an ink artwork, and every design is a
  "no ink variants" design for that product.

So the separation is a property of (product, design), and the same design
can land in different groups for different products.

The message is now a plain sentence, and there is a one-click fix that moves
the offending colours into the "one artwork" group.

### 3. The user's own keys: a hosted background remover

The user asked for the removal to use their **background remover API key** and
their **Google AI Studio key**, so that images are separated after they are
uploaded.

**Settings -> API connections** now has a "Background removal" section: a
service picker (remove.bg / PhotoRoom / Google AI Studio) and the key for it.
The Gemini path needs no second key - it reuses the Google AI Studio key the
app already holds as the `google` AI provider. That matters, because sending
whichever provider happens to be active would ask the wrong account.

The new endpoint `POST /api/bg-remove` forwards the image to the service. It
follows the credential pattern the app already uses: the key lives in the
user's own IndexedDB, travels as a request header, and is never written to
the server. `BG_REMOVE_API_KEY` is the optional server fallback.

Three providers, three different methods:

| Provider | Key | What it does |
|---|---|---|
| remove.bg | `x-bg-remove-key` | a dedicated background-removal service |
| PhotoRoom | `x-bg-remove-key` | the same, a different request shape |
| Gemini | the **Google AI Studio key** (`x-ai-key`) | edits the image so the background is transparent |

**The separation happens after the upload.** The studio's Designs tab runs
the `api` engine on every design it just uploaded, when a key is configured,
and the original is always kept. Verified in the browser: an upload fired
`POST /api/bg-remove` on the dev server, and the failure came back as a
toast naming the design - *"flat-design": remove.bg rejected the API key.
Check the key in Settings.*

The `auto` chain tries the local engines first - they are free, instant and
private - and reaches the hosted service before the 25 MB model download when
a key is configured.

The endpoint was verified live against the real providers with a fake key:
remove.bg answered **403** and PhotoRoom **404**, which proves the request
reaches them. A rejected key now says so: *"remove.bg rejected the API key.
Check the key in Settings."*

**Two bugs found on the way:**

- The removal read `designMainAssetId()`, which returns the PROCESSED cutout
  when there is one - so re-running the removal operated on an
  already-transparent image, which cannot work, and always said "little was
  removed". It now always reads the original.
- The exported Gemini request builder had no default model, so calling it
  without one built `models/undefined:generateContent`.

## Printify Studio, fourth pass (Oct 2026)

The instruction was blunt: **no AI separation, one background remover that
works with unlimited usage, and the ink pairs stacked by hand.** So this pass
is mostly subtraction - and every removal is recorded here so nobody adds it
back.

### 1. One background remover, two local engines, no key and no limit

`ai-segmenter` (MODNet in a worker, ~25 MB CDN download) and `api` (remove.bg /
PhotoRoom / Gemini) are **gone**, along with `POST /api/bg-remove`,
`src/lib/client/background-removal.ts`, the AI worker, `BG_REMOVE_API_KEY`,
the `bgRemove` integration setting, its Settings section and its headers.

What is left is the chain that was already the best one for artwork, and it
stops after two engines:

| Result | Outcome |
|---|---|
| flood key removed >= 2%, transparency <= 98% | done, `flood-key` |
| flood key removed >= 2%, transparency > 98% | **fail** - the artwork WAS the background. Not escalated. |
| flood key removed < 2% | border model |
| border model removed >= 2%, transparency <= 99.5% | done, `border-model` |
| border model removed < 2% | **fail** - "no background was detected", plus the one sentence that says a busy photo must be cut out before upload |

Both engines are instant, offline, deterministic and free. There is no
account, no key, no upload and no usage cap - which is the point. The failure
message is a sentence, not a stack trace, and it no longer pretends another
engine could rescue a busy photograph.

`tests/studio-remove-background.test.ts` was rewritten around the two-engine
chain and now also asserts that `removeBgAI`, `removeBackground` and
`setBgRemovalProgressCallback` are **absent** from the engine module, so the
AI path cannot creep back in unnoticed.

### 2. The ink split is a checkbox, not a guess

The disturbing behaviour was the automatic split: changing the product moved
designs between "Has ink variants" and "No ink variants", and there was a
one-click button that silently rewrote the user's colour groups.

Both are removed (`splitDesignsByProduct`, `splitDesignsByInkArtwork`,
`coloursToMoveToPlain`). In their place is one checkbox on every design card -
labelled **Ink variants**, `aria-label="Ink variants for <name>"` - stored as
`session.inkPairIds`:

- **Ticked** = this design has the ink pair. It prints its ink artwork on the
  ink colours and its main artwork on the plain ones, and a missing ink
  artwork is reported in plain language ("this design has no white-ink
  artwork, so on Black and Navy it would print with the main artwork").
- **Unticked** = one artwork on every colour. That is a decision, so it is
  never warned about.

The Designs tab and the Design panel draw the same card, so the two tabs
cannot disagree. Unticking is the fix for a "missing ink" warning; there is
no button that moves colours behind the user's back.

### 3. Removed the before/after wave

`wave-compare.tsx` and the pause/resume control are deleted. The card shows
the cutout if there is one and the original otherwise - statically. A
comparison animation on a card that is also being selected, dragged and
re-ordered was one moving part too many.

### 4. Layout

The gallery's broken look was a grid-track overflow:

- `min-w-0` on the cards and on the grid so a long design name or a wide
  badge can shrink instead of pushing the card out of its row.
- Badges wrap instead of widening the card.
- The adjustment dialog is `sm:grid-cols-[260px_minmax(0,1fr)]` with
  `min-w-0` on the flexible column, and `max-h-[calc(100dvh-2rem)]
  overflow-x-hidden overflow-y-auto` on the dialog itself, so a short window
  scrolls instead of clipping the Save button.
- Acceptance test 18 measures every `[data-design-card]` box against its
  `[data-design-row]` and fails if one escapes.

### Gates

- `npm run lint` - clean.
- `npm run typecheck` - 0 errors (153 files).
- `npm run test` - **303** unit tests pass.
- `npm run build` - succeeds; `dist/.assetsignore` written.
- `npm run test:e2e` - **22/25** pass. Tests 18, 22, 23 and 24 were rewritten
  for this pass and all pass. Tests 20, 25 and 26 fail on `#area-preset`,
  which no longer exists anywhere in `src`: they belong to the separate,
  in-progress print-area editor rewrite, not to this pass.

### Still to do

- Rotate the Printify key that was pasted in plain text during this pass:
  `npx wrangler secret put PRINTIFY_API_KEY`, and update `.dev.vars`.

---

# Fifth pass - pair two designs as one listing, and clip the adjustment preview

### 1. The adjustment panel no longer lets the design escape

`print-area-preview.tsx` sized the artwork as `scale x area width` and let its
height follow the artwork's own aspect, but nothing clipped it. A tall design,
or the width slider at 200%, painted straight over the sliders and out of the
dialog.

- The artwork layer now sits inside an `absolute inset-0 overflow-hidden`
  wrapper, so it is cut at the dashed print-area frame - the crop Printify
  actually applies. Guides, the snap badge and the rotation handle stay
  outside the clip.
- The rotation handle is clamped inside the preview box. It is placed beyond
  the artwork's top edge, so large artwork used to push it over the controls
  or off the panel entirely.
- The caption now says that anything outside the frame is cropped.
- The drag / rotate / snap maths and the stored placement are untouched.

### 2. Two designs can be paired as ONE Printify listing

The ink split used to require the ink artwork to live on the SAME design. The
user uploads the black-ink and white-ink designs separately instead, so the
studio now pairs them.

- New `session.inkPairs: StudioInkPair[]`, `{ blackInkDesignId,
  whiteInkDesignId }`. `loadSession` repairs it, and `pruneStudioDesign`
  removes a pair when either design is deleted. Old sessions load as `[]`, so
  nothing changes for them.
- **Designs tab -> "Pair for one listing"**, enabled when exactly two designs
  are ticked. The first ticked is the black-ink half; the roles are swappable
  on the cards. Each card shows its partner and two boxes: **Black ink** /
  **White ink**, plus **Unpair**.
- The black-ink design prints the plain colours AND the black-ink colours;
  the white-ink design prints the rest of the ink colours. `pairedColourGroups`
  and `planPairedDesignColours` are pure and unit-tested, and together they
  cover every colour exactly once.
- One pair = one product: the black-ink design owns the title, price and
  placement, and the partner is excluded from the product loop. A pair only
  applies when both designs are in the batch scope.
- A design can be in one pair only (`withInkPair` replaces the old one).
  Unticking either half, or Unpair, breaks the pair and returns both designs
  to the no-ink-variants row. A paired design is never reported as "missing
  ink": its partner is the artwork for the other half.

### 2b. The pair step is visible without a batch selection

The first shipped version put **"Pair for one listing"** only in the selection
bar, and that bar renders only when at least one design is ticked for the
batch. The user ticked "Ink variants" on two designs and saw nothing - the
pair step was invisible, and so were the Black ink / White ink boxes that only
appear after it.

The ink row now offers **"Pair these two as one listing"** as soon as exactly
two of its designs are ink-ticked and unpaired. It needs no batch checkbox and
adds both halves to the batch scope, because a pair IS a listing. With one
ink-ticked design the row says "Tick another design's Ink variants box...";
with three or more it points at the card checkboxes. The selection-bar path
still works for picking a specific two out of many, and Unpair still returns
both to the no-ink row.

### 3. Tests and gates

- `tests/design-colours.test.ts` gains 13 cases for the role split, the pair
  helpers and the role swap.
- New `e2e/ink-pairs.spec.ts` covers pairing, role swap, reload persistence,
  card layout, and the clipping + handle clamp. It lives in its own file so
  the numbered tests in `workflow.spec.ts` do not shift.
- `npm run lint` - clean.
- `npm run typecheck` - 0 errors.
- `npm run test` - **316** unit tests pass.
- `npm run build` - succeeds; `dist/.assetsignore` written.
- `e2e/ink-pairs.spec.ts` - 2/2 pass. The rest of the e2e suite still has the
  other session's in-progress print-area failures (tests 25-27).

