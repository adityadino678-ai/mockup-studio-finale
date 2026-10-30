# One `print_areas` group per colour

## Why

Printify's editor shows a "variant specific design" for exactly ONE colour per
`print_areas` group — the colour of that group's first `variant_ids` entry
(verified live; see `plans/printify-editor-routing.md`). Today one group holds
70+ colours, so 69 of them display the default (black-ink) artwork even though
the print data is correct.

Fix: keep ONE uploaded image per artwork, but emit ONE `print_areas` group per
colour. Same upload, same position, same placement — only the grouping changes.

## Shape

Client sends one artwork entry per ink group, as today, plus an optional
`variantGroups: number[][]` that partitions its `variantIds` into the groups to
create:

```ts
{
  printAreaId: "front",
  variantIds: [/* every enabled variant of this artwork */],
  variantGroups: [[73199, 73203, ...], [73196, ...]], // one per colour
  base64, filename, placement
}
```

The endpoint uploads ONCE per artwork entry and emits one `printAreaGroup` per
inner array, reusing that upload's image id and the same placement. So:

- payload size is unchanged (no duplicate base64, no N uploads),
- the 24 MB total-upload cap still measures real uploads,
- `verifyProductArtwork` still sees one image per variant,
- no UI change, no per-colour placement, no extra tabs.

## Code

1. `src/lib/printify/variants.ts`
   ```ts
   export function splitVariantIdsByColour(index: ColourIndex, variantIds: number[]): number[][]
   ```
   Walks `index.variantIds`, keeps the intersection with `variantIds`, sorted,
   at most one array per colour. Pure.

2. `src/lib/printify/print-areas.ts`
   ```ts
   export function expandArtworkGroups(input: ArtworkGroup[]): ArtworkGroup[]
   ```
   Turns `{imageId, variantIds, variantGroups}` into one `ArtworkGroup` per
   inner array (same imageId). Falls back to the single group when
   `variantGroups` is absent. Pure; unit-testable.

3. `src/lib/client/studio-create.ts`
   Compute the per-colour split of `activeVariantIds` and send it as
   `variantGroups`. Skip the split when it yields a single colour (payload
   unchanged for one-colour products).

4. `src/pages/api/printify/products.ts`
   Accept `variantGroups`, validate that it partitions `variantIds` exactly
   (non-empty arrays, no duplicates, nothing missing, nothing extra), upload
   once, then push one printAreaGroup per inner array.

5. Tests in `tests/studio-printify.test.ts`
   - split by colour: 4 colours -> 4 arrays, each holding only its own enabled ids
   - sizes filter respected; unknown ids dropped
   - `expandArtworkGroups` keeps one imageId for every group and the same placement
   - a malformed split (missing/duplicate ids) is rejected
   - the create-request schema KEEPS `variantGroups` and `leftoverVariantIds`

6. `src/lib/security/validation.ts`
   The create schema is a zod object, which STRIPS unknown keys. Both new
   fields must be declared or they silently disappear between the browser and
   the endpoint — the first live run did exactly that and created one group per
   artwork instead of one per colour.

7. `src/lib/client/studio-create.ts` + `products.ts` — the leftover absorber.
   Printify appends every variant no group named to the LAST group. The app
   only names the ENABLED variants, so the disabled catalogue extras landed in
   the last colour group, where their lower variant ids put a disabled colour
   first (`Navy 73197` before `True Navy 79081`). The editor then showed the
   colour-specific design on Navy and True Navy fell back to the default —
   the exact bug we set out to fix.
   The client now sends `leftoverVariantIds` (every `allVariantIds` not
   enabled); the endpoint appends one trailing group naming them all, reusing
   the first group's upload, position and placement. No extra upload, no extra
   base64.

## Verification (done, live, Oct 2026)

Throwaway product `6ae451fe683aa56b73075c37` (blueprint 706 / provider 99,
White + Butter = black ink, Black + True Navy = white ink), created through
`POST /api/printify/products` with the exact new payload, produced:

- 5 `print_areas` groups: White, Butter, Black, True Navy (7 variants each) and
  one trailing group of 481 disabled variants.
- Editor, clicking each chip: White = default design / `…dark.png`,
  Butter = variant specific / `…dark.png`, Black = variant specific /
  `…white.png`, **True Navy = variant specific / `…white.png`**.

All four colours now show the artwork they actually print. The product was
deleted afterwards.

