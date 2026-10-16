"use client";

import * as React from "react";
import { Check, ChevronDown, RefreshCw, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { favoriteKey, type ModelInfo, type ProviderDef } from "@/lib/ai/providers";

export interface ProviderModels {
  provider: ProviderDef;
  models: ModelInfo[];
  hasKey: boolean;
}

interface ModelPickerProps {
  activeProviderId: string;
  activeModelId: string;
  groups: ProviderModels[];
  favorites: string[];
  disabled?: boolean;
  onSelect(providerId: string, modelId: string): void;
  onToggleFavorite(providerId: string, modelId: string): void;
  onRefresh?(providerId: string): void;
}

function modelName(models: ModelInfo[], id: string): string {
  return models.find((m) => m.id === id)?.name ?? id;
}

/** Combined provider+model picker for the composer (Hermes-style, grouped by provider). */
export function ModelPicker({
  activeProviderId,
  activeModelId,
  groups,
  favorites,
  disabled,
  onSelect,
  onToggleFavorite,
  onRefresh,
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = groups.find((g) => g.provider.id === activeProviderId);
  const label = active?.provider.label ?? "Provider";
  const current = active ? modelName(active.models, activeModelId) : activeModelId;

  const q = query.trim().toLowerCase();
  const favoriteGroups = groups
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => favorites.includes(favoriteKey(g.provider.id, m.id))),
    }))
    .filter((g) => g.models.length > 0);

  const visibleGroups = groups
    .filter((g) => g.hasKey || g.provider.id === activeProviderId)
    .map((g) => ({
      ...g,
      models: q
        ? g.models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
        : g.models,
    }))
    .filter((g) => g.models.length > 0);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Choose model — ${label} · ${current || "none"}`}
        className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 text-[11px] text-ink-muted transition-colors hover:bg-surface-muted disabled:opacity-50"
        title="Choose model"
      >
        <span className="truncate">{label}</span>
        <span className="text-ink-subtle">·</span>
        <span className="truncate font-medium text-ink">{current || "Select model"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-ink-subtle" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 flex max-h-[420px] w-[300px] flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface shadow-pop">
          <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-ink-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>

          <div className="scroll-thin flex-1 overflow-y-auto py-1">
            {favoriteGroups.length > 0 && !q && (
              <>
                <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
                  Favorites
                </div>
                {favoriteGroups.flatMap((g) =>
                  g.models.map((m) => (
                    <ModelRow
                      key={`fav-${g.provider.id}-${m.id}`}
                      name={m.name}
                      free={m.free}
                      provider={g.provider.label}
                      selected={g.provider.id === activeProviderId && m.id === activeModelId}
                      favorite
                      onSelect={() => {
                        onSelect(g.provider.id, m.id);
                        setOpen(false);
                      }}
                      onToggleFavorite={() => onToggleFavorite(g.provider.id, m.id)}
                    />
                  )),
                )}
              </>
            )}

            {visibleGroups.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-ink-subtle">
                {groups.some((g) => g.hasKey)
                  ? "No models match your search."
                  : "Add a provider key in Settings to pick a model."}
              </div>
            )}

            {visibleGroups.map((g) => (
              <div key={g.provider.id}>
                <div className="flex items-center justify-between px-3 pb-1 pt-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
                    {g.provider.label}
                  </span>
                  {onRefresh && (
                    <button
                      type="button"
                      onClick={() => onRefresh(g.provider.id)}
                      className="text-ink-subtle hover:text-ink"
                      title="Refresh model list"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {g.models.map((m) => (
                  <ModelRow
                    key={`${g.provider.id}-${m.id}`}
                    name={m.name}
                    free={m.free}
                    context={m.contextLength}
                    selected={g.provider.id === activeProviderId && m.id === activeModelId}
                    favorite={favorites.includes(favoriteKey(g.provider.id, m.id))}
                    onSelect={() => {
                      onSelect(g.provider.id, m.id);
                      setOpen(false);
                    }}
                    onToggleFavorite={() => onToggleFavorite(g.provider.id, m.id)}
                  />
                ))}
              </div>
            ))}
          </div>

          <a
            href="/settings"
            className="border-t border-border-subtle px-3 py-2 text-[11px] text-forest hover:bg-surface-muted"
          >
            Manage providers &amp; keys →
          </a>
        </div>
      )}
    </div>
  );
}

function ModelRow({
  name,
  free,
  context,
  provider,
  selected,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  name: string;
  free?: boolean;
  context?: number;
  provider?: string;
  selected: boolean;
  favorite: boolean;
  onSelect(): void;
  onToggleFavorite(): void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-surface-muted",
        selected ? "text-forest" : "text-ink",
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Check className={cn("h-3 w-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {provider && <span className="shrink-0 text-[10px] text-ink-subtle">{provider}</span>}
        {free && (
          <span className="shrink-0 rounded bg-sage-soft px-1 text-[10px] font-medium text-forest">free</span>
        )}
        {context ? <span className="shrink-0 text-[10px] text-ink-subtle">{(context / 1000).toFixed(0)}k</span> : null}
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        className={cn("shrink-0 p-0.5 text-ink-subtle hover:text-warning", favorite && "text-warning")}
        title={favorite ? "Remove favorite" : "Add favorite"}
      >
        <Star className={cn("h-3 w-3", favorite && "fill-current")} />
      </button>
    </div>
  );
}
