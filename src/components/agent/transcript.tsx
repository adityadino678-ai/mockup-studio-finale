"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { MessageItem } from "@/components/agent/message-item";
import type { ChatMessage, ToolCallData } from "@/types/domain";

interface TranscriptProps {
  messages: ChatMessage[];
  streaming?: ChatMessage | null;
  error?: string | null;
  emptyHint?: React.ReactNode;
  onConfirmTool?: (messageId: string, call: ToolCallData) => void;
  onCancelTool?: (messageId: string, call: ToolCallData) => void;
  /**
   * Approves EVERY pending confirm-gated call at once. Only offered when two
   * or more are waiting: one pending call has its own Create button on its
   * own card, and a second button for the same thing is noise.
   */
  onConfirmAll?: () => void;
  /** Shown with the error when the turn stopped early but can be resumed. */
  onContinue?: () => void;
  continuing?: boolean;
}

export function Transcript({ messages, streaming, error, emptyHint, onConfirmTool, onCancelTool, onConfirmAll, onContinue, continuing }: TranscriptProps) {
  const endRef = React.useRef<HTMLDivElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  const empty = messages.length === 0 && !streaming;

  // Only create_printify_product is click-gated now, but a turn can still
  // stack several of them (one per design). Count the waiting cards so the
  // user can approve the whole batch with one press instead of hunting for
  // each Create button.
  const pendingConfirms = messages.flatMap((m) =>
    m.parts
      .filter(
        (part): part is { type: "tool"; call: ToolCallData } =>
          part.type === "tool" && part.call.status === "pending",
      )
      .map((part) => ({ messageId: m.id, call: part.call })),
  );

  return (
    <div ref={scrollerRef} className="scroll-thin flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {empty ? (
          <div className="mx-auto mt-16 max-w-md text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-sage-soft text-forest">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="text-[15px] font-semibold text-ink">How can I help?</div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">
              Ask about the app, draft listing copy, summarize your workspace, or plan a batch job.
            </p>
            {emptyHint && <div className="mt-4">{emptyHint}</div>}
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                onConfirmTool={onConfirmTool}
                onCancelTool={onCancelTool}
              />
            ))}
            {streaming && <MessageItem message={streaming} streaming />}
            {pendingConfirms.length >= 2 && onConfirmAll && (
              <div className="flex items-center justify-center gap-3 rounded-md border border-sage bg-sage-soft/60 px-3 py-2">
                <span className="text-[12px] text-ink-subtle">
                  {pendingConfirms.length} Printify products are waiting for approval.
                </span>
                <button
                  type="button"
                  onClick={onConfirmAll}
                  className="rounded-md bg-forest px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-forest-deep"
                >
                  Approve all
                </button>
              </div>
            )}
          </>
        )}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] leading-relaxed text-danger">
            {error}
            {onContinue && (
              <button
                type="button"
                onClick={onContinue}
                disabled={continuing}
                className="mt-2 block rounded-md bg-forest px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-forest-deep disabled:opacity-40"
              >
                {continuing ? "Continuing…" : "Continue"}
              </button>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
