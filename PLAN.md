# Plan: Fix Ink Variant Logic & Deep AI Agent Tool Audit

## Overview
Two major issues to address:
1. **Ink variant logic bug** - White ink only applies to black color even when multiple dark colors selected
2. **AI agent tools not working** - Need deep audit of all tools, their connections, and end-to-end testing with real Brave browser

---

## Part 1: Ink Variant Logic Fix

### Current Behavior (Broken)
- User selects colors in "plain" row and "ink" row in Colors tab
- For ink row colors, user toggles black/white ink per color
- **Bug**: White ink only ends up on black color on Printify; other dark colors get black ink or main artwork

### Desired Behavior (User's Spec)
1. **No ink variants (plain row)**: Design prints main artwork on ONLY the colors selected in plain row
2. **Has ink variants (ink row)**: Design prints on ONLY the colors selected in ink row, with per-color black/white ink toggle
3. Each ink row color gets explicit black/white ink assignment via tap

### Root Cause Analysis Needed
Investigate these files for the bug:
- src/lib/printify/design-colours.ts - planDesignColours(), 
ormaliseColourGroups(), pairedColourGroups()
- src/lib/printify/studio-plan.ts - uildStudioPlan(), planDesignColours() usage
- src/lib/printify/variants.ts - uildPartition(), esolveVariantIds()
- src/lib/server/printify.ts - createProduct() print area group construction
- src/lib/client/studio-create.ts - createStudioProduct() artwork upload per group

### Specific Fixes Required
1. **Color group assignment**: Ensure 
ormaliseColourGroups() correctly separates plain vs ink colors (ink row wins on overlap)
2. **Ink variant mapping**: In planDesignColours(), verify lack and white arrays are correctly derived from lackInkColors
3. **Partition construction**: In uildPartition(), ensure groups are ordered correctly so white ink group doesn't get absorbed
4. **Print area groups**: In createStudioProduct() and createProduct(), verify each ink group (main/black/white) gets correct ariantIds and imageId
5. **Variant resolution**: In esolveVariantIds(), ensure colors map to correct variant IDs for selected sizes

### Test Cases to Verify
- Select 5 dark colors (Black, Navy, Dark Grey, Charcoal, Dark Heather) in ink row
- Toggle all to white ink
- Create product -> verify all 5 colors get white ink artwork on Printify
- Mix black/white ink toggles -> verify each color gets correct ink
- Plain row colors -> verify main artwork only

---

## Part 2: Deep AI Agent Tool Audit & Real Browser Testing

### Tools to Audit (All Must Work End-to-End)

| Tool | Purpose | Key Connections to Verify |
|------|---------|---------------------------|
| save_listing_details | Write title/description/tags/price to listing drafts | proposeSaveListingDetails -> confirmSaveListingDetails -> saveStudioListingDrafts -> IndexedDB |
| create_printify_product | Create real Printify product | proposePrintifyProduct -> confirmPrintifyProduct -> /api/printify/products -> Printify API |
| create_mockup_render | Render design on mockup | proposeMockupRender -> confirmMockupRender -> enderComposition -> IndexedDB asset |
| etsy_research | Research Etsy listings | esearchEtsy() -> API or extension fallback |
| draft_listing | Generate SEO copy | /api/ai/seo -> AI provider |
| rowse_printify_catalog | Browse products/providers/variants | /api/printify/catalog -> Printify API |
| save_placement | Save design placement | proposeSavePlacement -> confirmSavePlacement -> writeBackStudioPlacement / savePlacement |
| create_ink_variant | Generate white/black ink | proposeInkVariant -> confirmInkVariant -> createInkVariantBlob |
| emove_background | Remove bg from design | proposeRemoveBackground -> confirmRemoveBackground -> emoveBackgroundAuto |
| save_chat_image | Save attached image as design/mockup | proposeSaveChatImage -> confirmSaveChatImage -> createDesignFromFile/createMockupFromFile |
| create_batch_job | Batch render designs x mockups | proposeBatchJob -> confirmBatchJob -> createBatchJob + unBatchJob |

### Common Failure Points to Check
1. **Tool schema <-> implementation mismatch** (like items vs design in save_listing_details)
2. **Confirm handler not receiving correct payload** from propose step
3. **IndexedDB operations failing silently** (no error thrown, just empty result)
4. **API endpoint errors** (503, 400, 500) not surfaced to agent
5. **Image/blob handling** - base64 conversion, file uploads, asset storage
6. **Session state** - tools reading stale session vs live session
7. **Design lookup by name** - case sensitivity, partial matches, exact matches

### Real Brave Browser Test Plan
Launch Brave with remote debugging (port 9233) on fresh profile, then:

#### Test 1: Upload Design
- Navigate to /printify-studio
- Upload a test design (PNG/JPG)
- Verify it appears in Designs tab

#### Test 2: Create Mockup Render
- Go to /mockups -> Print Areas tab
- Upload a mockup photo
- Set print area
- Save render
- Verify render appears in Listing images

#### Test 3: Agent Creates Listing with SEO
- Go to /agent
- Start new chat
- Say: "Upload this design, research 'vintage sunset tee' on Etsy, write SEO listing copy, and save it to all listings"
- Verify agent:
  1. Calls save_chat_image (if image attached) or references existing design
  2. Calls etsy_research("vintage sunset tee")
  3. Calls draft_listing(concept="vintage sunset tee")
  4. Calls save_listing_details(items=[...]) with unique copy per listing
  4. Confirm card appears -> click Create
  5. Verify listing drafts updated in /listing-details

#### Test 4: Agent Creates Printify Product
- Say: "Create a t-shirt product for the Sunset design with white ink on dark colors"
- Verify agent:
  1. Calls rowse_printify_catalog(query="t-shirt") -> picks blueprint/provider
  2. Calls create_printify_product with correct params
  3. Confirm card appears -> click Create
  4. Verify product created on Printify (check productDrafts)

#### Test 5: Ink Variant Assignment
- In Colors tab: select 5 dark colors in ink row
- Toggle all to white ink
- Agent: "Create product for this design with current ink settings"
- Verify on Printify: white ink artwork on all 5 dark colors

---

## Part 3: Implementation Order

### Phase 1: Ink Variant Fix (Priority 1)
1. Add debug logging to planDesignColours, uildPartition, createStudioProduct
2. Test with Brave browser: create product with 5 dark colors + white ink
3. Trace variant IDs through the pipeline
4. Fix the specific bug (likely in partition group ordering or variant resolution)
5. Add unit test for "5 dark colors all white ink"

### Phase 2: AI Agent Tool Audit (Priority 2)
1. Write test harness that calls each tool directly (bypassing AI)
2. Fix any schema/implementation mismatches
3. Test each tool end-to-end with Brave browser
4. Add integration tests for critical paths

### Phase 3: Agent Workflow Testing (Priority 3)
1. Run full agent workflows in Brave browser
2. Fix any tool chaining issues
3. Update system prompt based on actual tool capabilities
4. Document known limitations

---

## Files Likely Needing Changes

### Ink Variant Fix
- src/lib/printify/design-colours.ts - 
ormaliseColourGroups, planDesignColours, pairedColourGroups
- src/lib/printify/studio-plan.ts - uildStudioPlan, color group construction
- src/lib/printify/variants.ts - uildPartition, group ordering
- src/lib/server/printify.ts - createProduct print area construction
- src/lib/client/studio-create.ts - createStudioProduct artwork per group

### AI Agent Tools
- src/lib/ai/tools.ts - Tool schemas (fix any mismatches)
- src/lib/client/tools.ts - All propose/confirm handlers
- src/pages/api/ai/chat.ts - System prompt updates
- src/pages/api/printify/products.ts - Product creation endpoint
- src/pages/api/ai/seo.ts - SEO endpoint
- src/pages/api/printify/catalog.ts - Catalog endpoint
- src/pages/api/etsy/research.ts - Etsy research endpoint

---

## Verification Checklist

After fixes, verify with Brave browser:
- [ ] Upload design -> appears in Designs tab
- [ ] Colors tab: plain row + ink row selections work independently
- [ ] Ink row: per-color black/white toggle works
- [ ] Create product with 5 dark colors all white ink -> Printify shows white ink on all 5
- [ ] Agent: research -> draft -> save_listing_details(items=[...]) works
- [ ] Agent: create_printify_product with correct ink assignment works
- [ ] Agent: create_mockup_render saves render to listing
- [ ] All 35 e2e tests pass
- [ ] All 532 unit tests pass
- [ ] Typecheck, lint, build all green

---

## Notes
- Use Brave browser on port 9233 with fresh temp profile for all testing
- Copy Chrome profile to temp dir for Printify/Etsy session if needed
- Mock Printify API calls during unit tests; real API only in browser tests
- The ink variant fix must not break existing paired designs or plain designs
