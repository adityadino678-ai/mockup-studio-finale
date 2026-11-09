import * as React from "react";
import { useInkScene } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A scene whose ink strokes draw themselves in as it enters the viewport.
 *
 * Server markup is fully drawn; the scene is only armed once JS runs and the
 * visitor has not asked for reduced motion.
 */
export function InkDraw({
  children,
  className,
  threshold = 0.3,
}: {
  children: React.ReactNode;
  className?: string;
  threshold?: number;
}) {
  const ref = useInkScene<HTMLDivElement>(threshold);
  return (
    <div ref={ref} className={cn("sk-scene", className)}>
      {children}
    </div>
  );
}

const WASH_PATH =
  "M60 40Q200 0 350 50T340 250Q200 300 70 260T60 40Z";

/** A rough ink-wash blob. Blue or wash only; never a gradient. */
export function InkWash({
  tone = "wash",
  path = WASH_PATH,
  opacity,
  index = 0,
  className,
}: {
  tone?: "wash" | "blue" | "orange";
  path?: string;
  opacity?: number;
  index?: number;
  className?: string;
}) {
  return (
    <svg
      className={cn("sk-wash", className)}
      viewBox="0 0 400 320"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="sk-f"
        style={{ "--i": index } as React.CSSProperties}
        fill={`var(--${tone})`}
        opacity={opacity}
        filter="url(#sk-rough)"
        d={path}
      />
    </svg>
  );
}
