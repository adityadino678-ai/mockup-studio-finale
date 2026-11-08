import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const tokens = readFileSync(path.join(root, "src/styles/tokens.css"), "utf8");
const sketch = readFileSync(path.join(root, "src/styles/sketch.css"), "utf8");

const PALETTE: Record<string, string> = {
  "--paper": "#f7f3ec",
  "--ink": "#15110e",
  "--blue": "#3f63c9",
  "--orange": "#e8702a",
  "--wash": "#dde5f7",
};

describe("sketchbook tokens", () => {
  it("declares exactly the five approved brand colours", () => {
    for (const [token, hex] of Object.entries(PALETTE)) {
      expect(tokens).toContain(`${token}: ${hex};`);
    }
    const hexes = tokens.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(new Set(hexes.map((hex) => hex.toLowerCase()))).toEqual(
      new Set(Object.values(PALETTE)),
    );
  });

  it("self-hosts Josefin Sans and Caveat with system fallbacks", () => {
    expect(tokens).toContain('"Josefin Sans Variable"');
    expect(tokens).toContain("system-ui");
    expect(tokens).toContain('"Caveat Variable"');
    expect(tokens).toContain("cursive");
  });

  it("never uses a gradient in the sketch system", () => {
    expect(sketch).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/);
  });

  it("honours reduced motion with fully drawn art", () => {
    expect(sketch).toContain("@media (prefers-reduced-motion: reduce)");
    expect(sketch).toContain("stroke-dashoffset: 0 !important;");
  });

  it("keeps illustrations visible when JS never runs", () => {
    // The hidden start state is only armed by the .sk-anim class, which the
    // motion library adds after mount.
    expect(sketch).toContain(".sk-anim .sk-f {");
    expect(sketch).not.toMatch(/^\.sk-f \{/m);
  });

  it("plays the scene when .sk-in lands on the same element as .sk-anim", () => {
    expect(sketch).toContain(".sk-in .sk-f {");
    expect(sketch).toContain(".sk-in .sk-d {");
    expect(sketch).not.toContain(".sk-anim .sk-in");
  });

  it("animates transform, opacity and stroke only", () => {
    const keyframes = sketch.match(/@keyframes[\s\S]*?(?=\n\/\* --- Responsive)/);
    expect(keyframes?.[0]).toBeTruthy();
    expect(keyframes?.[0]).not.toMatch(/\b(width|height|top|left|background):/);
  });
});
