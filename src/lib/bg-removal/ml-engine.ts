// Browser-side ML segmentation glue (Problem 2).
// Lazy model download (Cache Storage + progress), Worker inference, honest
// fallback. No model bytes are committed to git.

import { ML_CACHE_NAME, ML_MODEL_URLS, ML_INPUT_SIZE, type MlModelSize } from "./ml-config";

export type { MlModelSize };

export interface MlSegmentResult {
  mask: Float32Array;
  sw: number;
  sh: number;
  backend: "webgpu" | "wasm";
}

/** True when the WebGPU API exists (worker will prefer it). */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

async function cacheGet(url: string): Promise<ArrayBuffer | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(ML_CACHE_NAME);
    const hit = await cache.match(new Request(url));
    if (!hit) return null;
    const buf = await hit.arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function cachePut(url: string, bytes: ArrayBuffer): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(ML_CACHE_NAME);
    await cache.put(
      new Request(url),
      new Response(bytes.slice(0), { headers: { "Content-Type": "application/octet-stream" } }),
    );
  } catch {
    // Cache is an optimisation; a failure must not break removal.
  }
}

/**
 * Downloads the model lazily (first use), with progress, and caches it.
 * Throws a user-safe Error when the download is blocked/offline.
 */
export async function ensureModel(
  size: MlModelSize,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const url = ML_MODEL_URLS[size];
  const cached = await cacheGet(url);
  if (cached) {
    onProgress?.(cached.byteLength, cached.byteLength);
    return cached;
  }
  let res: Response;
  try {
    res = await fetch(url, { cache: "default" });
  } catch {
    throw new Error("The segmentation model could not be downloaded (offline?).");
  }
  if (!res.ok || !res.body) {
    throw new Error(
      res.status === 0
        ? "The segmentation model could not be downloaded (offline?)."
        : `The segmentation model could not be downloaded (HTTP ${res.status}).`,
    );
  }
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total || loaded);
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  await cachePut(url, bytes.buffer);
  return bytes.buffer;
}

let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let pendingInit: { resolve: () => void; reject: (e: Error) => void } | null = null;
const pending = new Map<string, { resolve: (r: MlSegmentResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./ml-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent) => {
    const data = ev.data as {
      ready?: boolean;
      backend?: "webgpu" | "wasm";
      id?: string;
      mask?: Float32Array;
      sw?: number;
      sh?: number;
      error?: string;
    };
    if (data.ready) {
      pendingInit?.resolve();
      pendingInit = null;
      return;
    }
    if (data.id && pending.has(data.id)) {
      const p = pending.get(data.id)!;
      pending.delete(data.id);
      if (data.error || !data.mask) p.reject(new Error(data.error ?? "Segmentation failed"));
      else p.resolve({ mask: data.mask, sw: data.sw!, sh: data.sh!, backend: data.backend ?? "wasm" });
    } else if (data.error && pendingInit) {
      pendingInit.reject(new Error(data.error));
      pendingInit = null;
    }
  };
  worker.onerror = () => {
    const err = new Error("The segmentation worker failed to start.");
    pendingInit?.reject(err);
    pendingInit = null;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  return worker;
}

async function initWorker(model: ArrayBuffer): Promise<void> {
  workerReady ??= new Promise<void>((resolve, reject) => {
    pendingInit = { resolve, reject };
    getWorker().postMessage({ type: "init", model }, [model.slice(0)]);
  });
  await workerReady;
}

/**
 * Runs ML segmentation in the Worker on a downscaled copy.
 * Returns a soft mask (1 = foreground) at ML_INPUT_SIZE.
 * Throws a user-safe Error when the model cannot run.
 */
export async function segmentWithWorker(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  model: ArrayBuffer,
): Promise<MlSegmentResult> {
  await initWorker(model);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const copy = new Uint8ClampedArray(rgba);
  return new Promise<MlSegmentResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const w = getWorker();
    w.postMessage(
      { type: "segment", id, rgba: copy.buffer, width, height },
      [copy.buffer],
    );
  });
}

/** Downscales RGBA to the model's input size on the main thread (fast path). */
export { ML_INPUT_SIZE };
