// ---------------------------------------------------------------------------
// Naming the artwork file that is uploaded to Printify.
//
// The name is not cosmetic. Printify's "Edit design" panel lists every print
// area's artwork by FILE NAME, so two groups that upload the same name look
// like one design applied everywhere - even when their pixels are different.
//
// A pair made this invisible: both halves are labelled `ink: "main"` and the
// plan item is named after its black half, so the old `${designName}-${ink}`
// produced `<black design>-main.png` TWICE. The fix is to name the file after
// the design that actually owns that group and its ink role.
// ---------------------------------------------------------------------------

/** Characters Printify or a filesystem may reject in an upload name. */
const UNSAFE = /[\\/:*?"<>|]/g;

/** Control characters are stripped separately, so the regex stays printable. */
function stripControl(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("");
}

/**
 * A readable, safe upload name for one artwork group.
 *
 * - A paired group's label is `"Black ink · <design>"`: the design after the
 *   separator owns the artwork, so the name uses THAT design, plus the role.
 * - Any other group falls back to the plan item's design name (the artwork is
 *   that design's own black/white ink file).
 */
export function artworkFilename(input: {
  /** `StudioDesignGroup.label`, e.g. "White ink · Bear tee". */
  label?: string;
  /** The plan item's design name, used when the label carries none. */
  designName: string;
  /** The group's ink role. */
  ink: "main" | "black" | "white";
}): string {
  const label = (input.label ?? "").trim();
  const separator = label.indexOf("·");
  const fromLabel = separator >= 0 ? label.slice(separator + 1).trim() : "";
  const design = fromLabel || input.designName.trim() || "design";
  const role = input.ink === "main" ? "main" : `${input.ink}-ink`;
  const base = `${design}-${role}`.replace(UNSAFE, "").replace(/\s+/g, "_");
  const safe = stripControl(base);
  const trimmed = safe.slice(0, 120).replace(/[._-]+$/, "");
  return `${trimmed || "artwork"}.png`;
}
