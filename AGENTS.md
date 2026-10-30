# AGENTS.md — Mockup Studio

Operating notes for this project. Read this first; it records decisions that are
not obvious from the code.

## What this is

A local-first print-on-demand workspace for sellers: upload artwork, place it on a
real Printify print area, map that area onto mockup photos, generate renders,
create ink variants, remove backgrounds, and export verified ZIP archives.

There are **twelve pages** — `/` (a static redirect to the Studio), Printify
Studio, Mockups, Listing images, Listing details, Listing preview, Autopilot,
Export Center, Agent, Activity, Settings, and the Printify bookmarklet install
page. The Designs, editor, Batch Studio, Templates, Product Builder, Listings
and AI SEO screens were folded into those pages or removed; their engines
(batch runner, compositor, Printify core, agent tools) are still here and still
what the UI and the agent call. The two listing tabs that used to live inside
the Studio were promoted to their own pages (below), and the Studio went back
to three tabs: Designs, Colors, Design panel. The Autopilot is the
review-gated bulk listing runner; a persistent task dock on every other page
shows its live progress.

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
npm run test          # 529 unit tests
npm run test:e2e      # 35 acceptance tests (local dev server)
npm run build         # astro build + postbuild (asserts _worker.js + .assetsignore)
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
- **12 static pages + 13 on-demand endpoints.** No page depends on request state,
  so all pages prerender. Each endpoint opts in with `export const prerender = false`.
  `dist/_routes.json` excludes the pages, so static files come off the CDN and
  only API calls reach the Worker. `/` is a static redirect (meta refresh plus
  `location.replace`, with an `<a>` fallback) to `/printify-studio`, not a view.
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
  print areas per colour (embroidery front ≠ DTF front). One shared placement
  therefore means different physical sizes on different garments.
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
  field". It is not a simple toggle. `POST /api/printify/publish` is the server
  half of that call: same-origin only, `application/json` only, requires
  `confirm:true`, validates the product id, answers an honest 503 with no key,
  and passes Printify's status and message through. It publishes an existing
  product id only - the client sends the draft this app created for its own
  listing.
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

## Printify mockups: public upload, private selection

The official product create/update schema has **no writable `images` field**.
Sending one returns 200 and is ignored. The product's mockup selection is a
separate, undocumented pair of APIs, and only half of it is reachable from a
server:

1. **Upload a custom product mockup (public API, verified live Oct 2026):**
   `POST https://api.printify.com/v1/shops/{shop_id}/products/{product_id}/mockups.json`
   with `Content-Type: application/x-www-form-urlencoded` and body
   `file_url=<public image URL>`. It returns `201 {"id":"…","src":"…"}`.
   A JSON body fails. The file URL must already exist, so the app uploads the
   render through `/uploads/images.json`, then passes its `preview_url`.
   Uploaded mockups are stored separately: the product's `images` array does
   not change.
2. **Select the product's mockups (web BFF, no public API):**
   `GET /api/v1/users/{user_id}/shops/{shop_id}/products/{product_id}/mockup-library-layout`
   returns `{groups, selected_mockups, limits}`. `selected_mockups` is an
   **object keyed by mockup id**.
   `PUT /api/v1/users/{user_id}/shops/{shop_id}/products/{product_id}/selected-mockups`
   takes exactly `{groups, selected_mockups}` - **not** `limits`, and here
   `selected_mockups` is an **array**. Uploaded entries are
   `{id, src, type:"UPLOADED", ownership:"MPL"}`.
   Groups are `{group_key, label, variant_ids, mockup_ids}`; the no-variant
   group is `not_linked`. The web app hides groups with an empty `mockup_ids`
   and uses group order for display, so the first group is the main image.
   **The bookmarklet preserves every group's identity, not its old mockups.**
   Dropping a group would lose the product's variant configuration, so
   `group_key`, `label` and `variant_ids` survive; replacement clears each
   group's `mockup_ids` and puts the new ids in `not_linked` (first).

The web session is in `localStorage.session` on **printify.com**:
`{access_token, embedded, user_id, shop_id}`. CSRF is the readable `XSRF-TOKEN`
cookie, sent as `X-XSRF-TOKEN`. The session is origin-scoped, which is why the
bookmarklet requires exactly `printify.com` - `www.printify.com` 301s to it.
A Cloudflare Worker cannot run a browser and must never hold this session.

**The flow is a clipboard bridge, not a server call.** The app uploads the
selected renders and builds a payload (`src/lib/printify/mockup-bridge.ts`)
containing product ids, mockup ids and image URLs only. The bookmarklet
(`src/lib/printify/bookmarklet.ts`) reads that payload, calls the BFF with the
user's cookies first, and only on a 401 retries with the session token. It
**replaces** by default (`payload.replace !== false`): `selected_mockups` is
normalised whether the BFF returns the keyed object or an array, only the new
ids are selected, every group keeps its `group_key`, `label` and `variant_ids`
but loses its old `mockup_ids`, and `not_linked` becomes the first group. That
is what removes Printify's generated/default mockups. `replace: false` opts
back into the old dedupe/prepend merge, and an older payload with no flag is
treated as replacement. Payload product ids and
mockup ids must match `[A-Za-z0-9_-]{1,64}` and image URLs must be `https://`,
so a tampered clipboard payload cannot inject a `javascript:`/`data:` URL.
If the layout cannot be read (or a 200 is malformed), the bookmarklet asks
before replacing; the extension cannot ask in a background tab, so it skips
that product and reports why. Each request has a 30 s abort timeout; it backs
off on 429 and runs at most two products at once. No token leaves printify.com.

A `javascript:` URL has all ASCII newlines/tabs removed before execution, so
the bookmarklet source must never contain `//` line comments - they would
swallow the rest of the code. Use `/* ... */`; the unit test parses the exact
newline-stripped source the browser runs.

**The companion extension (`extension/`) automates the last step.** It is a
local Chrome/Edge MV3 unpacked prototype that loads on `printify.com`,
`etsy.com` and the app origins. Its content script announces itself with
`<html data-mockup-studio-ext="1" data-mockup-studio-ext-protocol="2"
data-mockup-studio-ext-etsy="1" data-mockup-studio-ext-version="1.2.0">` plus
`mockup-studio:extension-ready`; on `mockup-studio:apply-request` the service
worker opens the first product in a background printify.com tab,
`chrome.scripting.executeScript` runs the SAME apply logic as the bookmarklet in
the isolated world (same origin, cookies and `localStorage`,
`credentials:"include"`), closes the tab, and answers via
`mockup-studio:apply-result`/`apply-error`. No `chrome.storage`, no remote code,
no API key in the extension, no payload persisted - it is held in memory for
one run. **Protocol 2 is required** (replacement apply + Etsy research). An
installed build that only sets the old marker is reported as "reload the
extension" and is never used for one-click apply or Etsy, so it cannot silently
merge mockups or leave the app waiting for an answer. It has a second job: when
the app has no working Etsy keystring, it
opens `etsy.com/search?q=...` in a background tab, injects
`extension/etsy-research.js`, returns the public titles/prices/URLs and closes
the tab (see the Etsy section below). `extension/protocol.md` is the contract;
`extension/STORE.md` lists what store publishing needs (replace icons, privacy
policy, fee). The app keeps the clipboard + bookmarklet path as the fallback
when the extension is absent, so the one-click button appears only after the
user installs it once. Competitor research (Mockup Maestro, Skalefy, Printify
bulk tools) found NO server-side equivalent: every tool either uses Printify's
default mockups or a browser extension running inside the user's printify.com
session, which is exactly this design.

`POST /api/printify/mockups` (`src/pages/api/printify/mockups.ts`) is the
server half: it requires `confirm:true`, is same-origin only, requires
`Content-Type: application/json`, rejects a body over 40 MB before parsing,
validates at most 10 images of 4 MB each and 24 MB total, checks each image is
valid base64 with JPEG/PNG magic bytes, resolves the shop, and requires the
product title to match the app's result (409 on a stale or missing title)
before uploading media + custom product mockups two at a time. The client sends
8 at a time and downscales to a 2 MB JPEG with a white background
(`src/lib/client/mockup-upload.ts`); it also rejects an image with no natural
dimensions instead of dividing by zero. The Printify product must exist before
its mockups can be uploaded. Because the endpoint spends the operator's key,
cross-site callers are rejected even when they use a preflight-free content
type.

**This path needs a real Printify web session to verify end to end.** CI and
the unit tests can prove the payload and the contract, not the PUT. Use a
throwaway product and a real printify.com tab for the final check.

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
- `src/views/studio/` - the three tabs: Designs, Colors, Design panel. The
  Design panel no longer owns title or price; it owns placement and **Create
  on Printify**. Copy, tags and price belong to the Listing pages because they
  apply per listing, not per placement.
- `src/views/listings/` - the three listing pages the two old Studio tabs
  became (plus their shared `listing-catalog.ts` loader): **Listing images**
  (`listing-images-view.tsx`, `/listing-images`), **Listing details**
  (`listing-details-view.tsx`, `/listing-details`) and **Listing preview**
  (`listing-preview-view.tsx`, `/listing-preview` — the Printify "My
  products"-style preview with separate Send and Publish actions). The engines
  underneath are unchanged: `listing-plan`, `listing-drafts`,
  `listing-render`, `renderComposition`, the send/bookmarklet bridge, and
  `src/lib/server/printify.ts` (+ the new `/api/printify/publish` endpoint
  for the final publish step, which sends the documented booleans body).
- **The Designs tab absorbed the old Designs page.** Each card's "…" menu
  (`design-card.tsx`, labelled `Actions for <name>`) renames and tags
  (`edit-design-dialog.tsx`), creates ink variants (`ink-variants-dialog.tsx`,
  moved here from `components/designs/`), removes the background inline,
  downloads the artwork, duplicates and deletes. The tab also has a search box
  and tag chips, and one bulk "Remove background" for the ticked designs. The
  card menu's remove-background calls the SAME `removeBackgrounds(ids)` the bulk
  button does, with an explicit id - there is no separate dialog, because a
  second remover was how the two paths drifted apart before.
- The session is one blob in the `settings` table (`printifyStudio:session`).
  It survives a reload without a schema migration. The Studio, the Mockups
  panel and the agent all write it, so the Studio's auto-save merges the
  latest stored blob and only overrides the fields this tab actually edited;
  saving the whole local copy used to put a stale placement back.
- **One saved Printify shop is the account-wide default.** Settings →
  **Printify shop** stores `printifyShopId` in the browser-local integrations
  record; `integrationHeaders()` sends it as `x-printify-shop`, and
  `credentialsFromRequest()` parses it into `creds.printify.shopId`. Product
  creation, mockup uploads, Send and Publish all use the same choice. The
  server never silently falls back to `shops[0]` when a shop id was supplied
  but is missing: `/api/printify/products` answers 409 `shop-missing`. Publish
  and mockup uploads are stricter still — they resolve the shop that actually
  OWNS the product (`resolveProductShop`) before writing, so a stale selection
  cannot address another shop's product. `GET /api/printify/shops` is the
  read-only list (connected first) that drives the dropdown and the preview's
  target-shop row.

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
   fifty products. Created products are also written to `productDrafts`, so the
   Agent's artifact rail and the Export Center can see them.

### Listing images, Listing details, Listing preview

These three pages turn the selected mockups and the bulk copy into local
listing drafts - and, after the product exists, into the Printify product's
mockups and finally a live product.

- **One listing per design, or per pair.** `src/lib/printify/listing-plan.ts`
  is the single answer: only ticked designs are in scope, a complete pair is
  one listing owned by its **black-ink** half, a half-pair is not a pair, and
  an ordinary design sits in the ink row only when it is ink-ticked **and
  actually has an ink asset**. A tick with no ink file prints the main artwork
  on every colour, so showing it in the ink row would make the tab disagree
  with the product. The black half's artwork and placement are the listing's
  preview and render; the pair is emitted at the black half's slot even if the
  white half sorts first. Designs are ordered by `createdAt`, matching the
  product loop.
- **Listing images**: `src/views/listings/listing-images-view.tsx` (page
  `/listing-images` — moved out of the Studio, rebuilt as one horizontal strip
  of mockup tiles per design). Every design in the batch gets a row (plain and
  ink), oldest first and numbered like the Mockups tabs; nothing is picked by
  hand. Every mockup in the library is a tile for every listing.
  - **A listing that was never configured starts with EVERY mockup included.**
    An explicit `session.listingImages[listingId]` wins; the cleared marker
    (`listingImageCleared`) records a deliberate empty selection; only those
    two states are "configured". Before a render or a send, the page persists
    the effective ids, so the drafts engine and the page agree about what will
    be sent. "Include all" appends the missing ids; "Clear" persists the empty
    selection; "Reset to all mockups" drops the explicit list and returns to
    the default.
  - **Long-press removal**: holding a tile (~500 ms, or right-click) starts a
    removal set for that row; clicks then toggle marked tiles; "Remove N from
    this listing" persists the effective selection minus the marked ones and
    "Cancel" discards the set. Removed mockups are simply absent from the
    selection, which is what keeps them out of Printify. The first included
    tile is the main image (order badge + "main" chip).
  - **Tiles show saved renders, not fresh guesses.** A tile adopts a
    `mockup-render` asset from the Mockups panel whose recorded `renderFp`
    equals the listing's current fingerprint (`render-adoption.ts`); only then
    are its pixels provably what the listing would render. Missing renders say
    "Not rendered" honestly. One **Save & render** adopts/reuses every current
    render, renders the rest one at a time with live progress, and writes the
    local listing drafts. The long render loop reads the latest session from a
    ref before saving, so edits made on another page mid-render are not
    overwritten.
  - **Renders saved before the fingerprint can be linked explicitly.** A
    `mockup-render` with no `renderFp` cannot be adopted automatically, so the
    page offers "N saved render(s) from Mockups can be linked"; one click pins
    the newest saved pixels for each uncovered tile to the CURRENT fingerprint.
    It is deliberately not automatic: linking assumes the design and area have
    not changed since that render was saved.
  - **Save render now means save AND use.** The Mockups panel's toolbar has a
    visible "Save render" (distinct from "Save area", which only stores the
    frame). Saving writes the render into `session.listingRenders` for the
    owning listing AND makes sure that mockup is in the selection, so the
    pixels reach Listing images / preview / Send immediately with no separate
    adopt step. `src/lib/printify/render-link.ts` (`linkSavedRender`) is the
    single rule: it finds the owning listing (`listing-plan.ts`), refuses on a
    pair's **white-ink half** (the pair is owned by its black half, so the
    white half's artwork would be wrong), refuses a design not in the batch,
    and only extends an explicit selection (a cleared selection becomes just
    this mockup; a never-configured listing keeps its "every mockup" default).
  - **Tiles are labelled by where their pixels came from.** `StudioListingRender`
    carries `source: "mockups" | "listing"`. Badges read **From Mockups**,
    **Rendered here**, **Not rendered**, or **Excluded** (and
    **Override: Mockups** when forced). Listing preview shows the same source
    split and a "Fix images" link, so the preview cannot silently disagree with
    Listing images.
  - **Out-of-date saved renders warn and can be overridden per tile or per
    row.** When a session entry exists but its fingerprint no longer matches
    and no fingerprint-adopted alternative hides the difference, the tile warns
    ("saved render is out of date") and offers **Use Mockups render**; a whole
    row has one "Use Mockups renders (N)" button. The override pins the saved
    pixels despite the mismatch, is reversible ("Clear override"), and is
    session-local (it never rewrites the asset's fingerprint). If the listing's
    image selection is **locked** (`ListingDraft.imageSelectionLocked`), any
    replace asks first ("Replace the locked images for X?").
  - Designs that are in the library but not ticked for the batch appear in a
    "Not in this batch" card with an explicit **Add to batch** button. They are
    never added automatically: an empty tick list means NO products.
  - The page is a real document, so an unsaved details form does not survive a
    round-trip through it - it hydrates from the last SAVED session.
- A listing render is the batch engine's `renderComposition`, stored as a
  `mockup-render` asset and keyed by `<listingId>:<mockupId>` in
  `session.listingRenders`. `renderComposition` also stores the fingerprint as
  `renderFp` on the asset's meta, which is what lets the Listing images page
  adopt a render made in the Mockups panel or by the agent. The fingerprint in
  `src/lib/printify/listing-render.ts` covers the design asset, the mockup
  asset/dimensions, the pixel-affecting print-area fields (`areaWidth`,
  `areaHeight`, `frame`, `crop`, `clipMode`), the Studio placement, the saved
  fallback transform **only when there is no print area**, and the
  behind-garment override. The area is resolved for THAT listing's design
  (`printAreaOf(mockup, designId)`), and the hashed `behindMockup` is the
  EFFECTIVE compositing mode: the area's `clipMode` when an area exists, the
  saved placement flag otherwise. `label`, `source`, `reference` and
  `updatedAt` are deliberately excluded. The fingerprint is `version: 4`;
  changing it invalidates existing renders once, which is the intended cost of
  fixing the old over-broad hash. Version 4 exists because every render of a
  ROTATED frame made before the clip-transform fix was displaced (see the
  compositor trap below), so those pixels had to stop being adoptable even
  though their inputs were unchanged.
- **Downloads** build a ZIP of the current renders only, in click order. The
  Export Center uses `listing.imageAssetIds` in order when
  `imageSelectionLocked` is true, and falls back to every render when it is
  not (`src/lib/export/zip-export.ts`). For a pair, the white half looks up the
  **black owner's** draft for copy and images; when the owner locked its image
  selection, the white half does not export its own fallback renders and adds
  a note pointing at the owner folder instead.
- **Listing details**: `src/views/listings/listing-details-view.tsx` (page
  `/listing-details`). Numbered per-design tabs (same oldest-first numbering as
  the Mockups panel) with a SMALL design card beside a dominant form.
  - **Per-design by default.** The form edits the open listing and saves only
    that listing's draft (title/description/tags/category/quantity) plus its
    own price override in `session.listingPrices`; it must never rewrite the
    other designs' drafts. A design that was never individually edited shows
    its batch-template expansion, so the form shows what WILL be sent.
  - **"Apply to every design" starts OFF.** Turning it on writes the batch
    templates (`titleTemplate`, `descriptionTemplate`, `tags`, `priceMode`,
    `priceCents`, `listingPrices`, `category`, `quantity`) and regenerates
    every active listing's draft from them - the old bulk save's semantics,
    per-design price overrides included in what it replaces.
  - `{design}` and `{product}` expand per listing; tags are capped at 13 of 20
    characters; price is either one fixed value for every listing or a custom
    value per listing. Custom prices are explicitly required - there is no
    silent fallback to the old fixed price, and the card says "Set a price"
    until one is entered. Price input accepts `24.99` or `24,99` but rejects
    ambiguous values such as `12.99.00` and `1e3`. A price applies to **every
    variant** of the product, which is what Printify requires.
- **Listing preview**: `src/views/listings/listing-preview-view.tsx` (page
  `/listing-preview`). The same numbered tabs, then a Printify "My products"
  style layout: the effective selection's first image as the MAIN image with
  the rest as thumbnails (session renders or fingerprint-adopted assets),
  expanded title, price, description, tag chips, meta rows, and a "What
  Printify gets" checklist that fails honestly and links to the page that
  fixes each miss.
  - **Send and Publish are two separate, confirm-gated actions.** *Send* creates
    the product draft if this listing has none (the same path
    `confirmPrintifyProduct` uses); when it already has a Printify product,
    Send **updates that product first** with a partial
    `PUT /shops/{shop_id}/products/{product_id}.json`. The first pipeline step
    is therefore "Create or update the Printify product". Only
    title/description/tags and, when a price is set, every existing variant
    (with `is_enabled` preserved) are sent - never `print_areas`. The update
    runs BEFORE the image upload, so `/api/printify/mockups`'s stale-title check
    compares against the new title. Then Send uploads the active listing's
    selected renders through `/api/printify/mockups`, and then uploads every
    OTHER batch listing that already has a Printify product, so one payload
    carries the mockup SELECTION for the whole batch (exactly like Listing
    images' Send). A listing with no product, no current render, or a partial
    render set is skipped with its reason in the step and a toast - never sent
    a shorter selection. The payload is applied through the companion extension
    (one click) or the clipboard/bookmarklet bridge (only a printify.com tab
    can write it). It then STOPS at `updated`: the products are updated in
    Printify and still unpublished. **A copy/price-only Send is a fast path.**
    When the product exists and the exact selection (ordered mockup ids plus
    render fingerprints, recorded only after a successful apply) still matches,
    Send stops after the product `PUT`: no render, no upload, no selection
    write. The dialog says "Update details only", and the applied signature is
    stored in `session.listingMockupsApplied`. A changed image, order, render
    fingerprint or product id falls back to the full pipeline. Listing images'
    extension apply records the same signature, so Listing preview can fast-path
    after a send from either page. *Publish* is a
    second, explicit click on **Publish now**, which calls
    `POST /api/printify/publish` with `{confirm:true, productId, shopId}` and is
    only reachable after the selection was applied, so the shop cannot receive
    Printify's generated mockups. **The extension never publishes** — its only
    network calls are the layout GET and the `selected-mockups` PUT — and a
    successful apply never chains into a publish. Any failure stops the run and
    shows the upstream message verbatim; a publish is never retried
    automatically, because publishing an already-published product errors
    upstream. The page never publishes a product this app did not create or
    link for that listing. E2E test 33 drives the whole path with TWO listings
    and only the first tab open: one payload applies both products, the run
    stops at `updated` with zero publish calls, and only **Publish now** makes
    the one publish call (for the open listing).
  - **The saved shop is checked BEFORE the button.** The page reads
    `printifyShopId`, lists shops through `/api/printify/shops`, and blocks a
    run while the list is still loading or when no shop is selected, the saved
    shop is no longer on the account, the list cannot be read, or the shop has
    no sales channel (the original `8254` failure). The message names the shop
    and links to Printify → My stores. `/api/printify/publish` repeats the
    check server-side against the shop that actually OWNS the product, answers
    `409 {code:8254, shopId, shopTitle, connectUrl}` without calling Printify
    when it is disconnected, and maps an upstream 8254 to the same shape.
    `POST /api/printify/products` uses the saved shop before uploading any
    artwork and returns `409 shop-missing` rather than silently using another
    store.
  - A **pair, or an unpaired ink design, is created in the Studio, not here.**
    `confirmPrintifyProduct` takes one artwork, while a pair needs both
    halves' print-area groups and an ink design needs its main and ink groups.
    The preview blocks creation with the reason and points at
    `/printify-studio`; once the product exists it links and publishes
    normally. Placement is not forwarded by that creation path either, so a
    non-default scale warns before creating a centred draft.
- **Draft locking is deliberate.** `src/lib/printify/listing-drafts.ts` writes
  one `ListingDraft` per listing, links the newest `ProductDraft`, and stores
  only asset ids that still exist. Before locking, it recomputes each render's
  fingerprint, so a placement/artwork change between render and save cannot
  lock obsolete pixels. `nextListingImageState` has three distinct cases:
  an explicit **Clear** locks an empty list; a complete fresh selection locks
  that exact order; anything else (untouched, partial, pending or stale)
  preserves the previous image state. A global save therefore cannot wipe
  every listing the user has not configured yet. Product creation saves drafts
  with `lockSelection:false`; an existing locked selection stays locked.
  **Copy is protected the same way, through `copyMode`.** `regenerate` is the
  Listing details page's explicit write (the form or the batch templates are
  the source of truth); `preserve` is the default for every incidental save -
  image selections, a placement fix, product creation - and keeps the title,
  description, tags, category and quantity already written for that design. A
  listing with no draft yet is seeded from the templates in either mode, so
  "per-design" never means "blank".
  Draft rows are read newest-first by `updatedAt`, not `createdAt`, so a
  re-saved draft is the one that wins. When the user swaps a pair's black/white
  roles, `remapListingState` moves images, clears, prices and renders to the
  new owner and `remapListingDraftOwner` re-points the local draft.
- **Printify images** are uploaded through `/api/printify/mockups` first, then
  the clipboard/bookmarklet applies them to the product's mockup selection.
  Sending is all-or-nothing per listing: if any selected image lacks a current
  render, that listing is skipped rather than sending a shorter set, because a
  shorter set changes which image becomes the main one. The render is the
  listing's image, not the product's print file; the print file still comes
  from the print areas.
  The Send dialog is **one press plus the final step**. It uploads, copies the
  payload automatically, and shows a 3-step indicator (images uploaded →
  payload copied → render the selection). When a protocol-2 companion extension
  is loaded the final step is a TRUE one-click: the dialog dispatches
  `mockup-studio:apply-request` with the payload object, and the extension
  (`extension/`) opens the product in a BACKGROUND printify.com tab, applies the
  selection with the user's own session, closes the tab, and reports back through
  `mockup-studio:apply-result` / `apply-error`. The dialog then shows a local
  "mockups applied" done state (with a per-product failure list). Without the
  extension the copy-again/text/bookmarklet fallback stays available; both paths
  use only the user's printify.com session — no token ever leaves
  printify.com. `extension/protocol.md` is the exact message contract.
  **Listing preview uses the same detection and apply path** (`extension-ready`
  marker/listener, `apply-request`, `apply-result`/`apply-error`), so the
  extension is offered there too instead of only the bookmarklet. Its apply
  step ends at "updated in Printify" and never publishes; only a separate
  **Publish now** click calls `/api/printify/publish`. Both paths send
  `replace: true`, so the app's images are the product's whole mockup
  selection and Printify's generated mockups are removed.
- **`/printify-bookmarklet`** is the install page. It is intentionally outside
  the sidebar: it is a utility page opened from the Send dialog, not another
  work surface.

## The listing autopilot (`/autopilot`)

The autopilot turns one ticked Studio batch into reviewed listings, but it is
deliberately **not** a "publish everything" button. It runs a persisted state
machine with three separate human gates:

```
research + draft  ->  HUMAN copy & image review
build + upload    ->  HUMAN bookmarklet step on printify.com
publish review    ->  HUMAN final publish approval  ->  published
```

Nothing advances past a gate until the user acts. A run is one row in
IndexedDB (`autopilotRuns`, schema v4), so a reload resumes it and the task
dock can show it on any page. A short tab lease (`sessionStorage` tab id +
`lease.expiresAt`) stops two tabs from running the same job; the second tab
skips the job rather than racing it, and a later resume picks it up once the
lease expires.

### Research and copy

- **One Etsy query per run, shared by every listing.** Etsy's Open API v3 has
  usage limits, and one market view is enough to ground the whole batch.
  `src/lib/server/etsy.ts` calls
  `GET https://openapi.etsy.com/v3/application/listings/active?keywords=...`
  with `x-api-key`, normalises the active-listing results, and reports
  **observed** title terms, tag counts, a median price, samples and an empty
  `currency` when the data is missing. It never invents search volume, sales,
  rankings or revenue.
- `POST /api/etsy/research` (`src/pages/api/etsy/research.ts`) is the only
  network path. It is same-origin, JSON-only, caps the body at 8 KB, caches
  successful results for 10 minutes per isolate, answers `503` without a
  keystring (or with a rejected one), and maps Etsy's own rate limit to `429`
  with a wait instruction.
- **The keystring is user-supplied**, stored in the browser-local integrations
  record (`etsyKeystring`), sent as `x-etsy-key`, with `ETSY_API_KEY` as the
  server fallback. Settings has an enabled Etsy card, a query box, a
  **Test research** button and an honest result line. It is read-only: it does
  not connect an Etsy shop or submit listings.
- AI copy is optional. `src/lib/autopilot/plan.ts` shapes it into Etsy's strict
  limits (140-character title, 13 tags of 20 characters, 5000-character
  description). With no AI key, or when the AI call fails, a deterministic
  fallback still produces a complete listing from the Studio templates and the
  observed Etsy terms. The copy is grounded on the research, and
  `groundedOnEtsy` says so.
- **Editing copy clears that listing's approval.** The review is of the exact
  title, description, tags, price and image selection that will be built.

### Build, mockups and the two publish gates

- **Every listing must be approved before a product is created.**
  `startAutopilotBuild` refuses outside `copy-review` and checks every
  listing's selected images against a current render. It does this **before the
  first product exists**, so a missing render cannot leave a half-created
  batch. The page disables **Approve all** until every listing is image-ready,
  and each listing card links straight to Listing images.
- **The run freezes the mockup SELECTION, not the render state.**
  `withCurrentRenderState` in `plan.ts` merges the CURRENT session's
  `universalPlacement`, `placements` and `listingRenders` into the run snapshot
  while keeping the snapshot's `listingImages`. That is what lets a user start
  a run, then go to Listing images and press **Save & render** during copy
  review: the run sees the new render instead of repeating "0 of 4 rendered".
  Changing the selection in Listing images does not affect an existing run; it
  keeps the start-time selection, and the warning says so.
- The build uses the same `buildStudioPlan` and `createStudioProduct` as the
  Studio, so pairs and ink colours keep their one-product semantics. A retry
  after a failed mockup upload **reuses the product already created**
  (`listing.productId`), never creates a duplicate. If an older run has a
  product id but no shop id, it falls back to the run's saved shop, and the
  server still resolves the product's real owner before writing.
- **A build with any failed listing fails the whole run at `build`.** The
  successful products and their uploaded mockups stay on the listing rows, so
  **Retry build** resumes from there instead of uploading everything again.
  Uploaded mockups are persisted (`uploadedUploads`) precisely so the
  bookmarklet payload can be rebuilt without re-uploading pixels.
- The bookmarklet step is the same clipboard bridge as Send. The run stores
  `bridgePayload` and `bridgeProducts`; the page shows the payload, a Copy
  button and the Printify product links. Only the user's printify.com tab can
  write the product's mockup selection, so the run waits here. Pressing
  **I ran the bookmarklet** records `mockupsAppliedAt` and moves to
  `publish-review`; it does not publish.
- **Publishing is only allowed for listings with `status === "uploaded"`, a
  product and a shop.** `publishAutopilotRun` refuses without
  `mockupsAppliedAt`, and `runPublish` skips already-published rows. The first
  upstream publish failure stops the run at `publishing` with Printify's message
  verbatim; **Retry publish** resets only failed rows that actually have
  `uploadedUploads`, so a row that was never prepared cannot be published by
  accident. There is no automatic publish retry.
- **Retry research is only offered while no product exists.** Once Printify has
  a product for the run, re-running research would orphan it, so the button is
  gone.

### The persistent task dock

`src/components/layout/task-dock.tsx` is mounted in the app shell on every page
except `/autopilot`. It reads the newest run live, is collapsed by default
(showing status and published count), expands to the listing chips, the last
three log lines, Pause/Resume and an **Open** link to
`/autopilot?run=<id>`. On mount it calls `resumeActiveRuns()`, which is what
makes a real document navigation safe: the new page continues a run that was
mid-research, mid-build or mid-publish. The run page owns the run itself and is
excluded so the dock cannot duplicate the controls.

E2E tests 30 and 31 cover the gates without keys: they seed a persisted run at
`mockup-review`/`copy-review`, assert that no publish request is made before
both confirmations, and assert that an unapproved listing cannot start a
build.

## Background removal: two engines, both local, no key and no limit

`src/lib/printify/remove-background.ts` owns the decision. There are exactly
two engines and the chain stops after them:

| Flood-key result | Outcome |
|---|---|
| removed >= 2% and transparency <= 98% | success, engine `flood-key` (flat artwork) |
| removed >= 2% and transparency > 98% | **throw** - the artwork WAS the background. Do NOT try the border model: it only eats the same artwork. |
| removed < 2% | try the **border model** next |
| border model removed >= 2% and transparency <= 99.5% | success, engine `border-model` (a backdrop that fades or vignettes) |
| border model removed < 2% | **throw** "no background was detected", plus the one sentence that says a busy photo has to be cut out before upload |

`removed` is the fraction of pixels whose ALPHA CHANGED, never the output's
total transparency: a soft ramp (alpha 255 -> 100) counts as a change, and an
already-transparent artwork scores 1.0 without a pixel being touched.

The two engines are different methods:

- **flood-key** matches ONE flat colour from the border. Instant, offline.
- **border-model** (`src/lib/bg-removal/border-model.ts`) models the
  background from the image border and takes the estimate ALONG each row and
  column, so a gradient or a vignette is followed instead of matched against
  one colour. The removal is restricted to the pixels CONNECTED to the
  border, which is what keeps a white shape inside the artwork from being
  erased. Instant, offline, no model.

**Both engines finish through `src/lib/bg-removal/edge-refine.ts`.** After the
mask, the kept anti-aliased ring is still a blend of subject and backdrop - the
dark fringe/halo a dedicated remover would clean up. `refineEdges` projects each
band pixel onto the local background→foreground line (the caller supplies the
background estimate: removed-neighbour colour for flood-key, its per-pixel
border estimate for border-model), sets alpha from the coverage, and
decontaminates RGB when the pixel lies on the line. A one-pixel morphology pass
removes isolated opaque specks and fills pinholes; fully transparent pixels are
never recoloured and opaque interior detail is never treated as edge. It adds
no model, key, upload or network call.

**There is deliberately no AI engine and no hosted service.** This was the
user's decision: one remover that works, unlimited, with no key, no account
and no upload. Do not re-add an AI model or a `BG_REMOVE_API_KEY` path. A busy
photographic background is out of scope, and the error message says so
instead of quietly escalating to something that costs money.

**Every entry point must use `removeBackgroundAuto`.** The Designs page's dialog
(removed with the page) used to call the old `removeBackground()` directly, which
never escalated - so on a photograph it removed ~1% and reported "little
transparency detected". The agent's `remove_background` tool had the same bug.
The Studio now has exactly two entry points - the card menu and the bulk button -
and both call `removeBackgrounds`, which uses `removeBackgroundAuto`.

**The removal always reads the ORIGINAL file**, never the processed cutout.
`designMainAssetId()` returns the cutout when there is one, so re-running the
removal used to operate on an already-transparent image - which cannot work,
and reported "little was removed" every time.

## The ink split is the user's two panels, not a guess

`src/lib/printify/design-colours.ts` owns this. There are TWO independent colour
panels, and each design row reads ONLY from its own panel:

- **No ink variants** (`plain`): a design in this row prints exactly the colours
  selected in that panel, with one artwork. It never inherits the ink panel's
  colours.
- **Has ink variants** (`ink`): a design in this row prints exactly the colours
  selected in that panel, with its ink artwork — black ink on the colours marked
  **Black ink**, white ink on the colours marked **White ink**, and on nothing
  else. It never inherits the plain panel's colours.

**White ink is an explicit choice, and the two lists are the whole truth.**
`session.rows.ink` carries `blackInkColors` AND `whiteInkColors`. A colour in
neither list is **undecided**: it is printed by no design, and
`undecidedInkProblems(plan)` blocks Create with a message naming the colours.
That third state exists because white used to be implicit ("everything not
marked black"), so a colour the user never marked silently went to the
white-ink design — the exact cross-contamination this model prevents. Selecting
a colour in the Colors tab leaves it undecided; only the **Black ink / White
ink** buttons decide, and `setInk` keeps the two lists mutually exclusive (a
colour in both resolves to black and is dropped from white on load). A session
with no `inkRevision` (or `< 2`) was saved while the app still guessed inks
from garment lightness; those lists ARE that guess, so `loadSession` clears the
**ink row once** (`inkRevision: 2`, `inkReset: true`) instead of replaying it.
The "No ink variants" row is never touched: its colours carry no ink and are
kept exactly as saved. `saveSession` stamps `inkRevision: 2`, so the reset
cannot run twice; `inkReset` drives a dismissible notice that says the old
automatic split was cleared. The undecided state shows the swatch's existing
`ambiguous` badge (`?`), with
neither ink button pressed. An autopilot run snapshotted before the field
existed gets the same one-time derivation in `withCurrentRenderState`, so a
resumed run is not left permanently "undecided" by colours it can no longer
edit.

The two panels are deliberately independent, and a colour selected in BOTH is
allowed and intentional: the plain row prints it with the plain artwork, the ink
row with the ink artwork. There is no merge and no stripping. `planDesignColours`
therefore returns the plain panel for an unticked design and the ink panel for a
ticked one — never a union, never a product-wide set.

WHICH design uses the ink artwork is still the user's decision, stored as
`session.inkPairIds` and set by the **"Ink variants" checkbox on every design
card** - the Designs tab and the Design panel draw the same card, so the two
tabs cannot disagree:

- Ticked: the design moves to the ink row and prints the ink panel's colours with
  its ink artwork. If the ink artwork is missing, that IS reported.
- Unticked: the design stays in the plain row and prints the plain panel's
  colours. That is a choice, not a defect, so it is never reported - and the
  box is the only thing that moves a design between the two rows.

**An empty panel is a blocked Create, not an automatic fix.** When a design's
own panel holds no colours it would create a product with no colours at all,
which Printify refuses. `emptyPanelProblems(plan)` names the design and the
panel ("…no colours are selected in the 'Has ink variants' panel of Colors…")
and blocks the Create button. Nothing is moved between panels automatically.

**`StudioDesignPlan.inkTicked` exists because `row` is not the tick.** The
`row` field is the DISPLAY row and falls back to `"plain"` when a ticked design
has no ink artwork to use, so the empty-panel message branches on `inkTicked`
(the user's actual tick), not on `row`.

**The partition's safe absorber prefers `main`, then `black`, then the last
group with variants.** `buildPartition` completes the partition over the whole
catalogue, so unclaimed variants land inside one group while staying disabled
(`is_enabled: false` via `resolveVariantIds`). An ink-ticked design's plan has
no `main` group (the panels are independent), so the absorber falls back to
`black` — never `white`, because white ink on a light garment is invisible and
must never be the group that swallows leftovers.

**The Colors tab shows the route, not just the marks.** "Where each colour
prints" (`data-ink-routing`) lists every ink-row colour with its Black ink /
White ink control and the design that will print it (`data-ink-route-to` =
`black` | `white` | `none`), named from the library: the pair's halves when the
colour is paired, otherwise the ink-ticked design that actually has that ink
artwork. An undecided colour says "No design yet — pick an ink" and is tinted
`warning-soft`, so a misroute is visible before Create. "Clear all ink marks"
clears ONLY the ink row. No arrow is inferred from lightness.

Three things were removed on purpose; do not bring them back:

- the product-driven split (`splitDesignsByProduct`), which moved designs
  between rows when the user changed the product;
- the one-click `coloursToMoveToPlain` fix, which silently rewrote the
  user's colour groups; and
- the automatic ink assignment — guessing an ink when a colour is clicked and
  re-balancing the lists on load. Both decided a colour's design on the user's
  behalf, which is exactly what sent a colour to the wrong artwork.

### Pairing two uploaded designs as ONE listing

`session.inkPairs` holds the pairs. There are TWO ways to pair, and they share
one function:

- the **ink row** offers **"Pair these two as one listing"** as soon as exactly
  two ink-ticked designs are unpaired - the user's own gesture (tick "Ink
  variants" on both) and the one that is visible without touching the batch
  checkboxes; or
- tick exactly two designs and press **"Pair for one listing"** in the
  selection bar. That bar is hidden until something is selected, which is why
  the row button exists.

The first design becomes the **black-ink** half and owns the listing (title,
price, placement), the other the **white-ink** half. Pairing also adds both
halves to the batch scope, because a pair IS a listing - leaving one half out
of the scope would create nothing for the other. Each card then names its
partner and shows a **Black ink / White ink** box, because which design is
which is the user's decision, not a guess.

- The black-ink design prints the plain colours AND the colours marked for
  black ink; the white-ink design prints the colours marked for white ink.
  Together they cover every DECIDED colour exactly once
  (`pairedColourGroups` and `planPairedDesignColours` in `design-colours.ts`).
  A colour in neither ink list is in neither half and blocks Create.
- **One pair = ONE product.** The partner is excluded from the product loop,
  so it never creates a listing of its own.
- Both designs must be ticked for the batch: a half-pair is left as two
  ordinary designs instead of being guessed at.
- A design can only be in one pair (`withInkPair` replaces an old pair), and
  unticking either half, or **Unpair**, breaks it and moves both back to the
  no-ink-variants row.
- Pairing is additive: a design's OWN white/black ink files still work for
  designs that are not paired, and no AI or automatic split is involved.

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
- **The preview is clipped to the print area.** The artwork layer sits inside
  an `overflow-hidden` wrapper, so a tall design (or a scale above 100%) is
  cut at the dashed frame instead of painting over the panel's controls -
  the same crop Printify applies. The rotation handle is clamped inside the
  preview for the same reason; it used to sit beyond the artwork's edge and
  could land off the dialog entirely. Covered by `e2e/ink-pairs.spec.ts`.

## Print areas (the Mockups tab)

The Mockups page has two tabs in its upper section: `Mockups` (the library)
and `Print areas`. A **print area** maps a REAL Printify print area onto a
mockup photo, so the mockup shows what the product actually gets.

- `src/lib/mockups/print-area.ts` is the pure core: the frame maths, the
  composed mapping between Printify's placement and the mockup's `Transform`,
  the area list derived from the catalogue, the physical sizes, and the
  template payload. No DOM, no React, no IndexedDB - so it is unit-tested on
  its own.
- `src/lib/mockups/render-plan.ts` is the ONE resolver for a render. It takes a
  single mockup snapshot and returns the placement, transform AND clip, so the
  preview, Save render, batch renders, listing renders and the agent cannot
  disagree about which frame was on screen. Callers pass `clip: plan.clip ??
  null`; `null` is authoritative ("no area"), while `undefined` would make the
  compositor re-read storage.
- `src/lib/mockups/propagate.ts` owns applying one area to many mockups. The
  default inside a design tab is **All mockups of this type** — the workflow is
  "place it on one photo, save, next design" — and "This mockup only" and "All
  mockups" are explicit choices. When copying, the frame, size, source, label,
  clip mode AND the visible window (crop) travel; only the garment reference
  (the inches measurement) stays per photo, because a line drawn across one
  garment says nothing about another photo. A whole-area save clears a
  sibling's stale crop — that is what "crop follows the frame" means. A
  mockup uploaded LATER starts with no area; one re-save on any sibling of
  its type brings it in line.
- `src/components/mockups/print-area-canvas.tsx` is the Konva canvas (lazy
  loaded). `src/views/mockups/print-areas-tab.tsx` is the screen.

**The workspace is organised as one TAB PER DESIGN** — small numbered pills
(1, 2, 3…), oldest design first so **tab 1 = the first uploaded**, matching
the Studio's design order and the product-creation loop. The design NAME
lives in the tab's tooltip/`aria-label` (tests and screen readers address
tabs by name) and the active design's name shows in the context line above
the canvas — the only place it is visible. The searchable `DesignPicker`
dropdown these replaced was deleted. Everything in the tab — canvas, frame,
controls, renders — is that design only:

- **The area itself is per design too.** `Mockup.designAreas?: Record<string,
  MockupPrintArea | null>` is the override model. `printAreaOf(mockup,
  designId?)` is the single resolver: an existing key wins (`null` means
  "this design deliberately has no area"), a missing key falls back to the
  shared `printArea`. Saving in a design tab writes only that design's
  override and never touches the shared base or another design's entry.
  Every path that renders must thread the design id - the tab preview, Save
  render, Render on every mockup, the batch runner and the agent tools - and
  Save render / Render everywhere persist the draft first, then recompute the
  fingerprint from the SAVED design-aware area. A mockup counts as mapped when
  the shared base exists OR any override is non-null; the Listing images tile
  label asks `printAreaOf(mockup, listing.designId)` for the same reason.
- A design owns ONE placement in the Studio (`placements[designId]`, falling
  back to `universalPlacement` until it is first edited). Every mockup with a
  print area uses that same placement inside its own frame, so the design
  lands at the same relative spot on every photo. Editing design A never moves
  design B, and there is no universal placement mode. The Studio's Design
  panel and these tabs show the SAME placement, live, from the shared session.
- The frame save defaults to **All <category> mockups**, so "adjust on one
  mockup, hit Save, next tab" leaves the whole type consistent. This reversed
  an earlier per-mockup default — deliberately.
- **Render on every mockup** renders the tab's design onto every mockup that
  HAS a print area, skipping the rest (named in the toast). It resolves each
  target through `resolveRenderPlan`, so the set is pixel-identical to the
  preview and to a single Save render.
- The active tab and mockup are remembered in the session
  (`mockupsActiveDesignId` / `mockupsActiveMockupId`, validated on load), so a
  reload resumes the same design-by-design pass. An explicit "Set the print
  area" from a library card still wins over the memory.
- `Set as the placeholder for all designs` is the explicit bulk action: it
  makes the placement on screen the shared default and clears per-design
  overrides. "Fit to area" writes only the picked design.

Saves are debounced; leaving the panel or switching mockups flushes a pending
draft. Every pending draft carries its own `mockupId` + `designId`, and a
`draftOwner` guard refuses to arm the previous tab's area under a newly selected
one. **Remove area cancels the live debounce before writing the `null`
override** - otherwise the timer's closure could silently save the removed area
back on the next tab switch or page unload. The session is read with a LIVE
query, so a placement written in the Studio or by the agent appears here without
a reload. Repeated saves reuse one toast id instead of stacking identical
notifications.

**The print area is a FRAME that carries the design.**
That is the whole design, and it is deliberate:

- The frame is moveable, uniformly scalable and rotatable on the photo. The
  design sits INSIDE the frame in the frame's local space, so moving,
  scaling or rotating the frame moves, scales and rotates the design with it.
- **The design is NOT moveable in the mockups tab.** Its placement belongs to
  the Printify Studio: `StudioPlacement.scale` = artwork width / area width,
  `x`/`y` = the artwork's CENTRE in the area, `angle` = its rotation. Nudge
  it in the Studio, not here.
- The frame's transform is **staging only**: it is the garment's pose on the
  photo. It changes no product and no print file - `print-file.ts` renders
  from the Studio placement alone.
- The frame's aspect is ALWAYS the area's aspect. It is stored as fractions of
  the photo (`x`, `y` = centre, `scale` = width / photo width, `rotation` in
  degrees), so it survives a resize and travels as a template.
- The frame's rotation composes with the Studio's angle: the drawn rotation
  is `frame.rotation + placement.angle`. `studioPlacementFromTransform` takes
  the frame back off when a transform has to become a Studio placement.
- **The design is clipped to the frame** - in the preview, every batch render
  and the export. Cut is `clipFor(...)` -> a centre + size + rotation, consumed
  by `compose.ts` (`translate -> rotate -> rect -> clip`).
- **A mockup can show only PART of the area: the crop.** A shirt photographed
  folded hides the bottom of the print area, so `MockupPrintArea.crop` is the
  window (`x`, `y`, `width`, `height` as fractions of the area) the design is
  allowed to paint on. The area itself is unchanged and `print-file.ts` still
  renders the whole 4500 x 5400 - that is what Printify prints. `clipFor`
  returns the WINDOW's centre + size + rotation, so the preview, every batch
  render and the export all cut at the fold with no extra code;
  `cropLocalRect` feeds the Konva group's clip, and `areaPointInMockup` /
  `areaPointFromMockup` convert between mockup pixels and area fractions so
  the window's handles stay right at any angle. Absent = whole area, and
  `normalisePrintArea` drops a window that covers everything.

**The right-hand panel is deliberately small.** The mockup's TYPE is already
known from the Mockups tab, so there are no blueprint / print provider /
position pickers here:

- **Print area**: the size and aspect, where it came from ("The Studio's
  product · front", a preset, or custom), a `Use the Studio's area` button
  that reads the exact catalogue placeholder of the product selected in the
  Studio, and a `Typical size for a T-shirt / hoodie / mug ...` dropdown
  driven by the mockup's category (`src/lib/mockups/categories.ts`,
  `presetsForCategory`). Exact size wins over typical size.
- **Visible window** (the crop): `Whole area` / `Top half` / `Top 60%` and a
  `Crop` mode where the window is moved and resized on the photo with eight
  handles (four corners, four edges). The design is cut at the window's edge;
  the readout names it ("Top 60% of the area").
- **Garment reference**: collapsed until asked for. A line drawn across the
  garment plus a real width in inches gives the photo a scale, and the app
  reports the area's and the design's printed size in inches.
- **Compositing**: clip to area, or draw under a transparent mockup PNG.
- **Reuse**: print-area templates, the print-file export, and **Save render** -
  which composes the design onto the mockup through the batch engine's
  `renderComposition` and stores it as a `mockup-render` asset for the Export
  Center. It is the same call the agent's `create_mockup_render` makes, so a
  saved render and an agent render are pixel-identical, and it clips to the
  print area and its window.
- `Set as the placeholder for all designs` promotes the placement currently on
  screen into the Studio's shared default placement AND drops the per-design
  overrides, so every design starts at that one spot inside the area. Editing a
  design afterwards gives that design its own placement again.

**Traps in this feature:**

- **Konva's pointer is in CANVAS pixels, not mockup pixels.** The stage is
  scaled down to fit the panel, so every pointer reading must be divided by
  `displayScale` before it is compared with anything in the mockup's space.
  This bug made the rotate handle jump and the measure line miss.
- **Konva's `Transformer` is what makes the frame draggable,** so its
  `shouldOverdrawWholeArea` overlay sits on top of the artwork and swallows
  the artwork's own click. The chrome toggle is therefore handled at the
  STAGE level: a click whose target is the stage hides the chrome, anything
  else shows it. A click handler on the artwork never fires.
- **The rotate handle is ours, not the Transformer's.** `rotateEnabled` is
  off; a `Circle` above the frame's edge (30 screen px, i.e.
  `30 / displayScale` stage units) turns the group around its centre. Konva's
  own rotate anchor is a wedge that is fiddly to hit in a test and in the
  hand. The knob is 16 screen px across and carries `hitStrokeWidth`
  (30 screen px), so the grabbable area is much bigger than the painted dot -
  at radius 6 px it was technically present and practically impossible to
  catch. Its drag maths only reads the POINTER's angle around the group's
  centre, so widening the hit area changes nothing about the rotation.
- **The rotate handle lives in its OWN layer, painted last.** Inside the
  frame's layer the artwork sat over it, and the Transformer's
  `shouldOverdrawWholeArea` overlay (a transparent rect) sat over it too and
  ate the clicks. The knob's layer comes after the Transformer's, and it is
  moved by hand (`syncRotateHandle`, called from `syncFrame`, the frame's
  `onDragMove`, `onTransform` and its own drag) because react-konva will not
  follow the frame's imperative transform for it.
- **The stage is FOUR canvases**: photo, frame (the clipped design), the
  Transformer's chrome, then the knob + crop window. The e2e reads the
  Transformer's layer as `layers[2]` (the chrome-ink test) and the knob's as
  `layers[3]`; keep that order.
- **The handle must stay on the photo.** Above the frame's top edge is the
  default; it flips below when that would land off the top of the photo, and
  its final position is clamped onto the photo (`rotateRadius + 8` screen px
  from each edge). A large frame otherwise puts the knob off-canvas, where it
  is invisible and unclickable.
- **The crop is a CLIP, not a re-placement of the design.** A window that
  excludes the design's centre shows the design cut, not re-centred: the
  Studio's placement is the single source of truth for where artwork sits.
- **The crop's clip goes on an INNER group.** On the frame's own group it
  would also clip the frame's dashed outline and the handles at its edge, so
  the user would lose sight of the area the print file really uses.
- **In Crop mode the Transformer is detached** (`transformer.nodes([])`), or
  its overdraw overlay swallows the window drags. The frame is not draggable
  in that mode either, and a stage click must NOT toggle the chrome there -
  the crop's handles are the tool.
- **`compose.ts`'s clip rectangle is CENTRE-based,** like `clipFor`. When it
  was briefly treated as a top-left, the design was cut to a quarter of the
  area. The path restores the canvas transform after `clip()`, or the design
  is drawn rotated by the clip.
- **The clip transform must be undone in REVERSE order.** `drawPlacement`
  applies `T(c)·R(φ)` to build the clip, so the inverse is `R(−φ)·T(−c)`.
  Undoing it as `T(−c)·R(−φ)` leaves `T(c − R(φ)·c)` behind — a pure
  translation of `2·|c|·sin(φ/2)`, measured from the PHOTO's origin, not the
  frame's centre. At 4° that is ~50 px on a 1000 px mockup, which is exactly
  the "design slid slightly right" report: the Konva preview was right and
  every saved render was wrong. It cannot be a `save()`/`restore()` pair,
  because `restore()` pops the clip with the transform. `tests/draw-placement.test.ts`
  pins the CTM the design is drawn under, for several clip rotations.
- **react-konva re-applies props on every render.** The group's position,
  rotation and scale, the artwork's geometry and the handle's position are
  all set IMPERATIVELY; only committed values (the frame's size) come from
  props. A prop on a dragged node snaps it back.
- **A Konva clip on a `Group` clips in the group's local space,** which is
  what makes the frame's clip turn with the frame. `clipFunc` on an
  untransformed group was used by the editor for a rotated, centre-based clip;
  the editor is gone, but `compose.ts` still cuts at the same rectangle.
- The design's pixel size is NOT needed for the mapping: Printify scales
  artwork uniformly, and the renderer preserves the artwork's own aspect.
  Only the area's size and the frame matter.
- `StudioPlacement.scale` may exceed 1 (the artwork is wider than the area
  and gets cropped). The Studio's width slider used to stop at 100% and had
  to be raised to 200%, or the mockups tab could set something the Studio
  could not show.
- **A new lazy chunk means a stale Vite optimiser.** Adding
  `print-area-canvas.tsx` as `React.lazy` gave `504 (Outdated Optimize Dep)`
  and the whole React tree unmounted (a blank page). Restart the dev server
  and delete `node_modules/.vite`; a cold cache then reloads once per
  discovered dep, so warm the routes before trusting a first e2e run. The
  suite only passed reliably with a server started outside Playwright and
  left running (`reuseExistingServer: true`).

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
4. **Cloudflare redirects directory-like routes to a trailing slash.**
   `/mockups` → `/mockups/` and `/autopilot` → `/autopilot/`. `astro dev` does
   not. Any URL assertion must tolerate an optional trailing slash.
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
- **Eight screens were removed on purpose**, and what they did is now either in
  a surviving page or gone: Designs → the Studio's Designs tab; the editor's
  free canvas → the Studio's placement panel; Batch Studio → the agent's
  `create_batch_job` plus **Save render** in Mockups → Print areas; Templates →
  print-area templates; Product Builder → the Studio's Design panel; Listings
  and AI SEO → the agent's `draft_listing`. Their engines
  (`lib/batch/runner.ts`, `lib/canvas/compose.ts`, `lib/printify/*`,
  `lib/client/tools.ts`, all thirteen `/api/*` endpoints) are untouched, because
  the UI and the agent still call them. Accepted losses: there is no batch-job list
  screen (the renders land in the Export Center, and a batch row in the artifact
  rail is inert) and no free-form canvas editor.
- **API keys are optional and user-supplied.** A visitor can paste their own
  Printify / AI keys in **Settings → API connections**; they are stored in that
  browser's IndexedDB (`settings` table, key `integrations`) and sent per-request
  as `x-printify-key` / `x-printify-shop` / `x-ai-provider` / `x-ai-key` /
  `x-ai-base-url` / `x-ai-model` headers. `src/lib/server/creds.ts` prefers the
  browser value and falls back to a server secret, so nothing breaks when
  neither is set. **The saved `printifyShopId` is part of that record** and is
  what the Settings dropdown, creation, Send and Publish share; it is validated
  as a positive integer on load and when it arrives on the wire. The
  server never stores a user's key. Preview deployments can also set secrets with
  `npx wrangler secret put PRINTIFY_API_KEY` (and/or `AI_API_KEY`). With no keys
  anywhere, every integration endpoint returns 503 before doing work, and a key
  Printify REJECTS is reported the same way: `/api/printify/catalog` maps an
  upstream 401/403 to **503** with `configured:false` and a message naming the
  rejected key. It used to be a bare 502 `"Unauthenticated"`, which made a stale
  key indistinguishable from Printify being down (a production e2e run caught
  exactly that). Note the catalogue itself is cached per URL at the edge without
  the key, so a cache hit can still answer 200 while the key is rejected — the
  data is public and identical for everyone, so that is not a lie about the key.
- **The live Worker's `PRINTIFY_API_KEY` is currently REJECTED by Printify**
  (401 `Unauthenticated`, verified Oct 2026 with a cache-busting catalogue
  request). `/api/integrations/status` still reports `configured: true` because
  that only means a secret is present. The catalogue can still answer 200 from
  the edge cache, so the Studio looks healthy, but every real Printify call
  (print providers, variants, product creation) fails until the secret is
  rotated with `npx wrangler secret put PRINTIFY_API_KEY`. A visitor can also
  paste their own key in **Settings → API connections**.
- **The mockup-selection write is proven by contract, not by a live session.**
  The upload endpoint, the BFF GET/PUT shape, the replacement/merge body and
  the bookmarklet are implemented and unit-tested, but CI has no Printify web
  session. Run the bookmarklet once on a throwaway product before trusting it
  for a batch, and check that Printify's generated mockups are gone. Also
  rotate any Printify token that was pasted into a chat; treat it as exposed.
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
  isomorphic registry of fourteen tools. Six are read-only: `explain_howto`,
  `summarize_workspace`, `list_library` (designs/mockups by name),
  `browse_printify_catalog` (product types / print providers / variants),
  `draft_listing` (calls the existing `/api/ai/seo`), and `etsy_research`
  (API first, browser-extension fallback). Eight write: `create_batch_job`,
  `create_printify_product`, `create_mockup_render`, `save_placement`,
  `create_ink_variant`, `remove_background`, `save_chat_image`, and
  `save_listing_details`.
  **Every local write runs immediately; only `create_printify_product` needs a
  click.** `executeTool()` (in `src/lib/client/tools.ts`) runs the propose step
  to VALIDATE the arguments, then — for every tool except the one in
  `CLICK_GATED_TOOLS` (`create_printify_product`) — immediately calls its
  `CONFIRM_TOOL_RUNNERS` entry with the proposed payload and returns the result.
  The user's own words ("save the price", "remove the background") are the
  approval. Printify product creation is the exception because it uploads
  artwork and spends the operator's key, so it still returns a pending
  `confirmation` for the tool card's Create button. The transcript shows an
  **Approve all** button when two or more Printify confirmations are pending,
  so a bulk turn is one press instead of N identical clicks. `save_listing_details`
  is the write counterpart of `draft_listing`: it writes the title, description,
  tags and/or price into the local `listingDrafts` (and `session.listingPrices`
  when a price is present), so the agent can actually change what will be sent,
  not just return copy ideas. `routeIntent()`'s keyword fallback routes
  save/set/update/update-style phrasing to `save_listing_details` (extracting a
  price and any clearly-quoted title) and keeps `draft_listing` for ideation
  only, so a "save my listing" request reaches the tool that writes. `etsy_research` tries `/api/etsy/research` first
  and only falls back to the extension when that endpoint is missing or fails. `create_printify_product` auto-resolves the blueprint
  from a product type (catalog keyword search), then a print provider and up to
  100 variants, but never invents ids — with no product type it asks. `create_ink_variant`
  and `remove_background` reuse the Studio's own canvas code
  (`createInkVariantBlob`, `removeBackgroundAuto`); `create_mockup_render` reuses the
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
  Studio's Design panel collects a price and print provider, and artwork is downscaled
  to fit an **8 MB** upload cap (base64 inflates ~33%). A live run created
  product `6ad322422a5e991891032a2b` (blueprint 6, provider 30, 100 variants,
  visible, 666 auto-generated mockups), so the path is proven end to end.
- **Printify caps a product at 100 enabled variants.** Sending more fails with
  code `8251` / "Too many variants enabled. Maximum allowed: 100". The client
  default-selects the first 100 (`MAX_VARIANTS` in `src/views/studio/colors-tab.tsx`),
  the `All` button stops at the cap, the Create button disables past it, the
  `create_printify_product` tool sends at most 100, and
  `src/pages/api/printify/products.ts` rejects a larger payload with 400 before
  calling Printify. Selecting all 132 variants is what surfaced this.
- **Printify's gateway has returned a bare 502 on a large upload that a retry
  then completed** (128 s failed, 13 s succeeded). `request()` in
  `src/lib/server/printify.ts` now retries a dropped connection or
  502/503/504 only for replay-safe methods (`GET`/`PUT`/`DELETE`). A `POST`
  may already have been applied even when the response was lost, so replaying
  it can create duplicate uploads or mockups. A `429` is still retried for
  every method because that request was not processed. The old "the body is a
  string, so replay is safe" note was wrong for POST.
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
- **Etsy *research* is built; Etsy listing *submission* is still deliberately
  not implemented.** The preferred path reads active-listing data with a
  developer keystring (API v3, no OAuth) and uses it to ground copy. When no key
  is configured, or Etsy rejects it, the agent's `etsy_research` tool falls back
  to the companion extension: the extension opens the public
  `etsy.com/search?q=...` page in a background tab in the USER'S browser, reads
  the listing cards, and returns titles/prices/URLs. That path cannot read tags,
  so it returns `topTags: []` and says so; nothing is scraped server-side, and
  no Etsy credential or query reaches Mockup Studio's server. The query is
  extracted from the request (`etsyQueryFromText`), so "research Etsy for cat mug
  keywords" searches `cat mug`, not the whole sentence; a request with no
  searchable words falls back to `trending`. The extension polls the tab (up to
  six checks), scrolls between attempts to mount lazy cards, stops early on
  Etsy's own no-results page, and reports page diagnostics (title, URL, anchor
  counts, a short page-text sample) instead of a bare "no cards". An old
  extension build is reported as "reload" immediately rather than waiting 45 s
  for a reply it cannot send. It does not create
  an Etsy listing or connect an Etsy shop, because v3 submission needs OAuth app
  registration. Settings shows the keystring card **enabled** with a Test
  research button; the card says read-only and never implies that research is a
  search-volume or sales report.
- **Background removal is local and deliberately limited.** It handles a
  solid or faded backdrop; a busy photographic background has to be cut out
  before upload. There is no AI model and no hosted service, so there is
  nothing to configure and no usage limit.

## Git

History is intact. The eight removed screens were folded into the surviving
pages in `b962c92 feat: consolidate the app around the Printify Studio`. Everything before
it — the foundation, the Astro migration, live Printify product creation, agent
M1–M4, and the mockup print areas — is still in the log, which is where the
reasoning behind the domain layer lives.

Do **not** touch `adityadino678-ai/mockup-studio`. It is a *different* project (a
Vite SPA using `@imgly/background-removal` and `onnxruntime-web`, with branches
`main` and `redesign/clean-studio-ui`). This project lives in
`mockup-studio-finale`. There is also a separate private `Mockup-studio-3.0`.

## Prior work on this project

`PROGRESS.md` holds the original build log (Next.js phases 1–7: foundation, batch
studio, templates/export, Printify/Etsy/AI routes, test suites). It predates the
Astro migration but documents why the domain layer looks the way it does.
