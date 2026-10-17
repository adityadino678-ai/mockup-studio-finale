"use client";

import * as React from "react";
import { Copy, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type DebugKind = "turn" | "request" | "frame" | "summary";

export interface DebugEntry {
  id: string;
  kind: DebugKind;
  label: string;
  body?: string;
}

const KIND_STYLES: Record<DebugKind, string> = {
  turn: "text-forest",
  request: "text-sky-600",
  frame: "text-ink-muted",
  summary: "text-amber-600",
};

function toText(entries: DebugEntry[]): string {
  return entries
    .map((e) => {
      const head = `[${e.kind}] ${e.label}`;
      return e.body ? `${head}\n${e.body}` : head;
    })
    .join("\n\n");
}

/**
 * Temporary diagnostic drawer for the `?debug=1` capture. It shows every SSE
 * frame the server sent, the request summary it acknowledged, and a per-turn
 * result summary — enough to tell reasoning-only responses from tool calls.
 */
export function DebugPanel({
  entries,
  onClear,
  onClose,
}: {
  entries: DebugEntry[];
  onClear: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(toText(entries));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [entries]);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex max-h-[45vh] flex-col border-t border-border-subtle bg-surface-raised shadow-lg">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <span className="text-[12px] font-semibold text-ink">SSE debug</span>
        <span className="text-[11px] text-ink-subtle">{entries.length} entries</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-ink-muted hover:bg-surface hover:text-ink"
          >
            <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy all"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-ink-muted hover:bg-surface hover:text-ink"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-subtle hover:bg-surface hover:text-ink"
            title="Hide debug panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <pre className="scroll-thin min-h-0 flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed">
        {entries.length === 0 ? (
          <span className="text-ink-subtle">
            Send a message. Every frame the server streams back will appear here.
          </span>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="mb-1.5">
              <span className={cn("font-medium", KIND_STYLES[entry.kind])}>[{entry.kind}]</span>{" "}
              <span className="text-ink">{entry.label}</span>
              {entry.body && (
                <div className="whitespace-pre-wrap break-words text-ink-muted">{entry.body}</div>
              )}
            </div>
          ))
        )}
      </pre>
    </div>
  );
}
