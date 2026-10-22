import { beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "@/lib/bg-removal/engine";
import { removeBgBorderModel, removeBgFloodKey } from "@/lib/bg-removal/engine";
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
// The decision logic of the background remover.
//
// There are exactly TWO engines, both local, both free, both instant:
//
//   flood-key    - exact, but it needs one flat colour that touches the
//                  border.
//   border-model - it FOLLOWS a backdrop that fades or vignettes towards the
//                  edges, where the flood key leaves a halo.
//
// The chain is flood-key -> border-model and it stops there. There is no AI
// model to download and no hosted service to call: the remover works offline,
// needs no key and has no usage limit. That is a product decision, not an
// implementation detail, so the tests pin that the chain cannot escalate past
// the two engines.
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
}));

const floodKey = vi.mocked(removeBgFloodKey);
const borderModel = vi.mocked(removeBgBorderModel);

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
  // Defaults so a test that forgets to stub an engine fails with a real
  // removal failure instead of a TypeError.
  floodKey.mockResolvedValue(engineResult(0, 0));
  borderModel.mockResolvedValue(engineResult(0, 0));
});

describe("the engine module", () => {
  it("exposes the two local engines and nothing else", () => {
    // The AI segmenter and the hosted-service path are gone. If either comes
    // back by accident, this is the test that says so.
    expect(typeof engine.removeBgFloodKey).toBe("function");
    expect(typeof engine.removeBgBorderModel).toBe("function");
    expect("removeBgAI" in engine).toBe(false);
    expect("removeBackground" in engine).toBe(false);
    expect("setBgRemovalProgressCallback" in engine).toBe(false);
  });
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
      // The second engine must not have been started.
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("treats exactly 2% as a successful removal", () => {
    // The threshold is inclusive: 2% of the pixels changing is enough.
    floodKey.mockResolvedValue(engineResult(0.02, 0.2));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("treats exactly 98% transparency as a success", () => {
    // A mostly transparent output is legitimate: the artwork is small in a
    // large print area. Only an essentially EMPTY output is a failure.
    floodKey.mockResolvedValue(engineResult(0.5, 0.98));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("tries the border model when the flood key changed almost nothing", () => {
    // The background is not one flat colour, so the flood key cannot touch
    // it. The border model follows a gradient and still needs no network.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(borderModel).toHaveBeenCalledTimes(1);
      expect(outcome.engine).toBe("border-model");
      expect(outcome.removed).toBe(0.4);
    });
  });

  it("reports the border model as the engine that did the work", () => {
    floodKey.mockResolvedValue(engineResult(0, 0));
    borderModel.mockResolvedValue(engineResult(0.35, 0.25));

    return removeBackgroundAuto(INPUT_BLOB).then((outcome) => {
      expect(outcome.engine).toBe("border-model");
      expect(outcome.blob).toBe(RESULT_BLOB);
      expect(floodKey).toHaveBeenCalledTimes(1);
    });
  });

  it("fails without escalating when the flood key erased the artwork", () => {
    // More than 98% transparent means the flood fill ate the DESIGN. The
    // border model cannot rescue that - it would fail the same way - so the
    // cheap engine must fail the run outright instead of guessing again.
    floodKey.mockResolvedValue(engineResult(0.99, 0.99));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("fails without escalating when the border model erased the artwork", () => {
    // The border model is looser than the flood key (a gradient backdrop
    // legitimately leaves a lot of transparency), but once it has eaten the
    // artwork there is nothing left to find.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.9, 0.999));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
    });
  });

  it("says a busy background is out of scope when both engines change nothing", () => {
    // A photograph with a busy background. The chain has nothing left, so it
    // must say that plainly instead of pretending a removal happened.
    floodKey.mockResolvedValue(engineResult(0, 0));
    borderModel.mockResolvedValue(engineResult(0.005, 0.1));

    return rejection(removeBackgroundAuto(INPUT_BLOB)).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/no background was detected/i);
      expect(message).toMatch(/solid or faded background/i);
      expect(message).toMatch(/cut out before uploading/i);
    });
  });

  it("reports 'Done' when the flood key succeeds", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages[0]).toMatch(/^Removing background/);
      expect(stages[stages.length - 1]).toBe("Done");
    });
  });

  it("reports a stage when it falls back to the border model", () => {
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages.some((s) => /faded backdrop/i.test(s))).toBe(true);
      expect(stages[stages.length - 1]).toBe("Done");
    });
  });

  it("never mentions a model download", () => {
    // There is no model any more. A "downloading…" stage would be a lie that
    // also makes the instant remover look slow.
    floodKey.mockResolvedValue(engineResult(0.01, 0));
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));
    const stages: string[] = [];

    return removeBackgroundAuto(INPUT_BLOB, { onProgress: (s) => stages.push(s) }).then(() => {
      expect(stages.some((s) => /model|download|\bMB\b/i.test(s))).toBe(false);
    });
  });
});

describe("removeBackgroundAuto - forced engines", () => {
  it("never runs the border model when the flood engine is forced", () => {
    floodKey.mockResolvedValue(engineResult(0.5, 0.3));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" }).then((outcome) => {
      expect(outcome.engine).toBe("flood-key");
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("never runs the flood key when the border model is forced", () => {
    borderModel.mockResolvedValue(engineResult(0.4, 0.5));

    return removeBackgroundAuto(INPUT_BLOB, { engine: "border-model" }).then((outcome) => {
      expect(outcome.engine).toBe("border-model");
      expect(floodKey).not.toHaveBeenCalled();
    });
  });

  it("fails with a usable message when the forced flood engine removed nothing", () => {
    // The user chose the engine by hand, so "nothing happened" is a failure
    // rather than a reason to run the other one.
    floodKey.mockResolvedValue(engineResult(0.001, 0));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/no background was detected/i);
      expect(message).toMatch(/solid or faded background/i);
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("fails when the forced flood engine removed the artwork", () => {
    floodKey.mockResolvedValue(engineResult(0.99, 0.99));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "flood-key" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
      expect(borderModel).not.toHaveBeenCalled();
    });
  });

  it("fails with a usable message when the forced border model removed nothing", () => {
    // The border model cannot escalate either: the user chose it by hand,
    // and there is nothing after it.
    borderModel.mockResolvedValue(engineResult(0.001, 0));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "border-model" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/no background was detected/i);
      expect(floodKey).not.toHaveBeenCalled();
    });
  });

  it("fails when the forced border model removed the artwork", () => {
    borderModel.mockResolvedValue(engineResult(0.99, 0.999));

    return rejection(removeBackgroundAuto(INPUT_BLOB, { engine: "border-model" })).then((error) => {
      const message = expectUserSafe(error);
      expect(message).toMatch(/artwork itself looks like the background/i);
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

  it("moves on to the border model when the flood key changed almost nothing", () => {
    expect(decideRemoval({ removed: 0.019, transparency: 0, engine: "flood-key" })).toEqual({
      action: "escalate",
    });
  });

  it("refuses to escalate when the flood key erased the artwork itself", () => {
    // Everything went, so the artwork WAS the background. The border model
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

  it("is the end of the chain when the border model changed almost nothing", () => {
    // There is no third engine. A border-model miss is a final "no
    // background here", not another escalation.
    expect(
      decideRemoval({ removed: MIN_REMOVED - 0.001, transparency: 0, engine: "border-model" }),
    ).toEqual({ action: "no-background" });
  });

  it("refuses the border model when it erased the artwork itself", () => {
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
});
