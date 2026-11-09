"use client";

import * as React from "react";
import { Markdown } from "@/components/agent/markdown";
import { ReasoningBlock } from "@/components/agent/reasoning-block";
import { ToolCard } from "@/components/agent/tool-card";
import { cn } from "@/lib/utils";
import type { ChatMessage, ToolCallData } from "@/types/domain";

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** One transcript row: user bubble, or an assistant turn with reasoning + tools + markdown. */
export function MessageItem({
  message,
  streaming,
  onConfirmTool,
  onCancelTool,
}: {
  message: ChatMessage;
  streaming?: boolean;
  onConfirmTool?: (messageId: string, call: ToolCallData) => void;
  onCancelTool?: (messageId: string, call: ToolCallData) => void;
}) {
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
            return (
              <ToolCard
                key={i}
                call={part.call}
                onConfirm={onConfirmTool ? () => onConfirmTool(message.id, part.call) : undefined}
                onCancel={onCancelTool ? () => onCancelTool(message.id, part.call) : undefined}
              />
            );
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
          if (part.type === "checklist") {
            return (
              <ul key={i} className="mb-1 space-y-1 rounded-md border border-border-subtle p-2">
                {part.items.map((item, j) => (
                  <li key={j} className="flex items-center gap-2 text-xs">
                    <span
                      className={
                        item.status === "done"
                          ? "text-status-ok"
                          : item.status === "failed"
                            ? "text-status-error"
                            : item.status === "active"
                              ? "text-ink"
                              : "text-ink-muted"
                      }
                    >
                      {item.status === "done" ? "✓" : item.status === "failed" ? "✕" : item.status === "active" ? "▸" : "○"}
                    </span>
                    <span className={item.status === "pending" ? "text-ink-muted" : ""}>{item.label}</span>
                  </li>
                ))}
              </ul>
            );
          }
          if (part.type === "question") {
            return (
              <div
                key={i}
                className="mb-2 rounded-md border border-border-subtle bg-surface-raised p-2 text-xs"
              >
                <p className="mb-1 font-medium">{part.question.question}</p>
                <div className="flex flex-wrap gap-1">
                  {part.question.options.map((option, j) => (
                    <span
                      key={j}
                      className={
                        part.answer === option
                          ? "rounded-full border border-ink bg-ink px-2 py-0.5 text-surface"
                          : "rounded-full border border-border-subtle px-2 py-0.5 text-ink-muted"
                      }
                    >
                      {option}
                    </span>
                  ))}
                </div>
              </div>
            );
          }
          if (isUser) {
            return (
              <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
                {part.text}
              </p>
            );
          }
          // Every other part type returned above, so what is left is text.
          return part.text.trim() ? (
            <Markdown key={i} content={part.text} />
          ) : streaming ? (
            <span key={i} className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-ink-subtle" />
          ) : null;
        })}
      </div>
      <div className="px-1 text-xs text-ink-muted">
        {message.model ? `${message.model} · ` : ""}
        {timeLabel(message.createdAt)}
      </div>
    </div>
  );
}
