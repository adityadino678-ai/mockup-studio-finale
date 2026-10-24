"use client";

// ---------------------------------------------------------------------------
// The design picker.
//
// The old picker was a Radix Select capped at 16rem with a hidden scrollbar:
// about eight rows. Designs are sorted alphabetically, so anything uploaded
// recently could sit below the fold and look like it was from an old version
// of the app. This picker shows every design, newest first, with a search box
// and a count, so a late-sorted design is one keystroke away.
// ---------------------------------------------------------------------------

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { Design } from "@/types/domain";

export function DesignPicker({
  designs,
  value,
  onChange,
  triggerId,
  className,
  placeholder = "Pick a design",
}: {
  designs: readonly Design[];
  value: string | null;
  onChange: (designId: string) => void;
  triggerId?: string;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const ordered = React.useMemo(
    () => [...designs].sort((a, b) => b.createdAt - a.createdAt),
    [designs],
  );
  const selected = designs.find((d) => d.id === value);
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? ordered.filter((d) => d.name.toLowerCase().includes(needle))
    : ordered;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={triggerId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-8 w-[240px] justify-between gap-2 px-2.5 text-[12px] font-normal",
            className,
          )}
        >
          <span className="truncate">{selected?.name ?? placeholder}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[330px] p-0">
        <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search designs…"
            className="h-7 border-0 bg-transparent px-0 text-[12px] focus-visible:ring-0"
          />
        </div>
        <div className="flex items-center justify-between px-2.5 py-1.5 text-[10.5px] text-ink-subtle">
          <span>
            {filtered.length} of {ordered.length} design{ordered.length === 1 ? "" : "s"}
          </span>
          <span>Newest first</span>
        </div>
        <div
          role="listbox"
          aria-label="Designs"
          className="max-h-[260px] overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-ink-subtle">
              No designs match “{query.trim()}”.
            </div>
          ) : (
            filtered.map((design) => {
              const active = design.id === value;
              return (
                <button
                  key={design.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(design.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-muted",
                    active && "bg-forest-soft",
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{design.name}</span>
                </button>
              );
            })
          )}
        </div>
        <a
          href="/printify-studio"
          className="block border-t border-border-subtle px-2.5 py-2 text-[11.5px] text-ink-muted hover:text-ink"
        >
          Manage designs in the Printify Studio…
        </a>
      </PopoverContent>
    </Popover>
  );
}
