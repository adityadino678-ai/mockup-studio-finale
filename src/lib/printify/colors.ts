// ---------------------------------------------------------------------------
// Colour helpers.
//
// Printify's catalogue only gives colour NAMES. The real hexes live on a
// product (`options[].values[].colors[]`) - see AGENTS.md. Until we have a
// product to read them from, this module supplies a curated fallback table and
// the maths that decides which ink a garment needs.
//
// The ink rule (locked): a DARK garment needs WHITE ink, a LIGHT garment needs
// BLACK ink, and a mid-tone is AMBIGUOUS - the user must choose, because
// guessing wrong means invisible artwork.
// ---------------------------------------------------------------------------

/** Which ink a design should be printed in on a given garment colour. */
export type InkChoice = "black" | "white" | "ambiguous";

/** Below this the garment reads as dark -> white ink. */
export const DARK_THRESHOLD = 0.35;
/** Above this the garment reads as light -> black ink. */
export const LIGHT_THRESHOLD = 0.65;

/**
 * Perceived brightness of a hex colour, 0 (black) to 1 (white).
 *
 * This is the classic luma weighting (0.299 R + 0.587 G + 0.114 B) applied to
 * sRGB bytes *without* linearising. Luma tracks how a person names a colour
 * ("dark navy", "light grey") far better than relative luminance does, which
 * is why it is used here rather than the WCAG formula.
 */
export function lightness(hex: string): number {
  const { r, g, b } = parseHex(hex);
  if (r === null || g === null || b === null) return 0.5;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * The ink a design should use on a garment of this colour.
 *
 * Mid-tones are returned as "ambiguous" rather than guessed: a mid-grey shirt
 * is exactly where black-on-dark or white-on-light goes wrong, and the cost of
 * asking is one click.
 */
export function suggestInk(hex: string): InkChoice {
  const l = lightness(hex);
  if (l < DARK_THRESHOLD) return "white";
  if (l > LIGHT_THRESHOLD) return "black";
  return "ambiguous";
}

/** Picks the first hex of a colour, or the supplied fallback. */
export function primaryHex(hexes: string[] | undefined, fallback = "#9ca3af"): string {
  const first = hexes?.find((h) => typeof h === "string" && h.trim().length > 0);
  return first ? normaliseHex(first) : fallback;
}

/** Normalises "#ABC" / "abc" to "#aabbcc". Returns the input if unparseable. */
export function normaliseHex(value: string): string {
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return value.trim();
}

/** Parses a hex colour into 0-255 channels, or nulls when it is not a hex. */
export function parseHex(hex: string): { r: number | null; g: number | null; b: number | null } {
  const raw = hex.trim().replace(/^#/, "");
  const full = /^[0-9a-fA-F]{3}$/.test(raw)
    ? raw
        .split("")
        .map((c) => c + c)
        .join("")
    : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return { r: null, g: null, b: null };
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** A readable ink colour for text drawn on top of a swatch. */
export function contrastInk(hex: string): "#ffffff" | "#111827" {
  return lightness(hex) > 0.55 ? "#111827" : "#ffffff";
}

// ---------------------------------------------------------------------------
// Ink versus garment contrast
// ---------------------------------------------------------------------------

/**
 * How well an ink choice reads against a garment colour.
 *
 * - "ok"      the ink is clearly visible on the garment
 * - "low"     a mid-tone garment: either ink risks disappearing
 * - "none"    the ink is the SAME tone as the garment, so it is invisible
 *
 * "none" is worth catching loudly. It is easy to reach by accident: mark
 * "Black" for the black ink and the artwork disappears into the shirt.
 */
export type InkContrast = "ok" | "low" | "none";

export function inkContrast(garmentHex: string, ink: "black" | "white"): InkContrast {
  const l = lightness(garmentHex);
  if (l < DARK_THRESHOLD) {
    // A dark garment: white ink reads, black ink vanishes.
    return ink === "white" ? "ok" : "none";
  }
  if (l > LIGHT_THRESHOLD) {
    // A light garment: black ink reads, white ink vanishes.
    return ink === "black" ? "ok" : "none";
  }
  return "low";
}

/** A sentence explaining a contrast problem, for the UI. */
export function describeInkContrast(garmentHex: string, ink: "black" | "white"): string {
  const contrast = inkContrast(garmentHex, ink);
  if (contrast === "ok") return "";
  const garment = lightness(garmentHex) < DARK_THRESHOLD ? "dark" : "light";
  if (contrast === "none") {
    return `The ${ink} ink is the same tone as this ${garment} garment, so the design would be invisible.`;
  }
  return `This is a mid-tone garment, so ${ink} ink may be hard to see.`;
}

// ---------------------------------------------------------------------------
// Fallback table
// ---------------------------------------------------------------------------

/**
 * Curated hexes for the colour names Printify uses most. This is a FALLBACK
 * for when no product is available to read real hexes from - the values below
 * are the manufacturers' published garment colours, not guesses.
 */
const FALLBACK_HEXES: Record<string, string> = {
  "solid black": "#050505",
  "solid white": "#f9f9f9",
  "solid red": "#c8102e",
  "solid navy": "#0c2340",
  "solid blue": "#0f4c81",
  "solid royal": "#4169e1",
  "solid green": "#00853f",
  "solid kelly": "#4cbb17",
  "solid maroon": "#7b1113",
  "solid purple": "#4b0082",
  "solid violet": "#8f00ff",
  "solid pink": "#ff69b4",
  "solid orange": "#ff6600",
  "solid gold": "#d4af37",
  "solid yellow": "#ffd700",
  "solid brown": "#4a2c17",
  "solid tan": "#d2b48c",
  "solid cream": "#fdf6e3",
  "solid sand": "#c2b280",
  "solid charcoal": "#36454f",
  "solid forest": "#228b22",
  "solid teal": "#008080",
  "solid turquoise": "#40e0d0",
  "solid coral": "#ff7f50",
  "solid indigo": "#4b0082",
  "solid fuchsia": "#c154c1",
  "solid khaki": "#c3b091",
  "solid olive": "#808000",
  "solid scarlet": "#ff2400",
  "solid marbled": "#6d6d6d",
  "heather grey": "#a4a4a3",
  "heather slate": "#454b51",
  "light heather grey": "#c3c3c3",
  "dark heather grey": "#63666a",
  "sport grey": "#8a8a8a",
  "ash": "#8a8a8a",
  "charcoal": "#3c4858",
  "charcoal marled": "#4a4a4a",
  "graphite": "#3d3d3d",
  "dark heather": "#4c4c4c",
  "vintage heather": "#d6d2cd",
  "slate grey": "#708090",
  "smoke grey": "#d3d3d3",
  "silver": "#c0c0c0",
  "grey": "#808080",
  "dark grey": "#3b3b3b",
  "light grey": "#d3d3d3",
  "banana cream": "#f5e3a3",
  "cool blue": "#4a6fa5",
  "heavy metal": "#4a4a4a",
  "light blue": "#add8e6",
  "midnight navy": "#1c2038",
  "purple rush": "#5a2a82",
  "tahiti blue": "#3a7ca8",
  "cardinal red": "#b5322f",
  "desert pink": "#e0b0a8",
  "white": "#ffffff",
  "black": "#000000",
  "red": "#ff0000",
  "navy": "#000080",
  "royal": "#4169e1",
  "carolina blue": "#4b9cd3",
  "daisy": "#f6e7c1",
  "light pink": "#f7b7c4",
  "pink": "#ffc0cb",
  "soft pink": "#f4c2c2",
  "antique cherry": "#841b2d",
  "cherry": "#d2232a",
  "crimson": "#dc143c",
  "maroon": "#800000",
  "redwood": "#a45a52",
  "rust": "#b7410e",
  "burnt orange": "#cc5500",
  "irish green": "#33b1a4",
  "military green": "#4b5320",
  "moss": "#8a9a5b",
  "pine": "#01796f",
  "bright green": "#4cbb17",
  "lime": "#00ff00",
  "apple": "#a4dd40",
  "kelly green": "#4cbb17",
  "dark chocolate": "#3c2214",
  "chocolate": "#5c3a21",
  "coffee": "#6f4e37",
  "dark brown": "#654321",
  "cinnamon": "#d2691e",
  "light brown": "#b5651d",
  "navy blue": "#000080",
  "collegiate blue": "#002d62",
  "french blue": "#3f7fd6",
  "denim": "#1560bd",
  "ice blue": "#d6eaf8",
  "frosty blue": "#a5cfe8",
  "baby blue": "#89cff0",
  "pool": "#00a2e8",
  "caribbean blue": "#1d9bf0",
  "dodger blue": "#1e90ff",
  "heather blue": "#6e89b8",
  "steel blue": "#4682b4",
  "spruce": "#2f4f4f",
  "forest green": "#228b22",
  "moss green": "#4cbb17",
  "olive drab": "#6b8e23",
  "purple": "#800080",
  "grape": "#6f2da8",
  "plum": "#8e4585",
  "lavender": "#e6e6fa",
  "orchid": "#da70d6",
  "lilac": "#c8a2c8",
  "maroon heather": "#7b3f61",
  "antique gold": "#8c7853",
  "dark chocolate brown": "#3b2f2f",
  "cement": "#6b6b6b",
  "natural": "#efe4cd",
  "bone": "#e3dac9",
  "sand": "#c2b280",
  "oatmeal": "#e0d5b7",
  "tan": "#d2b48c",
  "brown": "#4a2c17",
  "forest": "#228b22",
  "hemlock": "#4b4c42",
  "rust orange": "#b7410e",
  "high visibility": "#ffff00",
  "neon green": "#39ff14",
  "neon orange": "#ff7b00",
  "neon pink": "#ff6ec7",
  "neon blue": "#4d4dff",
  "sport purple": "#6a0dad",
  "sport red": "#c8102e",
  "vintage black": "#1a1a1a",
  "antique white": "#f5f2e9",
  "dark forest": "#254117",
};

/**
 * Qualifiers that may sit in front of a colour name.
 *
 * "solid " and "light " change the SHADE, so they are only stripped when the
 * remainder is a colour we know - "light blue" must not fall back to
 * "blue". "dark " and "heather " are never stripped, because they mean a
 * genuinely different colour.
 */
const STRIPPABLE_PREFIXES = ["solid ", "sport ", "antique ", "vintage ", "bright ", "midnight "];

/**
 * The best hex we can offer for a colour name without a product to read from.
 * Falls back to a deterministic mid grey so a swatch is never blank.
 */
export function hexForColourName(colour: string): string {
  const key = fallbackKey(colour);
  if (FALLBACK_HEXES[key]) return FALLBACK_HEXES[key];
  return "#9ca3af";
}

/** True when the table knows this colour name. */
export function knowsColourName(colour: string): boolean {
  return fallbackKey(colour) in FALLBACK_HEXES;
}

/**
 * Works out the lookup key for a colour name.
 *
 * The prefix is stripped REPEATEDLY, because Printify stacks them:
 * "Solid Cool Blue" -> "cool blue" -> "blue". A single strip used to leave
 * nine real Printify colours looking like identical grey swatches.
 */
function fallbackKey(colour: string): string {
  let key = colour.trim().toLowerCase();
  if (FALLBACK_HEXES[key]) return key;
  for (let i = 0; i < 3; i++) {
    const prefix = STRIPPABLE_PREFIXES.find((p) => key.startsWith(p));
    if (!prefix) break;
    key = key.slice(prefix.length);
    if (FALLBACK_HEXES[key]) return key;
  }
  return key;
}
