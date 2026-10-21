"use client";

import * as React from "react";
import { AssetThumb } from "@/components/asset-thumb";
import { cn } from "@/lib/utils";

interface WaveCompareProps {
  /** The artwork as it was uploaded. */
  originalAssetId: string;
  /** The background-removed version, when there is one. */
  processedAssetId?: string;
  /** Used to stagger the animation so a grid does not pulse in lockstep. */
  index?: number;
  /** Pause the animation (the grid can stop it when the tab is hidden). */
  paused?: boolean;
  className?: string;
}

/**
 * Shows a design before and after its background was removed.
 *
 * The original sits underneath and the cutout is wiped over it from the left,
 * with a bright edge travelling with the wipe - so the change is visible
 * happening rather than just visible. Without a cutout it is a plain
 * thumbnail.
 *
 * The animation only runs while the card is on screen: a grid of fifty cards
 * animating off-screen is wasted work, and the browser would not paint it
 * anyway.
 */
export function WaveCompare({
  originalAssetId,
  processedAssetId,
  index = 0,
  paused = false,
  className,
}: WaveCompareProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const hasCutout = !!processedAssetId;

  // Nothing should animate in a tab the user is not looking at.
  React.useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  React.useEffect(() => {
    if (!hasCutout) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // The observer stays alive and the card animates ONLY while it is on
    // screen. Disconnecting on the first intersection (as an earlier version
    // did) left every off-screen card animating forever, which is a lot of
    // wasted paint in a grid of fifty designs.
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((e) => e.isIntersecting));
      },
      { rootMargin: "80px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasCutout]);

  const delay = `${(index % 8) * 0.16}s`;

  return (
    <div ref={ref} className={cn("checkerboard relative overflow-hidden", className)}>
      <AssetThumb
        assetId={originalAssetId}
        alt="Design"
        className="absolute inset-0 h-full w-full object-contain"
      />
      {hasCutout && (
        <>
          <AssetThumb
            assetId={processedAssetId}
            alt="Design with the background removed"
            className={cn(
              "absolute inset-0 h-full w-full object-contain",
              visible && !paused && !hidden && "studio-wave-layer",
            )}
            style={visible && !paused && !hidden ? { animationDelay: delay } : undefined}
          />
          {visible && !paused && !hidden && (
            // The wrapper is the full width and the line sits on its right
            // edge, so a transform moves the line across the card without a
            // layout pass.
            <div
              aria-hidden
              className="studio-wave-edge pointer-events-none absolute inset-y-0 left-0 w-full"
              style={{ animationDelay: delay }}
            >
              <div className="absolute right-0 top-0 h-full w-[3px] bg-[#f0f4ec] shadow-[0_0_6px_rgba(49,77,61,0.55)]" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
