import * as React from "react";
import { cn } from "@/lib/utils";
import {
  SLOGAN_DEFAULT,
  sloganFontSize,
  splitSlogan,
} from "@/lib/sketch/slogan";

export const TEE_OUTLINE =
  "M100 40 40 72l22 56 34-16-4 150q58 14 118 0l-4-150 34 16 22-56-60-32Q150 86 100 40z";
export const TEE_NECK = "M102 41Q150 24 200 41Q150 80 102 41z";

/**
 * The signature object: a blue, 3D-style hand-drawn tee.
 *
 *  - `hero` slowly turns in perspective; `fixed` sits at one angle; `loader`
 *    is the same tee at a small size for busy/empty states.
 *  - The print is always three slogan lines with the middle line on an orange
 *    block. No icons, no sun, no brand marks.
 */
export function Tee3D({
  slogan = SLOGAN_DEFAULT,
  mode = "hero",
  backdrop = true,
  note,
  className,
}: {
  slogan?: string;
  mode?: "hero" | "fixed" | "loader";
  backdrop?: boolean;
  note?: string;
  className?: string;
}) {
  const lines = splitSlogan(slogan);
  const art = mode === "fixed";
  const label = `A blue hand-drawn tee printed with the slogan ${lines
    .filter(Boolean)
    .join(" ")}`;

  return (
    <div
      className={cn(
        "sk-stage",
        art && "sk-stage--art",
        mode === "loader" && "sk-stage--loader",
        className,
      )}
    >
      {backdrop ? (
        <svg
          className="sk-stage__bg"
          viewBox="0 0 420 420"
          role="img"
          aria-label={label}
        >
          <path
            className="sk-f"
            style={{ "--i": 0 } as React.CSSProperties}
            fill="var(--wash)"
            filter="url(#sk-rough)"
            d="M70 100Q120 30 230 60T370 160Q390 280 290 340T110 330Q30 250 70 100Z"
          />
          <rect
            className="sk-f"
            style={{ "--i": 5 } as React.CSSProperties}
            x="70"
            y="332"
            width="280"
            height="26"
            fill="var(--orange)"
            filter="url(#sk-rough)"
          />
          <path
            className="sk-d sk-d--thin"
            style={{ "--i": 5 } as React.CSSProperties}
            pathLength={1}
            d="M40 392q40-24 80 0t80 0t80 0t80 0"
          />
          <path
            className="sk-d"
            style={{ "--i": 6 } as React.CSSProperties}
            pathLength={1}
            d="M350 40l8 20 22 2-17 14 6 22-19-12-19 12 6-22-17-14 22-2z"
          />
          {note ? (
            <text
              className="sk-svg-note sk-f"
              style={{ "--i": 7 } as React.CSSProperties}
              x="252"
              y="414"
            >
              {note}
            </text>
          ) : null}
        </svg>
      ) : null}

      <svg
        className={cn("sk-tee", mode !== "hero" && "sk-tee--fixed")}
        viewBox="0 0 300 300"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="sk-f"
          style={{ "--i": 1 } as React.CSSProperties}
          fill="var(--blue)"
          d={TEE_OUTLINE}
        />
        <path
          className="sk-f2"
          style={{ "--i": 2 } as React.CSSProperties}
          fill="var(--ink)"
          d={TEE_NECK}
        />
        <path
          className="sk-d sk-d--thin"
          style={{ "--i": 2 } as React.CSSProperties}
          pathLength={1}
          d="M98 140l14 22M98 162l14 22M98 184l14 22M98 206l14 22M98 228l14 22M70 118l16 6M76 110l16 6M82 108l12 8"
        />
        <path
          className="sk-d sk-d--thin sk-d--paper"
          style={{ "--i": 3 } as React.CSSProperties}
          pathLength={1}
          d="M190 130l-10 20M194 156l-10 20M198 182l-10 20M200 208l-10 20"
        />
        <path
          className="sk-d sk-d--thin sk-d--paper"
          style={{ "--i": 3 } as React.CSSProperties}
          pathLength={1}
          d="M120 236q-12-30 4-60M176 232q12-24 2-54M96 112q26 8 36 38M206 112q-26 8-32 36"
        />
        <path
          className="sk-d"
          style={{ "--i": 2 } as React.CSSProperties}
          pathLength={1}
          d={TEE_OUTLINE}
        />
        <path
          className="sk-d"
          style={{ "--i": 3 } as React.CSSProperties}
          pathLength={1}
          d="M106 48Q150 92 196 48"
        />
        <path
          className="sk-d sk-d--thin sk-d--paper"
          style={{ "--i": 3 } as React.CSSProperties}
          pathLength={1}
          d="M49 76l18 46M254 76l-20 48M93 251q57 14 115 0"
        />
        <g transform="rotate(-4 150 150)">
          <text
            className="sk-tt sk-f"
            style={{
              "--i": 5,
              fontSize: sloganFontSize(lines[0]),
            } as React.CSSProperties}
            x="150"
            y="138"
            textAnchor="middle"
          >
            {lines[0]}
          </text>
          <rect
            className="sk-f"
            style={{ "--i": 6 } as React.CSSProperties}
            x="100"
            y="148"
            width="100"
            height="30"
            fill="var(--orange)"
          />
          <text
            className="sk-tt sk-tt--ink sk-f"
            style={{
              "--i": 6,
              fontSize: sloganFontSize(lines[1]),
            } as React.CSSProperties}
            x="150"
            y="170"
            textAnchor="middle"
          >
            {lines[1]}
          </text>
          <text
            className="sk-tt sk-f"
            style={{
              "--i": 7,
              fontSize: sloganFontSize(lines[2]),
            } as React.CSSProperties}
            x="150"
            y="204"
            textAnchor="middle"
          >
            {lines[2]}
          </text>
        </g>
      </svg>
    </div>
  );
}

/** Small tee used as a loading indicator. */
export function TeeLoader({ label = "Working on it" }: { label?: string }) {
  return (
    <span role="status" aria-label={label} style={{ display: "inline-block", width: 72 }}>
      <Tee3D mode="loader" backdrop={false} slogan="" />
    </span>
  );
}

/** Empty state with the tee, a title and a handwritten note. */
export function SketchEmpty({
  title,
  note,
  action,
}: {
  title: string;
  note?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="sk-empty">
      <Tee3D mode="fixed" backdrop={false} slogan="" />
      <h3>{title}</h3>
      {note ? <p className="sk-note sk-note--sm">{note}</p> : null}
      {action}
    </div>
  );
}
