"use client";

import * as React from "react";
import { MessageSquare, Pin, Plus, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types/domain";

interface SessionsRailProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): void;
  onTogglePin(id: string, pinned: boolean): void;
  onDelete(id: string): void;
}

function groupLabel(ts: number): string {
  const days = (Date.now() - ts) / 86_400_000;
  if (days < 1) return "Today";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

export function SessionsRail({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onTogglePin,
  onDelete,
}: SessionsRailProps) {
  const [query, setQuery] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  const q = query.trim().toLowerCase();
  const filtered = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations;

  const groups = new Map<string, Conversation[]>();
  for (const c of filtered) {
    const key = c.pinned ? "Pinned" : groupLabel(c.updatedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const order = ["Pinned", "Today", "Previous 7 days", "Older"];
  const orderedGroups = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  const commitRename = (id: string) => {
    onRename(id, draft);
    setEditingId(null);
  };

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border-subtle bg-surface">
      <div className="flex items-center gap-2 px-3 py-3">
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-forest px-3 text-[13px] font-medium text-white transition-colors hover:bg-forest-deep"
        >
          <Plus className="h-4 w-4" /> New chat
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-muted px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-ink-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="h-5 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {orderedGroups.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-ink-subtle">
            {conversations.length === 0 ? "No conversations yet." : "No matches."}
          </div>
        )}
        {orderedGroups.map(([label, items]) => (
          <div key={label} className="mb-2">
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
              {label}
            </div>
            {items.map((c) => {
              const active = c.id === activeId;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "group mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
                    active ? "bg-sage-soft text-forest" : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  {editingId === c.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(c.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-1 text-[13px] outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      onDoubleClick={() => {
                        setEditingId(c.id);
                        setDraft(c.title);
                      }}
                      className="min-w-0 flex-1 truncate text-left"
                      title={c.title}
                    >
                      {c.title}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onTogglePin(c.id, !c.pinned)}
                    className={cn(
                      "shrink-0 p-0.5 text-ink-subtle opacity-0 hover:text-ink group-hover:opacity-100",
                      c.pinned && "text-warning opacity-100",
                    )}
                    title={c.pinned ? "Unpin" : "Pin"}
                  >
                    <Pin className={cn("h-3 w-3", c.pinned && "fill-current")} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    className="shrink-0 p-0.5 text-ink-subtle opacity-0 hover:text-danger group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
