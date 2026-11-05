import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The "Fit to area" action was deliberately removed from the print areas
 * screen by the project owner (Nov 2026). Placement is edited in the
 * Printify Studio only. This test fails if the button (or the code path
 * that supports it) is ever reintroduced. Do not fix it by weakening the
 * assertions - fix it by removing the re-added code.
 */
describe("the print areas screen has no Fit to area path", () => {
  const tab = readFileSync(join(__dirname, "../src/views/mockups/print-areas-tab.tsx"), "utf8");
  const fitModule = readFileSync(join(__dirname, "../src/lib/printify/fit.ts"), "utf8");

  it("does not render the Fit to area button", () => {
    expect(tab).not.toContain("Fit to area");
  });

  it("does not contain the fitToArea helper", () => {
    expect(tab).not.toMatch(/\bfitToArea\b/);
  });

  it("does not import or call computeFit", () => {
    expect(tab).not.toMatch(/\bcomputeFit\b/);
  });

  it("does not define computeFit either", () => {
    expect(fitModule).not.toMatch(/\bcomputeFit\b/);
  });
});
