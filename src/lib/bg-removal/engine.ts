import { floodKeyRemoveBackground, FLOOD_KEY_DEFAULTS, transparentFraction } from "./flood-key";

// ---------------------------------------------------------------------------
// Background removal engine abstraction. Two local engines:
//   1. flood-key    — instant, deterministic, works on solid backgrounds
//   2. ai-segmenter — transformers.js U2Net in a Web Worker (first use
//                     downloads the model, cached by the browser afterwards)
// The original blob is never modified; engines return a new PNG blob.
// ---------------------------------------------------------------------------

export type BgRemovalEngineId = "flood-key" | "ai-segmenter";

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

let workerInstance: Worker | null = null;
const pendingRequests = new Map<string, { resolve: (r: BgRemovalResult) => void; reject: (e: Error) => void }>();
let progressCallback: ((stage: string) => void) | null = null;

function getWorker(): Worker {
  if (!workerInstance) {
    // NOTE: webpack only compiles a worker entry when `new URL(...)` is written
    // inline inside `new Worker(...)`. Keep this pattern exactly as written.
    workerInstance = new Worker(new URL("@/lib/workers/bg-removal-ai.worker.ts", import.meta.url), {
      type: "module",
    });
    workerInstance.onmessage = (event: MessageEvent) => {
      const { requestId, ok, blob, error, removed, progress } = event.data as {
        requestId: string;
        ok: boolean;
        blob?: Blob;
        error?: string;
        /** Fraction of pixels whose alpha changed. */
        removed?: number;
        progress?: { stage: string };
      };
      const pending = pendingRequests.get(requestId);
      if (progress?.stage && progressCallback) progressCallback(progress.stage);
      if (!pending) return;
      if (ok && blob) {
        pendingRequests.delete(requestId);
        const transparencyTask = createImageBitmap(blob)
          .then((bmp) => {
            const c = document.createElement("canvas");
            c.width = bmp.width;
            c.height = bmp.height;
            const cx = c.getContext("2d", { willReadFrequently: true });
            let transparency = 0;
            if (cx) {
              cx.drawImage(bmp, 0, 0);
              const d = cx.getImageData(0, 0, c.width, c.height);
              transparency = transparentFraction(d.data);
            }
            bmp.close();
            return transparency;
          })
          .catch(() => 0);
        transparencyTask.then((transparency) =>
          pending.resolve({ blob, transparency, removed: removed ?? 0 }),
        );
      } else if (!ok && error) {
        pendingRequests.delete(requestId);
        pending.reject(new Error(error));
      }
    };
    workerInstance.onerror = (event) => {
      const err = new Error(`Background removal worker failed: ${event.message ?? "unknown error"}`);
      for (const pending of pendingRequests.values()) pending.reject(err);
      pendingRequests.clear();
      workerInstance?.terminate();
      workerInstance = null;
    };
  }
  return workerInstance;
}

export function setBgRemovalProgressCallback(cb: ((stage: string) => void) | null): void {
  progressCallback = cb;
}

export async function removeBgAI(blob: Blob): Promise<BgRemovalResult> {
  const worker = getWorker();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<BgRemovalResult>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage({ requestId, blob });
  });
}
export async function removeBackground(
  engine: BgRemovalEngineId,
  blob: Blob,
  tolerance?: number,
): Promise<BgRemovalResult> {
  if (engine === "flood-key") {
    return removeBgFloodKey(blob, tolerance);
  }
  return removeBgAI(blob);
}
