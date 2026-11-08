import { describe, expect, it } from "vitest";
import {
  SLOGAN_MAX_LENGTH,
  clampSlogan,
  sloganFontSize,
  splitSlogan,
} from "@/lib/sketch/slogan";

describe("sketch slogan lines", () => {
  it("puts a single word on the middle orange line", () => {
    expect(splitSlogan("hello")).toEqual(["", "HELLO", ""]);
  });

  it("uses the top and middle lines for two words", () => {
    expect(splitSlogan("make more")).toEqual(["MAKE", "MORE", ""]);
  });

  it("uses all three lines for three words", () => {
    expect(splitSlogan("make more merch")).toEqual(["MAKE", "MORE", "MERCH"]);
  });

  it("keeps the remaining words on the third line", () => {
    expect(splitSlogan("good vibes only always")).toEqual([
      "GOOD",
      "VIBES",
      "ONLY ALWAYS",
    ]);
  });

  it("collapses whitespace and ignores empty input", () => {
    expect(splitSlogan("   ")).toEqual(["", "", ""]);
    expect(splitSlogan("  make   more\nmerch ")).toEqual([
      "MAKE",
      "MORE",
      "MERCH",
    ]);
  });

  it("shrinks long lines but never below the readable floor", () => {
    expect(sloganFontSize("MORE")).toBe(25);
    expect(sloganFontSize("AVERYLONGWORD")).toBeLessThan(25);
    expect(sloganFontSize("X".repeat(40))).toBe(11);
    expect(sloganFontSize("")).toBe(25);
  });

  it("clamps to the field limit without splitting a surrogate pair", () => {
    expect(clampSlogan("make more merch")).toBe("make more merch");
    expect(clampSlogan("x".repeat(60))).toHaveLength(SLOGAN_MAX_LENGTH);
    expect(Array.from(clampSlogan("👕".repeat(30)))).toHaveLength(
      SLOGAN_MAX_LENGTH,
    );
  });
});
