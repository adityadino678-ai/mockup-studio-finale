"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getAssetBlob } from "@/lib/db/repo";
import { cn } from "@/lib/utils";

interface AssetImageProps {
  assetId: string;
  className?: string;
  alt?: string;
  /**
   * What to show until the full file is decoded.
   *
   * The thumbnail is a small cached JPEG, so the placeholder is sharp enough
   * for the layout and the full pixels replace it a moment later.
   */
  placeholder?: React.ReactNode;
}

/**
 * Renders an asset at FULL resolution.
 *
 * `AssetThumb` serves the small cached thumbnail, which is right for a tile
 * but too soft for the main listing image. This loads the stored file
 * itself, so the big picture is the real render.
 */
export function AssetImage({ assetId, className, alt, placeholder }: AssetImageProps) {
  const blob = useLiveQuery(() => getAssetBlob(assetId), [assetId]);
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let objectUrl: string | null = null;
    setFailed(false);
    if (blob) {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    } else {
      setUrl(null);
    }
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  if (failed) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-surface-muted text-ink-subtle",
          className,
        )}
      >
        <span className="text-[11px]">unavailable</span>
      </div>
    );
  }

  if (!url) {
    return (
      <div className={cn("bg-surface-muted", className)}>
        {placeholder ?? <div className="h-full w-full animate-pulse" />}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt ?? "Image"}
      onError={() => setFailed(true)}
      className={cn("object-contain", className)}
      draggable={false}
    />
  );
}
