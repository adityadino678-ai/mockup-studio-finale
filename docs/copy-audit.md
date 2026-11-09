# Copy audit — Problem 3 (before / after)

Budget: Page title + ≤8 words, Card title + ≤10 words, Field label only
(helper ≤8 words only where commonly wrong, longer text in InfoTip),
one “How it works” per major page, Empty state short + one action,
Toast ≤6 words. Warnings about irreversible/publishing actions, error and
validation messages, privacy/legal text, and the disconnected-shop warning
are NEVER removed.

## Printify Studio (`src/views/printify-studio-page.tsx`)

- Before: `Upload designs, choose product/colours, place artwork, and create one Printify product per design. Products are unpublished drafts; Publish is separate.`
- After: `Upload designs, pick a product, create listings.` (7 words)
- Moved to How-it-works dialog: full step text + `Send creates an unpublished draft`.
- Kept: `Printify is not connected` error state; provider-drop toast (error).

## Settings (`src/views/settings-page.tsx`)

- Local storage Card: Before `ListBulkly stores all designs, mockups and generated images in your browser's IndexedDB. Nothing is uploaded anywhere.` → After `Stored in this browser only.`
- Account Card: Before `Sign in with email. Optional — the library stays in this browser.` → After `Optional.`
- API connections Card: Before `Keys stay in this browser (IndexedDB), are sent per-request via the server, and are never stored server-side. Clear any time.` → After `Keys stay in this browser.`
- Printify key helper: Before `Create one at developers.printify.com. Used to read the live catalog and to create products you explicitly confirm.` → After `Create one at developers.printify.com.`
- Shop footnote: Before `Used for product creation, Send and Publish.` → Deleted. Kept the disconnected-shop warning verbatim: `This shop is not connected to a sales channel (Etsy), so publishing to it will fail — connect it in Printify or pick a connected shop.`
- AI models footnote: Before `Fetched live from {provider}. Free models are tagged from the provider's own pricing where available.` → After `Free models are tagged where available.`
- Deleted: `A server-set key still works as a fallback when no key is saved here.`

## Mockups (`src/views/mockups-page.tsx`)

- Before: `Photos of your products. Uploaded mockups stay on this device.` → After: `Your product photos.`
- Added: How-it-works (Upload → Map print area → Save renders).

## Background remover (same UI, no new page)

- No dedicated page (removed per owner request): the engine upgrade runs
  entirely behind the existing Designs-tab “Remove background” action.
- Upload hint: `PNG, JPG, WebP · 40 MB max`.

## Activity (`src/views/activity-page.tsx`)

- Before: `Workspace activity log (latest 2,000 events).` → After: `` (nothing).
- Empty state: Before `Actions like uploads, placements, batches and exports will be recorded here.` → After `Nothing recorded yet.`

## Export (`src/views/export-page.tsx`)

- Before: `Download your work as an organized ZIP archive with a manifest.` → After: `Download organized ZIP archives.`

## Listing pages

- Images Empty: Before `Tick the designs this batch should create on the Designs tab of the Printify Studio. Each design becomes one listing; a pair becomes one listing.` → After `Tick designs in Studio.`
- Details Empty: Before `... Each design becomes one listing; a pair becomes one listing shared by both designs.` → After `Tick designs in Studio.`
- Preview Empty: Before `No listings to preview. Tick designs on the Studio's Designs tab; a pair is one listing.` → After `Tick designs in Studio.`

## Studio Colors / Design panel

- Colors Empty: Before `Pick the product your designs will be printed on. The colour and size list comes from Printify's live catalogue.` → After `Choose a product.`
- Colors heading paragraph: Before `Panels are independent. "No ink" designs print their panel; "Has ink" designs print their panel split black/white. A colour in both panels prints with each row's own artwork.` → After `Panels are independent.`
- Placement Empty: Before `The design panel needs a product, because the print area and its size come from the product's placeholders.` → After `Choose a product.`
- Designs upload hint: Before `PNG, JPEG or WebP · up to 40 MB each · multiple files welcome` → After `PNG, JPG, WebP · 40 MB max`.

## Toasts (≤6 words)

- `Paired as one listing — use the Black ink / White ink boxes to set each design's role` → `Paired as one listing`.

## Components

- New `InfoTip` (`src/components/ui/info-tip.tsx`, Radix Tooltip, 24×24) for long help.
- New `HowItWorks` (`src/components/ui/how-it-works.tsx`, Radix Dialog) — Studio, Mockups, Background Remover.

## Preserved (never removed)

- Irreversible/publishing warnings (`Send creates an unpublished draft`, publish gating), all error/validation messages, privacy/legal text, and the disconnected-shop warning.

## Tests updated

- `e2e/workflow.spec.ts`: Printify Studio copy assertion updated to the new 7-word header.
