// ML model registry (Problem 2). Commercially licensable only.
//
//   - runtime: onnxruntime-web (MIT, commercially usable)
//   - small:  U2Netp (MIT, NathanUA/U-2-Net), ~4 MB, fast
//   - large:  ISNet general-use (DIS, Apache-2.0), ~170 MB, accurate
//
// No AGPL packages (e.g. @imgly/background-removal) and no non-commercial
// weights (e.g. BRIA RMBG 1.4/2.0) are used. See docs/bg-removal-model.md.

export type MlModelSize = "small" | "large";

export interface MlModel {
  size: MlModelSize;
  name: string;
  licence: string;
  source: string;
  /** Approximate ONNX size for the progress UI. */
  approxBytes: number;
}

export const ML_MODELS: Record<MlModelSize, MlModel> = {
  small: {
    size: "small",
    name: "U2Netp",
    licence: "MIT",
    source: "https://github.com/NathanUA/U-2-Net",
    approxBytes: 4_500_000,
  },
  large: {
    size: "large",
    name: "ISNet general-use (DIS)",
    licence: "Apache-2.0",
    source: "https://github.com/xaveroam/isnet",
    approxBytes: 170_000_000,
  },
};

/**
 * CORS-enabled free host for lazy model download (Hugging Face).
 * Models are NEVER committed to git; they are fetched on first use and cached
 * in Cache Storage. If these URLs are blocked, the app falls back honestly to
 * the local flood-key / border-model engines.
 */
export const ML_MODEL_URLS: Record<MlModelSize, string> = {
  small: "https://huggingface.co/skytnt/anime-seg/resolve/main/u2netp.onnx",
  large: "https://huggingface.co/xaveroam/isnet-general-use/resolve/main/isnet-general-use.onnx",
};

/** Input size the worker resizes to before inference (speed vs accuracy). */
export const ML_INPUT_SIZE = 320;

/** Cache Storage name for downloaded models. */
export const ML_CACHE_NAME = "listbulkly-ml-v1";

export function mlModelFor(size: MlModelSize): MlModel {
  return ML_MODELS[size];
}
