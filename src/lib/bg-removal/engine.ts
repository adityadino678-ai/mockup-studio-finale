import { floodKeyRemoveBackground, FLOOD_KEY_DEFAULTS, transparentFraction } from "./flood-key";
import { borderModelRemoveBackground, BORDER_MODEL_DEFAULTS } from "./border-model";
import { refineEdges } from "./edge-refine";
import {
  applyMaskToPixels,
  featherMask,
  fillSmallHoles,
  guidedFilterMaskApprox,
  removeTinyIslands,
  upscaleMaskBilinear,
} from "./ml-mask";

// ---------------------------------------------------------------------------
// Background removal engine abstraction. Three engines:
//   1. flood-key    — instant, deterministic, works on solid backgrounds
//   2. border-model — instant, deterministic, follows a gradient or a vignette
//   3. ml           — in-browser segmentation (onnxruntime-web, MIT) in a Worker;
//                     hybrid refine upscales to ORIGINAL resolution
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

/**
 * ML segmentation: model in a Worker, soft mask refined at ORIGINAL resolution.
 * `softMask` (1 = foreground) may be supplied by tests; otherwise the Worker is
 * used. Throws a user-safe Error when the model cannot run so the caller can
 * fall back to flood-key / border-model.
 */
export async function removeBgMlSegmentation(
  blob: Blob,
  opts: {
    tolerance?: number;
    feather?: number;
    modelSize?: "small" | "large";
    softMask?: Float32Array;
    softMaskWidth?: number;
    softMaskHeight?: number;
    onProgress?: (stage: string) => void;
    onDownload?: (loaded: number, total: number) => void;
  } = {},
): Promise<BgRemovalResult> {
  const feather = opts.feather ?? 1;
  const bmp = await createImageBitmap(blob);
  const width = bmp.width;
  const height = bmp.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const image = ctx.getImageData(0, 0, width, height);
  const before = new Uint8ClampedArray(image.data);

  let smallMask: Float32Array;
  let sw: number;
  let sh: number;
  if (opts.softMask && opts.softMaskWidth && opts.softMaskHeight) {
    opts.onProgress?.("Refining the cutout…");
    smallMask = opts.softMask;
    sw = opts.softMaskWidth;
    sh = opts.softMaskHeight;
  } else {
    opts.onProgress?.("Loading the segmentation model…");
    const { ensureModel, segmentWithWorker } = await import("./ml-engine");
    const model = await ensureModel(opts.modelSize ?? "small", opts.onDownload);
    opts.onProgress?.("Segmenting with the model…");
    // Downscale for the model; the mask is upscaled back to ORIGINAL size.
    const maxSide = 768;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    let rgba: Uint8ClampedArray = image.data;
    let rw = width;
    let rh = height;
    if (scale < 1) {
      const smallCanvas = document.createElement("canvas");
      smallCanvas.width = Math.max(1, Math.round(width * scale));
      smallCanvas.height = Math.max(1, Math.round(height * scale));
      const sctx = smallCanvas.getContext("2d");
      if (!sctx) throw new Error("Could not get 2D context");
      sctx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
      rgba = sctx.getImageData(0, 0, smallCanvas.width, smallCanvas.height).data;
      rw = smallCanvas.width;
      rh = smallCanvas.height;
      if (smallCanvas) {
        smallCanvas.width = 1;
        smallCanvas.height = 1;
      }
    }
    const result = await segmentWithWorker(new Uint8ClampedArray(rgba), rw, rh, model);
    smallMask = result.mask;
    sw = result.sw;
    sh = result.sh;
  }

  opts.onProgress?.("Refining the cutout…");
  let mask = upscaleMaskBilinear(smallMask, sw, sh, width, height);
  mask = removeTinyIslands(mask, width, height, 16);
  mask = fillSmallHoles(mask, width, height, 256);
  mask = guidedFilterMaskApprox(mask, image.data, width, height, 2);
  mask = featherMask(mask, width, height, feather);
  applyMaskToPixels(image.data, width, height, mask);
  // Decontaminate fringe on edge pixels (same pass as flood/border).
  refineEdges(image.data, width, height);
  const transparency = transparentFraction(image.data);
  const removed = alphaChangeFraction(before, image.data);
  ctx.putImageData(image, 0, 0);
  const outBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), "image/png");
  });
  canvas.width = 1;
  canvas.height = 1;
  return { blob: outBlob, transparency, removed };
}
