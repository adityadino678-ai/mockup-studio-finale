import { describe, expect, it } from "vitest";
import {
  buildColourTemplateInput,
  colourPayloadFromProduct,
  pickColourTemplateVariant,
  TEMPLATE_ARTWORK_BASE64,
  TEMPLATE_PRODUCT_TITLE,
} from "@/lib/server/colour-template";
import type { PrintifyShopProduct, PrintifyVariant } from "@/lib/server/printify";

const VARIANTS: PrintifyVariant[] = [
  {
    id: 41001,
    title: "White / M",
    options: { color: "White", size: "M" },
    placeholders: [{ position: "front" }],
    available: false,
  },
  {
    id: 41002,
    title: "Black / M",
    options: { color: "Black", size: "M" },
    placeholders: [{ position: "front" }],
    available: true,
  },
];

const TEMPLATE_PRODUCT: PrintifyShopProduct = {
  id: "tpl-1",
  title: TEMPLATE_PRODUCT_TITLE,
  options: [
    {
      name: "Colors",
      type: "color",
      values: [
        { id: 831, title: "Heather Grey", colors: ["#a4a4a3", "#b7b6b5"] },
        { id: 832, title: "Solid Black", colors: ["#1a1a1a"] },
      ],
    },
    { name: "Size", type: "size", values: [{ id: 2, title: "M" }, { id: 3, title: "L" }] },
  ],
  variants: [{ id: 99001, title: "Heather Grey / M", options: [831, 2] }],
};

describe("pickColourTemplateVariant", () => {
  it("picks the first AVAILABLE variant and its first print position", () => {
    expect(pickColourTemplateVariant(VARIANTS)).toEqual({ variantId: 41002, position: "front" });
  });

  it("answers null when the provider has no variants or no position", () => {
    expect(pickColourTemplateVariant([])).toBeNull();
    expect(pickColourTemplateVariant([{ id: 1, title: "x" }])).toBeNull();
  });
});

describe("buildColourTemplateInput", () => {
  it("builds a minimal COMPLETE partition: the one variant names itself", () => {
    const input = buildColourTemplateInput({
      blueprintId: 6,
      printProviderId: 30,
      plan: { variantId: 41002, position: "front" },
      imageId: "img-1",
    });
    expect(input.title).toBe(TEMPLATE_PRODUCT_TITLE);
    expect(input.variants).toEqual({ colour: [41002] });
    expect(input.prices).toEqual({ 41002: 100 });
    expect(input.printAreaGroups).toHaveLength(1);
    expect(input.printAreaGroups?.[0]).toMatchObject({
      position: "front",
      imageId: "img-1",
      variantIds: [41002],
    });
    // The enabled variants are exactly the ones the print areas name: the
    // partition is complete, so Printify cannot silently reassign variants
    // into the wrong artwork group.
    const enabled = Object.values(input.variants).flat();
    const named = input.printAreaGroups?.flatMap((g) => g.variantIds) ?? [];
    expect(new Set(named)).toEqual(new Set(enabled));
  });
});

describe("colourPayloadFromProduct", () => {
  it("extracts colour/size/variant values by option TYPE, not position", () => {
    const payload = colourPayloadFromProduct(TEMPLATE_PRODUCT);
    expect(payload.source).toBe("product");
    expect(payload.provisioned).toBe(false);
    expect(payload.colors).toEqual([
      { id: 831, title: "Heather Grey", colors: ["#a4a4a3", "#b7b6b5"] },
      { id: 832, title: "Solid Black", colors: ["#1a1a1a"] },
    ]);
    expect(payload.sizes).toEqual([
      { id: 2, title: "M" },
      { id: 3, title: "L" },
    ]);
    expect(payload.variants).toEqual([
      { id: 99001, title: "Heather Grey / M", options: [831, 2] },
    ]);
  });

  it("marks a provisioned read and drops the (deleted) template product id", () => {
    const payload = colourPayloadFromProduct(TEMPLATE_PRODUCT, {
      provisioned: true,
      templateProductId: "gone",
    });
    expect(payload.provisioned).toBe(true);
    expect(payload.templateProductId).toBeUndefined();
  });
});

describe("TEMPLATE_ARTWORK_BASE64", () => {
  it("is a valid PNG (magic bytes) and large enough to survive every guard", () => {
    const bytes = Buffer.from(TEMPLATE_ARTWORK_BASE64, "base64");
    expect(bytes.length).toBeGreaterThanOrEqual(256);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Decodable all the way to IEND.
    const text = bytes.toString("latin1");
    expect(text.includes("IEND")).toBe(true);
  });
});
