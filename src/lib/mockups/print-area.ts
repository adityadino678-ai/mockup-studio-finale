// ---------------------------------------------------------------------------
// Print areas: mapping a real Printify print area onto a mockup photo.
//
// A print area is a FRAME on the photo that the design is attached to.
//
//   * the design's placement INSIDE the area (where it sits, how wide, at
//     what angle) belongs to the Printify Studio - Printify's own numbers:
//     `scale` is the artwork width / area width, `x`/`y` are the CENTRE of
//     the artwork inside the area, `angle` is its rotation;
//   * the frame's own transform (where it sits on the photo, how big, how
//     rotated) belongs to the mockup.
//
// The two compose: the design is drawn inside the frame, so moving, scaling
// or rotating the frame moves, scales or rotates the design with it.
//
// A mockup can also show only PART of the area - a shirt photographed folded
// hides the bottom of it - so `crop` is the window the design may paint on.
// The area itself, and the print file rendered from it, never change.
//
// This module is the pure core: no DOM, no React, no IndexedDB. The preview,
// the batch render, the editor and the print file all call the same
// functions, so they agree by construction rather than by discipline.
// ---------------------------------------------------------------------------

import type {
  MockupPrintArea,
  PrintAreaSource,
  PrintAreaTemplatePayload,
  StudioPlacement,
  Transform,
} from "@/types/domain";
import type { CatalogVariant } from "@/lib/printify/types";

/** The frame, in mockup pixels. */
export interface FramePixels {
  /** The frame's centre. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Degrees, clockwise. */
  rotation: number;
}

/** A rectangle that can be rotated - the clip region. */
export interface RotatedRect {
  /** The centre. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise. */
  rotation: number;
}

/** The frame on the photo. */
export type AreaFrame = MockupPrintArea["frame"];

/**
 * The visible window into the print area, as fractions of the area.
 *
 * A folded-shirt mockup shows only part of the printable area, so the design
 * is cut at the fold instead of floating over it. The AREA does not change:
 * the print file still renders the whole thing, because that is what Printify
 * prints.
 */
export interface AreaCrop {
  /** The window's top-left, as fractions of the area. */
  x: number;
  y: number;
  /** The window's size, as fractions of the area. */
  width: number;
  height: number;
}

/** No crop: the whole print area is visible. */
export const FULL_CROP: AreaCrop = { x: 0, y: 0, width: 1, height: 1 };

/** Nothing smaller than this is a window; it is a sliver. */
export const MIN_CROP = 0.05;

function clamp01(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The area's crop, normalised.
 *
 * A missing crop is the whole area, and a stored one is clamped inside it -
 * an out-of-range value from a hand-edited record must not produce a clip
 * rectangle that is nowhere on the photo.
 */
export function areaCrop(area: { crop?: AreaCrop }): AreaCrop {
  const raw = area.crop;
  if (!raw) return { ...FULL_CROP };
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return { ...FULL_CROP };
  const left = clamp01(x, 0, 1 - MIN_CROP);
  const top = clamp01(y, 0, 1 - MIN_CROP);
  return {
    x: left,
    y: top,
    width: clamp01(width, MIN_CROP, 1 - left),
    height: clamp01(height, MIN_CROP, 1 - top),
  };
}

/** True when the crop is the whole area, within a rounding error. */
export function isFullCrop(crop: AreaCrop): boolean {
  return crop.x <= 0.0001 && crop.y <= 0.0001 && crop.width >= 0.9999 && crop.height >= 0.9999;
}

/** A one-line description of the window, for the panel and the templates. */
export function describeCrop(crop: AreaCrop): string {
  if (isFullCrop(crop)) return "Whole area";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (crop.x <= 0.0001 && crop.width >= 0.9999) {
    if (crop.y <= 0.0001) return `Top ${pct(crop.height)} of the area`;
    if (crop.y + crop.height >= 0.9999) return `Bottom ${pct(crop.height)} of the area`;
    return `Middle ${pct(crop.height)} of the area`;
  }
  return `${pct(crop.width)} × ${pct(crop.height)} of the area`;
}

/**
 * A point of the AREA in mockup pixels.
 *
 * `u`/`v` are fractions of the area, turned with the frame. Used to place the
 * crop's outline and its handles on the photo.
 */
export function areaPointInMockup(
  framePx: FramePixels,
  u: number,
  v: number,
): { x: number; y: number } {
  const rad = ((framePx.rotation || 0) * Math.PI) / 180;
  const localX = (u - 0.5) * framePx.width;
  const localY = (v - 0.5) * framePx.height;
  return {
    x: framePx.cx + localX * Math.cos(rad) - localY * Math.sin(rad),
    y: framePx.cy + localX * Math.sin(rad) + localY * Math.cos(rad),
  };
}

/**
 * The inverse: a point on the photo as fractions of the area.
 *
 * A crop gesture reads the pointer in mockup pixels and needs to know which
 * part of the area it is over - whatever angle the frame is at.
 */
export function areaPointFromMockup(
  framePx: FramePixels,
  x: number,
  y: number,
): { u: number; v: number } {
  const rad = (-(framePx.rotation || 0) * Math.PI) / 180;
  const dx = x - framePx.cx;
  const dy = y - framePx.cy;
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
  return {
    u: framePx.width > 0 ? localX / framePx.width + 0.5 : 0.5,
    v: framePx.height > 0 ? localY / framePx.height + 0.5 : 0.5,
  };
}

/**
 * The crop window in the FRAME's local space.
 *
 * A Konva `Group` clips in its own coordinate space, whose origin is the
 * frame's centre - so the window is the crop, measured from there.
 */
export function cropLocalRect(
  area: { crop?: AreaCrop },
  framePx: FramePixels,
): { x: number; y: number; width: number; height: number } {
  const crop = areaCrop(area);
  return {
    x: -framePx.width / 2 + crop.x * framePx.width,
    y: -framePx.height / 2 + crop.y * framePx.height,
    width: crop.width * framePx.width,
    height: crop.height * framePx.height,
  };
}

/** The area's height / width. */
export function areaAspect(area: { areaWidth: number; areaHeight: number }): number {
  if (!area.areaWidth || !area.areaHeight) return 1;
  return area.areaHeight / area.areaWidth;
}

/**
 * The frame, in mockup pixels.
 *
 * The width comes from the stored fraction; the height is ALWAYS the area's
 * own aspect ratio, which is what keeps the frame the same shape as the
 * Printify print area. A frame can be moved, scaled and rotated, never
 * distorted.
 */
export function frameToPixels(
  frame: AreaFrame,
  area: { areaWidth: number; areaHeight: number },
  mockupW: number,
  mockupH: number,
): FramePixels {
  const width = Math.max(1, frame.scale * mockupW);
  const height = width * areaAspect(area);
  return {
    cx: frame.x * mockupW,
    cy: frame.y * mockupH,
    width,
    height,
    rotation: frame.rotation || 0,
  };
}

/**
 * The clip region for the design: the crop window, turned with the frame.
 *
 * Everything outside the print area is cut off - on the real product it would
 * not be printable either. When the mockup crops the area (a folded shirt),
 * the cut is the crop window instead, so the design stops at the fold.
 */
export function clipFor(
  area: { areaWidth: number; areaHeight: number; crop?: AreaCrop },
  frame: AreaFrame,
  mockupW: number,
  mockupH: number,
): RotatedRect {
  const px = frameToPixels(frame, area, mockupW, mockupH);
  const crop = areaCrop(area);
  if (isFullCrop(crop)) {
    return {
      x: px.cx,
      y: px.cy,
      width: px.width,
      height: px.height,
      rotation: px.rotation,
    };
  }
  const centre = areaPointInMockup(px, crop.x + crop.width / 2, crop.y + crop.height / 2);
  return {
    x: centre.x,
    y: centre.y,
    width: crop.width * px.width,
    height: crop.height * px.height,
    rotation: px.rotation,
  };
}

/**
 * A sensible starting frame: the area centred on the upper chest, 40% of the
 * photo's width, not rotated.
 */
export function defaultFrame(
  area: { areaWidth: number; areaHeight: number },
  mockupW: number,
  mockupH: number,
): AreaFrame {
  const scale = 0.4;
  const height = scale * mockupW * areaAspect(area);
  const half = height / mockupH / 2;
  return {
    x: 0.5,
    // The chest sits above the middle of a flat-lay photo, with a little room
    // above it for the rotate handle.
    y: Math.max(half + 0.06, 0.45 - half),
    scale,
    rotation: 0,
  };
}

/**
 * The Printify Studio's placement, expressed in the mockup's own coordinates.
 *
 * The placement is inside the area, so it is first placed in the FRAME's
 * local space and then carried by the frame's own transform: the design's
 * centre is rotated with the frame, and its size scales with it.
 *
 * The artwork's aspect ratio is preserved - Printify scales artwork
 * uniformly, so a non-uniform stretch would be a lie.
 */
export function mapStudioPlacement(
  placement: StudioPlacement,
  area: { areaWidth: number; areaHeight: number },
  frame: AreaFrame,
  mockupW: number,
  mockupH: number,
): Transform {
  const px = frameToPixels(frame, area, mockupW, mockupH);
  const rad = (px.rotation * Math.PI) / 180;
  const localX = (placement.x - 0.5) * px.width;
  const localY = (placement.y - 0.5) * px.height;
  const cx = px.cx + localX * Math.cos(rad) - localY * Math.sin(rad);
  const cy = px.cy + localX * Math.sin(rad) + localY * Math.cos(rad);
  const designWidthPx = Math.max(0.01, placement.scale) * px.width;
  return {
    x: mockupW > 0 ? cx / mockupW : 0.5,
    y: mockupH > 0 ? cy / mockupH : 0.5,
    scale: mockupW > 0 ? designWidthPx / mockupW : 0.1,
    rotation: px.rotation + placement.angle,
    flipX: false,
    flipY: false,
    opacity: 1,
    stretch: 1,
  };
}

/**
 * The inverse: a mockup-space transform back into the Studio's placement.
 *
 * The frame's own rotation and scale are taken back off, so what lands in the
 * Studio session is the design's placement INSIDE the area - which is what
 * Printify is told.
 */
export function studioPlacementFromTransform(
  transform: Transform,
  area: { areaWidth: number; areaHeight: number },
  frame: AreaFrame,
  mockupW: number,
  mockupH: number,
  position: string,
): StudioPlacement {
  const px = frameToPixels(frame, area, mockupW, mockupH);
  const dx = transform.x * mockupW - px.cx;
  const dy = transform.y * mockupH - px.cy;
  const rad = (-px.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
  const designWidthPx = transform.scale * mockupW;
  return {
    position,
    x: px.width > 0 ? localX / px.width + 0.5 : 0.5,
    y: px.height > 0 ? localY / px.height + 0.5 : 0.5,
    scale: px.width > 0 ? designWidthPx / px.width : 0.5,
    angle: transform.rotation - px.rotation,
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
 * the physical size comes from the frame on the photo: how big the frame is
 * in photo pixels, converted through the reference.
 */
export function areaInches(
  area: MockupPrintArea,
  mockupW: number,
  mockupH: number,
): { width: number; height: number } | null {
  const ppi = area.reference?.pixelsPerInch ?? 0;
  if (!ppi) return null;
  const px = frameToPixels(area.frame, area, mockupW, mockupH);
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
  const crop = areaCrop(area);
  return {
    type: "print-area",
    areaWidth: area.areaWidth,
    areaHeight: area.areaHeight,
    source: area.source,
    label: area.label,
    frame: { ...area.frame },
    crop: isFullCrop(crop) ? undefined : { ...crop },
    reference: area.reference ? { ...area.reference } : undefined,
    clipMode: area.clipMode,
  };
}

/**
 * Applies a template to a mockup.
 *
 * The frame travels as a FRACTION of the photo, so a template written on one
 * mockup lands in the same relative spot on another.
 */
export function printAreaFromTemplate(payload: PrintAreaTemplatePayload): MockupPrintArea {
  return {
    areaWidth: payload.areaWidth,
    areaHeight: payload.areaHeight,
    source: payload.source,
    label: payload.label,
    frame: { ...payload.frame },
    crop: payload.crop ? { ...payload.crop } : undefined,
    reference: payload.reference ? { ...payload.reference } : undefined,
    clipMode: payload.clipMode,
    updatedAt: Date.now(),
  };
}

/** A one-line description of a template, for the template list. */
export function describePrintAreaTemplate(payload: PrintAreaTemplatePayload): string {
  const source =
    payload.source.kind === "studio"
      ? `Printify · ${payload.source.position}`
      : payload.source.kind === "preset"
        ? "Preset"
        : "Manual";
  const crop = payload.crop ? ` · ${describeCrop(areaCrop(payload))}` : "";
  return `${source} · ${payload.areaWidth}×${payload.areaHeight}${crop}`;
}

// ---------------------------------------------------------------------------
// Reading a stored area.
// ---------------------------------------------------------------------------

/**
 * The print area of a mockup, normalised.
 *
 * Every read of a mockup's area goes through this, so an area stored in the
 * old shape is upgraded on the way in.
 */
export function printAreaOf(mockup: { printArea?: unknown }): MockupPrintArea | undefined {
  return normalisePrintArea(mockup.printArea);
}

/**
 * Normalises a stored print area.
 *
 * The frame replaced an axis-aligned `box`, and the `studio` source replaced
 * `printify`. A browser that already used the feature keeps its setup: the
 * old box becomes a frame with no rotation, and the old source becomes a
 * studio source (the same blueprint, provider and position).
 */
export function normalisePrintArea(value: unknown): MockupPrintArea | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<MockupPrintArea> & {
    box?: { x: number; y: number; width: number };
    source?: PrintAreaSource | { kind: "printify"; blueprintId: number; printProviderId: number; position: string };
  };
  if (!raw.areaWidth || !raw.areaHeight) return undefined;

  const frame: AreaFrame | undefined = raw.frame
    ? {
        x: raw.frame.x ?? 0.5,
        y: raw.frame.y ?? 0.5,
        scale: raw.frame.scale ?? 0.4,
        rotation: raw.frame.rotation ?? 0,
      }
    : raw.box
      ? { x: raw.box.x, y: raw.box.y, scale: raw.box.width, rotation: 0 }
      : undefined;
  if (!frame) return undefined;

  let source: PrintAreaSource = { kind: "manual" };
  const rawSource = raw.source as PrintAreaSource | undefined;
  if (rawSource && rawSource.kind === "studio") {
    source = rawSource;
  } else if (rawSource && rawSource.kind === "preset") {
    source = rawSource;
  } else if (rawSource && (rawSource as unknown as { kind: string }).kind === "printify") {
    const legacy = rawSource as unknown as {
      kind: "printify";
      blueprintId: number;
      printProviderId: number;
      position: string;
    };
    source = {
      kind: "studio",
      blueprintId: legacy.blueprintId,
      printProviderId: legacy.printProviderId,
      position: legacy.position,
    };
  }

  const crop = raw.crop ? areaCrop({ crop: raw.crop }) : undefined;

  return {
    areaWidth: raw.areaWidth,
    areaHeight: raw.areaHeight,
    source,
    label: raw.label ?? "Print area",
    frame,
    crop: crop && !isFullCrop(crop) ? crop : undefined,
    reference: raw.reference ? { ...raw.reference } : undefined,
    clipMode: raw.clipMode ?? "area",
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}
