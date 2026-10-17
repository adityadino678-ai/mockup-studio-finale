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
  /** Shown with the error when the turn stopped early but can be resumed. */
  onContinue?: () => void;
  continuing?: boolean;
}

export function Transcript({ messages, streaming, error, emptyHint, onConfirmTool, onCancelTool, onContinue, continuing }: TranscriptProps) {
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
