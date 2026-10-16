"use client";

import * as React from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Collapsible "thinking" block, collapsed by default like Hermes' reasoning view. */
export function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = React.useState(false);
  if (!text.trim() && !streaming) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border-subtle bg-surface-muted/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-ink-muted hover:text-ink"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        <Brain className="h-3 w-3" />
        {streaming ? "Reasoning…" : "Reasoning"}
      </button>
      {open && (
        <div className="scroll-thin max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-border-subtle px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
          {text || "…"}
        </div>
      )}
    </div>
  );
}
