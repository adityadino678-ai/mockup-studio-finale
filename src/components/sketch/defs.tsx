import * as React from "react";

/**
 * The rough ink-wash filter, mounted once per page. Every blob, orange stripe
 * and wash references `url(#sk-rough)`.
 */
export function SketchDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <filter id="sk-rough" x="-10%" y="-30%" width="120%" height="160%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".04"
            numOctaves="3"
            seed="2"
            result="n"
          />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="14" />
        </filter>
      </defs>
    </svg>
  );
}

/** Subtle paper grain over the whole page. Purely decorative. */
export function Grain() {
  return <div className="sk-grain" aria-hidden="true" />;
}
