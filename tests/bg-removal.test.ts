import { describe, expect, it } from "vitest";
import { floodKeyRemoveBackground, transparentFraction, FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import { validateImageFile, sanitizeFilename } from "@/lib/image/image";

function solidBackgroundImage(w: number, h: number, bg: [number, number, number, number], fgRect?: [number, number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = bg[0];
    px[i * 4 + 1] = bg[1];
    px[i * 4 + 2] = bg[2];
    px[i * 4 + 3] = bg[3];
  }
  if (fgRect) {
    const [x0, y0, x1, y1] = fgRect;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        px[i] = 200;
        px[i + 1] = 40;
        px[i + 2] = 40;
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

describe("flood-key background removal", () => {
  it("removes a solid white background but keeps interior artwork", () => {
    const w = 20;
    const h = 20;
    const px = solidBackgroundImage(w, h, [255, 255, 255, 255], [6, 6, 14, 14]);
    floodKeyRemoveBackground(px, w, h, FLOOD_KEY_DEFAULTS);

    const at = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };

    expect(at(0, 0)[3]).toBe(0); // background transparent
    expect(at(19, 19)[3]).toBe(0);
    expect(at(10, 10)[3]).toBe(255); // artwork kept
    expect(at(10, 10)[0]).toBe(200); // artwork color untouched
  });

  it("does not remove interior regions of the background color", () => {
    // An island of the same color inside the artwork must survive because the
    // flood only reaches border-connected pixels.
    const w = 20;
    const h = 20;
    const px = solidBackgroundImage(w, h, [255, 255, 255, 255], [5, 5, 15, 15]);
    // Punch a white hole inside the red square.
    for (let y = 8; y < 12; y++) {
      for (let x = 8; x < 12; x++) {
        const i = (y * w + x) * 4;
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        px[i + 3] = 255;
      }
    }
    floodKeyRemoveBackground(px, w, h, FLOOD_KEY_DEFAULTS);
    const i = (10 * w + 10) * 4;
    expect(px[i + 3]).toBe(255);
  });

  it("respects tolerance: pixels beyond the tolerance distance are kept", () => {
    const w = 10;
    const h = 10;
    const px = solidBackgroundImage(w, h, [255, 255, 255, 255]);
    // Keep the four corners white (they become the seeds); every other pixel is
    // 10 units away in the red channel, beyond a tolerance of 2.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isCorner =
          (x === 0 && y === 0) ||
          (x === w - 1 && y === 0) ||
          (x === 0 && y === h - 1) ||
          (x === w - 1 && y === h - 1);
        if (!isCorner) px[(y * w + x) * 4] = 245;
      }
    }
    floodKeyRemoveBackground(px, w, h, { tolerance: 2, softness: 2 });
    // Only the corner seeds themselves were within tolerance — nothing else.
    expect(transparentFraction(px)).toBe(4 / 100);
  });

  it("reports the transparent fraction after removal", () => {
    const w = 10;
    const h = 10;
    const px = solidBackgroundImage(w, h, [255, 255, 255, 255]);
    floodKeyRemoveBackground(px, w, h, FLOOD_KEY_DEFAULTS);
    expect(transparentFraction(px)).toBe(1);
  });
});

describe("file validation and filename safety", () => {
  // `new File(["x"])` is always 1 byte, so size-dependent limits need a stubbed
  // size property.
  const fileWithSize = (name: string, type: string, size: number) => {
    const f = new File(["x"], name, { type });
    Object.defineProperty(f, "size", { value: size });
    return f;
  };
  const file = (name: string, type: string) => fileWithSize(name, type, 1000);

  it("accepts png/jpeg/webp under the size limit", () => {
    expect(validateImageFile(file("a.png", "image/png")).ok).toBe(true);
    expect(validateImageFile(file("a.jpg", "image/jpeg")).ok).toBe(true);
    expect(validateImageFile(file("a.webp", "image/webp")).ok).toBe(true);
  });

  it("rejects unsupported types", () => {
    const result = validateImageFile(file("a.gif", "image/gif"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unsupported/i);
  });

  it("rejects oversized files", () => {
    const result = validateImageFile(fileWithSize("big.png", "image/png", 41 * 1024 * 1024));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too large/i);
  });

  it("rejects empty files", () => {
    expect(validateImageFile(fileWithSize("empty.png", "image/png", 0)).ok).toBe(false);
  });

  it("strips path separators and traversal sequences", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\design.png")).toBe("design.png");
    expect(sanitizeFilename("....")).toBe("file");
    expect(sanitizeFilename("a<b>c:d.png")).toBe("a_b_c_d.png");
  });
});