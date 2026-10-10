"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { AssetThumb } from "@/components/asset-thumb";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Images, PenTool, Search, Shapes } from "lucide-react";

interface PickerProps {
  onOpen: (designId: string, mockupId: string) => void;
  initialDesignId?: string;
  initialMockupId?: string;
}

function usePickerList(kind: "designs" | "mockups") {
  const [query, setQuery] = React.useState("");
  const items = useLiveQuery(async () => {
    if (kind === "designs") {
      const rows = await db.designs.orderBy("createdAt").reverse().toArray();
      const q = query.trim().toLowerCase();
      return rows
        .filter((d) => !q || d.name.toLowerCase().includes(q))
        .map((d) => ({ id: d.id, name: d.name, assetId: d.originalAssetId, meta: `${d.tags.length} tags` }));
    }
    const rows = await db.mockups.orderBy("createdAt").reverse().toArray();
    const q = query.trim().toLowerCase();
    return rows
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .map((m) => ({ id: m.id, name: m.name, assetId: m.assetId, meta: `${m.width}×${m.height}` }));
  }, [kind, query]);
  return { query, setQuery, items };
}

function PickerColumn({
  kind,
  selectedId,
  onSelect,
}: {
  kind: "designs" | "mockups";
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { query, setQuery, items } = usePickerList(kind);
  const isDesigns = kind === "designs";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2">
        <div className={cn("flex h-7 w-7 items-center justify-center rounded-md", isDesigns ? "bg-sage-soft text-forest" : "bg-forest-soft text-forest")}>
          {isDesigns ? <Images className="h-3.5 w-3.5" /> : <Shapes className="h-3.5 w-3.5" />}
        </div>
        <h2 className="text-[14px] font-semibold text-ink">{isDesigns ? "1. Choose a design" : "2. Choose a mockup"}</h2>
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="h-8 pl-8" />
      </div>
      <div className="scroll-thin max-h-[420px] min-h-[200px] overflow-y-auto">
        {!items ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-surface-muted" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={isDesigns ? <Images /> : <Shapes />}
            title={isDesigns ? "No designs" : "No mockups"}
            description={isDesigns ? "Upload artwork in the Designs section first." : "Upload mockup photos in the Mockups section first."}
            className="border-0 bg-transparent py-8"
          />
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md p-1.5 text-left transition-colors",
                    selectedId === item.id ? "bg-sage-soft ring-1 ring-forest" : "hover:bg-surface-muted",
                  )}
                >
                  <AssetThumb assetId={item.assetId} className="h-14 w-14 shrink-0 rounded-md" checkerboard={isDesigns} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink">{item.name}</div>
                    <div className="text-[11px] text-ink-subtle">{item.meta}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function EditorPicker({ onOpen, initialDesignId, initialMockupId }: PickerProps) {
  const [designId, setDesignId] = React.useState<string | undefined>(initialDesignId);
  const [mockupId, setMockupId] = React.useState<string | undefined>(initialMockupId);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sage-soft text-forest">
          <PenTool className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-semibold text-ink">Mockup Editor</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Pick a design and a mockup to start placing artwork. Your placement is saved per design + mockup pair.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PickerColumn kind="designs" selectedId={designId} onSelect={setDesignId} />
        <PickerColumn kind="mockups" selectedId={mockupId} onSelect={setMockupId} />
      </div>
      <div className="mt-5 flex justify-center">
        <Button size="lg" disabled={!designId || !mockupId} onClick={() => designId && mockupId && onOpen(designId, mockupId)}>
          Open canvas
        </Button>
      </div>
    </div>
  );
}
