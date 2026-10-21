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
  /** Fraction of pixels whose alpha changed. 0 means nothing was removed. */
  removed?: number;
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

/**
 * Normalises the model's output to bytes.
 *
 * A float mask carries 0..1 per channel while the byte form carries 0..255;
 * reinterpreting one as the other would turn the mask into noise.
 */
function toByteArray(data: Uint8ClampedArray | Float32Array): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] * 255);
  return out;
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
  post({ requestId, ok: true, progress: { stage: "Loading background-removal model…" } });
  try {
    const remover = await getRemover();
    post({ requestId, ok: true, progress: { stage: "Removing background…" } });
    const output = await remover(blob, {});
    const img: RawImageLike = Array.isArray(output) ? output[0] : output;
    if (!img || !img.data) {
      post({ requestId, ok: false, error: "Model returned no image" });
      return;
    }

    // The model's own output size is not the artwork's size. Reading the
    // input's dimensions keeps the cutout at the original resolution, which
    // matters because the artwork is later printed at the size of the print
    // area and a 320px mask would be rejected outright.
    const inputBitmap = await createImageBitmap(blob);
    const inputWidth = inputBitmap.width;
    const inputHeight = inputBitmap.height;
    const inputCanvas = new OffscreenCanvas(inputWidth, inputHeight);
    const inputCtx = inputCanvas.getContext("2d", { willReadFrequently: true });
    if (!inputCtx) {
      post({ requestId, ok: false, error: "Could not get 2D context" });
      return;
    }
    inputCtx.drawImage(inputBitmap, 0, 0);
    inputBitmap.close();
    // The input's alpha is the baseline for "did anything change", so it is
    // required: without it the run could not be told apart from a no-op.
    const inputAlpha = inputCtx.getImageData(0, 0, inputWidth, inputHeight).data;

    const canvas = new OffscreenCanvas(inputWidth, inputHeight);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      post({ requestId, ok: false, error: "Could not get 2D context" });
      return;
    }
    let rgba: Uint8ClampedArray<ArrayBuffer>;
    const src = toByteArray(img.data);
    if (img.channels === 4 && img.width === inputWidth && img.height === inputHeight) {
      // Exact copy: no resampling, so no premultiplication round trip that
      // would darken the soft edges of the mask.
      rgba = new Uint8ClampedArray(inputWidth * inputHeight * 4);
      rgba.set(src);
    } else {
      // The model works at its own resolution, so its output has to be
      // scaled to the artwork's size. The mask is drawn through a canvas
      // because that is the only way to resample it without a dependency.
      const modelRgba = new Uint8ClampedArray(new ArrayBuffer(img.width * img.height * 4));
      for (let i = 0, j = 0; i < src.length && j < modelRgba.length; i += img.channels, j += 4) {
        modelRgba[j] = src[i];
        modelRgba[j + 1] = img.channels > 1 ? src[i + 1] : src[i];
        modelRgba[j + 2] = img.channels > 2 ? src[i + 2] : src[i];
        modelRgba[j + 3] = 255;
      }
      const modelCanvas = new OffscreenCanvas(img.width, img.height);
      const modelCtx = modelCanvas.getContext("2d");
      if (!modelCtx) {
        post({ requestId, ok: false, error: "Could not get 2D context" });
        return;
      }
      // A copy with its own buffer: ImageData needs a plain ArrayBuffer.
      const copy = new Uint8ClampedArray(new ArrayBuffer(modelRgba.byteLength));
      copy.set(modelRgba);
      modelCtx.putImageData(new ImageData(copy, img.width, img.height), 0, 0);
      ctx.clearRect(0, 0, inputWidth, inputHeight);
      ctx.drawImage(modelCanvas, 0, 0, inputWidth, inputHeight);
      const scaled = ctx.getImageData(0, 0, inputWidth, inputHeight);
      rgba = scaled.data;
    }

    // How much actually changed? Without this a transparent artwork scores a
    // "success" even though nothing was removed. The comparison is on the
    // ALPHA channel, so a soft ramp (255 -> 100) counts as a change.
    let changed = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      if (inputAlpha[i] !== rgba[i]) changed++;
    }
    const removed = rgba.length > 0 ? changed / (rgba.length / 4) : 0;

    ctx.putImageData(new ImageData(rgba, inputWidth, inputHeight), 0, 0);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    post({ requestId, ok: true, blob: outBlob, removed, progress: { stage: "Done" } });
  } catch (err) {
    removerPromise = null; // allow retry after failure
    post({
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : "Background removal failed",
    });
  }
};
