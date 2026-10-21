"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type SwatchInk = "black" | "white" | "ambiguous";

interface ColorSwatchProps {
  /** The Printify colour name, e.g. "Solid Black". */
  name: string;
  /** The resolved hex, e.g. "#050505". */
  hex: string;
  selected?: boolean;
  /** Which ink this colour uses. Only meaningful in the ink row. */
  ink?: SwatchInk;
  /** Show the ink letter on the swatch. */
  showInk?: boolean;
  /**
   * The click handler. It is the SAME function for every swatch in a grid -
   * each swatch carries its colour in `data-colour` - so the memo below can
   * skip the ones that did not change.
   */
  onClick?: React.MouseEventHandler<HTMLElement>;
  className?: string;
}

const INK_LABEL: Record<SwatchInk, string> = {
  black: "black ink",
  white: "white ink",
  ambiguous: "needs an ink choice",
};

/**
 * A real colour circle, the way Printify shows them.
 *
 * Three details matter:
 *  - a white swatch needs a strong border or it disappears into the card
 *  - the ink has to reach assistive tech, not just be a letter on a circle
 *  - the accessible name comes from `aria-label`, not from `title`, because
 *    a title is not announced reliably and does not show on keyboard focus
 *
 * Memoised on purpose: a grid of a hundred swatches is re-rendered on every
 * click, and without this React reconciles all of them for one changed
 * `selected` flag. The click handler is delegated to the grid by the parent
 * (via `data-colour`), so the `onClick` prop stays stable.
 */
export const ColorSwatch = React.memo(function ColorSwatch({
  name,
  hex,
  selected = false,
  ink,
  showInk = false,
  onClick,
  className,
}: ColorSwatchProps) {
  const isWhite = hex.toLowerCase() === "#ffffff" || hex.toLowerCase() === "#f9f9f9";
  const inkLabel = ink ? INK_LABEL[ink] : "";
  const accessibleName =
    showInk && ink ? `${name}, ${hex}, printed with the ${inkLabel}` : `${name}, ${hex}`;

  const content = (
    <>
      <span
        aria-hidden
        className="block h-full w-full rounded-full"
        style={{
          backgroundColor: hex,
          // A white swatch on a white card needs a boundary of its own.
          boxShadow: isWhite ? "inset 0 0 0 1px #8a9186" : undefined,
        }}
      />
      {showInk && ink && (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ring-2 ring-surface",
              ink === "ambiguous" ? "bg-warning text-white" : "bg-forest text-white",
            )}
          >
            {ink === "black" ? "B" : ink === "white" ? "W" : "?"}
          </span>
          {/* The visible badge is decorative; this carries the state. */}
          <span className="sr-only">{`printed with the ${inkLabel}`}</span>
        </>
      )}
    </>
  );

  const base =
    "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-offset-2 transition-shadow";
  const ring = selected
    ? "ring-2 ring-forest"
    : "ring-1 ring-ink-muted hover:ring-forest";

  if (!onClick) {
    return (
      <span className={cn(base, ring, className)} title={accessibleName} data-colour={name}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={accessibleName}
      title={accessibleName}
      data-colour={name}
      className={cn(base, ring, "cursor-pointer", className)}
    >
      {content}
    </button>
  );
});

/** A small row of swatches, used to show a design's colour selection. */
export function ColorSwatchRow({
  swatches,
  className,
}: {
  swatches: Array<{ name: string; hex: string; ink?: SwatchInk }>;
  className?: string;
}) {
  if (swatches.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {swatches.map((s) => (
        <ColorSwatch key={s.name} name={s.name} hex={s.hex} ink={s.ink} showInk={!!s.ink} className="h-4 w-4" />
      ))}
    </div>
  );
}
