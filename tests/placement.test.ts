import { describe, expect, it } from "vitest";
import { computeGeometry } from "@/lib/canvas/compose";
import { DEFAULT_TRANSFORM, type Transform } from "@/types/domain";

const t = (patch: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...patch });

describe("placement geometry", () => {
  it("scales the design relative to the mockup width", () => {
    const geo = computeGeometry(1200, 1500, 800, 1000, t({ scale: 0.35 }));
    expect(geo.drawW).toBeCloseTo(420);
    // 35% of 1200 wide, aspect preserved from the 800×1000 design.
    expect(geo.drawH).toBeCloseTo(525);
  });

  it("positions the design center as a fraction of the mockup", () => {
    const geo = computeGeometry(1000, 500, 200, 200, t({ x: 0.6, y: 0.45 }));
    expect(geo.cx).toBeCloseTo(600);
    expect(geo.cy).toBeCloseTo(225);
  });

  it("applies the vertical stretch multiplier", () => {
    const locked = computeGeometry(1000, 1000, 100, 100, t({ scale: 0.5 }));
    const stretched = computeGeometry(1000, 1000, 100, 100, t({ scale: 0.5, stretch: 2 }));
    expect(stretched.drawH).toBeCloseTo(locked.drawH * 2);
    expect(stretched.drawW).toBeCloseTo(locked.drawW);
  });

  it("keeps percentages stable across different mockup sizes (templates transfer)", () => {
    const small = computeGeometry(600, 600, 300, 300, t({ scale: 0.4, x: 0.5, y: 0.5 }));
    const large = computeGeometry(1800, 1800, 300, 300, t({ scale: 0.4, x: 0.5, y: 0.5 }));
    expect(small.drawW / small.cx).toBeCloseTo(large.drawW / large.cx);
  });

  it("rejects designs with no dimensions", () => {
    expect(() => computeGeometry(100, 100, 0, 100, t())).toThrow(/invalid dimensions/i);
  });
});