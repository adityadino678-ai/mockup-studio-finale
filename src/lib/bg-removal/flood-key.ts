// ---------------------------------------------------------------------------
// Flood-key background removal: removes solid/near-solid backgrounds by
// flood-filling from the image borders with a color tolerance. 100% local,
// deterministic, license-clean. Alpha is preserved on kept pixels; removed
// pixels get alpha 0 with a soft tolerance ramp to avoid hard jaggies.
// ---------------------------------------------------------------------------

export interface FloodKeyOptions {
  /** Color distance (0..255 euclidean RGB) considered "background". */
  tolerance: number;
  /** Extra ramp above tolerance for soft edges (alpha feathering). */
  softness?: number;
}

export const FLOOD_KEY_DEFAULTS: FloodKeyOptions = { tolerance: 32, softness: 32 };

function colorDist(r: number, g: number, b: number, sr: number, sg: number, sb: number): number {
  const dr = r - sr;
  const dg = g - sg;
  const db = b - sb;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Removes the border-connected background from RGBA pixel data in place.
 * Returns the same buffer with modified alpha.
 */
export function floodKeyRemoveBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: FloodKeyOptions = FLOOD_KEY_DEFAULTS,
): { removedPixels: number } {
  const tolerance = Math.max(0, options.tolerance);
  const softness = Math.max(0, options.softness ?? 32);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  let removedPixels = 0;

  // Seed colors: the four corners. Each border pixel is compared to its
  // nearest corner's seed color to handle slight gradients.
  const cornerIdx = (x: number, y: number) => (y * width + x) * 4;
  const seeds = [
    [pixels[cornerIdx(0, 0)], pixels[cornerIdx(0, 0) + 1], pixels[cornerIdx(0, 0) + 2]],
    [pixels[cornerIdx(width - 1, 0)], pixels[cornerIdx(width - 1, 0) + 1], pixels[cornerIdx(width - 1, 0) + 2]],
    [pixels[cornerIdx(0, height - 1)], pixels[cornerIdx(0, height - 1) + 1], pixels[cornerIdx(0, height - 1) + 2]],
    [pixels[cornerIdx(width - 1, height - 1)], pixels[cornerIdx(width - 1, height - 1) + 1], pixels[cornerIdx(width - 1, height - 1) + 2]],
  ];

  const nearestSeed = (x: number, y: number): number => {
    // 0: TL, 1: TR, 2: BL, 3: BR
    if (y < height / 2) return x < width / 2 ? 0 : 1;
    return x < width / 2 ? 2 : 3;
  };

  const isBackground = (idx: number): boolean => {
    const p = idx * 4;
    if (pixels[p + 3] === 0) return true; // already transparent
    const s = nearestSeed(idx % width, Math.floor(idx / width));
    const d = colorDist(pixels[p], pixels[p + 1], pixels[p + 2], seeds[s][0], seeds[s][1], seeds[s][2]);
    return d <= tolerance;
  };

  const push = (idx: number) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  // Seed the queue with all border pixels.
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  const hardLimit = tolerance;
  const softLimit = tolerance + softness;

  while (head < tail) {
    const idx = queue[head++];
    const p = idx * 4;
    if (pixels[p + 3] === 0) continue;
    const s = nearestSeed(idx % width, Math.floor(idx / width));
    const d = colorDist(pixels[p], pixels[p + 1], pixels[p + 2], seeds[s][0], seeds[s][1], seeds[s][2]);

    if (d <= softLimit) {
      if (d <= hardLimit) {
        pixels[p + 3] = 0;
        removedPixels++;
      } else {
        // Soft ramp between tolerance and tolerance+softness.
        const t = (d - hardLimit) / (softLimit - hardLimit);
        const newAlpha = Math.min(pixels[p + 3], Math.round(255 * t));
        if (newAlpha < pixels[p + 3]) {
          pixels[p + 3] = newAlpha;
          removedPixels++;
        }
      }
      // Continue the flood through this pixel's neighbors.
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x > 0) push(idx - 1);
      if (x < width - 1) push(idx + 1);
      if (y > 0) push(idx - width);
      if (y < height - 1) push(idx + width);
    }
  }

  return { removedPixels };
}

/** Fraction of pixels that are fully transparent in the buffer. */
export function transparentFraction(pixels: Uint8ClampedArray): number {
  let transparent = 0;
  const total = pixels.length / 4;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] === 0) transparent++;
  }
  return total > 0 ? transparent / total : 0;
}
