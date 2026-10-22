"use client";

// ---------------------------------------------------------------------------
// Background removal with an automatic choice of engine.
//
// Three engines exist and they fail in opposite directions:
//   flood-key     - instant, exact and local, but it can only remove a solid
//                   background that touches the image border. On a photo it
//                   removes nothing at all, which used to look like the
//                   feature did nothing.
//   border-model  - instant and local, and it FOLLOWS a background that fades
//                   or vignettes, so it removes a studio backdrop where the
//                   flood key leaves a halo. Still no network.
//   ai-segmenter  - works on any photograph, but the first run downloads a
//                   ~25 MB model and there is no way to tell that apart from
//                   a freeze.
//
// So the cheap engines run first and the expensive one is only used when the
// cheap ones provably cannot help. The user should never pay for a model
// download to remove a solid background, and should never be left staring at
// a spinner while a model downloads when a photograph was uploaded.
// ---------------------------------------------------------------------------

import { removeBgAI, removeBgBorderModel, removeBgFloodKey } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
// A TYPE-only import: it is erased at compile time, so this module does not
// pull the browser's IndexedDB into its dependency graph.
import type { BgRemoveProvider } from "@/lib/client/integrations";

export type RemoveEngine = "auto" | "flood-key" | "border-model" | "ai-segmenter" | "api";

export interface RemoveOutcome {
  blob: Blob;
  /** Fraction of pixels whose ALPHA CHANGED. */
  removed: number;
  /** Which engine actually did the work. */
  engine: "flood-key" | "border-model" | "ai-segmenter" | "api";
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

/**
 * Above this the border model has removed the subject instead of the
 * background. It is looser than the flood key's own limit because the border
 * model matches a GRADIENT, so a backdrop that falls off towards the edges
 * legitimately leaves a lot of the image transparent.
 */
export const MAX_BORDER_TRANSPARENCY = 0.995;

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
  | { action: "use-border-model" }
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
  engine: "flood-key" | "border-model" | "ai-segmenter";
}): RemovalDecision {
  if (input.engine === "ai-segmenter") {
    if (input.removed < MIN_REMOVED) return { action: "no-background" };
    if (input.transparency > 0.999) return { action: "ai-emptied-image" };
    return { action: "use-ai-segmenter" };
  }
  if (input.engine === "border-model") {
    if (input.removed < MIN_REMOVED) return { action: "escalate" };
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

  if (engine === "api") {
    const out = await runApi(blob, onProgress);
    return out;
  }

  if (engine === "border-model") {
    onProgress?.("Removing background…");
    const result = await removeBgBorderModel(blob, tolerance);
    const decision = decideRemoval({
      removed: result.removed,
      transparency: result.transparency,
      engine: "border-model",
    });
    if (decision.action === "no-background" || decision.action === "escalate") {
      throw new Error(
        `${NO_BACKGROUND} Try a higher tolerance, or use the AI engine for photos and complex backgrounds.`,
      );
    }
    if (decision.action === "artwork-was-background") {
      throw new Error(ARTWORK_WAS_BACKGROUND);
    }
    onProgress?.("Done");
    return { blob: result.blob, removed: result.removed, engine: "border-model" };
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
      // flood key changed almost nothing - which, with no other engine
      // allowed, is a failure rather than a reason to try the other engine.
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

  // auto: the cheap engines first.
  onProgress?.("Removing background…");
  const flood = await removeBgFloodKey(blob, tolerance);
  const floodDecision = decideRemoval({
    removed: flood.removed,
    transparency: flood.transparency,
    engine: "flood-key",
  });

  if (floodDecision.action === "artwork-was-background") {
    // Something was removed but everything was removed: the ARTWORK itself was
    // the background. The AI engine cannot rescue that - it would only cost a
    // model download to fail the same way - so fail here instead.
    throw new Error(ARTWORK_WAS_BACKGROUND);
  }
  if (floodDecision.action === "use-flood-key") {
    onProgress?.("Done");
    return { blob: flood.blob, removed: flood.removed, engine: "flood-key" };
  }

  // The flood key found nothing usable: the background is not one flat
  // colour. The border model follows a gradient or a vignette, and needs no
  // network, so it is the next thing to try.
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

  // Still nothing: this is a photograph with a busy background.
  //
  // The user's own hosted service is tried BEFORE the local model: it is
  // quicker, it is more accurate on a hard photograph, and it needs no 25 MB
  // download. The local model is the fallback for when there is no key.
  const api = await tryApi(blob, onProgress);
  if (api) return api;

  return runAiSegmenter(blob, onProgress);
}

/**
 * Removes the background through the user's own hosted service.
 *
 * The provider and the key come from Settings, so the engine is just "api".
 */
async function runApi(
  blob: Blob,
  onProgress?: (stage: string) => void,
  provider?: BgRemoveProvider,
): Promise<RemoveOutcome> {
  const id = provider ?? (await configuredApiProvider())?.id;
  if (!id) {
    throw new Error(
      "No background-removal service is configured. Add a key in Settings, or use one of the local engines.",
    );
  }
  onProgress?.("Sending the image to the background remover…");
  const { removeBackgroundWithApi } = await import("@/lib/client/background-removal");
  const out = await removeBackgroundWithApi(blob, { provider: id, onProgress });
  if (out.removed < MIN_REMOVED) {
    throw new Error(
      "The background remover returned the image unchanged. Try a different service or a different image.",
    );
  }
  return { blob: out.blob, removed: out.removed, engine: "api" };
}

/**
 * The hosted service the user configured, or null when there is none.
 *
 * The integrations store lives in the browser, so this can legitimately be
 * unavailable - in a worker, in a test, in private mode - and then the API
 * simply is not one of the options.
 */
async function configuredApiProvider(): Promise<{ id: BgRemoveProvider } | null> {
  try {
    const { loadIntegrations, hasBgRemoveKey } = await import("@/lib/client/integrations");
    const config = await loadIntegrations();
    if (!hasBgRemoveKey(config)) return null;
    return { id: config.bgRemove.provider };
  } catch {
    return null;
  }
}

/**
 * The API engine, or null when the user has not configured one.
 *
 * A service that IS configured but fails is not swallowed: the user asked
 * for that service and needs to know why it did not work.
 */
async function tryApi(
  blob: Blob,
  onProgress?: (stage: string) => void,
): Promise<RemoveOutcome | null> {
  const provider = await configuredApiProvider();
  if (!provider) return null;
  return runApi(blob, onProgress, provider.id);
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
  let result;
  try {
    result = await removeBgAI(blob, (stage) => onProgress?.(stage));
  } catch (err) {
    // The most common failure here is the model download: the library and
    // the weights come from a CDN, and a blocked or offline network makes
    // that impossible. Say THAT, not "no background was detected", which
    // would send the user off to raise the tolerance for no reason.
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch|network|Failed to fetch|load|import/i.test(message)) {
      throw new Error(
        "The background model could not be downloaded, so the AI engine could not run. Check your connection, or use the flood-key or border-model engine.",
      );
    }
    throw err;
  }
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
