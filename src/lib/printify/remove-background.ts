"use client";

// ---------------------------------------------------------------------------
// Background removal with an automatic choice of engine.
//
// Two engines exist and they fail in opposite directions:
//   flood-key     - instant, exact and local, but it can only remove a solid
//                   background that touches the image border. On a photo it
//                   removes nothing at all, which used to look like the
//                   feature did nothing.
//   ai-segmenter  - works on photos, but the first run downloads a ~25 MB
//                   model and there is no way to tell that apart from a
//                   freeze.
//
// So the cheap engine runs first and the expensive one is only used when the
// cheap one is provably unable to help. The user should never pay for a model
// download to remove a solid background, and should never be left staring at
// a spinner while a model downloads when a photograph was uploaded.
// ---------------------------------------------------------------------------

import { removeBgAI, removeBgFloodKey } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";

export type RemoveEngine = "auto" | "flood-key" | "ai-segmenter";

export interface RemoveOutcome {
  blob: Blob;
  /** Fraction of pixels whose ALPHA CHANGED. */
  removed: number;
  /** Which engine actually did the work. */
  engine: "flood-key" | "ai-segmenter";
}

/**
 * Below this the engine did not measurably change the image.
 *
 * 2% is small enough to keep a thin ring of background around a subject and
 * large enough to ignore the anti-aliased edge pixels that a segmenter
 * always rewrites (which would otherwise register as "something happened").
 */
export const MIN_REMOVED = 0.02;

/**
 * Above this the output is empty: essentially every pixel is transparent,
 * which means the ARTWORK was removed, not the background. This is the
 * classic flat-artwork failure where the design is one solid colour and the
 * flood fill eats the whole thing.
 */
export const MAX_TRANSPARENCY = 0.98;

/** Shown when nothing in the image looks like a removable background. */
const NO_BACKGROUND = "No background was detected in this image.";

/** Shown when the artwork itself was the thing that got removed. */
const ARTWORK_WAS_BACKGROUND =
  "The artwork itself looks like the background, so removing the background would erase the whole design. Try a lower tolerance.";

interface RemoveOptions {
  engine?: RemoveEngine;
  tolerance?: number;
  /** Called with a short human-readable stage, e.g. "Downloading the background model…". */
  onProgress?: (stage: string) => void;
}

/**
 * What an engine's numbers mean for the run.
 *
 * Exported so the rule can be pinned by unit tests as constants, rather than
 * only observable through a whole run.
 */
export type RemovalDecision =
  | { action: "use-flood-key" }
  | { action: "use-ai-segmenter" }
  | { action: "escalate" }
  | { action: "artwork-was-background" }
  | { action: "no-background" }
  | { action: "ai-emptied-image" };

/**
 * Decides what to do with an engine's result.
 *
 * The flood-key engine is tried first because it is instant and local. It is
 * abandoned in exactly one case: it changed almost nothing, which means the
 * background was not a solid colour - i.e. this is a photograph.
 */
export function decideRemoval(input: {
  removed: number;
  transparency: number;
  engine: "flood-key" | "ai-segmenter";
}): RemovalDecision {
  if (input.engine === "ai-segmenter") {
    if (input.removed < MIN_REMOVED) return { action: "no-background" };
    if (input.transparency > 0.999) return { action: "ai-emptied-image" };
    return { action: "use-ai-segmenter" };
  }
  if (input.removed < MIN_REMOVED) return { action: "escalate" };
  if (input.transparency > MAX_TRANSPARENCY) return { action: "artwork-was-background" };
  return { action: "use-flood-key" };
}

/**
 * Removes the background of an image, picking the engine that fits.
 *
 * Throws an `Error` whose message is safe to show to the user; the caller is
 * expected to catch it and surface the message.
 */
export async function removeBackgroundAuto(
  blob: Blob,
  opts: RemoveOptions = {},
): Promise<RemoveOutcome> {
  const engine = opts.engine ?? "auto";
  const tolerance = opts.tolerance ?? FLOOD_KEY_DEFAULTS.tolerance;
  const onProgress = opts.onProgress;

  if (engine === "ai-segmenter") {
    return runAiSegmenter(blob, onProgress);
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
      // The forced flood-key path is the one place where the tolerance hint
      // belongs: the user chose this engine by hand. "escalate" means the
      // flood key changed almost nothing - which, with no AI engine allowed,
      // is a failure rather than a reason to try the other engine.
      throw new Error(
        `${NO_BACKGROUND} Try a higher tolerance, or use the AI engine for photos and complex backgrounds.`,
      );
    }
    if (decision.action === "artwork-was-background") {
      throw new Error(ARTWORK_WAS_BACKGROUND);
    }
    onProgress?.("Done");
    return { blob: result.blob, removed: result.removed, engine: "flood-key" };
  }

  // auto: the cheap engine first.
  onProgress?.("Removing background…");
  const flood = await removeBgFloodKey(blob, tolerance);
  const decision = decideRemoval({
    removed: flood.removed,
    transparency: flood.transparency,
    engine: "flood-key",
  });

  if (decision.action === "artwork-was-background") {
    // Something was removed but everything was removed: the ARTWORK itself was
    // the background. The AI engine cannot rescue that - it would only cost a
    // model download to fail the same way - so fail here instead.
    throw new Error(ARTWORK_WAS_BACKGROUND);
  }
  if (decision.action === "escalate") {
    // The flood key found nothing usable: this is a photo.
    return runAiSegmenter(blob, onProgress);
  }
  onProgress?.("Done");
  return { blob: flood.blob, removed: flood.removed, engine: "flood-key" };
}

/**
 * Runs the AI segmenter and applies the same success checks.
 *
 * The transparency check is deliberately looser here than for the flood key:
 * a segmenter legitimately leaves a small subject in a large transparent
 * field, and treating that as "the artwork was erased" would reject good
 * results. Only an essentially empty output is a failure.
 */
async function runAiSegmenter(
  blob: Blob,
  onProgress?: (stage: string) => void,
): Promise<RemoveOutcome> {
  // Said up front, because the model download is the one part of the run
  // that can take a while and looks like a freeze if it is not announced.
  onProgress?.("Downloading the background model (~25 MB, first use only)");
  const result = await removeBgAI(blob, (stage) => onProgress?.(stage));
  const decision = decideRemoval({
    removed: result.removed,
    transparency: result.transparency,
    engine: "ai-segmenter",
  });
  if (decision.action === "no-background") {
    throw new Error(NO_BACKGROUND);
  }
  if (decision.action === "ai-emptied-image") {
    throw new Error(
      "The background remover emptied the image - nothing was left. Try a different image.",
    );
  }
  // The AI path has to report "Done" too: a caller that waits for it to
  // close its progress indicator would otherwise spin forever.
  onProgress?.("Done");
  return { blob: result.blob, removed: result.removed, engine: "ai-segmenter" };
}