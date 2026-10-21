// ---------------------------------------------------------------------------
// Placement maths.
//
// Printify's coordinate system is centre-based: the print area's centre is
// x=0.5, y=0.5, and `scale` is the image width as a fraction of the print
// area's width. Printify's own rule of thumb: artwork the width of the
// placeholder, at scale 1, x 0.5, y 0.5 fills the area exactly.
//
// The fit rule below matches the one real bulk uploader uses: fit the artwork
// into the area, but never upscale it beyond twice its OWN original size, and
// never past half the size that would fill the area. Tiny artwork stays small
// rather than being blown up to a poster.
// ---------------------------------------------------------------------------

export interface FitInput {
  /** Artwork width in pixels. */
  artworkWidth: number;
  /** Artwork height in pixels. */
  artworkHeight: number;
  /** Print-area width in pixels (the placeholder width). */
  areaWidth: number;
  /** Print-area height in pixels (the placeholder height). */
  areaHeight: number;
}

export interface FitResult {
  /** Printify `scale`: image width as a fraction of the print-area width. */
  scale: number;
  /** Printify `x`: centre of the artwork within the print area, 0..1. */
  x: number;
  /** Printify `y`: centre of the artwork within the print area, 0..1. */
  y: number;
  /** Scaled artwork size in pixels. */
  width: number;
  height: number;
  /** Left edge of the artwork as a fraction of the area width (0..1). */
  offsetX: number;
  /** Top edge of the artwork as a fraction of the area height (0..1). */
  offsetY: number;
  /** The multiplier applied to the artwork to reach `width`/`height`. */
  factor: number;
}

/**
 * Largest upscale we will apply, as a multiple of the artwork's OWN size.
 *
 * A 100px-wide design in a 3000px-wide print area is drawn at 200px wide,
 * not at 3000px: Printify's uploader treats the artwork's own size as the
 * limit, and a blown-up thumbnail would fail the resolution check anyway.
 */
export const MAX_UPSCALE = 2;

/**
 * The multiplier that fits the artwork into the area (no upscale limit).
 *
 * The parameters are named for the values the caller passes: the area's size
 * first, the artwork's size second. The result is the factor the artwork has
 * to be scaled BY, so the artwork ends up filling the area on its shorter
 * side.
 */
function rawFit(areaW: number, areaH: number, artW: number, artH: number): number {
  return Math.min(areaW / artW, areaH / artH);
}

/**
 * Fits artwork into a print area and returns Printify's placement values.
 *
 * Artwork that is at least half the area on both sides is scaled so that it
 * fills the area. Smaller artwork is scaled up too, but never beyond
 * `MAX_UPSCALE` times its own size, and never past half the size that would
 * fill the area.
 */
export function computeFit(input: FitInput): FitResult {
  const {
    artworkWidth: artW,
    artworkHeight: artH,
    areaWidth: areaW,
    areaHeight: areaH,
  } = input;
  if (artW <= 0 || artH <= 0 || areaW <= 0 || areaH <= 0) {
    throw new Error("Artwork and print area must both have positive dimensions");
  }
  const factor =
    artW < areaW / 2 && artH < areaH / 2
      ? Math.min(MAX_UPSCALE, rawFit(areaW, areaH, artW * 2, artH * 2))
      : rawFit(areaW, areaH, artW, artH);

  const width = artW * factor;
  const height = artH * factor;
  const offsetX = (areaW - width) / 2 / areaW;
  const offsetY = (areaH - height) / 2 / areaH;
  const scale = width / areaW;
  return {
    scale,
    x: offsetX + scale / 2,
    y: offsetY + height / areaH / 2,
    width,
    height,
    offsetX,
    offsetY,
    factor,
  };
}

/** The print-area pixel size a placement is expressed against. */
export interface PrintArea {
  position: string;
  width: number;
  height: number;
}

/** Clamps a placement into the ranges Printify accepts. */
export function clampPlacement(placement: {
  x?: number;
  y?: number;
  scale?: number;
  angle?: number;
}): { x: number; y: number; scale: number; angle: number } {
  return {
    x: clamp(placement.x ?? 0.5, 0, 1),
    y: clamp(placement.y ?? 0.5, 0, 1),
    scale: Math.max(0.01, placement.scale ?? 1),
    angle: ((placement.angle ?? 0) % 360 + 360) % 360,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
