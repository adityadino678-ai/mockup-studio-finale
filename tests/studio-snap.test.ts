import { describe, expect, it } from "vitest";
import { snapAngle, snapPosition } from "@/lib/printify/snap";

// ---------------------------------------------------------------------------
// The Printify Studio's placement editor snaps the artwork to the middle of
// the print area and to the area's edges.
//
// Two properties make these tests worth writing:
//
//  1. The CENTRE line is the symmetry the user asked for. An artwork whose
//     centre is within the threshold of the area's centre must land on
//     exactly 0.5, not "close to 0.5" - a half-pixel off is visible on a
//     symmetric design.
//  2. The threshold is in SCREEN PIXELS, not in fractions of the area. The
//     same fractional offset has to snap in a small preview and NOT snap in a
//     large one, otherwise the snap distance changes with the zoom level.
//
// The area below is 400x400 screen pixels, so 1 pixel = 1/400 of the area and
// the default 7px threshold is 0.0175 of the area.
// ---------------------------------------------------------------------------

const AREA = { areaWidth: 400, areaHeight: 400 };

describe("snapPosition - the centre line", () => {
  it("snaps x to exactly 0.5 when it is within the threshold of the centre", () => {
    // 5px off the centre of a 400px area is well inside the 7px threshold.
    // y = 0.3 is far from every guide, so only the x axis may snap.
    const result = snapPosition({
      x: 0.505,
      y: 0.3,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
    });

    expect(result.x).toBe(0.5);
    expect(result.snappedX).toBe(true);
    expect(result.y).toBe(0.3);
    expect(result.snappedY).toBe(false);
    expect(result.label).toBe("Centre");
  });

  it("snaps y to exactly 0.5 when it is within the threshold of the centre", () => {
    const result = snapPosition({
      x: 0.3,
      y: 0.505,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
    });

    expect(result.y).toBe(0.5);
    expect(result.snappedY).toBe(true);
    expect(result.x).toBe(0.3);
    expect(result.snappedX).toBe(false);
    expect(result.label).toBe("Centre");
  });

  it("leaves the position alone when it is outside the threshold", () => {
    // Mode "centre" isolates the centre line from the edge guides.
    const result = snapPosition({
      x: 0.7,
      y: 0.62,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
      mode: "centre",
    });

    expect(result.x).toBe(0.7);
    expect(result.y).toBe(0.62);
    expect(result.snappedX).toBe(false);
    expect(result.snappedY).toBe(false);
    expect(result.label).toBeUndefined();
  });

  it("snaps an artwork that is already centred without moving it", () => {
    const result = snapPosition({
      x: 0.5,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
    });

    expect(result.x).toBe(0.5);
    expect(result.y).toBe(0.5);
    expect(result.snappedX).toBe(true);
    expect(result.snappedY).toBe(true);
    // Both axes snapped to the same guide, so the badge is one word.
    expect(result.label).toBe("Centre");
  });
});

describe("snapPosition - the threshold is in screen pixels", () => {
  it("snaps the same offset in a 400px area but not in a 4000px one", () => {
    // 1% off the centre is 4px in a 400px area and 40px in a 4000px area.
    // With an 8px threshold the first must snap and the second must not,
    // because a fixed fraction would feel completely different at every zoom.
    const input = {
      x: 0.51,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      thresholdPx: 8,
    };

    const small = snapPosition({ ...input, areaWidth: 400, areaHeight: 400 });
    expect(small.x).toBe(0.5);
    expect(small.snappedX).toBe(true);

    const large = snapPosition({ ...input, areaWidth: 4000, areaHeight: 4000 });
    expect(large.x).toBe(0.51);
    expect(large.snappedX).toBe(false);
  });

  it("uses a default snap distance of 7 screen pixels", () => {
    // 6px from the centre snaps, 8px does not.
    const inside = snapPosition({
      x: 0.56,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      areaWidth: 100,
      areaHeight: 100,
      mode: "centre",
    });
    expect(inside.x).toBe(0.5);
    expect(inside.snappedX).toBe(true);

    const outside = snapPosition({
      x: 0.58,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      areaWidth: 100,
      areaHeight: 100,
      mode: "centre",
    });
    expect(outside.x).toBe(0.58);
    expect(outside.snappedX).toBe(false);
  });
});

describe("snapPosition - edge snapping", () => {
  it("snaps the artwork's left edge to the area's left edge", () => {
    // scale 0.4 -> the artwork's half-width is 0.2 of the area, so its left
    // edge sits at x = 0.2. y = 0.3 is away from every guide, so the badge
    // only names the edge that was hit.
    const result = snapPosition({
      x: 0.205,
      y: 0.3,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
    });

    expect(result.x).toBe(0.2);
    expect(result.snappedX).toBe(true);
    expect(result.label).toBe("Left edge");
  });

  it("snaps the artwork's right edge to the area's right edge", () => {
    const result = snapPosition({
      x: 0.795,
      y: 0.3,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
    });

    expect(result.x).toBe(0.8);
    expect(result.snappedX).toBe(true);
    expect(result.label).toBe("Right edge");
  });

  it("snaps the artwork's top and bottom edges using the artwork's own height", () => {
    // scale 0.4 with a 1:2 artwork (artAspect 0.5) -> the artwork is 0.2 of
    // the area's width and 0.2 of its height, so its edges sit at 0.1/0.9.
    const top = snapPosition({
      x: 0.3,
      y: 0.102,
      scale: 0.4,
      artAspect: 0.5,
      ...AREA,
    });
    expect(top.y).toBe(0.1);
    expect(top.snappedY).toBe(true);
    expect(top.label).toBe("Top edge");

    const bottom = snapPosition({
      x: 0.3,
      y: 0.898,
      scale: 0.4,
      artAspect: 0.5,
      ...AREA,
    });
    expect(bottom.y).toBe(0.9);
    expect(bottom.snappedY).toBe(true);
    expect(bottom.label).toBe("Bottom edge");
  });

  it("converts the artwork's height with the area's aspect ratio", () => {
    // A 400x200 area: a square artwork at scale 0.4 is 0.8 of the area's
    // height, so its top edge is at y = 0.4, not at 0.2.
    const top = snapPosition({
      x: 0.3,
      y: 0.4,
      scale: 0.4,
      artAspect: 1,
      areaWidth: 400,
      areaHeight: 200,
    });
    expect(top.y).toBe(0.4);
    expect(top.snappedY).toBe(true);
    expect(top.label).toBe("Top edge");
  });
});

describe("snapPosition - modes", () => {
  it("does not edge-snap in mode 'centre'", () => {
    // 0.205 would snap to the left edge in mode "all".
    const result = snapPosition({
      x: 0.205,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
      mode: "centre",
    });

    expect(result.x).toBe(0.205);
    expect(result.snappedX).toBe(false);
    // The y axis still snaps to the centre: mode "centre" is about WHICH
    // guides exist, not about turning snapping off.
    expect(result.y).toBe(0.5);
    expect(result.snappedY).toBe(true);
    expect(result.label).toBe("Centre");
  });

  it("returns the input untouched in mode 'off'", () => {
    const result = snapPosition({
      x: 0.31,
      y: 0.62,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
      mode: "off",
    });

    expect(result.x).toBe(0.31);
    expect(result.y).toBe(0.62);
    expect(result.snappedX).toBe(false);
    expect(result.snappedY).toBe(false);
    expect(result.label).toBeUndefined();
  });

  it("does not even snap the centre in mode 'off'", () => {
    const result = snapPosition({
      x: 0.5,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      ...AREA,
      mode: "off",
    });

    expect(result.snappedX).toBe(false);
    expect(result.snappedY).toBe(false);
    expect(result.label).toBeUndefined();
  });

  it("defaults to mode 'all'", () => {
    const input = {
      x: 0.205,
      y: 0.102,
      scale: 0.4,
      artAspect: 0.5,
      ...AREA,
    };

    expect(snapPosition(input)).toEqual(snapPosition({ ...input, mode: "all" }));
    expect(snapPosition(input).snappedX).toBe(true);
  });
});

describe("snapPosition - the centre wins over an edge", () => {
  it("snaps to the centre when the centre and an edge are both in range", () => {
    // scale 0.98 -> the artwork's edges are at 0.49 and 0.51, which are
    // both inside the 7px (0.0175) threshold of each other. The centre line
    // is the symmetry the user asked for, so it must win: the result is 0.5,
    // NOT 0.49 and NOT 0.51.
    const result = snapPosition({
      x: 0.495,
      y: 0.5,
      scale: 0.98,
      artAspect: 1,
      ...AREA,
    });

    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(0.5);
    expect(result.label).toBe("Centre");
  });

  it("labels a centre snap on one axis and an edge snap on the other", () => {
    // scale 0.98 with artAspect 0.5 -> the artwork's half-height is
    // 0.245 of the area, so its top edge sits at y = 0.245.
    const result = snapPosition({
      x: 0.495,
      y: 0.245,
      scale: 0.98,
      artAspect: 0.5,
      ...AREA,
    });

    expect(result.label).toBe("Centre · Top edge");
  });
});

describe("snapPosition - degenerate input", () => {
  it("never returns NaN or Infinity", () => {
    // A preview that has not been measured yet reports a zero-sized area, and
    // an artwork can be degenerate too. None of these may poison the layout
    // with NaN, which spreads into every later calculation.
    const cases = [
      { x: 0.5, y: 0.5, scale: 0.4, artAspect: 1, areaWidth: 0, areaHeight: 0 },
      { x: 0.1, y: 0.2, scale: 0, artAspect: 1, areaWidth: 400, areaHeight: 400 },
      { x: 0.1, y: 0.2, scale: 0.4, artAspect: 0, areaWidth: 400, areaHeight: 400 },
      { x: 0.1, y: 0.2, scale: 0.4, artAspect: 1, areaWidth: 400, areaHeight: 400, thresholdPx: 0 },
      { x: 0.1, y: 0.2, scale: 0.4, artAspect: 1, areaWidth: -50, areaHeight: -50 },
    ];

    for (const input of cases) {
      const result = snapPosition(input);
      expect(Number.isFinite(result.x)).toBe(true);
      expect(Number.isFinite(result.y)).toBe(true);
      expect(typeof result.snappedX).toBe("boolean");
      expect(typeof result.snappedY).toBe("boolean");
    }
  });

  it("keeps a zero-sized area finite and centred rather than NaN", () => {
    const result = snapPosition({
      x: 0.5,
      y: 0.5,
      scale: 0.4,
      artAspect: 1,
      areaWidth: 0,
      areaHeight: 0,
    });

    expect(result.x).toBe(0.5);
    expect(result.y).toBe(0.5);
    expect(result.snappedX).toBe(true);
    expect(result.snappedY).toBe(true);
  });
});

describe("snapAngle", () => {
  it("snaps 88 degrees to 90", () => {
    const result = snapAngle(88);
    expect(result.angle).toBe(90);
    expect(result.snapped).toBe(true);
    expect(result.label).toBe("90°");
  });

  it("snaps 92 degrees to 90", () => {
    const result = snapAngle(92);
    expect(result.angle).toBe(90);
    expect(result.snapped).toBe(true);
    expect(result.label).toBe("90°");
  });

  it("does not snap 100 degrees", () => {
    // The nearest multiple of 15 is 105, which is 5 degrees away - outside
    // the 3.5 degree window.
    const result = snapAngle(100);
    expect(result.angle).toBe(100);
    expect(result.snapped).toBe(false);
    expect(result.label).toBeUndefined();
  });

  it("labels the snapped angle in degrees", () => {
    expect(snapAngle(88).label).toBe("90°");
    expect(snapAngle(2).label).toBe("0°");
    expect(snapAngle(-88).label).toBe("-90°");
  });

  it("honours a custom step", () => {
    const result = snapAngle(44, { stepDeg: 45, thresholdDeg: 5 });
    expect(result.angle).toBe(45);
    expect(result.snapped).toBe(true);
    expect(result.label).toBe("45°");

    const missed = snapAngle(52, { stepDeg: 45, thresholdDeg: 5 });
    expect(missed.angle).toBe(52);
    expect(missed.snapped).toBe(false);
  });

  it("honours a custom threshold", () => {
    // 5 degrees from 75: outside the default 3.5 degree window, inside a
    // 10 degree one.
    expect(snapAngle(80).snapped).toBe(false);
    const result = snapAngle(80, { thresholdDeg: 10 });
    expect(result.angle).toBe(75);
    expect(result.snapped).toBe(true);
  });

  it("snaps the short way round the circle", () => {
    // 179 is 1 degree from 180 and 14 degrees from 165, so it must snap
    // upwards, not downwards.
    const result = snapAngle(179);
    expect(result.angle).toBe(180);
    expect(result.snapped).toBe(true);
    expect(result.label).toBe("180°");
  });

  it("normalises the angle into (-180, 180]", () => {
    expect(snapAngle(190).angle).toBe(-170);
    expect(snapAngle(-190).angle).toBe(170);
    expect(snapAngle(180).angle).toBe(180);
    expect(snapAngle(-180).angle).toBe(180);
    expect(snapAngle(360).angle).toBe(0);
    expect(snapAngle(540).angle).toBe(180);

    for (const angle of [-720, -181, 0, 37, 181, 720]) {
      const normalised = snapAngle(angle).angle;
      expect(normalised).toBeGreaterThan(-180);
      expect(normalised).toBeLessThanOrEqual(180);
    }
  });

  it("never returns NaN or Infinity", () => {
    for (const angle of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = snapAngle(angle);
      expect(Number.isFinite(result.angle)).toBe(true);
      expect(result.angle).toBeGreaterThan(-180);
      expect(result.angle).toBeLessThanOrEqual(180);
    }
  });

  it("does not snap when the step is not a positive number", () => {
    // A step of 0 would divide by zero; the angle is returned untouched
    // instead of snapping to some arbitrary multiple.
    expect(snapAngle(88, { stepDeg: 0 }).snapped).toBe(false);
    expect(snapAngle(88, { stepDeg: 0 }).angle).toBe(88);
    expect(snapAngle(88, { stepDeg: -15 }).snapped).toBe(false);
    expect(snapAngle(88, { stepDeg: Number.NaN }).snapped).toBe(false);
  });
});
