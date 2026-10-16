"use client";

import { Gauge } from "lucide-react";
import { REASONING_EFFORTS, type ReasoningEffort } from "@/lib/ai/providers";
import { cn } from "@/lib/utils";

const LABEL: Record<ReasoningEffort, string> = { low: "Low", medium: "Med", high: "High" };

/** Reasoning-effort pill. Only rendered for models that accept an effort hint. */
export function EffortPill({
  value,
  onChange,
}: {
  value: ReasoningEffort;
  onChange(value: ReasoningEffort): void;
}) {
  const cycle = () => {
    const i = REASONING_EFFORTS.indexOf(value);
    onChange(REASONING_EFFORTS[(i + 1) % REASONING_EFFORTS.length]);
  };
  return (
    <button
      type="button"
      onClick={cycle}
      title={`Reasoning effort: ${value} — click to change`}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border border-border-subtle bg-surface px-2 text-[11px] text-ink-muted transition-colors hover:bg-surface-muted",
        value !== "medium" && "border-sage text-forest",
      )}
    >
      <Gauge className="h-3 w-3" />
      {LABEL[value]}
    </button>
  );
}
