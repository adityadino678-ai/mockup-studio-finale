import { describe, expect, it } from "vitest";
import { COLOUR_SEED } from "@/lib/printify/colour-seed";
import { parseHex, resolveColour } from "@/lib/printify/colors";

describe("the shipped colour seed", () => {
  it("every entry is a real hex - a bad paste must never ship", () => {
    for (const [name, hex] of Object.entries(COLOUR_SEED)) {
      expect(parseHex(hex).r, `${name} -> ${hex}`).not.toBeNull();
    }
  });

  it("names are normalised keys (lowercase, trimmed)", () => {
    for (const name of Object.keys(COLOUR_SEED)) {
      expect(name, name).toBe(name.trim().toLowerCase());
    }
  });
});

describe("seeded hexes resolve like learned hexes", () => {
  const SEED = { "heather grey": "#a4a4a3" };

  it("a seeded name resolves EXACT - not approximate", () => {
    const resolved = resolveColour("Heather Grey", { learned: SEED });
    expect(resolved).toEqual({ hex: "#a4a4a3", approximate: false, source: "learned" });
  });

  it("the browser's own learned hex wins over the seed", () => {
    const resolved = resolveColour("Heather Grey", {
      learned: { ...SEED, "heather grey": "#b7b6b5" },
    });
    expect(resolved).toEqual({ hex: "#b7b6b5", approximate: false, source: "learned" });
  });

  it("the user's override still wins over the seed", () => {
    const resolved = resolveColour("Heather Grey", {
      overrides: { "heather grey": "#123456" },
      learned: SEED,
    });
    expect(resolved).toEqual({ hex: "#123456", approximate: false, source: "override" });
  });

  it("an unseeded name still falls back to the curated guess, labelled approximate", () => {
    const resolved = resolveColour("Totally Unknown Shirt Colour", { learned: SEED });
    expect(resolved.approximate).toBe(true);
  });
});
