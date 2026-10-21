import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeBgAI, removeBgFloodKey } from "@/lib/bg-removal/engine";
import type { BgRemovalResult } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import { decideRemoval, MAX_TRANSPARENCY, MIN_REMOVED, removeBackgroundAuto } from "@/lib/printify/remove-background";

// ---------------------------------------------------------------------------
// The decision logic of the automatic background remover.
//
// The two engines need a real canvas (and the AI one needs a real model), so
// the pixels are stubbed here and only the DECISION is under test:
//
//   flood-key removed >= 2%  AND transparency <= 98%  -> success (flood-key)
//   flood-key removed >= 2%  AND transparency >  98%  -> FAIL, do not escalate
//   flood-key removed <  2%                          -> escalate to ai-segmenter
//   ai-segmenter removed < 2%                         -> FAIL
//
// Why these thresholds matter: an artwork that is ALREADY transparent scores
// 100% transparency without a pixel being touched, and a solid-colour
// artwork scores 100% because the ARTWORK ITSELF was erased. The number that
// says "did anything happen" is the fraction of pixels whose alpha CHANGED,
// which is what `removed` is.
// ---------------------------------------------------------------------------

vi.mock("@/lib/bg-removal/engine", () => ({
  removeBgFloodKey: vi.fn(),
  removeBgAI: vi.fn(),
}));

const floodKey = vi.mocked(removeBgFloodKey);
const aiSegmenter = vi.mocked(removeBgAI);

const INPUT_BLOB = new Blob(["input"], { type: "image/png" });
const RESULT_BLOB = new Blob(["result"], { type: "image/png" });

/** Builds an engine result with the two numbers the decision depends on. */
function engineResult(removed: number, transparency: number): BgRemovalResult {
  return { blob: RESULT_BLOB, removed, transparency };
}

/**
 * Asserts that a failure message is safe to show a visitor.
 *
 * A raw error would leak a stack trace or an internal identifier into the
 * dialog; the message has to read like a sentence.
 */
function expectUserSafe(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;

  expect(message.length).toBeGreaterThan(0);
  // A stack frame in a user-facing message means the raw error leaked.
  expect(message).not.toMatch(/\n\s+at\s/);
  expect(message).not.toMatch(/^\s*Error:/);
  // No internal identifiers, no debug leftovers.
  for (const jargon of [
    "flood-key",
    "ai-segmenter",
    "removeBg",
    "MIN_REMOVED",
    "MAX_TRANSPARENCY",
    "assertUsable",
    "runAiSegmenter",
    "transparency",
    "alpha",
    "undefined",
    "NaN",
    "[object",
  ]) {
    expect(message).not.toContain(jargon);
  }
  return message;
}

/** Runs the remover and returns the rejection instead of throwing. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the removal to fail, but it succeeded");
}

beforeEach(() => {
  floodKey.mockReset();
  aiSegmenter.mockReset();
  // Defaults so a test that forgets to stub an engine fails with a real
  // removal failure instead of a TypeError.
  floodKey.mockResolvedValue(engineResult(0, 0));
  aiSegmenter.mockResolvedValue(engineResult(0, 0));
});

describe("removeBackgroundAuto - auto engine", () => {
  it("accepts a flood-key result that removed something and left the artwork", () => {
    // 50% of the pixels changed and the output is mostly opaque: a normal
    // successful cut-out of flat artwork.
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(outcome.removed).toBe(0.5);
      expect(outcome.blob).toBe(RESULT_BLOB);
      // The expensive engine must not have been started.
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("treats exactly 2% as a successful removal", () => {
    // The threshold is inclusive: 2% of the pixels changing is enough.
    floodKey.mockResolvedValue(engineResult(0.02, 0.2));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("treats exactly 98% transparency as a success", () => {
    // A mostly transparent output is legitimate: the artwork is small in a
    // large print area. Only an essentially EMPTY output is a failure.
    floodKey.mockResolvedValue(engineResult(0.5, 0.98));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails without escalating when the artwork itself was removed", () => {
    // More than 98% transparent means the flood fill ate the DESIGN. The AI
    // segmenter cannot rescue that - it would only cost a model download to
    // fail the same way - so the cheap engine must fail the run outright.
    floodKey.mockResolvedValue(engineResult(0.99, 0.99));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      // The rule says "DO NOT escalate": the model must not be downloaded.
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("escalates to the AI segmenter when the flood key removed less than 2%", () => {
    // A photograph: the flood key cannot touch it, so the AI engine is used.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    aiSegmenter.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("ai-segmenter");
      expect(outcome.removed).toBe(0.4);
      expect(aiSegmenter).toHaveBeenCalledTimes(1);
    });
  });

  it("fails when the AI segmenter also removes less than 2%", () => {
    floodKey.mockResolvedValue(engineResult(0, 0));
    aiSegmenter.mockResolvedValue(engineResult(0.005, 0.1));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/no background was detected/i);
    });
  });

  it("fails when the AI segmenter empties the image", () => {
    // A segmenter can legitimately leave a small subject in a large
    // transparent field, so only an essentially empty output fails.
    floodKey.mockResolvedValue(engineResult(0, 0));
    aiSegmenter.mockResolvedValue(engineResult(0.5, 1));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/emptied the image/i);
    });
  });

  it("announces the model download before the AI engine starts", () => {
    // A ~25 MB download looks like a freeze unless it is announced first,
    // and the announcement has to come BEFORE the download starts.
    const events: string[] = [];
    floodKey.mockImplementation(async () => {
      events.push("flood");
      return engineResult(0, 0);
    });
    aiSegmenter.mockImplementation(async (_blob, onProgress) => {
      events.push("ai");
      onProgress?.("Loading modelâ€¦");
      return engineResult(0.4, 0.5);
    });

    return removeBackgroundAuto(INPUT_BLOB, {
      onProgress: (stage) => events.push(`stage:${stage}`),
    }).then(() => {
      expect(events[0]).toMatch(/^stage:Removing background/);
      expect(events[1]).toBe("flood");
      expect(events[2]).toMatch(/^stage:Downloading the background model/);
      expect(events[3]).toBe("ai");
      expect(events[4]).toBe("stage:Loading modelâ€¦");
    });
  });

  it("reports 'Done' when the cheap engine succeeds", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages[0]).toMatch(/^Removing background/);
      expect(stages[stages.length - 1]).toBe("Done");
    });
  });

  it("does not announce the model download when the flood key succeeds", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages.some((s) => /model/i.test(s))).toBe(false);
    });
  });
});

describe("removeBackgroundAuto - forced engines", () => {
  it("never runs the AI engine when the flood engine is forced", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" }).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("never runs the flood engine when the AI engine is forced", () => {
    aiSegmenter.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "ai-segmenter" }).then((outcome) => {
      expect(outcome.engine).toBe("ai-segmenter");
      expect(floodKey).not.toHaveBeenCalled();
    });
  });

  it("fails with a hint when the forced flood engine removed nothing", () => {
    // Forcing the cheap engine on a photo must say what to do about it,
    // rather than failing with a bare "nothing happened".
    floodKey.mockResolvedValue(engineResult(0.001, 0));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/no background was detected/i);
      expect(message).toMatch(/tolerance/i);
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails when the forced flood engine removed the artwork", () => {
    floodKey.mockResolvedValue(engineResult(0.99, 0.99));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails when the forced AI engine removed nothing", () => {
    aiSegmenter.mockResolvedValue(engineResult(0, 0));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "ai-segmenter" })).then((error) => {
      expect(expectUserSafe(error)).toMatch(/no background was detected/i);
      expect(floodKey).not.toHaveBeenCalled();
    });
  });

  it("passes the tolerance through to the flood engine", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key", tolerance: 12 }).then(() => {
      expect(floodKey).toHaveBeenCalledTimes(1);
      expect(floodKey.mock.calls[0][1]).toBe(12);
    });
  });

  it("uses the default tolerance when none is given", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" }).then(() => {
      expect(floodKey.mock.calls[0][1]).toBe(FLOOD_KEY_DEFAULTS.tolerance);
    });
  });
});

// ---------------------------------------------------------------------------
// The rule as a pure function.
//
// `decideRemoval` is the same rule the engine path uses, exported so the
// thresholds can be pinned as numbers instead of only through a whole run.
// ---------------------------------------------------------------------------

describe("decideRemoval", () => {
  it("keeps the flood-key result when it removed something and left an artwork behind", () => {
    expect(decideRemoval({ removed: 0.5, transparency: 0.5, engine: "flood-key" })).toEqual({
      action: "use-flood-key",
    });
  });

  it("treats a flood-key result at the exact thresholds as a success", () => {
    // The boundaries are inclusive: 2% removed and 98% transparent both pass.
    expect(decideRemoval({ removed: MIN_REMOVED, transparency: MAX_TRANSPARENCY, engine: "flood-key" })).toEqual({
      action: "use-flood-key",
    });
  });

  it("escalates to the AI engine when the flood key changed almost nothing", () => {
    expect(decideRemoval({ removed: 0.019, transparency: 0, engine: "flood-key" })).toEqual({
      action: "escalate",
    });
  });

  it("refuses to escalate when the flood key erased the artwork itself", () => {
    // Everything went, so the artwork WAS the background. The AI engine
    // cannot help here, so this must not turn into an escalation.
    expect(decideRemoval({ removed: 0.99, transparency: 0.99, engine: "flood-key" })).toEqual({
      action: "artwork-was-background",
    });
  });

  it("accepts a healthy AI result", () => {
    expect(decideRemoval({ removed: 0.98, transparency: 0.41, engine: "ai-segmenter" })).toEqual({
      action: "use-ai-segmenter",
    });
  });

  it("fails when the AI engine found no background", () => {
    expect(decideRemoval({ removed: 0.01, transparency: 0.2, engine: "ai-segmenter" })).toEqual({
      action: "no-background",
    });
  });

  it("fails when the AI engine emptied the image", () => {
    // The AI check is deliberately looser than the flood-key one: a small
    // subject in a big transparent field is a GOOD result, not an empty one.
    expect(decideRemoval({ removed: 0.99, transparency: 0.9995, engine: "ai-segmenter" })).toEqual({
      action: "ai-emptied-image",
    });
  });
});