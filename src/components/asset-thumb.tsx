"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getThumbBlob } from "@/lib/db/repo";
import { cn } from "@/lib/utils";

interface AssetThumbProps {
  assetId: string;
  className?: string;
  checkerboard?: boolean;
  alt?: string;
}

/**
 * Renders a cached thumbnail for an asset id from IndexedDB. Falls back to a
 * subtle placeholder while loading. Object URLs are revoked on unmount/update.
 */
export function AssetThumb({ assetId, className, checkerboard, alt }: AssetThumbProps) {
  const blob = useLiveQuery(() => getThumbBlob(assetId), [assetId]);
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
      <div className={cn("flex items-center justify-center bg-surface-muted text-ink-subtle", className)}>
        <span className="text-[11px]">unavailable</span>
      </div>
    );
  }

  if (!url) {
    return <div className={cn("animate-pulse bg-surface-muted", className)} />;
  }

  return (
    <img
      src={url}
      alt={alt ?? "Asset thumbnail"}
      onError={() => setFailed(true)}
      className={cn("object-contain", checkerboard && "checkerboard", className)}
      draggable={false}
    />
  );
}
