// Web Worker for ML segmentation (Problem 2).
// Runs onnxruntime-web (MIT) with WebGPU when available, otherwise single-thread
// WASM. No cross-origin isolation headers are required: the worker is created
// with { type: "module" } and transfers only ArrayBuffers.
//
// Protocol:
//   main -> worker: { type: "init", model: ArrayBuffer(ref .buffer) }
//   main -> worker: { type: "segment", id, rgba: ArrayBuffer, width, height }
//   worker -> main: { id, mask: Float32Array, sw, sh, backend: "webgpu"|"wasm" }
//   worker -> main: { id, error: string }

import { ML_INPUT_SIZE } from "./ml-config";

// onnxruntime-web (MIT) is loaded from a CDN inside the worker so the 28 MB
// WASM never ships as a Worker asset (Cloudflare limit is 25 MiB). The npm
// package is kept for types only; the runtime + WASM come from jsDelivr.
// If the CDN is unreachable the caller falls back to flood-key / border-model.
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";

type Ort = typeof import("onnxruntime-web");
let ort: Ort | null = null;
let session: Awaited<ReturnType<Ort["InferenceSession"]["create"]>> | null = null;
let inputName = "input";
let backend: "webgpu" | "wasm" = "wasm";

async function ensureOrt(): Promise<Ort> {
  if (ort) return ort;
  const mod = (await import(/* @vite-ignore */ `${ORT_CDN}ort.wasm.min.js`)) as unknown as Ort;
  ort = mod;
  const o = mod as unknown as { env: { wasm: { wasmPaths?: string; numThreads?: number } } };
  if (o && o.env && o.env.wasm) {
    o.env.wasm.wasmPaths = ORT_CDN;
    o.env.wasm.numThreads = 1;
  }
  return mod;
}

function resizeBilinearRgba(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, y * yScale));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, x * xScale));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const dp = (y * dw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top =
          src[(y0 * sw + x0) * 4 + c] * (1 - fx) + src[(y0 * sw + x1) * 4 + c] * fx;
        const bot =
          src[(y1 * sw + x0) * 4 + c] * (1 - fx) + src[(y1 * sw + x1) * 4 + c] * fx;
        dst[dp + c] = Math.round(top * (1 - fy) + bot * fy);
      }
      dst[dp + 3] = 255;
    }
  }
  return dst;
}

async function initSession(modelBytes: ArrayBuffer): Promise<void> {
  const o = await ensureOrt();
  // Single-thread WASM default: avoids SharedArrayBuffer / COOP-COEP requirement.
  o.env.wasm.numThreads = 1;
  const hasGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const exec = async (ep: string) => {
    return o.InferenceSession.create(modelBytes.slice(0), { executionProviders: [ep] });
  };
  if (hasGpu) {
    try {
      session = await exec("webgpu");
      backend = "webgpu";
    } catch {
      session = await exec("wasm");
      backend = "wasm";
    }
  } else {
    session = await exec("wasm");
    backend = "wasm";
  }
  const names = (session as unknown as { inputNames?: readonly string[] }).inputNames;
  if (names && names.length > 0) inputName = names[0];
}

function preprocess(rgba: Uint8ClampedArray, size: number): Float32Array {
  // ImageNet mean/std, CHW.
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c] / 255;
      out[c * size * size + i] = (v - mean[c]) / std[c];
    }
  }
  return out;
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as {
    type: "init" | "segment";
    model?: ArrayBuffer;
    id?: string;
    rgba?: ArrayBuffer;
    width?: number;
    height?: number;
  };
  try {
    if (msg.type === "init" && msg.model) {
      await initSession(msg.model);
      self.postMessage({ ready: true, backend });
      return;
    }
    if (msg.type === "segment" && msg.rgba && msg.width && msg.height && msg.id) {
      if (!session) throw new Error("Model not initialised");
      const o = await ensureOrt();
      const srcRgba = new Uint8ClampedArray(msg.rgba);
      const small = resizeBilinearRgba(srcRgba, msg.width, msg.height, ML_INPUT_SIZE, ML_INPUT_SIZE);
      const tensor = new o.Tensor("float32", preprocess(small, ML_INPUT_SIZE), [
        1,
        3,
        ML_INPUT_SIZE,
        ML_INPUT_SIZE,
      ]);
      const feeds = { [inputName]: tensor } as unknown as Parameters<typeof session.run>[0];
      const results = await session.run(feeds);
      const out = results[Object.keys(results)[0]] as { data?: Float32Array | Float64Array };
      const raw = out.data ?? new Float32Array(ML_INPUT_SIZE * ML_INPUT_SIZE);
      const mask = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const v = Number(raw[i]);
        mask[i] = 1 / (1 + Math.exp(-v)); // sigmoid for logit outputs; harmless for 0..1 outputs
        // Clamp: if the model already returned 0..1, sigmoid would squash. Recover by
        // detecting range: values > 1 are logits, values <= 1 are probabilities.
        if (v >= 0 && v <= 1) mask[i] = v;
      }
      self.postMessage(
        { id: msg.id, mask, sw: ML_INPUT_SIZE, sh: ML_INPUT_SIZE, backend },
        { transfer: [mask.buffer] },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "segment failed";
    if (msg.id) self.postMessage({ id: msg.id, error: message });
    else self.postMessage({ error: message });
  }
};
