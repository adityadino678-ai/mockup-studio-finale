// ---------------------------------------------------------------------------
// Print areas: mapping a real Printify print area onto a mockup photo.
//
// A print area is a rectangle on the photo whose PIXEL SIZE is a real
// Printify print area (e.g. 4500 x 5400 for a DTG tee front). The design
// inside it is placed with the Printify Studio's own numbers - `scale` is the
// artwork's width as a fraction of the area's width, `x`/`y` are the CENTRE
// of the artwork inside the area - so the mockup shows exactly what Printify
// prints, and whatever falls outside the area is clipped away.
//
// This module is the pure core: no DOM, no React, no IndexedDB. The preview,
// the batch render and the print-file export all call the same functions, so
// they are pixel-identical by construction rather than by discipline.
//
// Two coordinate spaces are in play:
//
//   * the PRINT AREA space - Printify's, centred on 0.5/0.5, `scale` is the
//     artwork width / area width. This is what the Studio session stores.
//   * the MOCKUP space - `Transform`, where x/y/scale are fractions of the
//     mockup's width/height. This is what the canvas and the batch engine
//     draw.
//
// `mapStudioPlacement` converts the first into the second, and
// `studioPlacementFromTransform` converts back - the second is what a drag
// gesture produces.
// ---------------------------------------------------------------------------

import type {
  MockupPrintArea,
  PrintAreaSource,
  PrintAreaTemplatePayload,
  StudioPlacement,
  Transform,
} from "@/types/domain";
import type { CatalogVariant } from "@/lib/printify/types";

/** A rectangle in mockup pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box on the photo, in fractions of the mockup. */
export type AreaBox = MockupPrintArea["box"];

/** The area's height / width. */
export function areaAspect(area: { areaWidth: number; areaHeight: number }): number {
  if (!area.areaWidth || !area.areaHeight) return 1;
  return area.areaHeight / area.areaWidth;
}

/**
 * The box on the photo, in mockup pixels.
 *
 * The width comes from the stored fraction; the height is ALWAYS the area's
 * own aspect ratio, which is what keeps the box the same shape as the
 * Printify print area. A box can be moved and scaled, never distorted.
 */
export function boxToPixels(
  box: AreaBox,
  area: { areaWidth: number; areaHeight: number },
  mockupW: number,
  mockupH: number,
): Rect {
  const width = Math.max(1, box.width * mockupW);
  const height = width * areaAspect(area);
  return {
    x: (box.x - box.width / 2) * mockupW,
    y: (box.y - height / mockupH / 2) * mockupH,
    width,
    height,
  };
}

/**
 * The clip rectangle for the design, in mockup pixels.
 *
 * Everything outside the print area is cut off: on the real product it would
 * not be printable either.
 */
export function clipRect(
  box: AreaBox,
  area: { areaWidth: number; areaHeight: number },
  mockupW: number,
  mockupH: number,
): Rect {
  return boxToPixels(box, area, mockupW, mockupH);
}

/**
 * A sensible starting box: the area centred on the upper chest, 40% of the
 * photo's width.
 */
export function defaultBox(
  area: { areaWidth: number; areaHeight: number },
  mockupW: number,
  mockupH: number,
): AreaBox {
  const width = 0.4;
  const height = width * mockupW * areaAspect(area);
  return {
    x: 0.5,
    // The chest sits above the middle of a flat-lay photo.
    y: Math.max(height / mockupH / 2 + 0.02, 0.45 - height / mockupH / 2),
    width,
  };
}

/**
 * The Printify Studio's placement, expressed in the mockup's own coordinates.
 *
 * `scale` (artwork width / area width) becomes a fraction of the mockup's
 * width, and the artwork's centre lands where the Studio put it inside the
 * area. The artwork's aspect ratio is preserved - Printify scales artwork
 * uniformly, so a non-uniform stretch would be a lie.
 */
export function mapStudioPlacement(
  placement: StudioPlacement,
  area: { areaWidth: number; areaHeight: number },
  box: AreaBox,
  mockupW: number,
  mockupH: number,
): Transform {
  const px = boxToPixels(box, area, mockupW, mockupH);
  const designWidthPx = Math.max(0.01, placement.scale) * px.width;
  const cx = px.x + placement.x * px.width;
  const cy = px.y + placement.y * px.height;
  return {
    x: mockupW > 0 ? cx / mockupW : 0.5,
    y: mockupH > 0 ? cy / mockupH : 0.5,
    scale: mockupW > 0 ? designWidthPx / mockupW : 0.1,
    rotation: placement.angle,
    flipX: false,
    flipY: false,
    opacity: 1,
    stretch: 1,
  };
}

/**
 * The inverse: a mockup-space transform back into the Studio's placement.
 *
 * This is what a drag in the mockups tab produces, and it is what gets
 * written back into the Studio session, so the product Printify receives and
 * the mockup the buyer sees can never disagree.
 */
export function studioPlacementFromTransform(
  transform: Transform,
  area: { areaWidth: number; areaHeight: number },
  box: AreaBox,
  mockupW: number,
  mockupH: number,
  position: string,
): StudioPlacement {
  const px = boxToPixels(box, area, mockupW, mockupH);
  const designWidthPx = transform.scale * mockupW;
  const cx = transform.x * mockupW;
  const cy = transform.y * mockupH;
  return {
    position,
    x: px.width > 0 ? (cx - px.x) / px.width : 0.5,
    y: px.height > 0 ? (cy - px.y) / px.height : 0.5,
    scale: px.width > 0 ? designWidthPx / px.width : 0.5,
    angle: transform.rotation,
  };
}

/** The artwork's aspect ratio, used by the snapping maths. */
export function designAspect(designW: number, designH: number): number {
  return designW > 0 ? designH / designW : 1;
}

// ---------------------------------------------------------------------------
// Print areas out of the Printify catalogue.
// ---------------------------------------------------------------------------

export interface PrintAreaOption {
  /** "front", "back", ... */
  position: string;
  /** The area's real pixel size. */
  width: number;
  height: number;
  /** The decoration method, when the provider reports one. */
  method?: string;
}

/**
 * The print areas of a (blueprint, print provider) pair.
 *
 * Printify's placeholder size is PER VARIANT: the same blueprint can have a
 * different area for an embroidered front than for a DTF front, and different
 * sizes per colour/size. We take the SMALLEST placeholder for each position,
 * which is the most common one - a design sized against it never exceeds the
 * real area on any other variant.
 */
export function derivePrintAreas(variants: CatalogVariant[]): PrintAreaOption[] {
  const map = new Map<string, PrintAreaOption>();
  for (const variant of variants) {
    for (const placeholder of variant.placeholders ?? []) {
      if (!placeholder.position) continue;
      const width = placeholder.width ?? 0;
      const height = placeholder.height ?? 0;
      if (width <= 0 || height <= 0) continue;
      const previous = map.get(placeholder.position);
      if (!previous || width * height < previous.width * previous.height) {
        map.set(placeholder.position, {
          position: placeholder.position,
          width,
          height,
          method: placeholder.decoration_method,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.position.localeCompare(b.position));
}

// ---------------------------------------------------------------------------
// Physical sizes.
// ---------------------------------------------------------------------------

/**
 * The scale of the photo, in pixels per inch, from a reference measurement.
 *
 * `linePixels` is the length of the reference line ON THE PHOTO (in the
 * photo's own pixels) and `inches` the real-world length it stands for.
 */
export function pixelsPerInch(linePixels: number, inches: number): number {
  if (inches <= 0 || linePixels <= 0) return 0;
  return linePixels / inches;
}

/**
 * The print area's real size on the garment, in inches.
 *
 * The area's pixel size is a PRINT resolution, not a photo measurement, so
 * the physical size comes from the box on the photo: how big the box is in
 * photo pixels, converted through the reference.
 */
export function areaInches(
  area: MockupPrintArea,
  mockupW: number,
  mockupH: number,
): { width: number; height: number } | null {
  const ppi = area.reference?.pixelsPerInch ?? 0;
  if (!ppi) return null;
  const px = boxToPixels(area.box, area, mockupW, mockupH);
  return { width: px.width / ppi, height: px.height / ppi };
}

/**
 * The design's printed size on the garment, in inches.
 *
 * The design covers `scale` of the area's width, so it is that fraction of
 * the area's physical width. Its height follows from the artwork's own
 * aspect ratio, measured against the area's height - the same way Printify
 * places it.
 */
export function designInches(
  scale: number,
  artAspect: number,
  area: MockupPrintArea,
  mockupW: number,
  mockupH: number,
): { width: number; height: number } | null {
  const physical = areaInches(area, mockupW, mockupH);
  if (!physical) return null;
  const width = scale * physical.width;
  const heightFraction = (scale * area.areaWidth * artAspect) / area.areaHeight;
  return { width, height: heightFraction * physical.height };
}

// ---------------------------------------------------------------------------
// Templates.
// ---------------------------------------------------------------------------

/** Builds the template payload for a mockup's print area. */
export function printAreaTemplateFrom(area: MockupPrintArea): PrintAreaTemplatePayload {
  return {
    type: "print-area",
    areaWidth: area.areaWidth,
    areaHeight: area.areaHeight,
    source: area.source,
    label: area.label,
    box: { ...area.box },
    reference: area.reference ? { ...area.reference } : undefined,
    clipMode: area.clipMode,
  };
}

/**
 * Applies a template to a mockup.
 *
 * The box travels as a FRACTION of the photo, so a template written on one
 * mockup lands in the same relative spot on another.
 */
export function printAreaFromTemplate(payload: PrintAreaTemplatePayload): MockupPrintArea {
  return {
    areaWidth: payload.areaWidth,
    areaHeight: payload.areaHeight,
    source: payload.source,
    label: payload.label,
    box: { ...payload.box },
    reference: payload.reference ? { ...payload.reference } : undefined,
    clipMode: payload.clipMode,
    updatedAt: Date.now(),
  };
}

/** A one-line description of a template, for the template list. */
export function describePrintAreaTemplate(payload: PrintAreaTemplatePayload): string {
  const source =
    payload.source.kind === "printify"
      ? `Printify · ${payload.source.position}`
      : payload.source.kind === "preset"
        ? "Preset"
        : "Manual";
  return `${source} · ${payload.areaWidth}×${payload.areaHeight}`;
}

/** The source's short label, for the mockup list badges. */
export function describePrintAreaSource(source: PrintAreaSource): string {
  if (source.kind === "printify") return source.position;
  if (source.kind === "preset") return "preset";
  return "manual";
}
