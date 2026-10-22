"use client";

// ---------------------------------------------------------------------------
// Background removal: two local engines and nothing else.
//
//   flood-key     - instant, exact and local. It removes a solid background
//                   that touches the image border, which is what most print
//                   artwork has.
//   border-model  - instant and local. It FOLLOWS a background that fades or
//                   vignettes, so it removes a studio backdrop where the flood
//                   key leaves a halo.
//
// There is no hosted service, no API key and no model download: both engines
// are deterministic, run on this device and can be used without a limit. A
// busy photographic background is outside what they can do, and the failure
// says so instead of silently escalating to something that costs money.
//
// The cheap engine runs first and the second one is only used when the first
// provably cannot help. Every failure is thrown with a message that is safe to
// show to the user.
// ---------------------------------------------------------------------------

import { removeBgBorderModel, removeBgFloodKey } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";

export type RemoveEngine = "auto" | "flood-key" | "border-model";

export interface RemoveOutcome {
  blob: Blob;
  /** Fraction of pixels whose ALPHA CHANGED. */
  removed: number;
  /** Which engine actually did the work. */
  engine: "flood-key" | "border-model";
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
  tolerance?: number;
  /** Called with a short human-readable stage, e.g. "Removing background…". */
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
  | { action: "use-border-model" }
  | { action: "escalate" }
  | { action: "artwork-was-background" }
  | { action: "no-background" };

/**
 * Decides what to do with an engine's result.
 *
 * The flood-key engine is tried first because it is instant and exact. It is
 * abandoned in exactly one case: it changed almost nothing, which means the
 * background was not a solid colour - so the border model gets its turn.
 */
export function decideRemoval(input: {
  removed: number;
  transparency: number;
  engine: "flood-key" | "border-model";
}): RemovalDecision {
  if (input.engine === "border-model") {
    if (input.removed < MIN_REMOVED) return { action: "no-background" };
    if (input.transparency > MAX_BORDER_TRANSPARENCY) {
      return { action: "artwork-was-background" };
    }
    return { action: "use-border-model" };
  }
  if (input.removed < MIN_REMOVED) return { action: "escalate" };
  if (input.transparency > MAX_TRANSPARENCY) return { action: "artwork-was-background" };
  return { action: "use-flood-key" };
}

/**
 * Removes the background of an image with the local engines.
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

  if (engine === "border-model") {
    return runBorderModel(blob, tolerance, onProgress);
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

  // auto: the solid-background engine first, the faded-backdrop one second.
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
    onProgress?.("Done");
    return { blob: flood.blob, removed: flood.removed, engine: "flood-key" };
  }

  // The flood key found nothing usable: the background is not one flat
  // colour. The border model follows a gradient or a vignette.
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
