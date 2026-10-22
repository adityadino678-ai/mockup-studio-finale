import { floodKeyRemoveBackground, FLOOD_KEY_DEFAULTS, transparentFraction } from "./flood-key";
import { borderModelRemoveBackground, BORDER_MODEL_DEFAULTS } from "./border-model";

// ---------------------------------------------------------------------------
// Background removal engine abstraction. Two local engines:
//   1. flood-key    — instant, deterministic, works on solid backgrounds
//   2. border-model — instant, deterministic, follows a gradient or a vignette
// The original blob is never modified; engines return a new PNG blob.
// ---------------------------------------------------------------------------

export interface BgRemovalResult {
  blob: Blob;
  /** Fraction of fully-transparent pixels in the result. */
  transparency: number;
  /**
   * Fraction of pixels whose ALPHA CHANGED.
   *
   * This is the number that says whether the engine did anything. The
   * output's total transparency cannot: an artwork that was already
   * transparent scores 1.0 without a single pixel being touched, and a
   * solid-colour artwork scores 1.0 because the ARTWORK ITSELF was erased.
   */
  removed: number;
}

/**
 * The fraction of pixels whose alpha differs between the input and the
 * output. A soft ramp (alpha 255 -> 100) counts as a change, which a
 * "fully transparent pixels" count would miss entirely.
 */
function alphaChangeFraction(before: Uint8ClampedArray, after: Uint8ClampedArray): number {
  const pixels = Math.min(before.length, after.length);
  if (pixels === 0) return 0;
  let changed = 0;
  let count = 0;
  for (let i = 3; i < pixels; i += 4) {
    count++;
    if (before[i] !== after[i]) changed++;
  }
  return count > 0 ? changed / count : 0;
}

export async function removeBgFloodKey(
  blob: Blob,
  tolerance: number = FLOOD_KEY_DEFAULTS.tolerance,
): Promise<BgRemovalResult> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const before = new Uint8ClampedArray(image.data);
  floodKeyRemoveBackground(image.data, canvas.width, canvas.height, {
    ...FLOOD_KEY_DEFAULTS,
    tolerance,
  });
  const transparency = transparentFraction(image.data);
  const removed = alphaChangeFraction(before, image.data);
  ctx.putImageData(image, 0, 0);
  const outBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), "image/png");
  });
  return { blob: outBlob, transparency, removed };
}

/**
 * Removes the background by modelling it from the image border.
 *
 * The second cheap engine: it follows a gradient or a vignette where the
 * flood key cannot, and it needs no network, so it still works when the AI
 * model cannot be downloaded.
 */
export async function removeBgBorderModel(
  blob: Blob,
  tolerance: number = BORDER_MODEL_DEFAULTS.tolerance,
): Promise<BgRemovalResult> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const before = new Uint8ClampedArray(image.data);
  borderModelRemoveBackground(image.data, canvas.width, canvas.height, {
    ...BORDER_MODEL_DEFAULTS,
    tolerance,
  });
  const transparency = transparentFraction(image.data);
  const removed = alphaChangeFraction(before, image.data);
  ctx.putImageData(image, 0, 0);
  const outBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), "image/png");
  });
  return { blob: outBlob, transparency, removed };
}
