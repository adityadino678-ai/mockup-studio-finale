// ---------------------------------------------------------------------------
// The throwaway colour template product.
//
// Printify's catalogue only knows colour NAMES; the true hexes live on a
// product. A visitor whose shop has NO product for a blueprint + provider
// could only ever see approximate swatches - so the palette provisions one:
// with the VISITOR'S OWN KEY it creates a hidden ONE-VARIANT draft, reads
// the product's real colour/size values, and DELETES the draft in the same
// request. One enabled variant still carries EVERY colour's hex in the
// product's options. No server key is ever involved; the only quota spent
// is the visitor's own (one upload + one create + one delete, cached).
//
// The pure helpers live here so tests can pin the payload without network.
// ---------------------------------------------------------------------------

import type {
  CreatePrintifyProductInput,
  PrintifyShopProduct,
  PrintifyVariant,
} from "@/lib/server/printify";

/** The throwaway draft's name - recognisable, so a failed delete is findable. */
export const TEMPLATE_PRODUCT_TITLE = "Mockup Studio colour template (safe to delete)";

/**
 * The template's artwork: a small, valid PNG (a plain panel with a green
 * disc). Printify decodes it fine; the artwork itself is irrelevant - only
 * the product's colour OPTIONS are read.
 */
export const TEMPLATE_ARTWORK_BASE64 =
  "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" +
  "AABJRU5ErkJggg==";

export interface ColourTemplatePlan {
  variantId: number;
  position: string;
}

/**
 * Pure: which ONE variant the throwaway product enables, and which print
 * position carries the artwork. The first available variant is enough - the
 * product's OPTIONS list every colour of the blueprint + provider regardless
 * of how many variants are enabled.
 */
export function pickColourTemplateVariant(
  variants: PrintifyVariant[],
): ColourTemplatePlan | null {
  const usable = variants.filter((v) => Number.isFinite(v.id) && (v.available ?? true));
  const variant = usable[0] ?? variants[0];
  const position = variant?.placeholders?.[0]?.position;
  if (!variant || !position) return null;
  return { variantId: variant.id, position };
}

/**
 * Pure: the minimal draft payload. The print-area group names exactly the one
 * enabled variant, so the partition is complete and Printify has nothing left
 * to silently reassign (the wrong-artwork trap in AGENTS.md).
 */
export function buildColourTemplateInput(params: {
  blueprintId: number;
  printProviderId: number;
  plan: ColourTemplatePlan;
  imageId: string;
}): CreatePrintifyProductInput {
  const { blueprintId, printProviderId, plan, imageId } = params;
  return {
    title: TEMPLATE_PRODUCT_TITLE,
    description:
      "Temporary product created by Mockup Studio to read this product type's exact colour values. It is deleted immediately; if you can still see it, it is safe to delete.",
    blueprintId,
    printProviderId,
    variants: { colour: [plan.variantId] },
    prices: { [plan.variantId]: 100 },
    printAreaGroups: [
      { position: plan.position, imageId, variantIds: [plan.variantId] },
    ],
  };
}

/** The palette payload one product resolves to. */
export interface ColourTemplatePayload {
  source: "product" | "none";
  approximate: boolean;
  /** True when the hexes came from a just-provisioned throwaway template. */
  provisioned: boolean;
  templateProductId?: string;
  colors: Array<{ id: number; title: string; colors: string[] }>;
  sizes: Array<{ id: number; title: string }>;
  variants: Array<{ id: number; title: string; options?: number[] }>;
}

/**
 * Pure: a full product's colour/size/variant values, the exact shape the
 * `colors=1` branch has always returned. The colour option is matched by its
 * TYPE or NAME (never by position), and the size option likewise.
 */
export function colourPayloadFromProduct(
  full: PrintifyShopProduct,
  flags: { approximate?: boolean; provisioned?: boolean; templateProductId?: string } = {},
): ColourTemplatePayload {
  const options = full.options ?? [];
  const colourOption = options.find((o) => /colou?r/i.test(o.type ?? o.name ?? ""));
  const sizeOption = options.find((o) => /size/i.test(o.type ?? o.name ?? ""));
  return {
    source: "product",
    approximate: flags.approximate === true,
    provisioned: flags.provisioned === true,
    // A provisioned template is deleted within the same request: its id must
    // never reach the client (there is nothing there any more).
    templateProductId: flags.provisioned ? undefined : flags.templateProductId,
    colors: (colourOption?.values ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      colors: v.colors ?? [],
    })),
    sizes: (sizeOption?.values ?? []).map((v) => ({ id: v.id, title: v.title })),
    variants: (full.variants ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      options: v.options ?? [],
    })),
  };
}
