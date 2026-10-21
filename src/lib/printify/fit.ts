// ---------------------------------------------------------------------------
// Placement maths.
//
// Printify's coordinate system is centre-based: the print area's centre is
// x=0.5, y=0.5, and `scale` is the image width as a fraction of the print
// area's width. Printify's own rule of thumb: artwork the width of the
// placeholder, at scale 1, x 0.5, y 0.5 fills the area exactly.
//
// The fit rule below matches the one real bulk uploader uses: fit the artwork
// into the area, but never upscale it beyond twice the size that would fill
// the area (tiny artwork stays small rather than being blown up to a poster).
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

/** Largest upscale we will apply, as a multiple of "fills the area". */
export const MAX_UPSCALE = 2;

/** The multiplier that fits the artwork into the area (no upscale limit). */
function rawFit(aw: number, ah: number, ow: number, oh: number): number {
  return Math.min(aw / ow, ah / oh);
}

/**
 * Fits artwork into a print area and returns Printify's placement values.
 *
 * Small artwork may be scaled up to fill the area, but never beyond
 * `MAX_UPSCALE` times the size that would fill it.
 */
export function computeFit(input: FitInput): FitResult {
  const { artworkWidth: ow, artworkHeight: oh, areaWidth: aw, areaHeight: ah } = input;
  if (ow <= 0 || oh <= 0 || aw <= 0 || ah <= 0) {
    throw new Error("Artwork and print area must both have positive dimensions");
  }
  const factor =
    ow < aw / 2 && oh < ah / 2
      ? Math.min(MAX_UPSCALE, rawFit(aw, ah, ow * 2, oh * 2))
      : rawFit(aw, ah, ow, oh);

  const width = ow * factor;
  const height = oh * factor;
  const offsetX = (aw - width) / 2 / aw;
  const offsetY = (ah - height) / 2 / ah;
  const scale = width / aw;
  return {
    scale,
    x: offsetX + scale / 2,
    y: offsetY + height / ah / 2,
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
