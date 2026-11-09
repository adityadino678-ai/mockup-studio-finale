import { describe, expect, it } from "vitest";
import {
  APPROXIMATE_INK_MARGIN,
  findTemplateMatch,
  harvestLearnedColours,
  hueForName,
  isWithinInkMargin,
  lightness,
  resolveColour,
  smartGuessHex,
  suggestInkForHex,
} from "@/lib/printify/colors";

describe("colour resolver order", () => {
  it("prefers user override over learned over exact over curated over smart", () => {
    const name = "Solid Black";
    expect(
      resolveColour(name, {
        overrides: { "solid black": "#111111" },
        learned: { "solid black": "#222222" },
        exactHexes: new Map([[name, ["#333333"]]]),
      }),
    ).toMatchObject({ hex: "#111111", source: "override", approximate: false });

    expect(
      resolveColour(name, {
        learned: { "solid black": "#222222" },
        exactHexes: new Map([[name, ["#333333"]]]),
      }),
    ).toMatchObject({ hex: "#222222", source: "learned", approximate: false });

    expect(
      resolveColour(name, { exactHexes: new Map([[name, ["#333333"]]]) }),
    ).toMatchObject({ hex: "#333333", source: "exact", approximate: false });

    // No exact/learned/override: curated wins and is marked approximate.
    expect(resolveColour(name)).toMatchObject({ source: "curated", approximate: true });
    // Unknown curated falls to smart and stays approximate but never plain grey.
    const smart = resolveColour("Totally Unknown Colour");
    expect(smart.source).toBe("smart");
    expect(smart.approximate).toBe(true);
    expect(smart.hex).not.toBe("#9ca3af");
    expect(/^#[0-9a-f]{6}$/.test(smart.hex)).toBe(true);
  });

  it("ignores an unparseable override", () => {
    const r = resolveColour("Solid Black", { overrides: { "solid black": "not-a-hex" } });
    expect(r.source).not.toBe("override");
  });
});

describe("smart fallback", () => {
  it("matches CSS named colours", () => {
    expect(smartGuessHex("Teal")).toBe("#008080");
    expect(smartGuessHex("crimson")).toBe("#dc143c");
  });

  it("handles qualifiers: dark / light / heather / solid / sport / vintage", () => {
    const dark = smartGuessHex("Mystery Dark Green");
    const base = smartGuessHex("Green");
    expect(lightness(dark)).toBeLessThan(lightness(base));
    const light = smartGuessHex("Mystery Light Green");
    expect(lightness(light)).toBeGreaterThan(lightness(base));
    const heather = smartGuessHex("Heather Green");
    expect(heather).not.toBe(base);
    // Qualifier-only prefixes do not change the base hue family.
    expect(smartGuessHex("Solid Teal")).toBe("#008080");
    expect(smartGuessHex("Sport Teal")).toBe("#008080");
    expect(smartGuessHex("Vintage Teal")).toBe("#008080");
  });

  it("picks the nearest known colour and a deterministic hue for nonsense", () => {
    expect(smartGuessHex("Dark Navy Blue Thing")).not.toBe("#9ca3af");
    const a = smartGuessHex("Zxq Jibber Wobble 42");
    const b = smartGuessHex("Zxq Jibber Wobble 42");
    expect(a).toBe(b);
    expect(a).not.toBe("#9ca3af");
    expect(hueForName("Zxq Jibber Wobble 42")).toBe(hueForName("zxq jibber wobble 42"));
  });

  it("never renders two different unknowns as the same grey", () => {
    expect(smartGuessHex("Alpha Zorp")).not.toBe(smartGuessHex("Beta Quilp"));
  });
});

describe("paging + template match", () => {
  const prods = [
    { id: "p1", blueprint_id: 6, print_provider_id: 30 },
    { id: "p2", blueprint_id: 99, print_provider_id: 30 },
    { id: "p3", blueprint_id: 6, print_provider_id: 31 },
    { id: "p4", blueprint_id: 6, print_provider_id: 30 },
  ];

  it("finds an exact match on same blueprint+provider even beyond the first page", () => {
    // P4 is conceptually on page 2 (beyond 50 items on page 1).
    const { exact, approximate } = findTemplateMatch([...prods], 6, 30);
    expect(exact?.id).toBe("p1");
    expect(approximate).toBeUndefined();
  });

  it("accepts same blueprint with another provider as approximate", () => {
    const { exact, approximate } = findTemplateMatch(
      [{ id: "only", blueprint_id: 6, print_provider_id: 99 }],
      6,
      30,
    );
    expect(exact).toBeUndefined();
    expect(approximate?.id).toBe("only");
  });

  it("returns none when no blueprint matches", () => {
    expect(findTemplateMatch(prods, 2026, 30)).toEqual({});
  });

  it("harvests learned name->hex for many blueprints at once", () => {
    const learned = harvestLearnedColours([
      { title: "Heather Grey", colors: ["#A4A4A3", "#B7B6B5"] },
      { title: "Solid Black", colors: ["#050505"] },
      { title: "Broken", colors: ["not-a-hex"] },
    ]);
    expect(learned).toEqual({ "heather grey": "#a4a4a3", "solid black": "#050505" });
  });
});

describe("threshold-margin ink rule", () => {
  it("forces ambiguous for approximate hexes within the margin", () => {
    expect(APPROXIMATE_INK_MARGIN).toBeGreaterThan(0);
    // Just outside the dark threshold (0.30) but within the margin of 0.35:
    // exact says "white", approximate near a threshold must ask first.
    const v = Math.round(0.3 * 255);
    const hex = `#${[v, v, v].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    expect(lightness(hex)).toBeCloseTo(0.3, 2);
    expect(isWithinInkMargin(hex)).toBe(true);
    expect(suggestInkForHex(hex, true)).toBe("ambiguous");
    // The same hex without the approximate flag does NOT force ambiguous.
    expect(suggestInkForHex(hex, false)).toBe("white");
    // Far from thresholds, approximate can still resolve.
    expect(suggestInkForHex("#050505", true)).toBe("white");
    expect(suggestInkForHex("#f9f9f9", true)).toBe("black");
    // Just above the light threshold (0.70) but within the margin of 0.65.
    const v2 = Math.round(0.7 * 255);
    const hex2 = `#${[v2, v2, v2].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    expect(isWithinInkMargin(hex2)).toBe(true);
    expect(suggestInkForHex(hex2, true)).toBe("ambiguous");
    expect(suggestInkForHex(hex2, false)).toBe("black");
  });
});
