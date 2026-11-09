import * as React from "react";

/** Loading placeholder. Pulses opacity only — the system has no gradients. */
export function SketchSkeleton({
  width = "100%",
  height = "1rem",
  lines = 1,
  label,
}: {
  width?: string;
  height?: string;
  lines?: number;
  label?: string;
}) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "block" }}
    >
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          className="sk-skeleton"
          style={{ width, height }}
        />
      ))}
    </span>
  );
}
