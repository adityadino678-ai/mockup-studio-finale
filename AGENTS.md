# AGENTS.md — Mockup Studio

Operating notes for this project. Read this first; it records decisions that are
not obvious from the code.

## What this is

A local-first print-on-demand workspace for sellers: upload artwork, place it on a
real Printify print area, map that area onto mockup photos, generate renders,
create ink variants, remove backgrounds, and export verified ZIP archives.

There are **seven pages** — `/` (a static redirect to the Studio), Printify
Studio, Mockups, Export Center, Agent, Activity, Settings. The Designs, editor,
Batch Studio, Templates, Product Builder, Listings and AI SEO screens were folded
into those pages or removed; their engines (batch runner, compositor, Printify
core, agent tools) are still here and still what the UI and the agent call.

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
npm run test          # 321 unit tests
npm run test:e2e      # 23 acceptance tests (local dev server)
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
- **7 static pages + 9 on-demand endpoints.** No page depends on request state,
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
   fifty products. Created products are also written to `productDrafts`, so the
   Agent's artifact rail and the Export Center can see them.

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

## The ink split is the user's tick, not a guess

`src/lib/printify/design-colours.ts` owns this. A product has ONE set of
colours, split into two groups: `plain` (one artwork) and `ink` (the ink
artwork, black on some colours and white on the rest).

WHICH design is printed with the ink artwork is the user's decision, stored
as `session.inkPairIds` and set by the **"Ink variants" checkbox on every
design card** - the Designs tab and the Design panel draw the same card, so
the two tabs cannot disagree:

- Ticked: the design prints its ink artwork on the ink colours and its main
  artwork on the plain ones. If the ink artwork is missing, that IS reported
  ("this design has no white-ink artwork, so on Black and Navy it would print
  with the main artwork").
- Unticked: the design prints its main artwork on EVERY colour of the
  product. That is a choice, not a defect, so it is never reported - and the
  box is the only thing that moves a design between the two rows.

The rule that matters: **a design always covers every colour of the
product.** The old code took the design's colour set from the group its ink
assets happened to match, so a design whose group was empty printed on
nothing and the only clue was "132 variant(s) are not in any group".

Two things were removed on purpose; do not bring them back:

- the product-driven split (`splitDesignsByProduct`), which moved designs
  between rows when the user changed the product; and
- the one-click `coloursToMoveToPlain` fix, which silently rewrote the
  user's colour groups.

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
  black ink; the white-ink design prints the remaining ink colours. Together
  they cover every colour exactly once (`pairedColourGroups` and
  `planPairedDesignColours` in `design-colours.ts`).
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
- `src/components/mockups/print-area-canvas.tsx` is the Konva canvas (lazy
  loaded). `src/views/mockups/print-areas-tab.tsx` is the screen.

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
- `Set as the placeholder for all designs` drops the per-design Studio
  overrides, so every design lands at the Studio's universal placement.

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
4. **Cloudflare redirects `/mockups` → `/mockups/`.** `astro dev` does not. Any
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
- **Eight screens were removed on purpose**, and what they did is now either in
  a surviving page or gone: Designs → the Studio's Designs tab; the editor's
  free canvas → the Studio's placement panel; Batch Studio → the agent's
  `create_batch_job` plus **Save render** in Mockups → Print areas; Templates →
  print-area templates; Product Builder → the Studio's Design panel; Listings
  and AI SEO → the agent's `draft_listing`. Their engines
  (`lib/batch/runner.ts`, `lib/canvas/compose.ts`, `lib/printify/*`,
  `lib/client/tools.ts`, all nine `/api/*` endpoints) are untouched, because the
  UI and the agent still call them. Accepted losses: there is no batch-job list
  screen (the renders land in the Export Center, and a batch row in the artifact
  rail is inert) and no free-form canvas editor.
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
- **Etsy listing *submission* is deliberately not implemented** (the agent
  drafts copy to paste; the old validation module went with the Listings page)
  because v3 OAuth needs app registration.
- **Background removal is local and deliberately limited.** It handles a
  solid or faded backdrop; a busy photographic background has to be cut out
  before upload. There is no AI model and no hosted service, so there is
  nothing to configure and no usage limit.

## Git

History is intact. The eight removed screens were folded into the surviving six in
`9788f62 feat: consolidate the app around the Printify Studio`. Everything before
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
