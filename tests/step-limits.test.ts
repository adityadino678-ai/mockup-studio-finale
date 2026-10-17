import { describe, expect, it } from "vitest";
import {
  callSignature,
  createCallTracker,
  MAX_IDENTICAL_CALLS,
  MAX_TURN_STEPS,
} from "@/lib/ai/step-limits";

describe("turn step limits", () => {
  it("allows enough steps for real multi-step work", () => {
    // A single Printify product needs ~5 steps before a confirm card; the old
    // cap of 6 dead-ended legitimate turns mid-task.
    expect(MAX_TURN_STEPS).toBeGreaterThanOrEqual(20);
  });

  it("still caps duplicate calls so a stuck model cannot run away", () => {
    expect(MAX_IDENTICAL_CALLS).toBeGreaterThanOrEqual(2);
    expect(MAX_IDENTICAL_CALLS).toBeLessThan(MAX_TURN_STEPS);
  });

  it("signs a call by name and trimmed arguments", () => {
    expect(callSignature("list_library", '  {"kind":"designs"}  ')).toBe(
      callSignature("list_library", '{"kind":"designs"}'),
    );
    expect(callSignature("list_library", "{}")).not.toBe(callSignature("summarize_workspace", "{}"));
  });

  it("counts each distinct call independently", () => {
    const tracker = createCallTracker();
    expect(tracker.record("list_library", "{}")).toBe(1);
    expect(tracker.record("list_library", "{}")).toBe(2);
    expect(tracker.record("summarize_workspace", "{}")).toBe(1);
    expect(tracker.count("list_library", "{}")).toBe(2);
    expect(tracker.count("browse_printify_catalog", "{}")).toBe(0);
  });

  it("flags an identical call once it passes the limit", () => {
    const tracker = createCallTracker();
    const limit = MAX_IDENTICAL_CALLS;
    for (let i = 1; i <= limit; i++) {
      expect(tracker.record("list_library", '{"kind":"designs"}')).toBe(i);
    }
    // The next identical call is the one the loop reacts to.
    expect(tracker.record("list_library", '{"kind":"designs"}')).toBe(limit + 1);
  });

  it("does not treat the same tool with different arguments as a stall", () => {
    const tracker = createCallTracker();
    for (let i = 0; i < MAX_IDENTICAL_CALLS + 2; i++) {
      expect(tracker.record("browse_printify_catalog", `{"query":"page-${i}"}`)).toBe(1);
    }
  });
});
