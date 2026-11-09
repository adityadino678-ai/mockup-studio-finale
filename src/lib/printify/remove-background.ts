"use client";

// ---------------------------------------------------------------------------
// Background removal: hybrid pipeline (Problem 2).
//
//   flood-key     - instant, exact and local. Removes a solid background that
//                   touches the image border. Used in Auto when the background
//                   is flat/solid and passes sanity checks. Enclosed
//                   same-colour areas (e.g. white text on white) stay intact
//                   because the flood is border-connected only.
//   border-model  - instant and local. FOLLOWS a background that fades or
//                   vignettes. Offline fallback when the ML model cannot load.
//   ml            - in-browser segmentation (onnxruntime-web, MIT; U2Netp /
//                   ISNet general-use) in a Web Worker (WebGPU when available,
//                   else single-thread WASM, no COOP/COEP required). Soft mask
//                   is refined at ORIGINAL resolution (never downscaled output),
//                   feather 0-2 px, decontaminated via edge-refine.
//
// Auto: flat+solid -> flood-key. Otherwise ML (downscaled copy) -> refine.
// Artwork/logo/text mode prefers colour-key so text/enclosed areas survive.
// Photo/object/person mode prefers ML. If the model cannot load (offline, no
// WebGPU/WASM, blocked), fall back to flood-key / border-model honestly.
// ---------------------------------------------------------------------------

import { removeBgBorderModel, removeBgFloodKey } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";

export type RemoveEngine = "auto" | "flood-key" | "border-model" | "ml";
export type RemoveMode = "auto" | "artwork" | "photo";

export interface RemoveOutcome {
  blob: Blob;
  /** Fraction of pixels whose ALPHA CHANGED. */
  removed: number;
  /** Which engine actually did the work. */
  engine: "flood-key" | "border-model" | "ml";
  /** Honest fallback note when the ML model was unavailable. */
  warning?: string;
}

/**
 * Below this the engine did not measurably change the image.
 *
 * 2% is small enough to keep a thin ring of background around a subject and
 * large enough to ignore the anti-aliased edge pixels that any engine always
 * rewrites (which would otherwise register as "something happened").
 */
export const MIN_REMOVED = 0.02;

/**
 * Above this the output is empty: essentially every pixel is transparent,
 * which means the ARTWORK was removed, not the background. This is the
 * classic flat-artwork failure where the design is one solid colour and the
 * flood fill eats the whole thing.
 */
export const MAX_TRANSPARENCY = 0.98;

/**
 * Above this the border model has removed the subject instead of the
 * background. It is looser than the flood key's own limit because the border
 * model matches a GRADIENT, so a backdrop that falls off towards the edges
 * legitimately leaves a lot of the image transparent.
 */
export const MAX_BORDER_TRANSPARENCY = 0.995;

/** Shown when nothing in the image looks like a removable background. */
const NO_BACKGROUND = "No background was detected in this image.";

/** The one thing a busy photo needs to hear: this remover cannot do it. */
const BUSY_BACKGROUND =
  "This remover handles a solid or faded background. A photo with a busy background has to be cut out before uploading.";

/** Shown when the artwork itself was the thing that got removed. */
const ARTWORK_WAS_BACKGROUND =
  "The artwork itself looks like the background, so removing the background would erase the whole design.";

export interface RemoveOptions {
  engine?: RemoveEngine;
  /** "auto" (hybrid), "artwork" (colour-key, preserves text), "photo" (ML). */
  mode?: RemoveMode;
  tolerance?: number;
  /** Edge feather, 0-2 px (default 1). */
  feather?: number;
  modelSize?: "small" | "large";
  /** Extra colour to remove (colour-pick tool). */
  extraColour?: { r: number; g: number; b: number } | null;
  /** Called with a short human-readable stage, e.g. "Removing background…". */
  onProgress?: (stage: string) => void;
  onDownload?: (loaded: number, total: number) => void;
}

/**
 * What an engine's numbers mean for the run.
 *
 * Exported so the rule can be pinned by unit tests as constants, rather than
 * only observable through a whole run.
 */
export type RemovalDecision =
  | { action: "use-flood-key" }
  | { action: "use-border-model" }
  | { action: "use-ml" }
  | { action: "escalate" }
  | { action: "artwork-was-background" }
  | { action: "no-background" };

/**
 * Decides what to do with an engine's result.
 *
 * The flood-key engine is tried first because it is instant and exact. It is
 * abandoned in exactly one case: it changed almost nothing, which means the
 * background was not a solid colour - so the ML / border model gets its turn.
 */
export function decideRemoval(input: {
  removed: number;
  transparency: number;
  engine: "flood-key" | "border-model" | "ml";
}): RemovalDecision {
  if (input.engine === "border-model" || input.engine === "ml") {
    if (input.removed < MIN_REMOVED) return { action: "no-background" };
    if (input.transparency > MAX_BORDER_TRANSPARENCY) {
      return { action: "artwork-was-background" };
    }
    return input.engine === "ml" ? { action: "use-ml" } : { action: "use-border-model" };
  }
  if (input.removed < MIN_REMOVED) return { action: "escalate" };
  if (input.transparency > MAX_TRANSPARENCY) return { action: "artwork-was-background" };
  return { action: "use-flood-key" };
}

/**
 * Removes the background of an image with the hybrid pipeline.
 *
 * Throws an `Error` whose message is safe to show to the user; the caller is
 * expected to catch it and surface the message.
 */
export async function removeBackgroundAuto(
  blob: Blob,
  opts: RemoveOptions = {},
): Promise<RemoveOutcome> {
  const engine = opts.engine ?? "auto";
  const mode: RemoveMode = opts.mode ?? "auto";
  const tolerance = opts.tolerance ?? FLOOD_KEY_DEFAULTS.tolerance;
  const feather = Math.max(0, Math.min(2, opts.feather ?? 1));
  const onProgress = opts.onProgress;
  const onDownload = opts.onDownload;

  if (engine === "border-model") {
    return runBorderModel(blob, tolerance, onProgress);
  }

  if (engine === "ml") {
    // Forced ML: no flood/border fallback by hand.
    onProgress?.("Removing background…");
    const { removeBgMlSegmentation } = await import("@/lib/bg-removal/engine");
    const result = await removeBgMlSegmentation(blob, {
      tolerance,
      feather,
      modelSize: opts.modelSize ?? "small",
      onProgress,
      onDownload,
    });
    const decision = decideRemoval({ removed: result.removed, transparency: result.transparency, engine: "ml" });
    if (decision.action === "artwork-was-background") throw new Error(ARTWORK_WAS_BACKGROUND);
    if (decision.action !== "use-ml") throw new Error(NO_BACKGROUND);
    // Extra colour removal (colour-pick tool).
    const outBlob = opts.extraColour ? await applyExtraColour(result.blob, opts.extraColour, tolerance) : result.blob;
    onProgress?.("Done");
    return { blob: outBlob, removed: result.removed, engine: "ml" };
  }

  if (engine === "flood-key") {
    onProgress?.("Removing background…");
    const result = await removeBgFloodKey(blob, tolerance);
    const decision = decideRemoval({
      removed: result.removed,
      transparency: result.transparency,
      engine: "flood-key",
    });
    if (decision.action === "no-background" || decision.action === "escalate") {
      // The flood key was chosen by hand, so "nothing changed" is a failure
      // rather than a reason to try the other engine.
      throw new Error(`${NO_BACKGROUND} ${BUSY_BACKGROUND}`);
    }
    if (decision.action === "artwork-was-background") {
      throw new Error(ARTWORK_WAS_BACKGROUND);
    }
    onProgress?.("Done");
    return { blob: result.blob, removed: result.removed, engine: "flood-key" };
  }

  // Photo mode prefers ML directly; artwork prefers colour-key (flood).
  if (mode === "photo") {
    onProgress?.("Removing background…");
    try {
      const { removeBgMlSegmentation } = await import("@/lib/bg-removal/engine");
      const ml = await removeBgMlSegmentation(blob, {
        tolerance,
        feather,
        modelSize: opts.modelSize ?? "small",
        onProgress,
        onDownload,
      });
      const d = decideRemoval({ removed: ml.removed, transparency: ml.transparency, engine: "ml" });
      if (d.action === "use-ml") {
        const outBlob = opts.extraColour ? await applyExtraColour(ml.blob, opts.extraColour, tolerance) : ml.blob;
        onProgress?.("Done");
        return { blob: outBlob, removed: ml.removed, engine: "ml" };
      }
      if (d.action === "artwork-was-background") throw new Error(ARTWORK_WAS_BACKGROUND);
    } catch (e) {
      // Fall through to flood/border below and say so honestly via warning.
      if (e instanceof Error && /artwork itself/i.test(e.message)) throw e;
    }
    // ML unavailable or empty -> local fallback with honest note.
    const fallback = await runAutoLocal(blob, tolerance, onProgress, true);
    return { ...fallback, warning: "The segmentation model was unavailable, so the local removers were used." };
  }

  // Auto + artwork: flood first (exact for flat/solid, preserves enclosed
  // same-colour text). Only escalate when flood provably cannot help.
  onProgress?.("Removing background…");
  const flood = await removeBgFloodKey(blob, tolerance);
  const floodDecision = decideRemoval({
    removed: flood.removed,
    transparency: flood.transparency,
    engine: "flood-key",
  });

  if (floodDecision.action === "artwork-was-background") {
    // Something was removed but everything was removed: the ARTWORK itself was
    // the background. The border model cannot rescue that, so fail here.
    throw new Error(ARTWORK_WAS_BACKGROUND);
  }
  if (floodDecision.action === "use-flood-key") {
    const outBlob = opts.extraColour ? await applyExtraColour(flood.blob, opts.extraColour, tolerance) : flood.blob;
    onProgress?.("Done");
    return { blob: outBlob, removed: flood.removed, engine: "flood-key" };
  }

  if (mode === "artwork") {
    // Artwork deliberately skips ML so white-on-white text inside the design
    // survives. Border model is the only escalation.
    const border = await runAutoLocal(blob, tolerance, onProgress, false);
    return border;
  }

  // Auto: not flat/solid. Try the faded-backdrop engine first (instant,
  // offline, exact for gradients), then ML for busy/photo backgrounds.
  // Keeping border before ML preserves the fast path and the offline
  // fallback; ML is the last resort for busy backgrounds both local engines
  // provably cannot touch.
  onProgress?.("Removing background (following a faded backdrop)…");
  try {
    const border = await removeBgBorderModel(blob, tolerance);
    const borderDecision = decideRemoval({
      removed: border.removed,
      transparency: border.transparency,
      engine: "border-model",
    });
    if (borderDecision.action === "use-border-model") {
      const outBlob = opts.extraColour ? await applyExtraColour(border.blob, opts.extraColour, tolerance) : border.blob;
      onProgress?.("Done");
      return { blob: outBlob, removed: border.removed, engine: "border-model" };
    }
    if (borderDecision.action === "artwork-was-background") throw new Error(ARTWORK_WAS_BACKGROUND);
  } catch (e) {
    if (e instanceof Error && /artwork itself/i.test(e.message)) throw e;
    // Border failure just means "continue to ML".
  }

  // Busy-photo path: ML segmentation, with honest offline fallback.
  let mlWarning: string | undefined;
  try {
    const { removeBgMlSegmentation } = await import("@/lib/bg-removal/engine");
    onProgress?.("Loading the segmentation model…");
    const ml = await removeBgMlSegmentation(blob, {
      tolerance,
      feather,
      modelSize: opts.modelSize ?? "small",
      onProgress,
      onDownload,
    });
    const d = decideRemoval({ removed: ml.removed, transparency: ml.transparency, engine: "ml" });
    if (d.action === "use-ml") {
      const outBlob = opts.extraColour ? await applyExtraColour(ml.blob, opts.extraColour, tolerance) : ml.blob;
      onProgress?.("Done");
      return { blob: outBlob, removed: ml.removed, engine: "ml" };
    }
    if (d.action === "artwork-was-background") throw new Error(ARTWORK_WAS_BACKGROUND);
    mlWarning = "The segmentation model found nothing to remove.";
  } catch (e) {
    if (e instanceof Error && /artwork itself/i.test(e.message)) throw e;
    mlWarning = "The segmentation model was unavailable (offline, no WebGPU/WASM, or blocked).";
  }

  throw new Error(
    mlWarning
      ? `${NO_BACKGROUND} ${mlWarning} ${BUSY_BACKGROUND}`
      : `${NO_BACKGROUND} ${BUSY_BACKGROUND}`,
  );
}

/** Local-only auto chain (flood already failed) used as the ML fallback. */
async function runAutoLocal(
  blob: Blob,
  tolerance: number,
  onProgress?: (stage: string) => void,
  silent: boolean = false,
): Promise<RemoveOutcome> {
  void silent;
  onProgress?.("Removing background (following a faded backdrop)…");
  const border = await removeBgBorderModel(blob, tolerance);
  const borderDecision = decideRemoval({
    removed: border.removed,
    transparency: border.transparency,
    engine: "border-model",
  });
  if (borderDecision.action === "use-border-model") {
    onProgress?.("Done");
    return { blob: border.blob, removed: border.removed, engine: "border-model" };
  }
  if (borderDecision.action === "artwork-was-background") {
    throw new Error(ARTWORK_WAS_BACKGROUND);
  }
  throw new Error(`${NO_BACKGROUND} ${BUSY_BACKGROUND}`);
}

async function applyExtraColour(
  blob: Blob,
  colour: { r: number; g: number; b: number },
  tolerance: number,
): Promise<Blob> {
  try {
    const { removeExtraColourFromPixels } = await import("@/lib/bg-removal/ml-mask");
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get 2D context");
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    removeExtraColourFromPixels(image.data, canvas.width, canvas.height, colour, tolerance);
    ctx.putImageData(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), "image/png");
    });
  } catch {
    return blob;
  }
}

/** The faded-backdrop engine, on its own. */
async function runBorderModel(
  blob: Blob,
  tolerance: number,
  onProgress?: (stage: string) => void,
): Promise<RemoveOutcome> {
  onProgress?.("Removing background (following a faded backdrop)…");
  const result = await removeBgBorderModel(blob, tolerance);
  const decision = decideRemoval({
    removed: result.removed,
    transparency: result.transparency,
    engine: "border-model",
  });
  if (decision.action === "no-background" || decision.action === "escalate") {
    throw new Error(`${NO_BACKGROUND} ${BUSY_BACKGROUND}`);
  }
  if (decision.action === "artwork-was-background") {
    throw new Error(ARTWORK_WAS_BACKGROUND);
  }
  onProgress?.("Done");
  return { blob: result.blob, removed: result.removed, engine: "border-model" };
}
