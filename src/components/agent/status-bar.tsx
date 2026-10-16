"use client";

import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  providerLabel: string;
  model: string;
  contextTokens: number;
  contextWindow?: number;
  tokensPerSecond?: number;
  streaming: boolean;
}

/** Thin footer mirroring Hermes' status bar: model, approx context use, tokens/sec. */
export function StatusBar({
  providerLabel,
  model,
  contextTokens,
  contextWindow,
  tokensPerSecond,
  streaming,
}: StatusBarProps) {
  const pct = contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : null;
  return (
    <div className="flex items-center gap-3 border-t border-border-subtle bg-surface-muted px-4 py-1.5 text-[10px] text-ink-subtle">
      <span className="truncate">
        <span className="text-ink-muted">{providerLabel}</span> · {model || "no model"}
      </span>
      {pct !== null && (
        <span className="flex items-center gap-1.5" title="Approximate context usage">
          <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-border-subtle sm:block">
            <span
              className={cn("block h-full rounded-full", pct > 85 ? "bg-danger" : "bg-forest")}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </span>
          ~{pct}% ctx
        </span>
      )}
      {streaming && tokensPerSecond ? (
        <span className="flex items-center gap-1 text-forest">
          <Zap className="h-3 w-3" /> {tokensPerSecond} tok/s
        </span>
      ) : null}
      <span className="ml-auto hidden sm:block">~{contextTokens.toLocaleString()} tokens est.</span>
    </div>
  );
}
