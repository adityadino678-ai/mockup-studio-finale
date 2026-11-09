"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

/**
 * Small info icon for long help. Minimum 24x24 tap target, label only in the
 * surrounding UI — the paragraph lives here so the field stays a label.
 */
export function InfoTip({
  label,
  text,
  className,
}: {
  label: string;
  text: string;
  className?: string;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={label}
            className={cn("h-6 w-6 shrink-0", className)}
          >
            <Info className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="center"
            className="z-50 max-w-xs border-2 border-ink bg-paper px-3 py-2 shadow-pop"
          >
            <p className="text-sm text-ink">{text}</p>
            <TooltipPrimitive.Arrow className="fill-ink" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
