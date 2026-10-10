/// <reference lib="webworker" />
// Background removal via transformers.js (loaded from CDN at runtime to keep
// the bundler out of the way). Model: Xenova/modnet (MIT-licensed MODNet) —
// runs fully in-browser on WASM/WebGPU. Downloaded once, then cached by the
// browser. MODNet is optimized for photos of people/products; for artwork
// with solid backgrounds the flood-key engine is faster and often better.

const MODEL_ID = "Xenova/modnet";
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";

interface RequestMessage {
  requestId: string;
  blob: Blob;
}

interface ResponseMessage {
  requestId: string;
  ok: boolean;
  blob?: Blob;
  error?: string;
  progress?: { stage: string };
}

const post = (msg: ResponseMessage) => {
  (self as unknown as Worker).postMessage(msg);
};

interface RawImageLike {
  data: Uint8ClampedArray | Float32Array;
  width: number;
  height: number;
  channels: number;
}

let removerPromise: Promise<{ (input: Blob | string, opts?: unknown): Promise<RawImageLike | RawImageLike[]> }> | null =
  null;

async function createRemover() {
  const mod = await import(/* webpackIgnore: true */ TRANSFORMERS_CDN);
  const { pipeline, env } = mod as {
    pipeline: (task: string, model: string, opts?: unknown) => Promise<never>;
    env: { allowLocalModels: boolean };
  };
  env.allowLocalModels = false;
  return pipeline("background-removal", MODEL_ID);
}

async function getRemover() {
  if (!removerPromise) {
    removerPromise = createRemover();
  }
  return removerPromise;
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { requestId, blob } = event.data;
  post({ requestId, ok: true, progress: { stage: "Loading background-removal model (first use downloads ~25 MB, cached after)" } });
  try {
    const remover = await getRemover();
    post({ requestId, ok: true, progress: { stage: "Removing background…" } });
    const output = await remover(blob, {});
    const img: RawImageLike = Array.isArray(output) ? output[0] : output;
    if (!img || !img.data) {
      post({ requestId, ok: false, error: "Model returned no image" });
      return;
    }
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      post({ requestId, ok: false, error: "Could not get 2D context" });
      return;
    }
    let rgba: Uint8ClampedArray<ArrayBuffer>;
    if (img.channels === 4) {
      rgba = new Uint8ClampedArray(img.width * img.height * 4);
      rgba.set(new Uint8ClampedArray(img.data.buffer ?? img.data, img.data.byteOffset ?? 0, img.width * img.height * 4));
    } else {
      // Expand non-RGBA output with full alpha.
      const src = img.data;
      rgba = new Uint8ClampedArray(img.width * img.height * 4);
      for (let i = 0, j = 0; i < src.length && j < rgba.length; i += img.channels, j += 4) {
        rgba[j] = src[i];
        rgba[j + 1] = img.channels > 1 ? src[i + 1] : src[i];
        rgba[j + 2] = img.channels > 2 ? src[i + 2] : src[i];
        rgba[j + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    post({ requestId, ok: true, blob: outBlob, progress: { stage: "Done" } });
  } catch (err) {
    removerPromise = null; // allow retry after failure
    post({
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : "Background removal failed",
    });
  }
};
