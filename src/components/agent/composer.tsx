"use client";

import * as React from "react";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ImagePartData } from "@/types/domain";

export interface SlashCommand {
  name: string;
  description: string;
  run(): void;
}

interface ComposerProps {
  value: string;
  onChange(v: string): void;
  onSend(): void;
  onStop(): void;
  streaming: boolean;
  disabled?: boolean;
  canAttach?: boolean;
  attachments: ImagePartData[];
  onAttachFiles(files: FileList | File[]): void;
  onRemoveAttachment(index: number): void;
  history: string[];
  /** Model picker + effort pill, rendered left of the send button. */
  header: React.ReactNode;
  commands?: SlashCommand[];
  error?: string | null;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  canAttach,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  history,
  header,
  commands = [],
  error,
}: ComposerProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const slashQuery = value.startsWith("/") && !value.includes(" ") ? value.slice(1).toLowerCase() : null;
  const matches = slashQuery === null ? [] : commands.filter((c) => c.name.startsWith(slashQuery));
  const showSlash = slashQuery !== null && matches.length > 0;

  const submit = () => {
    if (disabled || streaming) return;
    if (!value.trim() && attachments.length === 0) return;
    setHistoryIndex(-1);
    onSend();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash && e.key === "Tab") {
      e.preventDefault();
      const cmd = matches[0];
      cmd.run();
      onChange("");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "ArrowUp" && !value && history.length > 0) {
      e.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      onChange(history[history.length - 1 - next]);
      return;
    }
    if (e.key === "ArrowDown" && historyIndex >= 0) {
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      onChange(next < 0 ? "" : history[history.length - 1 - next]);
    }
  };

  return (
    <div className="border-t border-border-subtle bg-surface px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {error && <div className="mb-2 text-[11px] text-danger">{error}</div>}
        <div
          onDragOver={(e) => {
            if (canAttach) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (!canAttach) return;
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) onAttachFiles(e.dataTransfer.files);
          }}
          className={cn(
            "relative rounded-lg border bg-surface shadow-subtle transition-colors",
            dragging ? "border-forest" : "border-border-strong",
          )}
        >
          {showSlash && (
            <div className="absolute bottom-full left-0 mb-1.5 w-64 overflow-hidden rounded-lg border border-border-subtle bg-surface shadow-pop">
              {matches.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => {
                    c.run();
                    onChange("");
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-surface-muted"
                >
                  <span className="font-medium text-forest">/{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-subtle">{c.description}</span>
                </button>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border-subtle p-2">
              {attachments.map((a, i) => (
                <div key={i} className="group relative">
                  <img src={a.dataUrl} alt={a.name} className="h-12 w-12 rounded-md border border-border-subtle object-cover" />
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(i)}
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-white"
                    title="Remove"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Message the agent"
            placeholder={disabled ? "Add an AI provider key in Settings to chat…" : "Message the agent…  ( / for commands)"}
            disabled={disabled}
            rows={1}
            className="scroll-thin max-h-[220px] w-full resize-none bg-transparent px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed"
          />

          <div className="flex items-center gap-1.5 px-2 pb-2 pt-0.5">
            {canAttach && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => e.target.files && onAttachFiles(e.target.files)}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted hover:text-ink"
                  title="Attach image"
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
              </>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {header}
              {streaming ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-forest-soft text-forest hover:bg-sage-soft"
                  title="Stop"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={disabled || (!value.trim() && attachments.length === 0)}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-forest text-white transition-colors hover:bg-forest-deep disabled:opacity-40"
                  title="Send"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-1.5 px-1 text-[10px] text-ink-subtle">
          Enter to send · Shift+Enter for a new line · responses may be inaccurate; verify before publishing.
        </div>
      </div>
    </div>
  );
}
