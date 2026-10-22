import { describe, expect, it } from "vitest";
import {
  BORDER_MODEL_DEFAULTS,
  borderModelRemoveBackground,
} from "@/lib/bg-removal/border-model";
import { floodKeyRemoveBackground } from "@/lib/bg-removal/flood-key";

// ---------------------------------------------------------------------------
// The border-model background remover.
//
// It is a PURE function on a pixel buffer - no DOM, no canvas, no model - so
// the behaviour can be pinned with tiny synthetic images.
//
// The method, in one paragraph: the background of a studio shot is estimated
// from the BORDER of the image (the ring of pixels that is background by
// definition), the estimate is taken ALONG each row and column so a gradient
// is FOLLOWED rather than matched against one colour, and only the pixels
// CONNECTED to the border are removed - which is what keeps a white shape
// inside the artwork from being erased.
//
// Why this engine exists at all: the flood key needs ONE exact colour, so on
// a photo with a white sweep that falls off towards the edges it removes a
// ragged patch and leaves the rest. The last test of the gradient case pins
// exactly that difference.
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

/** Builds an opaque RGBA buffer from a per-pixel painter. */
function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgb,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const p = (y * width + x) * 4;
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

/** The alpha of one pixel. */
function alphaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number): number {
  return pixels[(y * width + x) * 4 + 3];
}

/** How many pixels are not fully transparent. */
function opaqueCount(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 0) count++;
  }
  return count;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const BLUE: Rgb = [30, 90, 160];

describe("BORDER_MODEL_DEFAULTS", () => {
  it("pins the default tolerance and the default softness", () => {
    // The tolerance is the colour distance that counts as "background" and
    // the softness is the extra ramp above it. Both are part of the
    // contract: the engine is called with them from the UI.
    expect(BORDER_MODEL_DEFAULTS.tolerance).toBe(40);
    expect(BORDER_MODEL_DEFAULTS.softness).toBe(28);
  });
});

describe("borderModelRemoveBackground - a flat background", () => {
  const WIDTH = 11;
  const HEIGHT = 11;
  /** The 3x3 subject in the middle. */
  const isSubject = (x: number, y: number) => x >= 4 && x <= 6 && y >= 4 && y <= 6;

  function flatImage(): Uint8ClampedArray {
    return makeImage(WIDTH, HEIGHT, (x, y) => (isSubject(x, y) ? BLACK : WHITE));
  }

  it("removes the background and keeps the subject", () => {
    const pixels = flatImage();

    borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    // Every background pixel is gone...
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (isSubject(x, y)) continue;
        expect(alphaAt(pixels, WIDTH, x, y)).toBe(0);
      }
    }
    // ...and every subject pixel is untouched.
    for (let y = 4; y <= 6; y++) {
      for (let x = 4; x <= 6; x++) {
        expect(alphaAt(pixels, WIDTH, x, y)).toBe(255);
      }
    }
  });

  it("counts the pixels it removed", () => {
    const pixels = flatImage();

    const result = borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    expect(result.removedPixels).toBe(WIDTH * HEIGHT - 9);
    expect(opaqueCount(pixels)).toBe(9);
  });

  it("leaves the original colours untouched - only the alpha changes", () => {
    // The RGB of a pixel must survive: a remover that blends the background
    // into the edge changes the artwork's colours.
    const pixels = flatImage();
    const before = Array.from(pixels);

    borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(before[i]);
      expect(pixels[i + 1]).toBe(before[i + 1]);
      expect(pixels[i + 2]).toBe(before[i + 2]);
    }
  });
});

describe("borderModelRemoveBackground - a gradient background", () => {
  const WIDTH = 21;
  const HEIGHT = 21;
  const CENTRE = 10;
  const MAX_RADIUS = Math.sqrt(200);
  /** The subject sits in the middle, where the backdrop is brightest. */
  const isSubject = (x: number, y: number) => x >= 9 && x <= 11 && y >= 9 && y <= 11;

  /**
   * A studio backdrop: white in the middle, grey towards the edges.
   *
   * The falloff is shallow on purpose - the model estimates the background
   * from the border, so a backdrop that falls off too hard puts the middle
   * of the image further from the estimate than the tolerance allows.
   */
  function gradientImage(): Uint8ClampedArray {
    return makeImage(WIDTH, HEIGHT, (x, y) => {
      if (isSubject(x, y)) return BLACK;
      const radius = Math.hypot(x - CENTRE, y - CENTRE);
      const value = 225 + 30 * (1 - radius / MAX_RADIUS);
      return [value, value, value];
    });
  }

  it("removes the WHOLE gradient, not just the part that matches one colour", () => {
    const pixels = gradientImage();

    const result = borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    expect(result.removedPixels).toBe(WIDTH * HEIGHT - 9);
    // Only the subject is left.
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const alpha = alphaAt(pixels, WIDTH, x, y);
        if (isSubject(x, y)) {
          expect(alpha).toBe(255);
        } else {
          expect(alpha).toBe(0);
        }
      }
    }
  });

  it("is the case the flood key cannot do - the flood key leaves a halo", () => {
    // The flood key matches ONE colour (the grey edge of the sweep) and
    // leaves the bright middle behind. This is exactly the bug the border
    // model was written for, so the difference is pinned here.
    const floodPixels = gradientImage();

    floodKeyRemoveBackground(floodPixels, WIDTH, HEIGHT);

    // The subject plus a halo of the backdrop that survived.
    expect(opaqueCount(floodPixels)).toBeGreaterThan(9);
  });
});

describe("borderModelRemoveBackground - the connectivity rule", () => {
  const WIDTH = 11;
  const HEIGHT = 11;

  it("keeps an interior white shape that is not connected to the border", () => {
    // A white shape in the middle of the artwork is not the background. The
    // flood fill starts at the border, so it never reaches it and the shape
    // survives - which is what stops the remover from eating a highlight.
    const pixels = makeImage(WIDTH, HEIGHT, (x, y) =>
      x >= 4 && x <= 6 && y >= 4 && y <= 6 ? WHITE : BLUE,
    );

    borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    for (let y = 4; y <= 6; y++) {
      for (let x = 4; x <= 6; x++) {
        expect(alphaAt(pixels, WIDTH, x, y)).toBe(255);
      }
    }
    // The coloured background around it is gone.
    expect(opaqueCount(pixels)).toBe(9);
  });

  it("keeps a background-coloured pocket that is walled off from the border", () => {
    // The sharpest form of the connectivity rule: the pocket has EXACTLY
    // the background's colour, so only the connectivity can save it.
    const isRing = (x: number, y: number) =>
      x >= 3 && x <= 7 && y >= 3 && y <= 7 && !(x >= 4 && x <= 6 && y >= 4 && y <= 6);

    const pixels = makeImage(WIDTH, HEIGHT, (x, y) => (isRing(x, y) ? BLACK : BLUE));

    borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    // The pocket inside the ring is still opaque.
    expect(alphaAt(pixels, WIDTH, 5, 5)).toBe(255);
    // The ring is opaque too...
    expect(alphaAt(pixels, WIDTH, 3, 3)).toBe(255);
    // ...and the background around the ring is removed.
    expect(alphaAt(pixels, WIDTH, 0, 0)).toBe(0);
    expect(alphaAt(pixels, WIDTH, 10, 10)).toBe(0);
  });
});

describe("borderModelRemoveBackground - a subject on the border", () => {
  const WIDTH = 11;
  const HEIGHT = 11;
  /** A block that reaches the left edge of the image. */
  const isSubject = (x: number, y: number) => x <= 1 && y >= 3 && y <= 7;

  it("still removes the background around it", () => {
    // The model samples the border to estimate the background, so a subject
    // that touches the border is part of that estimate. What must not
    // happen is the rest of the background surviving because the fill could
    // not get past the subject.
    const pixels = makeImage(WIDTH, HEIGHT, (x, y) => (isSubject(x, y) ? BLACK : WHITE));

    const result = borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (isSubject(x, y)) continue;
        expect(alphaAt(pixels, WIDTH, x, y)).toBe(0);
      }
    }
    expect(result.removedPixels).toBeGreaterThan(0);
  });
});

describe("borderModelRemoveBackground - the softness ramp", () => {
  const WIDTH = 11;
  const HEIGHT = 11;
  /** A one-pixel-thick black block with a single soft pixel in the middle. */
  const isBlock = (x: number, y: number) => x >= 4 && x <= 6 && y >= 4 && y <= 6;

  it("feathers a soft pixel that sits on the edge of the cutout", () => {
    // The pixel at the block's top-left corner is grey: further from the
    // background than the tolerance allows, so it is not removed outright,
    // but close enough to be feathered. Its alpha is neither 0 nor 255, and
    // that is what keeps a hard, jaggy edge off the subject.
    const pixels = makeImage(WIDTH, HEIGHT, (x, y) => {
      if (!isBlock(x, y)) return WHITE;
      return x === 4 && y === 4 ? [225, 225, 225] : BLACK;
    });

    const result = borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    const soft = alphaAt(pixels, WIDTH, 4, 4);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(255);
    // The hard part of the block is untouched...
    expect(alphaAt(pixels, WIDTH, 5, 5)).toBe(255);
    // ...and the white background around it is gone.
    expect(alphaAt(pixels, WIDTH, 0, 0)).toBe(0);
    // The feathered pixel counts as removed: its alpha changed. Only the
    // eight hard pixels of the block are still fully opaque.
    expect(result.removedPixels).toBe(WIDTH * HEIGHT - 8);
  });

  it("leaves a soft pixel that is an interior detail alone", () => {
    // The same grey pixel, but in the MIDDLE of the block: it is not next to
    // anything that was removed, so it is a detail of the artwork and not an
    // edge. Feathering it would punch a semi-transparent hole in the print.
    const pixels = makeImage(WIDTH, HEIGHT, (x, y) => {
      if (!isBlock(x, y)) return WHITE;
      return x === 5 && y === 5 ? [225, 225, 225] : BLACK;
    });

    borderModelRemoveBackground(pixels, WIDTH, HEIGHT);

    expect(alphaAt(pixels, WIDTH, 5, 5)).toBe(255);
    // The background is still gone.
    expect(alphaAt(pixels, WIDTH, 0, 0)).toBe(0);
  });

  it("keeps the ramp a function of the colour distance alone", () => {
    // Two pixels the same distance from the background get the same alpha:
    // the ramp is not random and it does not depend on the position.
    const pixels = makeImage(WIDTH, HEIGHT, (x, y) => {
      if (!isBlock(x, y)) return WHITE;
      return x === 4 && y === 4 ? [225, 225, 225] : BLACK;
    });
    const other = makeImage(WIDTH, HEIGHT, (x, y) => {
      if (!isBlock(x, y)) return WHITE;
      return x === 4 && y === 4 ? [225, 225, 225] : BLACK;
    });

    borderModelRemoveBackground(pixels, WIDTH, HEIGHT);
    borderModelRemoveBackground(other, WIDTH, HEIGHT);

    expect(alphaAt(pixels, WIDTH, 4, 4)).toBe(alphaAt(other, WIDTH, 4, 4));
    // ...and that alpha is really a ramp, not the untouched 255.
    expect(alphaAt(pixels, WIDTH, 4, 4)).toBeLessThan(255);
  });
});

describe("borderModelRemoveBackground - degenerate input", () => {
  it("does nothing on a 1x1 image", () => {
    const pixels = makeImage(1, 1, () => WHITE);

    const result = borderModelRemoveBackground(pixels, 1, 1);

    expect(result.removedPixels).toBe(0);
    expect(pixels[3]).toBe(255);
  });

  it("does nothing on a 2x2 image", () => {
    const pixels = makeImage(2, 2, () => WHITE);

    const result = borderModelRemoveBackground(pixels, 2, 2);

    expect(result.removedPixels).toBe(0);
    expect(opaqueCount(pixels)).toBe(4);
  });

  it("does not throw on a negative tolerance", () => {
    const pixels = makeImage(5, 5, () => WHITE);

    expect(() => borderModelRemoveBackground(pixels, 5, 5, { tolerance: -10 })).not.toThrow();
  });

  it("removes nothing when the tolerance is zero and the background is not exactly the estimate", () => {
    // A tolerance of zero means "only the exact colour of the border". The
    // estimate is the median of three border pixels, so a flat background
    // still matches exactly and is removed.
    const pixels = makeImage(11, 11, (x, y) =>
      x >= 4 && x <= 6 && y >= 4 && y <= 6 ? BLACK : WHITE,
    );

    const result = borderModelRemoveBackground(pixels, 11, 11, { tolerance: 0, softness: 0 });

    expect(result.removedPixels).toBe(11 * 11 - 9);
  });
});
