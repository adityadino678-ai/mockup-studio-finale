// ---------------------------------------------------------------------------
// Placement maths.
//
// Printify's coordinate system is centre-based: the print area's centre is
// x=0.5, y=0.5, and `scale` is the image width as a fraction of the print
// area's width. Printify's own rule of thumb: artwork the width of the
// placeholder, at scale 1, x 0.5, y 0.5 fills the area exactly.
// ---------------------------------------------------------------------------
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
