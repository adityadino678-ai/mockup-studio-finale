/**
 * Slogan handling for the signature tee.
 *
 * The print on any sketchbook mockup is ALWAYS a short slogan on three lines,
 * with the middle line on an orange block. Never a sun or a generic icon.
 * Slogans must avoid trademarks, brands, celebrities and copyrighted
 * characters; the field is user-supplied text, not generated copy.
 */

export const SLOGAN_MAX_LENGTH = 22;
export const SLOGAN_DEFAULT = "Make more merch";

export type SloganLines = [string, string, string];

/** Uppercase, collapse whitespace, and split across the three print lines. */
export function splitSlogan(raw: string): SloganLines {
  const words = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const lines: SloganLines = ["", "", ""];

  if (words.length === 1) {
    lines[1] = words[0];
  } else if (words.length === 2) {
    lines[0] = words[0];
    lines[1] = words[1];
  } else if (words.length > 2) {
    lines[0] = words[0];
    lines[1] = words[1];
    lines[2] = words.slice(2).join(" ");
  }

  return lines;
}

/** Shrink long lines so they stay inside the printed area of the tee. */
export function sloganFontSize(line: string, base = 25): number {
  const length = Math.max(1, line.length);
  return Math.min(base, Math.max(11, 92 / (length * 0.78)));
}

/** Clamp free text to the field's limit without splitting a surrogate pair. */
export function clampSlogan(raw: string): string {
  return Array.from(raw).slice(0, SLOGAN_MAX_LENGTH).join("");
}
