// ---------------------------------------------------------------------------
// Pre-built mockup templates for the six product types.
//
// Each template is a PrintAreaTemplatePayload: a real Printify print-area size
// (from the presets), a sensible default frame on the photo, and a label.
// The frame is stored as fractions of the photo, so applying a template to any
// mockup lands in the same relative spot.
//
// These are the defaults the agent auto-applies (by blueprint + print
// provider) and the starting point a user customises before saving their own
// template in template-store.ts.
// ---------------------------------------------------------------------------

import type { MockupCategory, MockupPrintArea } from "@/types/domain";
import type { CatalogBlueprint } from "@/lib/printify/types";
import type { Mockup, PrintAreaTemplatePayload } from "@/types/domain";
import { findPrintAreaPreset, PRINT_AREA_PRESETS } from "@/lib/printify/presets";
import { printAreaFromTemplate } from "@/lib/mockups/print-area";
import { mockupCategoryFor } from "@/lib/mockups/template-category";

/** A sensible starting frame for each product type. */
const FRAME_FOR_CATEGORY: Record<MockupCategory, { x: number; y: number; scale: number; rotation: number }> = {
  tshirt:  { x: 0.5, y: 0.42, scale: 0.40, rotation: 0 },
  hoodie:  { x: 0.5, y: 0.40, scale: 0.35, rotation: 0 },
  mug:     { x: 0.5, y: 0.50, scale: 0.55, rotation: 0 },
  poster:  { x: 0.5, y: 0.50, scale: 0.75, rotation: 0 },
  tote:    { x: 0.5, y: 0.50, scale: 0.50, rotation: 0 },
  sticker: { x: 0.5, y: 0.50, scale: 0.65, rotation: 0 },
  other:   { x: 0.5, y: 0.50, scale: 0.40, rotation: 0 },
};

/** The pre-built templates, one per product type. */
export const PRESET_TEMPLATES: PrintAreaTemplatePayload[] = (() => {
  const out: PrintAreaTemplatePayload[] = [];
  for (const preset of PRINT_AREA_PRESETS) {
    for (const category of preset.categories) {
      const frame = FRAME_FOR_CATEGORY[category];
      out.push({
        type: "print-area",
        areaWidth: preset.width,
        areaHeight: preset.height,
        source: { kind: "preset", presetId: preset.id },
        label: `${preset.label} template`,
        frame,
        clipMode: "area",
      });
    }
  }
  return out;
})();

/** The template for a mockup category, when a pre-built one exists. */
export function templateForCategory(category: MockupCategory): PrintAreaTemplatePayload | undefined {
  return PRESET_TEMPLATES.find((t) => {
    if (t.source.kind !== "preset") return false;
    const preset = findPrintAreaPreset(t.source.presetId);
    return preset?.categories.includes(category) ?? false;
  });
}

/**
 * Auto-apply: the template the agent should use for a blueprint.
 *
 * Determines the product type from the blueprint's title/category, finds the
 * matching pre-built template, and turns it into a MockupPrintArea ready to be
 * written onto a mockup. Returns undefined when no template matches.
 *
 * Pure: writes nothing to IndexedDB. The caller persists the result on the
 * mockup (e.g. via `db.mockups.put({ ...mockup, printArea: area })`).
 */
export function autoApplyTemplate(
  blueprint: CatalogBlueprint,
  _mockup: Mockup,
): MockupPrintArea | undefined {
  const category = mockupCategoryFor(blueprint);
  const template = templateForCategory(category);
  if (!template) return undefined;
  return printAreaFromTemplate(template);
}
