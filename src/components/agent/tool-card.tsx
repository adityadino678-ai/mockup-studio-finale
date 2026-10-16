"use client";

import * as React from "react";
import { AlertTriangle, Check, ChevronRight, Loader2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallData } from "@/types/domain";

function StatusIcon({ status }: { status: ToolCallData["status"] }) {
  if (status === "running" || status === "pending")
    return <Loader2 className="h-3 w-3 animate-spin text-ink-subtle" />;
  if (status === "error") return <AlertTriangle className="h-3 w-3 text-danger" />;
  return <Check className="h-3 w-3 text-forest" />;
}

interface ToolCardProps {
  call: ToolCallData;
  /** Called when the user approves a confirm-gated tool. */
  onConfirm?: () => void;
  /** Called when the user dismisses a confirm-gated tool. */
  onCancel?: () => void;
}

/**
 * One expandable tool-activity card. It reflects a real tool execution from the
 * transcript — the agent never shows a card for work it did not do. Tools that
 * write to the database render a confirm step and do nothing until approved.
 */
export function ToolCard({ call, onConfirm, onCancel }: ToolCardProps) {
  const [open, setOpen] = React.useState(call.status === "running" || call.status === "pending");
  const awaitingConfirm = call.status === "pending" && !!onConfirm;
  const detail = call.error
    ? call.error
    : call.result !== undefined
      ? typeof call.result === "string"
        ? call.result
        : JSON.stringify(call.result, null, 2)
      : JSON.stringify(call.args, null, 2);

  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border-subtle bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <StatusIcon status={call.status} />
        <Wrench className="h-3 w-3 text-ink-subtle" />
        <span className="text-[12px] font-medium text-ink">{call.name}</span>
        {call.summary && <span className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle">{call.summary}</span>}
        <ChevronRight className={cn("ml-auto h-3 w-3 shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <pre className="scroll-thin max-h-64 overflow-auto border-t border-border-subtle px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          {detail}
        </pre>
      )}
      {awaitingConfirm && (
        <div className="flex items-center gap-2 border-t border-border-subtle bg-surface-muted px-2.5 py-2">
          <span className="min-w-0 flex-1 text-[11px] text-ink-muted">
            Nothing is created until you approve.
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-ink-muted hover:bg-surface hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-forest px-2.5 py-1 text-[11px] font-medium text-white hover:bg-forest-deep"
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}
