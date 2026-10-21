// ---------------------------------------------------------------------------
// Snapping for the Printify Studio's placement editor.
//
// Printify's own editor snaps the artwork to the middle of the print area and
// to the area's edges, and draws a guide while the artwork is snapped. This
// module is the pure core of that behaviour: no DOM, no React, so it can be
// unit-tested on its own and reused by the preview component.
//
// The thresholds are in SCREEN pixels, never in fractions of the area. A fixed
// fraction would feel different at every zoom level (7px on a 320px-wide
// preview is a big move, on a 1200px-wide preview it is a nudge), so the
// caller divides the pixel threshold by the area's ON-SCREEN size to get the
// fractional distance. `areaWidth`/`areaHeight` below are therefore expected to
// be in the same pixel space as `thresholdPx` - the preview passes the
// measured on-screen size of the print area, not the print resolution.
// ---------------------------------------------------------------------------

/** Which guides the artwork may snap to. */
export type SnapMode = "all" | "centre" | "off";

export interface SnapResult {
  x: number;
  y: number;
  /** True when the value snapped to the centre line. */
  snappedX: boolean;
  /** True when the value snapped to the centre line. */
  snappedY: boolean;
  /** Human-readable name of what it snapped to, e.g. "Centre", "Left edge". */
  label?: string;
}

/** Default snap distance, in screen pixels. */
const DEFAULT_SNAP_PX = 7;

/** Default rotation step, in degrees. */
const DEFAULT_ANGLE_STEP = 15;

/** Default rotation snap window, in degrees. */
const DEFAULT_ANGLE_THRESHOLD = 3.5;

/**
 * Snaps the artwork's centre inside the print area.
 *
 * The centre line is the symmetry the user asked for: when the artwork's
 * centre is within the threshold of the area's centre it snaps to exactly
 * 0.5 on that axis. In mode "all" the artwork's own edges also snap to the
 * area's edges, so the artwork lines up with the printable border.
 *
 * `scale` is the artwork's width as a fraction of the area's width and
 * `artAspect` its height over its width, so the edge snapping knows where the
 * artwork's border actually is without knowing the artwork's pixel size.
 */
export function snapPosition(input: {
  x: number;
  y: number;
  /** Artwork width as a fraction of the area width. */
  scale: number;
  /** Artwork height / artwork width. */
  artAspect: number;
  areaWidth: number;
  areaHeight: number;
  /** Snap distance in SCREEN pixels. */
  thresholdPx?: number;
  mode?: SnapMode;
}): SnapResult {
  const { x, y, scale, artAspect } = input;
  const mode = input.mode ?? "all";

  if (mode === "off") {
    return { x, y, snappedX: false, snappedY: false };
  }

  const thresholdPx = input.thresholdPx ?? DEFAULT_SNAP_PX;
  // A zero-sized area means the preview has not been measured yet; a
  // threshold of "the whole area" keeps the maths finite instead of NaN.
  const areaWidth = input.areaWidth > 0 ? input.areaWidth : 1;
  const areaHeight = input.areaHeight > 0 ? input.areaHeight : 1;

  // The threshold as a fraction of the area, per axis.
  const thresholdX = thresholdPx / areaWidth;
  const thresholdY = thresholdPx / areaHeight;

  // The artwork's half-extent as a fraction of the area, per axis.
  const halfWidth = scale / 2;
  const halfHeight = (scale * artAspect * (areaWidth / areaHeight)) / 2;

  let snappedX = false;
  let snappedY = false;
  let labelX: string | undefined;
  let labelY: string | undefined;
  let nextX = x;
  let nextY = y;

  // The centre line wins over the edges: centring is the symmetry the user
  // asked for, and an artwork whose centre is near 0.5 is also usually near
  // an edge when it is large, so the order has to be explicit.
  if (Math.abs(x - 0.5) <= thresholdX) {
    nextX = 0.5;
    snappedX = true;
    labelX = "Centre";
  } else if (mode === "all") {
    if (Math.abs(x - halfWidth) <= thresholdX) {
      nextX = halfWidth;
      snappedX = true;
      labelX = "Left edge";
    } else if (Math.abs(x - (1 - halfWidth)) <= thresholdX) {
      nextX = 1 - halfWidth;
      snappedX = true;
      labelX = "Right edge";
    }
  }

  if (Math.abs(y - 0.5) <= thresholdY) {
    nextY = 0.5;
    snappedY = true;
    labelY = "Centre";
  } else if (mode === "all") {
    if (Math.abs(y - halfHeight) <= thresholdY) {
      nextY = halfHeight;
      snappedY = true;
      labelY = "Top edge";
    } else if (Math.abs(y - (1 - halfHeight)) <= thresholdY) {
      nextY = 1 - halfHeight;
      snappedY = true;
      labelY = "Bottom edge";
    }
  }

  return {
    x: nextX,
    y: nextY,
    snappedX,
    snappedY,
    label: combineLabels(labelX, labelY),
  };
}

/**
 * Snaps a rotation to the nearest multiple of `stepDeg` when it is within
 * `thresholdDeg` of it.
 *
 * The returned angle is always normalised to (-180, 180], which is the range
 * the studio's rotation slider uses.
 */
export function snapAngle(
  angle: number,
  input?: { stepDeg?: number; thresholdDeg?: number },
): { angle: number; snapped: boolean; label?: string } {
  const step = input?.stepDeg ?? DEFAULT_ANGLE_STEP;
  const threshold = input?.thresholdDeg ?? DEFAULT_ANGLE_THRESHOLD;
  const normalised = normaliseAngle(angle);

  if (!Number.isFinite(step) || step <= 0) {
    return { angle: normalised, snapped: false };
  }

  const nearest = Math.round(normalised / step) * step;
  // The distance is measured the short way round, so 179 degrees snaps to
  // 180 rather than to 165.
  let distance = Math.abs(normalised - nearest);
  if (distance > 180) distance = 360 - distance;

  if (distance <= threshold) {
    const snapped = normaliseAngle(nearest);
    return { angle: snapped, snapped: true, label: `${formatAngle(snapped)}°` };
  }
  return { angle: normalised, snapped: false };
}

/** Normalises an angle in degrees to (-180, 180]. */
function normaliseAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const wrapped = ((angle % 360) + 360) % 360;
  if (wrapped > 180) return wrapped - 360;
  return wrapped;
}

/**
 * Formats an angle for the badge: 90, 22.5, -15. Rounded to two decimals
 * because the angle comes from a pointer gesture and is full of float noise.
 */
function formatAngle(angle: number): string {
  return String(Math.round(angle * 100) / 100);
}

/** Joins the per-axis labels into the single badge text. */
function combineLabels(labelX: string | undefined, labelY: string | undefined): string | undefined {
  if (labelX && labelY) return labelX === labelY ? labelX : `${labelX} · ${labelY}`;
  return labelX ?? labelY;
}
