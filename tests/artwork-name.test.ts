import { describe, expect, it } from "vitest";
import { artworkFilename } from "@/lib/printify/artwork-name";

describe("artworkFilename", () => {
  it("names a pair's halves after their own designs", () => {
    const black = artworkFilename({
      label: "Black ink · Bear tee",
      designName: "Bear tee",
      ink: "main",
    });
    const white = artworkFilename({
      label: "White ink · Bear tee white",
      designName: "Bear tee",
      ink: "main",
    });
    expect(black).toBe("Bear_tee-main.png");
    expect(white).toBe("Bear_tee_white-main.png");
    // The whole point: two uploads in one product must not share a name.
    expect(black).not.toBe(white);
  });

  it("names a single ink-ticked design's two groups by ink role", () => {
    const black = artworkFilename({ label: "Black ink", designName: "Pine", ink: "black" });
    const white = artworkFilename({ label: "White ink", designName: "Pine", ink: "white" });
    expect(black).toBe("Pine-black-ink.png");
    expect(white).toBe("Pine-white-ink.png");
    expect(black).not.toBe(white);
  });

  it("keeps the main suffix for a plain design", () => {
    expect(artworkFilename({ label: "Main", designName: "Pine", ink: "main" })).toBe("Pine-main.png");
  });

  it("falls back to the item's design name when the label carries none", () => {
    expect(artworkFilename({ designName: "Pine", ink: "black" })).toBe("Pine-black-ink.png");
    expect(artworkFilename({ label: "", designName: "Pine", ink: "white" })).toBe("Pine-white-ink.png");
  });

  it("strips characters Printify would reject and collapses whitespace", () => {
    const name = artworkFilename({
      label: "Black ink · my/design: \"best\"?",
      designName: "x",
      ink: "main",
    });
    expect(name).toBe("mydesign_best-main.png");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("never returns an empty or dot-only name", () => {
    const name = artworkFilename({ label: "Black ink · ...", designName: "   ", ink: "main" });
    expect(name.endsWith(".png")).toBe(true);
    expect(name.length).toBeGreaterThan(4);
  });

  it("caps a very long name", () => {
    const name = artworkFilename({ designName: "x".repeat(400), ink: "black" });
    expect(name.length).toBeLessThanOrEqual(124);
    expect(name.endsWith(".png")).toBe(true);
  });
});
