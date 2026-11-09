import { describe, expect, it } from "vitest";
import { floodKeyRemoveBackground, FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import {
  applyMaskToPixels,
  featherMask,
  fillSmallHoles,
  guidedFilterMaskApprox,
  maskIoU,
  removeExtraColourFromPixels,
  removeTinyIslands,
  upscaleMaskBilinear,
} from "@/lib/bg-removal/ml-mask";
import { decideRemoval } from "@/lib/printify/remove-background";

function makeImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = paint(x, y);
    const i = (y * w + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
  return px;
}

function maskFromAlpha(px: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(px.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] > 128 ? 1 : 0;
  return out;
}

function referenceDisc(w: number, h: number, cx: number, cy: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
  }
  return out;
}

const W = 64;
const H = 64;

describe("ML mask refine + IoU fixtures", () => {
  it("solid background: flood-key mask scores high IoU", () => {
    const px = makeImage(W, H, (x, y) =>
      Math.hypot(x - 32, y - 32) <= 16 ? [200, 40, 40, 255] : [255, 255, 255, 255],
    );
    floodKeyRemoveBackground(px, W, H, FLOOD_KEY_DEFAULTS);
    const iou = maskIoU(maskFromAlpha(px), referenceDisc(W, H, 32, 32, 16));
    expect(iou).toBeGreaterThan(0.85);
  });

  it("gradient background: border-aware refine keeps IoU high", () => {
    const px = makeImage(W, H, (x, y) => {
      const inside = Math.hypot(x - 32, y - 32) <= 16;
      if (inside) return [40, 120, 200, 255];
      const t = x / W;
      const g = Math.round(120 + t * 120);
      return [g, g, g, 255];
    });
    // Synthetic ML mask (perfect) through refine must stay accurate.
    const ref = referenceDisc(W, H, 32, 32, 16);
    const soft = Float32Array.from(ref, (v) => v);
    let refined = removeTinyIslands(soft, W, H, 16);
    refined = fillSmallHoles(refined, W, H, 256);
    refined = guidedFilterMaskApprox(refined, px, W, H, 2);
    refined = featherMask(refined, W, H, 1);
    upscaleMaskBilinear(refined, W, H, W, H); // exercises upscale at same size
    const applied = new Uint8ClampedArray(px);
    applyMaskToPixels(applied, W, H, refined);
    expect(maskIoU(maskFromAlpha(applied), ref)).toBeGreaterThan(0.8);
  });

  it("busy photo: refined ML mask is robust (synthetic busy fixture)", () => {
    const px = makeImage(W, H, (x, y) => {
      const inside = Math.hypot(x - 32, y - 32) <= 16;
      if (inside) return [20, 20, 20, 255];
      // Busy checker-ish background flood-key cannot touch.
      return (x + y) % 2 === 0 ? [180, 180, 180, 255] : [60, 60, 60, 255];
    });
    const ref = referenceDisc(W, H, 32, 32, 16);
    // Noisy mask: 5% flipped bits + tiny islands must be cleaned.
    const noisy = Float32Array.from(ref, (v, i) => (i % 20 === 0 ? 1 - v : v));
    let cleaned = removeTinyIslands(noisy, W, H, 16);
    cleaned = fillSmallHoles(cleaned, W, H, 256);
    const applied = new Uint8ClampedArray(px);
    applyMaskToPixels(applied, W, H, cleaned);
    expect(maskIoU(maskFromAlpha(applied), ref)).toBeGreaterThan(0.75);
  });

  it("thin lines / hair: small holes are filled without eating the subject", () => {
    const px = makeImage(W, H, (x, y) =>
      Math.hypot(x - 32, y - 32) <= 18 ? [230, 230, 230, 255] : [20, 20, 20, 255],
    );
    // Thin hair gap: a 1px-wide slit inside the subject.
    const ref = referenceDisc(W, H, 32, 32, 18);
    const mask = Float32Array.from(ref, (v) => v);
    for (let y = 14; y < 50; y++) mask[y * W + 32] = 0;
    const filled = fillSmallHoles(mask, W, H, 256);
    expect(maskIoU(filled, ref)).toBeGreaterThan(0.9);
    void px;
  });

  it("already-transparent image scores 1.0 via transparent check + decide path", () => {
    const px = makeImage(W, H, () => [255, 255, 255, 0]);
    const ref = new Uint8Array(W * H); // all background
    const soft = new Float32Array(W * H);
    const applied = new Uint8ClampedArray(px);
    applyMaskToPixels(applied, W, H, soft);
    expect(maskIoU(maskFromAlpha(applied), ref)).toBe(1);
    // decideRemoval for ml mirrors the flood/border sanity gates.
    expect(decideRemoval({ removed: 0.5, transparency: 0.5, engine: "ml" })).toEqual({ action: "use-ml" });
  });

  it("artwork mode preserves enclosed white text (flood is border-connected)", () => {
    // White text inside a red square on a white background: the enclosed
    // white island is NOT border-connected, so flood must keep it.
    const px = makeImage(W, H, (x, y) => {
      const inSquare = x > 10 && x < 54 && y > 10 && y < 54;
      if (!inSquare) return [255, 255, 255, 255];
      const inText = x > 28 && x < 36 && y > 28 && y < 36;
      return inText ? [255, 255, 255, 255] : [200, 40, 40, 255];
    });
    floodKeyRemoveBackground(px, W, H, FLOOD_KEY_DEFAULTS);
    const centre = (32 * W + 32) * 4;
    expect(px[centre + 3]).toBe(255);
  });

  it("extra-colour removal clears the picked colour everywhere", () => {
    const px = makeImage(8, 8, () => [255, 0, 0, 255]);
    removeExtraColourFromPixels(px, 8, 8, { r: 255, g: 0, b: 0 }, 10);
    for (let i = 0; i < 64; i++) expect(px[i * 4 + 3]).toBe(0);
  });

  it("upscale + feather preserve a soft edge at original resolution", () => {
    const small = new Float32Array([0, 0.5, 1, 1]);
    const up = upscaleMaskBilinear(small, 2, 2, 4, 4);
    expect(up.length).toBe(16);
    const feathered = featherMask(up, 4, 4, 1);
    expect(feathered.length).toBe(16);
    expect(feathered.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
