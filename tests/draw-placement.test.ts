import { describe, expect, it } from "vitest";
import { computeGeometry, drawPlacement } from "@/lib/canvas/compose";
import type { ClipRect } from "@/lib/canvas/compose";
import { DEFAULT_TRANSFORM, type Transform } from "@/types/domain";

// ---------------------------------------------------------------------------
// `drawPlacement` is the only function that turns a plan into pixels, and it
// had no test. The clip path is applied in CANVAS space and then undone so the
// design is not drawn turned with it; undoing it in the wrong order leaves a
// residual translation of `c - R(phi)·c` behind, which slid the artwork away
// from the preview by tens of pixels on any rotated frame.
//
// The fake context below is a faithful 2D affine matrix, so the assertions are
// about the CTM the design is actually drawn under - not about call order.
// ---------------------------------------------------------------------------

type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

interface Snapshot {
  matrix: Matrix;
  alpha: number;
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** A minimal CanvasRenderingContext2D that records the matrices it is used with. */
function fakeContext() {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  let alpha = 1;
  const stack: Snapshot[] = [];
  const draws: Snapshot[] = [];
  const clips: Snapshot[] = [];
  let rectAtClip: { x: number; y: number; width: number; height: number } | null = null;

  const ctx = {
    globalAlpha: 1,
    imageSmoothingQuality: "high" as ImageSmoothingQuality,
    save() {
      stack.push({ matrix: [...matrix] as Matrix, alpha });
    },
    restore() {
      const previous = stack.pop();
      if (previous) {
        matrix = previous.matrix;
        alpha = previous.alpha;
      }
    },
    beginPath() {},
    translate(x: number, y: number) {
      matrix = multiply(matrix, [1, 0, 0, 1, x, y]);
    },
    rotate(rad: number) {
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      matrix = multiply(matrix, [cos, sin, -sin, cos, 0, 0]);
    },
    scale(x: number, y: number) {
      matrix = multiply(matrix, [x, 0, 0, y, 0, 0]);
    },
    rect(x: number, y: number, width: number, height: number) {
      rectAtClip = { x, y, width, height };
    },
    clip() {
      clips.push({ matrix: [...matrix] as Matrix, alpha });
    },
    drawImage() {
      draws.push({ matrix: [...matrix] as Matrix, alpha });
    },
  };

  // `globalAlpha` is read off the object, so keep it in sync with `alpha`.
  Object.defineProperty(ctx, "globalAlpha", {
    get: () => alpha,
    set: (value: number) => {
      alpha = value;
    },
  });

  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    draws,
    clips,
    rectAtClip: () => rectAtClip,
  };
}

const t = (patch: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...patch });

function draw(opts: {
  mockupW?: number;
  mockupH?: number;
  designW?: number;
  designH?: number;
  transform?: Partial<Transform>;
  clip?: ClipRect;
}) {
  const mockupW = opts.mockupW ?? 1000;
  const mockupH = opts.mockupH ?? 1000;
  const designW = opts.designW ?? 2000;
  const designH = opts.designH ?? 2400;
  const transform = t(opts.transform);
  const geo = computeGeometry(mockupW, mockupH, designW, designH, transform);
  const harness = fakeContext();
  drawPlacement(
    harness.ctx,
    { width: designW, height: designH } as unknown as CanvasImageSource,
    geo,
    transform,
    opts.clip,
  );
  return { geo, transform, ...harness };
}

describe("drawPlacement", () => {
  it("draws the design centred where the geometry says, with a rotated clip", () => {
    // The reported case: a slightly rotated frame with a top-51% window.
    const { geo, transform, draws } = draw({
      transform: { x: 0.4755, y: 0.7294, scale: 0.231, rotation: 4 },
      clip: { x: 508.613529, y: 496.820791, width: 420, height: 257.04, rotation: 4 },
    });

    expect(draws).toHaveLength(1);
    const world = apply(draws[0].matrix, 0, 0);
    // The design's own centre is local (0,0) at draw time.
    expect(world.x).toBeCloseTo(geo.cx, 6);
    expect(world.y).toBeCloseTo(geo.cy, 6);
    expect(transform.rotation).toBeCloseTo(4);
  });

  it("leaves no residual translation for any clip rotation", () => {
    for (const rotation of [-15, -4, 0, 4, 15, 37]) {
      const { geo, draws } = draw({
        transform: { x: 0.5, y: 0.5, scale: 0.3 },
        clip: { x: 500, y: 620, width: 420, height: 504, rotation },
      });
      const world = apply(draws[0].matrix, 0, 0);
      expect(world.x).toBeCloseTo(geo.cx, 6);
      expect(world.y).toBeCloseTo(geo.cy, 6);
    }
  });

  it("is unaffected by where the clip sits on the photo", () => {
    // The bug's magnitude grew with the clip centre's distance from the origin,
    // so a near-origin and a far one must both land exactly on the centre.
    const near = draw({
      transform: { x: 0.2, y: 0.2, scale: 0.2 },
      clip: { x: 100, y: 100, width: 200, height: 200, rotation: 8 },
    });
    const far = draw({
      transform: { x: 0.8, y: 0.8, scale: 0.2 },
      clip: { x: 900, y: 900, width: 200, height: 200, rotation: 8 },
    });
    for (const result of [near, far]) {
      const world = apply(result.draws[0].matrix, 0, 0);
      expect(world.x).toBeCloseTo(result.geo.cx, 6);
      expect(world.y).toBeCloseTo(result.geo.cy, 6);
    }
  });

  it("clips the rotated window where clipFor describes it", () => {
    const clip: ClipRect = { x: 500, y: 620, width: 420, height: 504, rotation: 12 };
    const { clips, rectAtClip } = draw({ clip });

    expect(clips).toHaveLength(1);
    // The clip is built in its own local space, then carried by the matrix.
    const local = rectAtClip();
    expect(local).not.toBeNull();
    expect(local!.width).toBeCloseTo(clip.width);
    expect(local!.height).toBeCloseTo(clip.height);

    const centre = apply(clips[0].matrix, 0, 0);
    expect(centre.x).toBeCloseTo(clip.x, 6);
    expect(centre.y).toBeCloseTo(clip.y, 6);
    // A 12° turn: the matrix's linear part must carry it, not just the position.
    const unit = apply(clips[0].matrix, 1, 0);
    expect(Math.atan2(unit.y - centre.y, unit.x - centre.x)).toBeCloseTo(
      (12 * Math.PI) / 180,
      6,
    );
  });

  it("applies opacity and still draws with no clip", () => {
    const { draws } = draw({ transform: { opacity: 0.4 } });
    expect(draws).toHaveLength(1);
    expect(draws[0].alpha).toBeCloseTo(0.4);
  });

  it("skips a design with no drawable size", () => {
    const harness = fakeContext();
    const transform = t();
    const geo = { cx: 10, cy: 10, drawW: 0, drawH: 0, designW: 1, designH: 1 };
    drawPlacement(
      harness.ctx,
      { width: 1, height: 1 } as unknown as CanvasImageSource,
      geo,
      transform,
      { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    );
    expect(harness.draws).toHaveLength(0);
  });
});
