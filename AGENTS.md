# AGENTS.md — Mockup Studio

Operating notes for this project. Read this first; it records decisions that are
not obvious from the code.

## What this is

A local-first print-on-demand workspace for sellers: upload artwork, composite it
onto mockup photos in a real editor, batch-generate combinations, create ink
variants, remove backgrounds, reuse templates, and export verified ZIP archives.

**The defining constraint: all user data lives in the visitor's own IndexedDB.**
Nothing is synced, there is no account, and the server holds no user data. This
is why every page can be prerendered — no page depends on request state.

## Access

| What | Where |
|---|---|
| **Live site** | https://mockup-studio.adityadino678.workers.dev |
| GitHub | https://github.com/adityadino678-ai/mockup-studio-finale (public, branch `main`) |
| Local folder | `C:\Users\hp\Projects\Mockup Studio 2.0\mockup-studio` |
| Source ZIP | `C:\Users\hp\Projects\Mockup Studio 2.0\mockup-studio-finale-source.zip` |
| Cloudflare account | `Adityadino678@gmail.com's Account` / `d9d43da4a430000a58df02d35e8d519c` |
| Cloudflare Worker | `mockup-studio` on subdomain `adityadino678` |

Start locally: double-click `..\start.cmd`, or `npm run dev` → http://localhost:3000

## Deploy

```powershell
npm run deploy        # build + wrangler deploy
```

Auth is a wrangler OAuth token already on this machine (`gh` is also
authenticated as `adityadino678-ai`). Neither is in the repo.

**Auto-deploy (Workers Builds) is not yet connected.** One dashboard click:
Workers & Pages → `mockup-studio` → Settings → Builds → connect the repo, build
`npm run build`, deploy `npx wrangler deploy`. No secrets needed.

## Gates — run all five before claiming anything works

```powershell
npm run lint          # 0 errors
npm run typecheck     # 0 errors
npm run test          # 129 unit tests
npm run test:e2e      # 17 acceptance tests (local dev server)
```

To run the e2e suite against the deployed site instead:

```powershell
$env:BASE_URL = "https://mockup-studio.adityadino678.workers.dev"
npx playwright test
```

Both must pass. The production run has caught bugs the local run missed.

## Architecture decisions

- **Astro 5, `output: "static"`, `@astrojs/cloudflare@12.6.13`.** Pin that exact
  adapter version: v13+ requires Astro 6 and v14 requires Astro 7.
- **13 static pages + 9 on-demand endpoints.** No page depends on request state,
  so all pages prerender. Each endpoint opts in with `export const prerender = false`.
  `dist/_routes.json` excludes the pages, so static files come off the CDN and
  only API calls reach the Worker.
- **App shell and page view share one React tree** (`src/routes/*.tsx`).
  Astro islands cannot nest, and the views need Radix context from
  `TooltipProvider`. Putting the shell in `.astro` broke hydration — `Tooltip`
  threw and every view rendered blank.
- **Navigation is real document loads.** `src/lib/client/nav.tsx` replaces
  `next/link` and `next/navigation`. `Link` is a plain `<a>`; `navigate()` calls
  `location.assign`. An earlier History-API version changed the URL while leaving
  the old view on screen, so every link looked dead.
- **Konva is lazy-loaded** (`React.lazy`) so its ~326 kB is only fetched when the
  canvas actually opens, not on every page.
- **Secrets via `getSecret()` from `astro:env/server`**, not `process.env` —
  `process.env` does not exist in the Workers runtime. Declared as optional
  secrets in `astro.config.mjs`; no key is required for the core workflow.
- **No `Buffer`.** `atob` + `Uint8Array` in `api/printify/products.ts`.

## The Printify product contract (verified live, Oct 2026)

Established by `npm run spike:printify` against a real shop — see
`scripts/spike-printify.mjs`. These are **observed** behaviours, not guesses.
Re-run the spike after any Printify change.

**A product is a variant partition, and `print_areas` must cover every variant.**

- `variants[]` = the enabled (colour × size) combinations, each with a price in
  cents. There is no `colors` parameter: **a colour *is* a variant id.**
- `print_areas[]` = groups of `{variant_ids, placeholders[{position, images[]}]}`.
  One group per artwork; different groups may carry different artwork.
- **`print_areas` is REQUIRED.** Code `8150` "print_areas: The print areas field
  is required." — but `createProduct()` in `lib/server/printify.ts` omits the
  field when `printAreas` is empty, so that path fails. Always send one.
- **Printify rewrites `variant_ids` to complete the partition.** Any variant not
  named by any group is silently appended to the **last** group.
- **An incomplete partition renders the WRONG ARTWORK.** Verified at the pixel
  level: with groups `A=[17391]` and `B=[17427]`, Printify expanded B to the
  other 17 variants *and* variant 17391's generated mockup showed B's artwork.
  With a **complete** partition (every variant named exactly once) the artwork
  is exact, in any group order — confirmed by sampling the generated mockup
  JPEGs: Heather Grey → red, Solid Black → blue, Solid White → green.
  → **Always build a complete partition over every variant of the
  (blueprint, print_provider) and disable the unwanted ones with
  `is_enabled: false`.** Never rely on Printify filling the gaps.
- `placeholders[].position` comes back expanded to every printable position for
  the variant (`front` **and** `back`), but only the position you named receives
  the image. The other stays empty — that is expected, not a bug.
- `x`/`y` are **centre-based** in `[0,1]` (`0.5` = print-area centre) and
  `scale` is image-width ÷ placeholder-width. Printify's own rule of thumb:
  artwork the width of the placeholder → `scale: 1, x: 0.5, y: 0.5`.
- Placeholder size is **per variant**, so one blueprint can have different
  print areas per colour (embroidery front ≠ DTF front). A "universal"
  placement therefore means different physical sizes on different garments.
- **Colour hexes live on the *product*, not the catalogue.** The v1 catalogue
  only returns colour *names* (`options: {color: "Heather Grey"}`). A product
  carries the real values:
  `options[] = [{name:"Colors", type:"color", display_in_preview:true,
  values:[{id:831, title:"Heather Grey", colors:["#a4a4a3","#B7B6B5"]}]}]`.
  A template product (or any existing product for the same blueprint+provider)
  is the only source of true swatch hexes.
- **API-created products are unpublished drafts.** `visible: true` is the
  sales-channel flag, not a publish flag: `unpublish.json` answers
  `"Cannot unpublish product, which was not published."` Publishing is
  `POST /shops/{id}/products/{pid}/publish.json` with a body of **booleans**
  (`{title:true, description:true, images:true, variants:true, tags:true,
  keyFeatures:true, shipping_template:true}`) — each flag says "publish this
  field". It is not a simple toggle.
- `GET /shops/{id}/products.json` returns `{current_page, data:[…]}`, **not**
  `{products:[…]}`. `limit` may not exceed 50.
- **The catalogue is a SUBSET of the product's variants.** Measured: blueprint
  6 / provider 30 lists 132 variants and the product has 137; 706 / 99 lists
  419 and the product has 509. The extras belong to colours the catalogue
  does not expose, so the UI can never select them - they arrive disabled.
  They do land in the LAST print area, so the last group must be one whose
  artwork would be harmless if it were ever enabled.
- `npm run spike:printify` checks all of the above against a live shop and
  deletes what it creates. Run it after any Printify change; it is the only
  thing that catches API drift.

## The Printify Studio (`/printify-studio`)

The bulk listing tool: upload designs, pick the product and its colours,
place the artwork, create one Printify product per design.

- `src/lib/printify/` - the pure core: `colors` (hex, lightness, ink
  contrast), `fit` (placement maths), `variants` (colour -> variant id and
  the partition), `print-areas` (the payload and its guard),
  `catalog-client` (cached catalogue), `studio-session` (the stored state).
  Everything in there is a pure function with unit tests in
  `tests/studio-printify.test.ts` - the ONLY safety net, because CI has no
  Printify key.
- `src/views/studio/` - the three tabs: Designs, Colors, Design panel.
- The session is one blob in the `settings` table (`printifyStudio:session`).
  It survives a reload without a schema migration.

Four things that are easy to get wrong, and were:

1. **The artwork is chosen by a group's INK LABEL, never by its position.**
   A group with no colours is normal (the user marked every colour for the
   other ink), and it used to shift the artwork onto the wrong colours.
2. **The partition must cover every variant.** `buildPartition` completes it
   over the catalogue, and `assertCompletePartition` checks it before a
   product is created. Printify rewrites an incomplete partition and prints
   the wrong artwork - proven at the pixel level.
3. **A background removal "succeeded" when it removed nothing.** The check
   used the output's total transparency, which is 1.0 for an
   already-transparent artwork AND for a solid-colour artwork whose artwork
   was erased. The engine now reports the fraction of pixels whose alpha
   CHANGED (`removed`), and the UI fails when nothing changed or when
   everything was removed.
4. **Only the ticked designs are created.** An empty selection means NO
   batch, not "every design" - otherwise one click turns one design into
   fifty products. Created products are also written to `productDrafts`, so
   they show up in the Product Builder and the Listings page.

## Background removal: four engines, and the rule that picks between them

`src/lib/printify/remove-background.ts` owns the decision. The cheap engines
run first and the expensive one is only used when the cheap ones provably
cannot help:

| Flood-key result | Outcome |
|---|---|
| removed >= 2% and transparency <= 98% | success, engine `flood-key` (flat artwork) |
| removed >= 2% and transparency > 98% | **throw** - the artwork WAS the background. Do NOT escalate: the AI engine cannot help, and it would cost a 25 MB download to fail the same way. |
| removed < 2% | try the **border model** next |
| border model removed >= 2% and transparency <= 99.5% | success, engine `border-model` (a backdrop that fades or vignettes) |
| border model removed < 2% | the **hosted service** next, if the user configured one, then the local model |

`removed` is the fraction of pixels whose ALPHA CHANGED, never the output's
total transparency: a soft ramp (alpha 255 -> 100) counts as a change, and an
already-transparent artwork scores 1.0 without a pixel being touched.

The four engines are genuinely different methods:

- **flood-key** matches ONE flat colour from the border. Instant, offline.
- **border-model** (`src/lib/bg-removal/border-model.ts`) models the
  background from the image border and takes the estimate ALONG each row and
  column, so a gradient or a vignette is followed instead of matched against
  one colour. The removal is restricted to the pixels CONNECTED to the
  border, which is what keeps a white shape inside the artwork from being
  erased. Instant, offline, no model.
- **ai-segmenter** (MODNet in a worker) handles any photograph. It downloads
  ~25 MB from a CDN on the first run, so its stages are reported through
  `onProgress` - "Downloading the background model (~25 MB, first use only)"
  must be visible or the run looks like a freeze.
- **api** is the user's own hosted service - see below. It is the engine the
  after-upload separation uses, and the `auto` chain reaches it before the
  25 MB download when a key is configured.

**Every entry point must use `removeBackgroundAuto`.** The Designs page
dialog used to call the old `removeBackground()` directly, which never
escalated - so on a photograph it removed ~1% and reported "little
transparency detected". The agent's `remove_background` tool had the same
bug.

**The removal always reads the ORIGINAL file**, never the processed cutout.
`designMainAssetId()` returns the cutout when there is one, so re-running the
removal used to operate on an already-transparent image - which cannot work,
and reported "little was removed" every time.

## The hosted background remover (the user's own key)

`POST /api/bg-remove` forwards to the service the user configured in
Settings. Three providers:

| Provider | Key | What it does |
|---|---|---|
| `remove-bg` | `x-bg-remove-key` | a dedicated background-removal service |
| `photoroom` | `x-bg-remove-key` | the same, different request shape |
| `gemini` | the **Google AI Studio key** (`x-ai-key`) | Gemini edits the image so the background is transparent |

The credential pattern is the one the app already uses: the key lives in the
user's own IndexedDB, travels as a request header, and is never written to
the server. `BG_REMOVE_API_KEY` is the optional server fallback.

**Gemini needs the GOOGLE key specifically, not whichever AI provider is
active** - `bgRemoveHeaders()` sends `x-ai-provider: google` and the Google
provider's key, so the request goes to the right account.

The removal's source is the ORIGINAL file, and the after-upload separation
in the studio's Designs tab uses the `api` engine directly - that is the
case the user sets a key up for. The local engines stay first in the `auto`
chain, because they are free, instant and private.

## The design split follows ONE product, not the design

`src/lib/printify/design-colours.ts` owns this. A product has ONE set of
colours, split into two groups: `plain` (one artwork) and `ink` (the ink
artwork, black on some colours and white on the rest).

The designs are separated **to match that product**:

- A design WITH ink artwork prints the ink artwork on the ink colours and its
  main artwork on the plain ones.
- A design WITHOUT ink artwork prints its main artwork on EVERY colour of
  the product. Its artwork is not "wrong" on the ink colours - it is simply
  not tuned for them, so that is reported, not hidden.
- A design is in the "Has ink variants" group only when it has an ink
  artwork **that this product's colours actually need**. For a product whose
  ink group is empty, no design needs an ink artwork and every design is a
  "no ink variants" design for that product.

The rule that matters: **a design always covers every colour of the
product.** The old code took the design's colour set from the group its ink
assets happened to match, so a design whose group was empty printed on
nothing and the only clue was "132 variant(s) are not in any group".

## Placement: drag, rotate, snap

`src/lib/printify/snap.ts` is the pure core and `print-area-preview.tsx` is
the React surface.

- Snap thresholds are in **SCREEN PIXELS** (7px), not fractions of the area,
  so the feel is the same at any zoom.
- The centre snap is the symmetry: the artwork's centre locks to 0.5 and a
  guide appears. The edges also snap to the area's edges in mode "all".
- Rotation snaps to every 15 degrees. Shift disables snapping.
- **The artwork's position must be `translate(-50%,-50%) translate((x-0.5)*W,
  (y-0.5)*H) rotate(a)`.** Positioning it with `left:50%` PLUS an absolute
  `translate(cx, cy)` double-counts the offset and throws the artwork out of
  the print area - a bug the prototype caught before it could ship.

## Print areas (the Mockups tab)

The Mockups page has two tabs in its upper section: `Mockups` (the library)
and `Print areas`. A **print area** maps a REAL Printify print area onto a
mockup photo, so the mockup shows what the product actually gets.

- `src/lib/mockups/print-area.ts` is the pure core: the box maths, the
  mapping between Printify's placement and the mockup's `Transform`, the
  area list derived from the catalogue, the physical sizes, and the template
  payload. No DOM, no React, no IndexedDB - so it is unit-tested on its own.
- `src/components/mockups/print-area-editor.tsx` draws the box on the photo
  and the artwork inside it. `src/views/mockups/print-areas-tab.tsx` is the
  screen; the editor canvas clips with a Konva `Group` and the batch/export
  compositor clips with `ctx.rect(...)` + `ctx.clip()`.

**The Printify Studio owns the design's placement. The mockup owns the area.**
That is the whole design, and it is deliberate:

- The area is a real Printify print area: the catalogue (blueprint → print
  provider → position) gives its exact pixel size, with named presets and a
  manual W x H as the fallback when there is no Printify key. Printify's
  placeholder size is per variant, so the **smallest** placeholder for a
  position is used - a design sized against it never exceeds the real area.
- The box's aspect is ALWAYS the area's aspect. It is stored as fractions of
  the photo (`x`, `y` = centre, `width`), so it survives a resize and travels
  to another mockup as a template.
- The artwork inside the box is placed by the Studio's own numbers (`scale` =
  artwork width / area width, `x`/`y` = the artwork's CENTRE in the area).
  **The mockups tab does not invent a placement.** Dragging the artwork there
  writes a per-design override back into the Studio session, so the mockup
  the buyer sees and the product Printify prints cannot disagree.
- For a mockup WITH an area, the Studio placement wins over a saved
  placement, in the editor and in the batch. Without an area, nothing about
  the old behaviour changed.
- **The design is clipped to the area** - in the editor preview, in every
  batch render and in the export. The part of the artwork that falls outside
  the printable area is not on the product either. Two acceptance tests prove
  it at the pixel level (`e2e/workflow.spec.ts`).
- A print-area **template** carries the area spec, the garment reference and
  the box position as a fraction of the photo - not the design placement,
  which belongs to the Studio. Apply it from `Mockups → Print areas` by
  ticking the target mockups.
- The optional **garment reference** (a line drawn across the garment, typed
  in inches) turns the photo into a scale, and the app can then report the
  design's printed size in inches.

**Traps in this feature:**

- The clip in Konva must live on a `Group` around the artwork. A clip on the
  artwork itself rotates with it. And a `Group` parent makes Konva bound the
  drag to the group's client rect - the artwork's own bounds - so the
  artwork would be pinned in place. The node needs an explicit
  `dragBoundFunc={(pos) => pos}`.
- The design's pixel size is NOT needed for the mapping: Printify scales
  artwork uniformly, and the renderer preserves the artwork's own aspect.
  Only the area's size and the box matter.
- `StudioPlacement.scale` may exceed 1 (the artwork is wider than the area
  and gets cropped). The Studio's width slider used to stop at 100% and had
  to be raised to 200%, or the mockups tab could set something the Studio
  could not show.

## Traps that will bite you again

1. **`main` in `wrangler.jsonc` must be a real file path.** The value in Astro's
   docs (`@astrojs/cloudflare/entrypoints/server`) does not work — wrangler
   resolves it as a filesystem path and the package has no top-level
   `entrypoints/` dir. We use `./dist/_worker.js/index.js`.
2. **`dist/.assetsignore` is required.** Wrangler refuses to deploy without it
   because it would otherwise upload the server-side Worker as a *public asset*.
   Regenerated by `scripts/postbuild.mjs` after every build. This is a real
   security guard — never work around it.
3. **PowerShell `Set-Content -Encoding UTF8` writes a BOM.** It silently corrupted
   `package.json` and introduced BOMs into 49 source files. Use the editor tools,
   or `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`.
4. **Cloudflare redirects `/designs` → `/designs/`.** `astro dev` does not. Any
   URL assertion must tolerate an optional trailing slash.
5. **Commit messages with `"` break PowerShell argument parsing.** Use
   `git commit -F <file>`.
6. **The repo lives in OneDrive, and Astro's content store does not always
   survive it.** `astro dev` writes `.astro/data-store.json` through a
   temporary file and renames it; OneDrive's sync can hold the target open
   and the rename fails with `EPERM: operation not permitted`, which kills
   the dev server with `UnknownFilesystemError`. Delete
   `.astro/data-store.json.tmp` and start again. If the dev server dies
   with a stack trace in `mutable-data-store.js`, this is why - not a code
   bug.
7. **A cold Vite optimizer pushes the first page load past the assertion
   timeouts**, so the e2e suite fails on "the app shell did not hydrate"
   with no application error anywhere. `e2e/global-setup.ts` visits every
   route once, with a real browser, before the suite runs. Do not remove it
   because the suite passes on a warm machine - it is what makes a cold
   machine pass.
8. **The dev server reloads the page when it re-optimises a lazy import.**
   A reload resets the React state, so anything transient (an open panel, a
   selected tab) is lost. `toleratingReload()` in `e2e/workflow.spec.ts`
   retries the interaction. The app is fine - production serves static
   files and has no Vite.

## Known gaps

- **Workers Builds auto-deploy is not connected** (needs the dashboard click above).
- **API keys are optional and user-supplied.** A visitor can paste their own
  Printify / AI keys in **Settings → API connections**; they are stored in that
  browser's IndexedDB (`settings` table, key `integrations`) and sent per-request
  as `x-printify-key` / `x-ai-provider` / `x-ai-key` / `x-ai-base-url` /
  `x-ai-model` headers. `src/lib/server/creds.ts` prefers the browser value and
  falls back to a server secret, so nothing breaks when neither is set. The
  server never stores a user's key. Preview deployments can also set secrets with
  `npx wrangler secret put PRINTIFY_API_KEY` (and/or `AI_API_KEY`). With no keys
  anywhere, every integration endpoint returns 503 before doing work.
- **AI is provider-aware.** `src/lib/ai/providers.ts` is the isomorphic registry
  of 14 providers (NVIDIA NIM, OpenRouter, Groq, Cerebras,
  Together, Google Gemini, Mistral, DeepSeek, Fireworks, xAI, OpenAI, Anthropic,
  Ollama, custom) — labels, base URLs, auth, key hints, docs, and a free-tagging
  rule (`pricing` for OpenRouter, `suffix` for `:free`/`-free`, `curated`,
  `all`, `none`). The registry holds no secrets and is imported by both the
  browser picker and the server client. All providers are reached through their
  OpenAI-compatible `chat/completions` endpoint; Anthropic/Gemini use their
  official OpenAI-compatibility layers. The client stores one key per provider
  and migrates the old single-key config into the `custom` provider on load.
- **`/api/integrations/test`** performs a live read-only probe (Printify
  `/v1/shops.json`; AI `/models` with a one-token chat fallback) and is the source
  of truth for the "Test connection" buttons.
- **`/api/integrations/models`** proxies a provider's live model list, normalizes
  it (chat models only, deduped, free-tagged) and returns it. Some providers
  (OpenRouter) publish a public list, so a key is not always required. Fetched
  lists are cached per provider in IndexedDB (`ai:models:<id>`, 10-minute TTL).
- **Agent chat (M1) lives at `/agent`.** A Hermes-style chat surface: sessions
  rail, streaming transcript (markdown + syntax highlighting), reasoning blocks,
  a combined provider/model picker with favorites and a reasoning-effort pill, and
  a status bar with an *approximate* token/context meter. Conversations and
  messages are stored in IndexedDB (`conversations` / `messages`, schema v3) —
  never server-side. Replies stream over SSE from **`/api/ai/chat`** (POST,
  `prerender = false`): the endpoint re-emits OpenAI-compatible deltas as
  `delta` / `reasoning` / `usage` / `done` / `error` frames (`src/lib/ai/sse.ts`).
  Capabilities (`reasoning` / `tools` / `vision`) are curated heuristics in
  `src/lib/ai/providers.ts` (`modelCapabilities`); the effort hint is only sent to
  models flagged as reasoning models. The floating `AssistantPanel` is now just a
  launcher for `/agent`.
- **Agent tools (M2) are real, and only real.** `src/lib/ai/tools.ts` is the
  isomorphic registry of twelve tools. Five are read-only: `explain_howto`,
  `summarize_workspace`, `list_library` (designs/mockups by name), and
  `browse_printify_catalog` (product types / print providers / variants),
  plus `draft_listing` (calls the existing `/api/ai/seo`). Seven write:
  `create_batch_job`, `create_printify_product`, `create_mockup_render`,
  `save_placement`, `create_ink_variant`, `remove_background`, and
  `save_chat_image`. Every writing tool is marked `confirm` and **writes nothing**
  until the user clicks Create on the tool card; only then does
  `src/lib/client/tools.ts` run the real work through `CONFIRM_TOOL_RUNNERS`
  (`confirmBatchJob`, `confirmPrintifyProduct`, `confirmMockupRender`,
  `confirmSavePlacement`, `confirmInkVariant`, `confirmRemoveBackground`,
  `confirmSaveChatImage`). `create_printify_product` auto-resolves the blueprint
  from a product type (catalog keyword search), then a print provider and up to
  100 variants, but never invents ids — with no product type it asks. `create_ink_variant`
  and `remove_background` reuse the editor's own canvas code
  (`createInkVariantBlob`, `removeBackground`); `create_mockup_render` reuses the
  batch engine's `renderComposition`, so a single render and a batch render are
  pixel-identical. `save_chat_image` reads images the user attached in the
  current conversation. Execution happens in the browser against IndexedDB, so
  the honesty rule in the system prompt still holds: the agent never claims an
  action the transcript does not show. The loop is client-driven: the model's
  streamed `tool_calls` come back on the SSE `tool_calls` frame, the browser runs
  each tool, replays assistant/tool messages, and re-calls the endpoint
  (`MAX_TURN_STEPS`, 30 per turn). `toApiMessages` omits tool calls that never got
  a result so the replayed history stays valid. Threads are auto-titled by the
  active model via **`/api/ai/title`**.
- **A turn pause is not a turn failure.** The step budget was 6, which is shorter
  than a single Printify listing (blueprint → print provider → variants → propose
  is five steps before the user even sees a confirm card), so legitimate turns
  used to die on `"The agent reached its step limit for this turn."` with no way
  forward. `src/lib/ai/step-limits.ts` now holds the pacing policy:
  `MAX_TURN_STEPS = 30`, plus a no-progress guard that stops the turn when the
  same tool+arguments signature repeats more than `MAX_IDENTICAL_CALLS` (3) times
  — the thing a step cap alone cannot distinguish from real progress. Both stops
  keep the full history and set `canContinue`, which renders a **Continue** button
  in the transcript; clicking it re-runs `runTurn` from the persisted messages, so
  the turn resumes instead of dead-ending. Verified live: one turn ran **9**
  steps (eight `browse_printify_catalog` calls plus a proposal), and the guard
  fired on a 4th byte-identical `list_library` call with Continue shown and
  resuming. Covered by `tests/step-limits.test.ts`.
- **Agent reliability (M4).** Free/weak models often answer in prose and never
  emit a tool call. `routeIntent()` in `src/lib/ai/tools.ts` is a keyword fallback
  the client runs when the model requested no tool, so the agent still acts.
  `src/lib/server/ai.ts` retries a fixable 400 once (`retryFix`: drops
  `reasoning_effort`/`temperature`, renames `max_tokens`↔`max_completion_tokens`,
  clamps a budget over the provider's cap, drops `tools`) and caps output
  (`2000` tokens; `8000` for reasoning models — the budget covers reasoning
  *and* the answer, so too small a value makes a reasoning model think and never
  answer). `parseProviderStreamLine` emits the provider's `finish_reason` as a
  `finish` frame; when a turn comes back reasoning-only the client retries once
  with double the budget and the reasoning hint off
  (`outputTokenBudget` in `src/lib/server/ai.ts`). `?debug=1` on `/agent` opens a
  raw-SSE capture drawer
  (`src/components/agent/debug-panel.tsx`) — use it to reproduce provider issues.
- **Tool calls must be emitted before `done`, and that is load-bearing.** The SSE
  read loop yields `{type:"done"}` the moment the provider sends `data: [DONE]`,
  and both `/api/ai/chat` and the client stop there. Aggregated `tool_calls` were
  originally flushed *after* the loop, so for every provider that terminates with
  `[DONE]` (OpenAI, Groq, OpenRouter, …) the model's tool calls were silently
  dropped and the agent only ever acted through the `routeIntent` keyword
  fallback. `streamChat` now accumulates through `absorb()`, flushes
  `tool_calls` first, and always ends with `done` last. `tests/agent-chat.test.ts`
  pins the ordering.
- **A model can stream reasoning forever and never answer.** Verified live:
  `nvidia/nemotron-3.5-lightning:free` over OpenRouter emits 22k+ characters of
  `delta.reasoning` with `content: ""` and no tool calls, so the agent looks
  broken ("still doesn't answer") when the fault is the model. The client
  already retries once with a doubled budget and a "reply now, plain text"
  nudge, then fails loudly. `cohere/north-mini-code:free` was the free model that
  reliably returned real `tool_calls`; check a model with a bare
  `/api/ai/chat` call before blaming the app. A provider whose model id is not
  enabled for the account fails fast with `Function '<uuid>': Not found for
  account '<id>'` (seen on NVIDIA NIM), which the error frame surfaces verbatim.
- **Printify's useful error text is not in `message`.** A rejected product comes
  back as `{"error":"Operation failed.","detail":"{\"errors\":{\"reason\":\"Failed
  to upload image…\"}}"}`. `confirmPrintifyProduct` now prefers
  `detail.errors.reason` so the tool card says what actually happened. A design
  whose artwork blob is only tens of bytes (a truncated PNG) is the usual cause —
  the confirm step rejects anything under `MIN_ARTWORK_BYTES` (256) before
  uploading.
- **A verified live run created product `6ad34982afcbf697740ed96f`** (blueprint 5,
  print provider 39, 100 variants, $24.99) from a generated 1 MB PNG through the
  agent's `create_printify_product` confirm card, proving model → tool call →
  confirm → Printify upload → product → `productDrafts` end to end.
- **Agent voice, steering, and the rail (M3).** `src/lib/client/speech.ts` wraps the
  Web Speech API with feature detection (nothing throws when unsupported); the
  composer shows a mic (dictation → draft) and a speaker toggle (read replies
  aloud, persisted in `settings` key `ai:speakReplies`). Because the tool loop is
  client-driven, **steering** is just a queue: sending while a reply streams appends
  to `queueRef` and the turn drains it when it finishes (one queued message per
  turn). The right-hand **`ArtifactRail`** reads IndexedDB live (batch jobs,
  exports, listing drafts, render count) and is a toggle in the header. The
  sessions rail is a drawer below `lg` and static above it; the artifact rail is
  `xl` only. M1–M4 are now shipped.
- **Printify product creation now sends every required field, and was verified
  against a live shop.** `POST /v1/shops/{shop_id}/products.json` requires
  `blueprint_id`, `print_provider_id`, and an integer-cent `price` per variant;
  artwork is uploaded first (`POST /v1/uploads/images.json`) and its id (a
  **string**) is attached to the print area. The client sends all of these
  (`src/lib/server/printify.ts`, `src/pages/api/printify/products.ts`), the
  Product Builder collects a price and print provider, and artwork is downscaled
  to fit an **8 MB** upload cap (base64 inflates ~33%). A live run created
  product `6ad322422a5e991891032a2b` (blueprint 6, provider 30, 100 variants,
  visible, 666 auto-generated mockups), so the path is proven end to end.
- **Printify caps a product at 100 enabled variants.** Sending more fails with
  code `8251` / "Too many variants enabled. Maximum allowed: 100". The client
  default-selects the first 100 (`MAX_VARIANTS` in `src/views/products-page.tsx`),
  the `All` button stops at the cap, the Create button disables past it, the
  `create_printify_product` tool sends at most 100, and
  `src/pages/api/printify/products.ts` rejects a larger payload with 400 before
  calling Printify. Selecting all 132 variants is what surfaced this.
- **Printify's gateway has returned a bare 502 on a large upload that a retry
  then completed** (128 s failed, 13 s succeeded). `request()` in
  `src/lib/server/printify.ts` retries once on 502/503/504 and on a dropped
  connection; the body is always a string, so replaying the request is safe.
- **Printify rejects artwork it cannot decode, and its top-level message is only
  "Operation failed.".** The real text lives in `error.errors.reason`
  ("Failed to upload image…"), so `extractError()` prefers the deepest message
  available. A 16×16 PNG whose final chunk was `END®` instead of a valid `IEND`
  decoded fine in the browser yet Printify refused it — the endpoint now reports
  Printify's reason instead of a generic failure.
- **Printify does not return a `permalink` when creating a product.** The draft
  card therefore shows the product id and links to the Printify products page.
- **The blueprint `<Select>` renders every blueprint (~2886 options) with no
  search**, slow enough to stall an automation client. Not yet fixed.
- **The base64 artwork upload is capped at 8 MB.** A larger body plus its decoded
  buffer can exceed the Workers 128 MB memory ceiling; the client downscales PNGs
  until they fit (`src/lib/client/artwork.ts`).
- **Data is per-origin.** A library created on `localhost:3000` does not appear on
  `workers.dev`. Export a ZIP from the local app first if the data matters.
- **Cloudflare calls `workers.dev` "not business-critical"** — a custom domain is
  the next step if this ever matters commercially.
- **Etsy listing *submission* is deliberately not implemented** (drafts +
  validation only) because v3 OAuth needs app registration.
- MODNet (background removal) is tuned for photos; flat artwork on solid
  backgrounds is better served by the flood-key engine.

## Git

History is intact — 11 commits from `c7cc6bc feat: foundation` through
`0304329 fix(deploy): make wrangler deploy work and verify against production`.

Do **not** touch `adityadino678-ai/mockup-studio`. It is a *different* project (a
Vite SPA using `@imgly/background-removal` and `onnxruntime-web`, with branches
`main` and `redesign/clean-studio-ui`). This project lives in
`mockup-studio-finale`. There is also a separate private `Mockup-studio-3.0`.

## Prior work on this project

`PROGRESS.md` holds the original build log (Next.js phases 1–7: foundation, batch
studio, templates/export, Printify/Etsy/AI routes, test suites). It predates the
Astro migration but documents why the domain layer looks the way it does.
