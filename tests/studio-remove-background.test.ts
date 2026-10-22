import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeBgAI, removeBgBorderModel, removeBgFloodKey } from "@/lib/bg-removal/engine";
import type { BgRemovalResult } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import {
  decideRemoval,
  MAX_BORDER_TRANSPARENCY,
  MAX_TRANSPARENCY,
  MIN_REMOVED,
  removeBackgroundAuto,
} from "@/lib/printify/remove-background";

// ---------------------------------------------------------------------------
// The decision logic of the automatic background remover.
//
// There are THREE engines and they fail in opposite directions:
//
//   flood-key    - instant and exact, but it needs one flat colour that
//                  touches the border.
//   border-model - instant and local, and it FOLLOWS a backdrop that fades
//                  towards the edges, where the flood key leaves a halo.
//   ai-segmenter - works on any photograph, but the first run downloads a
//                  ~25 MB model.
//
// So the auto chain is: flood-key -> border-model -> ai-segmenter. The
// expensive engine is only reached when both local engines provably cannot
// help, and the tests below pin that order - a run that downloads a model to
// remove a solid background is a bug the user pays for in bandwidth.
//
// The numbers that decide:
//
//   removed      - the fraction of pixels whose ALPHA CHANGED. Never the
//                  output's total transparency: an already-transparent
//                  artwork scores 1.0 without a pixel being touched, and a
//                  solid-colour artwork scores 1.0 because the ARTWORK
//                  ITSELF was erased.
//   transparency - the fraction of fully transparent pixels in the output.
// ---------------------------------------------------------------------------

vi.mock("@/lib/bg-removal/engine", () => ({
  removeBgFloodKey: vi.fn(),
  removeBgBorderModel: vi.fn(),
  removeBgAI: vi.fn(),
}));

const floodKey = vi.mocked(removeBgFloodKey);
const borderModel = vi.mocked(removeBgBorderModel);
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
function expectUserFacing(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;

  expect(message.length).toBeGreaterThan(0);
  // A stack frame in a user-facing message means the raw error leaked.
  expect(message).not.toMatch(/\n\s+at\s/);
  expect(message).not.toMatch(/^\s*Error:/);
  // No debug leftovers.
  for (const jargon of ["undefined", "NaN", "[object"]) {
    expect(message).not.toContain(jargon);
  }
  return message;
}

/**
 * The stricter check: a message that also mentions no engine by its
 * internal name.
 */
function expectUserSafe(error: unknown): string {
  const message = expectUserFacing(error);

  // No internal identifiers.
  for (const jargon of [
    "flood-key",
    "border-model",
    "ai-segmenter",
    "removeBg",
    "MIN_REMOVED",
    "MAX_TRANSPARENCY",
    "assertUsable",
    "runAiSegmenter",
    "transparency",
    "alpha",
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
  borderModel.mockReset();
  aiSegmenter.mockReset();
  // Defaults so a test that forgets to stub an engine fails with a real
  // removal failure instead of a TypeError.
  floodKey.mockResolvedValue(engineResult(0, 0));
  borderModel.mockResolvedValue(engineResult(0, 0));
  aiSegmenter.mockResolvedValue(engineResult(0, 0));
});

describe("removeBackgroundAuto - the auto chain", () => {
  it("stops at the flood key when it succeeds", () => {
    // 50% of the pixels changed and the output is mostly opaque: a normal
    // successful cut-out of flat artwork.
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(outcome.removed).toBe(0.5);
      expect(outcome.blob).toBe(RESULT_BLOB);
      // The other two engines must not have been started.
      expect(borderModel).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("treats exactly 2% as a successful removal", () => {
    // The threshold is inclusive: 2% of the pixels changing is enough.
    floodKey.mockResolvedValue(engineResult(0.02, 0.2));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(borderModel).not.toHaveBeenCalled();
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

  it("tries the border model when the flood key changed almost nothing", () => {
    // The background is not one flat colour, so the flood key cannot touch
    // it. The border model follows a gradient and still needs no network,
    // so it is the next thing to try - and the AI is NOT downloaded.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(borderModel).toHaveBeenCalledTimes(1);
      expect(outcome.engine).toBe("border-model");
      expect(outcome.removed).toBe(0.4);
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("reports the border model as the engine that did the work", () => {
    floodKey.mockResolvedValue(engineResult(0, 0));
    borderModel.mockResolvedValue(engineResult(0.35, 0.25));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("border-model");
      expect(outcome.blob).toBe(RESULT_BLOB);
      expect(floodKey).toHaveBeenCalledTimes(1);
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("escalates to the AI segmenter when both local engines changed nothing", () => {
    // A photograph with a busy background: neither local engine can help,
    // so this is the only case where the model is downloaded.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.005, 0));
    aiSegmenter.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("ai-segmenter");
      expect(outcome.removed).toBe(0.4);
      expect(floodKey).toHaveBeenCalledTimes(1);
      expect(borderModel).toHaveBeenCalledTimes(1);
      expect(aiSegmenter).toHaveBeenCalledTimes(1);
    });
  });

  it("fails without escalating when the flood key erased the artwork", () => {
    // More than 98% transparent means the flood fill ate the DESIGN. The AI
    // segmenter cannot rescue that - it would only cost a model download to
    // fail the same way - so the cheap engine must fail the run outright.
    floodKey.mockResolvedValue(engineResult(0.99, 0.99));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      // The rule says "DO NOT escalate": the model must not be downloaded.
      expect(borderModel).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails without escalating when the border model erased the artwork", () => {
    // The border model is looser than the flood key (a gradient backdrop
    // legitimately leaves a lot of transparency), but once it has eaten the
    // artwork there is nothing left for the AI to find either.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.9, 0.999));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails when the AI segmenter also removes less than 2%", () => {
    floodKey.mockResolvedValue(engineResult(0, 0));
    borderModel.mockResolvedValue(engineResult(0, 0));
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
    borderModel.mockResolvedValue(engineResult(0, 0));
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
    borderModel.mockImplementation(async () => {
      events.push("border");
      return engineResult(0, 0);
    });
    aiSegmenter.mockImplementation(async (_blob, onProgress) => {
      events.push("ai");
      onProgress?.("Loading model");
      return engineResult(0.4, 0.5);
    });

    return removeBackgroundAuto(INPUT_BLOB, {
      onProgress: (stage) => events.push(`stage:${stage}`),
    }).then(() => {
      const download = events.findIndex((e) => /^stage:Downloading the background model/.test(e));
      const ai = events.indexOf("ai");
      expect(download).toBeGreaterThan(-1);
      // The announcement comes first, and after both local engines.
      expect(download).toBeLessThan(ai);
      expect(events.indexOf("border")).toBeLessThan(download);
      expect(events[events.length - 1]).toBe("stage:Done");
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

  it("does not announce the model download when a cheap engine succeeds", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages.some((s) => /model/i.test(s))).toBe(false);
    });
  });

  it("does not announce the model download when the border model succeeds", () => {
    // The border model is local and free: reaching the AI stage would be a
    // 25 MB download for nothing.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages.some((s) => /model/i.test(s))).toBe(false);
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });
});

describe("removeBackgroundAuto - forced engines", () => {
  it("never runs the other engines when the flood engine is forced", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" }).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(borderModel).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("never runs the other engines when the border model is forced", () => {
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "border-model" }).then((outcome) => {
      expect(outcome.engine).toBe("border-model");
      expect(floodKey).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("never runs the other engines when the AI engine is forced", () => {
    aiSegmenter.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "ai-segmenter" }).then((outcome) => {
      expect(outcome.engine).toBe("ai-segmenter");
      expect(floodKey).not.toHaveBeenCalled();
      expect(borderModel).not.toHaveBeenCalled();
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
      expect(borderModel).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails when the forced flood engine removed the artwork", () => {
    floodKey.mockResolvedValue(engineResult(0.99, 0.99));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      expect(borderModel).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails with a hint when the forced border model removed nothing", () => {
    // The border model cannot escalate either: the user chose it by hand.
    borderModel.mockResolvedValue(engineResult(0.001, 0));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "border-model" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/no background was detected/i);
      expect(message).toMatch(/tolerance/i);
      expect(floodKey).not.toHaveBeenCalled();
      expect(aiSegmenter).not.toHaveBeenCalled();
    });
  });

  it("fails when the forced border model removed the artwork", () => {
    borderModel.mockResolvedValue(engineResult(0.99, 0.999));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "border-model" })).then((error) => {
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
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("says the model could not be downloaded instead of blaming the tolerance", () => {
    // The model comes from a CDN at runtime: a blocked or offline network
    // is the common cause, and telling the user to raise the tolerance
    // would send them down the wrong path.
    aiSegmenter.mockRejectedValue(new Error("Failed to fetch"));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "ai-segmenter" })).then((error) => {
      const message = expectUserFacing(error);
      expect(message).toMatch(/could not be downloaded/i);
      expect(message).not.toMatch(/no background was detected/i);
    });
  });

  it("passes the tolerance through to the flood engine", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key", tolerance: 12 }).then(() => {
      expect(floodKey).toHaveBeenCalledTimes(1);
      expect(floodKey.mock.calls[0][1]).toBe(12);
    });
  });

  it("passes the tolerance through to the border model", () => {
    borderModel.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "border-model", tolerance: 12 }).then(() => {
      expect(borderModel).toHaveBeenCalledTimes(1);
      expect(borderModel.mock.calls[0][1]).toBe(12);
    });
  });

  it("passes the tolerance through to the border model in the auto chain", () => {
    floodKey.mockResolvedValue(engineResult(0, 0));
    borderModel.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { tolerance: 12 }).then(() => {
      expect(borderModel.mock.calls[0][1]).toBe(12);
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
    expect(
      decideRemoval({ removed: MIN_REMOVED, transparency: MAX_TRANSPARENCY, engine: "flood-key" }),
    ).toEqual({ action: "use-flood-key" });
  });

  it("escalates to the next engine when the flood key changed almost nothing", () => {
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

  it("fails the flood key just above the transparency limit", () => {
    // The limit is inclusive: exactly 98% passes, one thousandth more does
    // not.
    expect(
      decideRemoval({
        removed: 0.5,
        transparency: MAX_TRANSPARENCY + 0.001,
        engine: "flood-key",
      }),
    ).toEqual({ action: "artwork-was-background" });
  });

  it("keeps the border-model result when it removed something", () => {
    expect(decideRemoval({ removed: 0.5, transparency: 0.5, engine: "border-model" })).toEqual({
      action: "use-border-model",
    });
  });

  it("treats a border-model result at the exact thresholds as a success", () => {
    expect(
      decideRemoval({
        removed: MIN_REMOVED,
        transparency: MAX_BORDER_TRANSPARENCY,
        engine: "border-model",
      }),
    ).toEqual({ action: "use-border-model" });
  });

  it("escalates to the AI engine when the border model changed almost nothing", () => {
    expect(
      decideRemoval({ removed: MIN_REMOVED - 0.001, transparency: 0, engine: "border-model" }),
    ).toEqual({ action: "escalate" });
  });

  it("refuses to escalate when the border model erased the artwork itself", () => {
    // The border model is allowed to leave more transparency than the flood
    // key (a gradient backdrop legitimately does), but not this much.
    expect(
      decideRemoval({
        removed: 0.9,
        transparency: MAX_BORDER_TRANSPARENCY + 0.001,
        engine: "border-model",
      }),
    ).toEqual({ action: "artwork-was-background" });
  });

  it("accepts a healthy AI result", () => {
    expect(decideRemoval({ removed: 0.98, transparency: 0.41, engine: "ai-segmenter" })).toEqual({
      action: "use-ai-segmenter",
    });
  });

  it("treats an AI result at the exact removal threshold as a success", () => {
    expect(
      decideRemoval({ removed: MIN_REMOVED, transparency: 0.999, engine: "ai-segmenter" }),
    ).toEqual({ action: "use-ai-segmenter" });
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

describe("removeBackgroundAuto - the hosted service", () => {
  it("says plainly that no service is configured", async () => {
    // There is no key in this environment, so the engine must say WHICH key
    // is missing rather than failing silently or pretending to work.
    await expect(removeBackgroundAuto(INPUT_BLOB, { engine: "api" })).rejects.toThrow(
      /No background-removal service is configured/i,
    );
  });

  it("never reaches the hosted service while the local engines succeed", async () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.5));
    borderModel.mockResolvedValue(engineResult(0.5, 0.5));

    const out = await removeBackgroundAuto(INPUT_BLOB, { engine: "auto" });

    expect(out.engine).toBe("flood-key");
    expect(borderModel).not.toHaveBeenCalled();
  });
});
