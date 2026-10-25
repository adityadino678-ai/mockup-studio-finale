import { describe, expect, it } from "vitest";
import { refineEdges } from "@/lib/bg-removal/edge-refine";
import { floodKeyRemoveBackground, FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import { borderModelRemoveBackground, BORDER_MODEL_DEFAULTS } from "@/lib/bg-removal/border-model";

// ---------------------------------------------------------------------------
// Edge refinement.
//
// The failure this pins: artwork flattened onto a DARK background keeps the
// backdrop in the RGB of its anti-aliased edge pixels. The mask feathers the
// alpha, but a 50%-covered pixel's colour is still a 50/50 blend, so the
// cutout shows a dark fringe/halo. After refinement the edge pixel should
// carry the SUBJECT's colour and only its alpha should carry the coverage.
//
// The metric is the mean RGB distance from the fully-covered subject colour
// across the semi-transparent ring: it must go DOWN materially, not by a
// rounding step.
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

const SIZE = 25;
const CENTRE = (SIZE - 1) / 2;
const RADIUS = 8;
const BACKGROUND: Rgb = [12, 12, 16]; // near-black studio card
const FOREGROUND: Rgb = [235, 70, 60]; // saturated red subject

/** The anti-aliasing coverage (0..1) the synthetic image was built from. */
function coverageAt(x: number, y: number): number {
  const distance = Math.hypot(x - CENTRE, y - CENTRE);
  return Math.max(0, Math.min(1, RADIUS + 0.5 - distance));
}

/**
 * An opaque image of a disc whose edge is a real RGB blend of the background
 * and the subject - exactly what a flattened anti-aliased shape looks like.
 */
function antiAliasedDisc(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const coverage = coverageAt(x, y);
      const p = (y * SIZE + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[p + channel] = Math.round(
          BACKGROUND[channel] + (FOREGROUND[channel] - BACKGROUND[channel]) * coverage,
        );
      }
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

function rgbDistance(pixels: Uint8ClampedArray, p: number, target: Rgb): number {
  const dr = pixels[p] - target[0];
  const dg = pixels[p + 1] - target[1];
  const db = pixels[p + 2] - target[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Mean RGB distance from the true subject colour across the anti-aliased ring.
 * Fully removed pixels are excluded: their colour is the background's and they
 * are not part of the visible edge any more.
 */
function edgeContamination(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const coverage = coverageAt(x, y);
      if (coverage < 0.35 || coverage > 0.9) continue;
      const p = (y * SIZE + x) * 4;
      if (pixels[p + 3] === 0) continue;
      sum += rgbDistance(pixels, p, FOREGROUND);
      count++;
    }
  }
  expect(count).toBeGreaterThan(10);
  return sum / count;
}

/** Mean error of the alpha the mask assigned against the true coverage. */
function alphaError(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const coverage = coverageAt(x, y);
      if (coverage < 0.35 || coverage > 0.9) continue;
      const p = (y * SIZE + x) * 4;
      if (pixels[p + 3] === 0) continue;
      sum += Math.abs(pixels[p + 3] - coverage * 255);
      count++;
    }
  }
  return sum / count;
}

function alphaAt(pixels: Uint8ClampedArray, x: number, y: number): number {
  return pixels[(y * SIZE + x) * 4 + 3];
}

function pixelAt(pixels: Uint8ClampedArray, x: number, y: number): Rgb {
  const p = (y * SIZE + x) * 4;
  return [pixels[p], pixels[p + 1], pixels[p + 2]];
}

describe("flood-key edge refinement over a dark background", () => {
  it("pulls the anti-aliased edge towards the subject colour", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    floodKeyRemoveBackground(pixels, SIZE, SIZE, FLOOD_KEY_DEFAULTS);

    const contaminationBefore = edgeContamination(before);
    const contaminationAfter = edgeContamination(pixels);
    // Measured on this synthetic: ~94 before, ~1 after.
    expect(contaminationAfter).toBeLessThan(contaminationBefore * 0.35);
    expect(contaminationAfter).toBeLessThan(8);
  });

  it("makes the alpha track the true coverage instead of a flat 255", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    floodKeyRemoveBackground(pixels, SIZE, SIZE, FLOOD_KEY_DEFAULTS);

    const errorBefore = alphaError(before);
    const errorAfter = alphaError(pixels);
    // Measured on this synthetic: ~102 before, ~31 after.
    expect(errorAfter).toBeLessThan(errorBefore * 0.5);
    expect(errorAfter).toBeLessThan(45);
  });

  it("keeps the fully opaque interior pixel untouched", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    floodKeyRemoveBackground(pixels, SIZE, SIZE, FLOOD_KEY_DEFAULTS);

    const centre = (Math.floor(CENTRE) * SIZE + Math.floor(CENTRE)) * 4;
    expect(pixels[centre + 3]).toBe(255);
    expect([pixels[centre], pixels[centre + 1], pixels[centre + 2]]).toEqual(
      Array.from(before.slice(centre, centre + 3)),
    );
    expect(pixelAt(pixels, Math.floor(CENTRE), Math.floor(CENTRE))).toEqual(FOREGROUND);
  });

  it("leaves the fully removed background at alpha 0 with its colour intact", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    floodKeyRemoveBackground(pixels, SIZE, SIZE, FLOOD_KEY_DEFAULTS);

    expect(alphaAt(pixels, 0, 0)).toBe(0);
    expect(alphaAt(pixels, SIZE - 1, SIZE - 1)).toBe(0);
    // A removed pixel is never recoloured: no invented colour.
    expect(pixelAt(pixels, 0, 0)).toEqual(pixelAt(before, 0, 0));
    expect(pixelAt(pixels, 0, 0)).toEqual(BACKGROUND);
  });
});

describe("border-model edge refinement over a dark background", () => {
  it("pulls the anti-aliased edge towards the subject colour", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    borderModelRemoveBackground(pixels, SIZE, SIZE, BORDER_MODEL_DEFAULTS);

    const contaminationBefore = edgeContamination(before);
    const contaminationAfter = edgeContamination(pixels);
    // Measured on this synthetic: ~94 before, ~1 after.
    expect(contaminationAfter).toBeLessThan(contaminationBefore * 0.35);
    expect(contaminationAfter).toBeLessThan(8);
  });

  it("makes the alpha track the true coverage instead of a flat 255", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    borderModelRemoveBackground(pixels, SIZE, SIZE, BORDER_MODEL_DEFAULTS);

    const errorBefore = alphaError(before);
    const errorAfter = alphaError(pixels);
    // Measured on this synthetic: ~102 before, ~31 after.
    expect(errorAfter).toBeLessThan(errorBefore * 0.5);
    expect(errorAfter).toBeLessThan(45);
  });

  it("keeps the fully opaque interior pixel untouched", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    borderModelRemoveBackground(pixels, SIZE, SIZE, BORDER_MODEL_DEFAULTS);

    const centre = Math.floor(CENTRE);
    expect(alphaAt(pixels, centre, centre)).toBe(255);
    expect(pixelAt(pixels, centre, centre)).toEqual(FOREGROUND);
    const p = (centre * SIZE + centre) * 4;
    expect([pixels[p], pixels[p + 1], pixels[p + 2]]).toEqual(
      Array.from(before.slice(p, p + 3)),
    );
  });

  it("leaves the fully removed background at alpha 0 with its colour intact", () => {
    const pixels = antiAliasedDisc();
    const before = new Uint8ClampedArray(pixels);

    borderModelRemoveBackground(pixels, SIZE, SIZE, BORDER_MODEL_DEFAULTS);

    expect(alphaAt(pixels, 0, 0)).toBe(0);
    expect(alphaAt(pixels, SIZE - 1, SIZE - 1)).toBe(0);
    expect(pixelAt(pixels, 4, 4)).toEqual(pixelAt(before, 4, 4));
  });
});

describe("refineEdges morphology and safety", () => {
  /** A buffer of one colour and one alpha. */
  function uniform(
    width: number,
    height: number,
    rgb: Rgb,
    alpha: number,
  ): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = rgb[0];
      pixels[i * 4 + 1] = rgb[1];
      pixels[i * 4 + 2] = rgb[2];
      pixels[i * 4 + 3] = alpha;
    }
    return pixels;
  }

  it("removes an isolated opaque speck in the removed region", () => {
    const width = 7;
    const height = 7;
    const pixels = uniform(width, height, BACKGROUND, 0);
    const centre = (3 * width + 3) * 4;
    pixels[centre] = FOREGROUND[0];
    pixels[centre + 1] = FOREGROUND[1];
    pixels[centre + 2] = FOREGROUND[2];
    pixels[centre + 3] = 255;

    refineEdges(pixels, width, height);

    expect(pixels[centre + 3]).toBe(0);
  });

  it("fills a 1 px pinhole in the kept region with the neighbours' colour", () => {
    const width = 7;
    const height = 7;
    const pixels = uniform(width, height, FOREGROUND, 255);
    const centre = (3 * width + 3) * 4;
    pixels[centre + 3] = 0;

    refineEdges(pixels, width, height);

    expect(pixels[centre + 3]).toBe(255);
    expect(pixels[centre]).toBe(FOREGROUND[0]);
    expect(pixels[centre + 1]).toBe(FOREGROUND[1]);
    expect(pixels[centre + 2]).toBe(FOREGROUND[2]);
  });

  it("does not touch a fully opaque interior pixel", () => {
    // Everything opaque: there is no removed region, so there is no band and
    // no pixel may change.
    const width = 7;
    const height = 7;
    const pixels = uniform(width, height, FOREGROUND, 255);
    const before = new Uint8ClampedArray(pixels);

    refineEdges(pixels, width, height);

    expect(Array.from(pixels)).toEqual(Array.from(before));
  });

  it("does not touch a fully removed region", () => {
    // Everything removed: there is no kept pixel, so nothing to refine.
    const width = 7;
    const height = 7;
    const pixels = uniform(width, height, BACKGROUND, 0);
    const before = new Uint8ClampedArray(pixels);

    refineEdges(pixels, width, height);

    expect(Array.from(pixels)).toEqual(Array.from(before));
  });

  it("is a no-op on a degenerate image", () => {
    const pixels = uniform(2, 2, FOREGROUND, 200);
    const before = new Uint8ClampedArray(pixels);

    expect(() => refineEdges(pixels, 2, 2)).not.toThrow();
    expect(Array.from(pixels)).toEqual(Array.from(before));
  });
});
