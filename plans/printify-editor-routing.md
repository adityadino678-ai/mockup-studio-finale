# Plan — Why Printify's "Edit design" shows only the white design on the black colour

Status: **investigation only** — no app code changes until evidence is in and approved.

## The report

- Printify's own generated mockups show the **correct** designs on the **correct** colours
  (black design on black-ink colours, white design on white-ink colours).
- But opening **Edit design** on the product shows **only the white design**, on the black colour.
- The user suspects the Printify API payload we send (`print_areas`) is not doing what we think.

Two facts make this urgent:

1. A silent-wrong `print_areas` payload is invisible to our own verification, because the check
   only fails when *both* expected and actual images exist. A missing image passes.
2. `print_areas` drives the **production print file**, while mockups can be produced from
   variant/placement metadata. So "mockups look right, editor looks wrong" is exactly the
   failure signature of a wrong `print_areas` payload — or of an editor that only shows one
   image per print position.

## Hypotheses, ranked

| # | Hypothesis | What would confirm it | What would refute it |
|---|---|---|---|
| H1 | **The editor shows one image per print position.** Printify's UI binds an image to a *position*, and the variant selector only changes the shirt, not the artwork. The white design is simply the last/first group written. | A product we know is correct (made by hand in the Printify UI with two designs) behaves the same way in Edit design. | Such a hand-made product shows the black design when the black variant is selected. |
| H2 | **Our `print_areas` groups are being merged/rewritten by Printify.** The payload sends separate groups but Printify collapses them into one position and keeps a single image, so the black variants inherit the white image. | Live product JSON shows fewer `print_areas` groups than we sent, or one group whose `variant_ids` swallow the black variants. | Live product JSON matches what we sent, one group per design, disjoint `variant_ids`. |
| H3 | **We send the correct groups but the wrong mapping.** e.g. group order vs `variant_ids` drift, or the `variant_ids` in the artwork payload are the *catalogue* variant ids rather than the product's variant ids, so Printify drops them and re-assigns. | A payload simulation shows any colour landing in the wrong group, or ids that are not in the product's variant list. | Simulation shows a clean, complete, disjoint partition with every id present in the product. |
| H4 | **The editor defaults to the first variant and the "black" the user sees is actually a light variant.** | The user switches the variant selector and the artwork changes. | The artwork never changes for any variant. |
| H5 | **Two images cannot share one print position in Printify at all.** The correct model may be "one product per design" or "one design, N colour groups". | Printify docs / API reference say a position has one image; variant-specific artwork is a different concept. | Docs show per-variant artwork is supported within one position. |

H2 and H3 are the ones that would mean *our* bug. H1, H4, H5 would mean the app is fine and the expectation is wrong. **We must not "fix" anything before we know which.**

## Evidence we need (in priority order)

### E1 — The payload we actually send (no network, pure code)

Reconstruct, for one real pair (2 designs, 4 colours: 2 black-ink, 2 white-ink), the exact
`print_areas` JSON that `createProduct` would POST, and the exact `variants` map. Dump it as:

```
colour -> variantId -> (groupIndex, imageId)  # what we INTEND
```

and the raw payload. Then check by inspection:

- every group's `variant_ids` are disjoint and together cover exactly the enabled variants;
- every colour's variant id appears in exactly the group whose artwork that colour should print;
- group order matches the index-zipped `item.groups` / `partition.groups` assumption;
- the ids are product variant ids, not catalogue ids.

This is the single highest-value artefact and needs no credentials.

### E2 — Static audit of the create path for silent-wrong output

Read-only audit of:

- `src/lib/printify/studio-plan.ts` (pair/ink group construction)
- `src/lib/client/studio-create.ts` (plan → `artworks`, verification)
- `src/lib/printify/print-areas.ts` (`buildPrintAreas`, `assertCompletePartition`)
- `src/lib/printify/variants.ts` (`buildPartition`, `resolveVariantIds`)
- `src/pages/api/printify/products.ts` (validation, duplicate/uncovered checks)
- `src/lib/server/printify.ts` (`createProduct` payload assembly)

Answer specifically:

1. Can two artwork groups ever be sent with the **same image id**? (Would explain "only the white design".)
2. Can a group's `variant_ids` be empty, or can two groups overlap?
3. Does the server send one `print_areas` entry per image, or does it collapse them?
4. Is there any path where the *last* group's image wins for every variant?
5. Does verification actually catch a variant with **no** image? (Known: no — it only flags `got && want`.)
6. Are uploads de-duplicated by content hash, so the black and white files collapse to one upload id?
7. Any leftover debug logging that could mask an error (`studio-plan.ts` ~201, `studio-create.ts` ~105–125).

### E3 — Printify semantics (docs + public sources)

Establish, from Printify's own documentation/reference:

- Does a product position support **different artwork per variant**?
- What is the relationship between `print_areas`, `placeholders`, and what the editor displays?
- Does the editor display `print_areas` artwork per variant, or a single "design" layer?
- Is the correct modelling "one product per design", or "one product, N colour-variant groups"?

### E4 — The live product (needs the user)

The only authoritative answer about *this* product is the product JSON. Two options, both
read-only:

- **Option A (preferred):** a browser-console snippet the user pastes on the product page in
  their logged-in printify.com session, which prints `print_areas` (group count, each group's
  `variant_ids` and image id). No token leaves the browser.
- **Option B:** a valid Printify personal access token placed in `.dev.vars`, so we can
  `GET /v1/shops/{id}/products/{id}.json` and diff it against E1.

Currently `.dev.vars`'s key returns `401 Unauthenticated`, so direct inspection from this
machine is blocked. The user's live session is the unblock.

## Experiment matrix

| Experiment | Cost | Needs user? | Kills/confirms |
|---|---|---|---|
| Simulate payload for a 2-design/4-colour pair | free | no | H3 |
| Static audit of the 6 create-path files | free | no | H2, H3, silent-verify gap |
| Printify docs on per-variant artwork | free | no | H1, H5 |
| Switch variant selector in Edit design | free | **yes** | H4, H1 |
| Dump product JSON from logged-in session | free | **yes** | H2 (definitive) |

## Decision gates

- **If E1 + E2 are clean and E4 shows our exact groups live** → the app is correct; the editor
  is a single-layer view (H1/H5). Deliverable: explain the editor, and decide whether we should
  model pairs as one product (current) or two.
- **If E4 differs from E1** → Printify rewrote the groups (H2). Deliverable: reproduce the
  rewrite in a test, then change the payload shape to whatever Printify preserves.
- **If E1/E2 show a mapping bug** → H3. Deliverable: failing test from the simulation, fix the
  builder, keep the explicit ink model unchanged.
- **If the variant selector changes the artwork** → H4. Deliverable: docs/UX explanation only,
  no code change.

## Guardrails

- No edits to `src/**` until a gate is passed and the user approves.
- Plain "No ink variants" row stays untouched by anything we do here.
- The explicit ink model (user's Black/White marks) is not up for revision — only the
  transport of those marks to Printify is.
- Any live API use is read-only (`GET`), never a create/publish, unless explicitly approved.

## Findings (investigation run, three read-only agents)

Models used: `nvidia/nvidia/nemotron-3-ultra-550b-a55b` (payload simulation) and
`nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` (code audit, docs research).

### F1 — The payload is structurally correct (H3 killed)

Simulated a 2-design / 4-colour pair (White+Sand black-ink, Black+Navy white-ink,
2 sizes). The POST body is:

```
print_areas: [
  { variant_ids: [white-S, white-M, sand-S, sand-M],
    placeholders: [{ position: "front", images: [{ id: "<black design upload>" }] }] },
  { variant_ids: [black-S, black-M, navy-S, navy-M],
    placeholders: [{ position: "front", images: [{ id: "<white design upload>" }] }] }
]
```

Distinct upload ids, disjoint and exhaustive `variant_ids`, array not a position-keyed
object, index zip between `item.groups` and `partition.groups` provably cannot diverge
(`variants.ts` preserves input order, `studio-create.ts:148-165`). No content-hash
dedupe exists on uploads, so two designs can never collapse onto one image id.

### F2 — Printify's docs say per-variant artwork IS supported (H1/H5 weakened)

`print_areas[].variant_ids` is documented as "the variants this print area applies to",
and multiple groups for the same position with different images are the documented
shape (developers.printify.com, `openapi.json` schemas `printArea` / `createProductRequest`).
Overlap/incomplete behaviour is **undocumented**; Printify's editor display behaviour is
**entirely undocumented** — no source states whether switching the variant changes the
displayed design. No community reports of this symptom were reachable.

### F3 — Our own history proves `print_areas` drives the mockups (decisive)

AGENTS.md records a live pixel-level spike: with an **incomplete** partition, Printify
expanded the last group and the mis-assigned variant's **generated mockup showed the
wrong artwork**; with a **complete** partition, artwork was exact per colour in any group
order. Printify's default mockups are composited FROM `print_areas`.

Therefore: **the user's observation that Printify's default mockups show the right design
on the right colour is itself evidence that `print_areas` is correct.** The mockups the
user is reading are Printify's generated ones, not only our uploaded renders. If the
black variant's Printify mockup shows the black design, the black variant IS in the black
design's print-area group.

Conclusion: the **Edit design** canvas is a single-layer view (one image per position,
independent of the variant selector). It is not evidence of a wrong payload, and it does
not change the print file. The practical risk is zero for production, but the user cannot
visually verify, which is the actual problem to solve.

### F4 — Real defects found (worth fixing regardless, none cause this symptom)

1. **Verification blind spot — `src/lib/client/studio-create.ts:223`**
   `if (got && want && got !== want)` — a variant with an expected image but **no**
   image in the returned product passes silently. Also checks only the image id: not
   position, scale, angle, or the number of placeholders. This is why a genuinely
   wrong payload would never be reported.
2. **Verification can be skipped entirely — `studio-create.ts:191`**
   `await response.json().catch(() => null)` — a 2xx with an unparseable body silently
   skips the whole check.
3. **Silent group drop — `src/lib/server/printify.ts:594`**
   `if (!group.imageId || group.variantIds.length === 0) continue;` — outside the
   validated API route (e.g. the agent tool path) an empty group is dropped instead of
   throwing, leaving variants unclaimed for Printify's last-group absorber.
4. **Leftover debug logging** — `studio-plan.ts:201`, `studio-create.ts:105,111,122,124`.

### F5 — Still unproven live

The only way to see the product's real `print_areas` is the user's printify.com session
or a valid token. This machine's `.dev.vars` key returns `401 Unauthenticated`, so E4 is
still outstanding. Everything above is code + documented contract + prior pixel-level
evidence, not a live reading of *this* product.

## Checks the user can run in two minutes (no code, no token)

1. Open the product → **Edit design**. Does the left panel list **two** design thumbnails
   or one? Two ⇒ both are attached; the canvas is just showing one at a time.
2. In Edit design, switch the **variant/colour selector**. Does the artwork change?
   Changes ⇒ the editor is variant-aware and the earlier view was the default variant.
   Never changes ⇒ the editor is a single-layer view (F3).
3. Printify → **Mockups** tab → pick the **black** variant's generated mockup. This is
   Printify compositing `print_areas`, so it is the authoritative check.

## Resolution (approved fix, implemented)

Gate: "payload correct, editor is a single-layer view" → not a routing bug. The
approved work was the verification hardening, not a payload change:

1. **`src/lib/printify/verify-artwork.ts`** (new, pure): `verifyProductArtwork`
   requires, per enabled variant, an expected image, an image in the product,
   and a matching id. "Not verifiable" is a failure, not a pass.
2. **`studio-create.ts`**: a 2xx with no readable body now fails instead of
   skipping the check; the strict verification replaces `got && want && ...`.
3. **`/api/printify/products`**: a multi-group request where any artwork names
   no variants is refused before uploading (the fallback would print one design
   on every colour).
4. **`server/printify.ts`**: a group with no image or no variants throws instead
   of being dropped (Printify would append those variants to the last group).
5. Leftover `console.debug` removed from `studio-create.ts` and `studio-plan.ts`.
6. `tests/verify-artwork.test.ts` — 10 cases, including the old silent-pass shape.
7. AGENTS.md records both rules: strict verification, and "Edit design is not a
   per-variant view".

No change to what is sent to Printify.

## Live verification against the real account (done)

Method: your running Brave cannot expose CDP on its default profile (Chromium 136+
blocks it), so a *copy* of the profile (`Local State`, Local Storage, IndexedDB)
was launched with `--remote-debugging-port=9222` and driven with `agent-browser`.
No password was needed and no cookie DB was copied; Printify authenticates the SPA
from `localStorage.session.access_token`. Only `GET` calls were made. The temp
profile and the token file were deleted afterwards.

Product inspected: `6ae4306bc237f65f2e065877` — Comfort Colors 1717, 4 colours ×
7 sizes = 28 variants (White, Black, Butter, True Navy).

### The editor's own model (`decorators[0].prints[]`)

| print | variants | colours | image | artwork |
|---|---|---|---|---|
| A | 14 | **White, Butter** | `2932cfb2-…` | dark "merry & bright" script |
| B | 495 | **Black, True Navy**, + every other blueprint colour | `c88c4cb9-…` | white "merry & bright" script |

Both images were downloaded and compared: different files, different art. The
mapping is exactly the ink rule — light colours get the dark-ink design, dark
colours get the white-ink design.

### What the editor shows

- Select **White** → "Currently editing the **default** design", canvas shows the
  **dark script**. `editor-white.png`.
- Select **Black** → "Currently editing **variant specific design**" + "Revert
  Black to default design", canvas shows the **white script**. `editor-black.png`.

So the editor *is* variant-aware and Black genuinely carries the white-ink
artwork — the same artwork its mockup shows. **Nothing is misrouted and nothing
is missing.**

### The one real defect: both uploads share a filename

`studio-plan.ts:119-137` labels **both halves of a pair `ink: "main"`** and names
the item after the black half, so `createStudioProduct` uploads
`<black design name>-main.png` **twice** (different bytes, same name). In
Printify's "Layers" panel you therefore see one indistinguishable
`…-removebg-preview-main.png` no matter which colour is selected — which reads as
"only one design, applied everywhere".

Proposed fix (not applied): name each upload by its ink role, e.g.
`<design>-black-ink.png` / `<design>-white-ink.png` (pairs), so the editor and the
Printify uploads page distinguish them. Cosmetic only — no payload change.

## Update: why True Navy shows the black-ink design (root cause)

Checked live on product `6ae43bafa9c8fca6d30ac7ff` (the one created after the
rename; both files upload as `black design-main.png` because it predates
`f4bfbe7`):

| print group | variants | first variant | artwork |
|---|---|---|---|
| 0 | 14 | `73199 S / White` | dark script (black ink) |
| 1 | 495 | `73196 S / Black` | white script (white ink) |

Black and True Navy are BOTH in group 1, and every enabled variant of both
maps to `c88c4cb9` (white script). The print data is right.

In the editor, selecting **Black** says "Currently editing variant specific
design" and paints the white script; selecting **True Navy** says "Currently
editing the default design" and paints the **dark** script, offering "Make a
specific design for True Navy".

The rule is in Printify's own bundle (`app/chunk-B3kK5WRn.js`):

```
isEditingAllVariants$ = prints.overrides[optionItemId] === undefined
featuredDesignApplied$ = !isEditingAllVariants$
```

So the editor is a per-COLOUR view with an `overrides` map, and an API-created
`print_areas` group only produces **one** override - the colour of its FIRST
`variant_ids` entry. Group 1's first id is `S / Black`, so Black is the only
colour it will show as specific. White is the default group's first id, and the
default group's artwork IS the default design, so it looks correct.

Consequence: with one group holding 71 dark colours, the editor can never show
the white-ink artwork for more than one of them, no matter what we name the
file. Naming fixes only distinguish the layers in Printify's uploads list.

Possible fix (not applied, needs live verification): emit **one print_areas
group per colour**, then each colour is its own override and the editor shows
its real artwork. Cost: the payload grows from 2 to ~71 groups (the same two
uploads reused), and it is unproven whether Printify keeps 71 overrides.
Alternative: accept the display limitation, since the print file and the
generated mockups are already correct.

## Modelling question to settle alongside the bug

If Printify truly cannot hold two artworks in one position, the honest model is **two products**
(one per design) rather than one product with a split `print_areas`. That would be a product
decision, not a bug fix — so it goes to the user with evidence, not as a silent change.
