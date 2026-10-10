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
  floodKeyRemoveBackground(image.data, canvas.width, canvas.height, {
    ...FLOOD_KEY_DEFAULTS,
    tolerance,
  });
  const transparency = transparentFraction(image.data);
  ctx.putImageData(image, 0, 0);
  const outBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), "image/png");
  });
  return { blob: outBlob, transparency };
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
      const { requestId, ok, blob, error, progress } = event.data as {
        requestId: string;
        ok: boolean;
        blob?: Blob;
        error?: string;
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
        transparencyTask.then((transparency) => pending.resolve({ blob, transparency }));
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
