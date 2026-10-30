# Forensic Analysis: Printify Dual-Artwork Payload

> Evidence appendix for `plans/printify-editor-routing.md`. Verbatim output of the
> NVIDIA Nemotron payload-simulation agent; some arrows are mangled by console
> encoding. Read-only — no app files were changed by it.

## WORKED EXAMPLE

**Scenario**: 1 pair (black-ink design "Design-Black", white-ink design "Design-White"), ink panel colours: White, Sand (black-ink) + Black, Navy (white-ink). 2 sizes (S, M) → 8 variants.

### 1. `variants: { [blueprintId]: number[] }` map (studio-create.ts:186)
```json
{ "6": [1001,1002,1003,1004, 1005,1006,1007,1008] }
```
| Variant ID | Colour | Size | Intended design |
|------------|--------|------|-----------------|
| 1001 | White | S | Design-Black (black ink) |
| 1002 | White | M | Design-Black |
| 1003 | Sand | S | Design-Black |
| 1004 | Sand | M | Design-Black |
| 1005 | Black | S | Design-White (white ink) |
| 1006 | Black | M | Design-White |
| 1007 | Navy | S | Design-White |
| 1008 | Navy | M | Design-White |

### 2. Plan item `groups` (studio-plan.ts:119-139)
```json
[
  { "ink": "main", "assetId": "asset-black", "colors": ["White","Sand"], "label": "Black ink · Design-Black", "fallback": false },
  { "ink": "main", "assetId": "asset-white", "colors": ["Black","Navy"], "label": "White ink · Design-White", "fallback": false }
]
```
Order: black group first, then white group.

### 3. `partition.groups` (variants.ts:147-181) — same order
```json
[
  { "ink": "main", "colors": ["White","Sand"], "variantIds": [1001,1002,1003,1004] },
  { "ink": "main", "colors": ["Black","Navy"], "variantIds": [1005,1006,1007,1008] }
]
```

### 4. `artworks` array sent to API (studio-create.ts:140-165)
```json
[
  { "printAreaId": "front", "variantIds": [1001,1002,1003,1004], "base64": "...", "filename": "Design-Black-main.png", "placement": {...} },
  { "printAreaId": "front", "variantIds": [1005,1006,1007,1008], "base64": "...", "filename": "Design-White-main.png", "placement": {...} }
]
```
Index-zipped: partition[0] ↔ item.groups[0], partition[1] ↔ item.groups[1].

### 5. `print_areas` assembled in server (server/printify.ts:590-612)
```json
[
  { "variant_ids": [1001,1002,1003,1004], "placeholders": [{ "position": "front", "images": [{ "id": "img-100", "x": 0.5, "y": 0.5, "scale": 1, "angle": 0 }] }] },
  { "variant_ids": [1005,1006,1007,1008], "placeholders": [{ "position": "front", "images": [{ "id": "img-101", "x": 0.5, "y": 0.5, "scale": 1, "angle": 0 }] }] }
]
```
Two groups, same position `"front"`, disjoint `variant_ids`, distinct `imageId`s.

### 6. Final POST body to Printify (server/printify.ts:639-646)
```json
{
  "title": "...",
  "description": "...",
  "blueprint_id": 6,
  "print_provider_id": 30,
  "variants": [{"id":1001,"price":2499,"is_enabled":true}, ... all 8 ...],
  "print_areas": [ /* the two groups above */ ],
  "tags": [...]
}
```

---

## ANSWERS

### Q1. Can two different groups ever carry the SAME image id / same upload?
**No.**  
- For pairs: `item.groups[0].assetId = mainAssetId(blackDesign)`, `item.groups[1].assetId = mainAssetId(whiteDesign)` — different designs → different blobs → different uploads → different `imageId` (studio-plan.ts:124-125, 133-134).  
- For single ink-ticked designs: black group uses `design.blackInkAssetId`, white group uses `design.whiteInkAssetId` (design-colours.ts:185-188). Fallback to main only if missing, but `inkArtworkProblems` blocks creation when ink artwork is missing (design-colours.ts:448-473).  
- Index zip in `studio-create.ts:148-150` aligns `partition.groups[i]` with `item.groups[i]`; order is identical because `buildPartition` preserves input order (variants.ts:154-168) and `item.groups` order is fixed (studio-plan.ts:122-138).  
**Evidence**: studio-plan.ts:122-138, studio-create.ts:148-150, variants.ts:154-168.

### Q2. Can any group have an EMPTY variant_ids array, or can two groups OVERLAP in variant ids?
**Empty**: Yes, if a group's colours have no matching variants in the selected sizes. `buildPartition` returns `variantIds: []` for such groups (variants.ts:155-167). `buildPrintAreas` drops them (print-areas.ts:63). `assertCompletePartition` flags them as `"empty-group"` (print-areas.ts:95-99).  
**Overlap**: No. `buildPartition` uses a `claimed` Set; each variant ID is assigned to the first group that names it (variants.ts:151-160). API re-validates no duplicates (api/printify/products.ts:286-295).  
**Evidence**: variants.ts:151-160, print-areas.ts:63, print-areas.ts:95-99, api/printify/products.ts:286-295.

### Q3. Do the groups cover every enabled variant exactly once, and are unselected variants disabled?
**Enabled variants**: Yes. Client computes `enabled = resolveVariantIds(...selected colours..., session.sizes)` (studio-create.ts:117-121). API validates `printAreaGroups` covers `variantIds` (the enabled set) exactly once (api/printify/products.ts:285-305).  
**Unselected catalogue variants**: Not in `enabled`, not sent in `variants` map, not in any `printAreaGroup` → Printify does not create them (or creates as disabled).  
**Extra product variants (not in catalogue)**: Not covered by client partition; Printify appends them to the **last** group (AGENTS.md: "Printify rewrites variant_ids to complete the partition... silently appended to the last group"). They arrive disabled per AGENTS.md.  
**Evidence**: studio-create.ts:117-121, api/printify/products.ts:285-305, AGENTS.md lines 105-110.

### Q4. Is there any code path where ONE group's image ends up applied to ALL variants (collapse)?
**No for enabled variants.**  
- Client skips groups with zero active variants (studio-create.ts:152: `if (!artwork || activeVariantIds.length === 0) continue;`).  
- API validates every enabled variant appears in exactly one `printAreaGroup` (api/printify/products.ts:285-305).  
- Legacy single-`artwork` path defaults to all variants (api/printify/products.ts:272), but Studio always sends `artworks[]` array.  
**Evidence**: studio-create.ts:152, api/printify/products.ts:272, api/printify/products.ts:285-305.

### Q5. Are the variant ids used product variant ids or catalogue variant ids? Could they be ids Printify doesn't recognise?
**Catalogue variant IDs** (`CatalogVariant.id` from `/variants.json`). Printify recognises them — the spike confirms "a colour *is* a variant id" and product creation succeeds with these IDs (AGENTS.md). Extra variants Printify adds have different IDs unknown to client, but they are added by Printify post-creation, not sent by client.  
**Evidence**: variants.ts:24-43 (buildCatalogueIndex uses `v.id`), server/printify.ts:644 (sends same IDs), AGENTS.md lines 95-110.

### Q6. Does the client verification catch a variant that has NO image in the returned product?
**No — DEFECT.**  
Verification condition (studio-create.ts:222):
```typescript
if (got && want && got !== want) wrongArtwork.push(String(variant.id));
```
Only triggers when **both** `got` (from `product.print_areas`) and `want` (from uploaded artworks echo) exist and differ. Misses:
- `want && !got` — variant in uploaded set but missing from product's print_areas
- `got && !want` — variant has image in product but wasn't in our upload (e.g., Printify default)
- `!got && want` — variant has no image at all  
**Evidence**: studio-create.ts:201-224.

### Q7. Does the server send `print_areas` keyed by position in a way that assumes exactly one image per position?
**No.**  
Server builds `print_areas` as an **array** of groups (server/printify.ts:582, 590-612). Each group carries its own `position`, `variant_ids`, and `images[]`. Multiple groups with the same `position` (e.g., two `"front"` groups) are explicitly created — one per artwork group. The legacy `printAreas` Record<string,string> path (server/printify.ts:613-627) assumes one image per position, but Studio uses `printAreaGroups[]`.  
**Evidence**: server/printify.ts:590-612, server/printify.ts:613-627.

---

## DEFECTS FOUND

1. **should-fix** — `studio-create.ts:222`  
   Verification does not detect variants that have no image in `product.print_areas` or have an image not in the uploaded set. Add checks for `want && !got` and `got && !want`.

2. **nit** — `studio-create.ts:139`  
   Comment "partition.groups now matches item.groups 1:1 (no absorber)" is slightly misleading: `buildPartition` has no absorber (unclaimed left out), but the partition is only over user-selected colours, not the full catalogue. The zip is correct today, but the comment overstates.

3. **nit** — `variants.ts:179`  
   `Partition.complete` compares against `index.allVariantIds` (full catalogue) but callers only care about selected colours. Unused, so harmless.

---

## VERDICT

The payload **correctly expresses** "design A on colours 1-2, design B on colours 3-4" per Printify's documented schema. The `print_areas` array contains multiple groups for the same position (`"front"`), each with disjoint `variant_ids` and a distinct `imageId`. The index-based zip between `partition.groups` and `item.groups` is order-consistent: both are derived from the same `item.groups` array (black-ink group first, white-ink group second). Printify's own mockups confirm the partition works — the generated mockups show the correct artwork per colour.

The reported symptom ("Edit design screen shows white design on black colour") describes the **correct behaviour** for a dark garment: the colour "Black" is marked for white ink, so it receives the white-ink design. If the user expects the black-ink design on a black garment, the colour marking is inverted in the UI. No structural payload limitation exists; the defect is either a Printify UI quirk (mockups vs. edit-screen data source) or a colour-marking error. The only actionable code defect is the incomplete verification (Q6).