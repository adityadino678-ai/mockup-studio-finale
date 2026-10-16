"use client";

import * as React from "react";
import { Markdown } from "@/components/agent/markdown";
import { ReasoningBlock } from "@/components/agent/reasoning-block";
import { ToolCard } from "@/components/agent/tool-card";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/domain";

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** One transcript row: user bubble, or an assistant turn with reasoning + tools + markdown. */
export function MessageItem({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3.5 py-2.5",
          isUser ? "bg-forest-soft text-ink" : "border border-border-subtle bg-surface",
        )}
      >
        {message.parts.map((part, i) => {
          if (part.type === "reasoning") {
            return <ReasoningBlock key={i} text={part.text} streaming={streaming} />;
          }
          if (part.type === "tool") {
            return <ToolCard key={i} call={part.call} />;
          }
          if (part.type === "image") {
            return (
              <img
                key={i}
                src={part.image.dataUrl}
                alt={part.image.name}
                className="mb-2 max-h-52 rounded-md border border-border-subtle"
              />
            );
          }
          if (isUser) {
            return (
              <p key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed">
                {part.text}
              </p>
            );
          }
          return part.text.trim() ? (
            <Markdown key={i} content={part.text} />
          ) : streaming ? (
            <span key={i} className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-ink-subtle" />
          ) : null;
        })}
      </div>
      <div className="px-1 text-[10px] text-ink-subtle">
        {message.model ? `${message.model} · ` : ""}
        {timeLabel(message.createdAt)}
      </div>
    </div>
  );
}
