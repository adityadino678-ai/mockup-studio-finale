"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge, Card, CardContent, Separator } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/primitives";
import { ColorSwatch } from "@/components/studio/color-swatch";
import {
  buildBlueprintIndex,
  categoriesOfIndex,
  filterBlueprintIndex,
} from "@/lib/printify/catalog-client";
import { describeInkContrast, inkContrast, knowsColourName, suggestInk } from "@/lib/printify/colors";
import { inkProblems } from "@/lib/printify/studio-session";
import { ROW_HINTS, ROW_LABELS, ROWS } from "@/lib/printify/studio-session";
import { cn } from "@/lib/utils";
import type { StudioCatalogState } from "@/views/printify-studio-page";
import type { StudioRowId, StudioSession } from "@/types/domain";
import { AlertTriangle, Package, Palette, Search, Sparkles } from "lucide-react";

interface ColorsTabProps {
  session: StudioSession;
  update: (patch: Partial<StudioSession>) => void;
  updateRow: (row: StudioRowId, patch: Partial<StudioSession["rows"][StudioRowId]>) => void;
  catalog: StudioCatalogState;
  hexFor: (name: string) => string;
  realHexes: Map<string, string[]>;
  onGoToPanel: () => void;
}

/** Printify's own limit on enabled variants per product. */
const MAX_VARIANTS = 100;

export function ColorsTab({
  session,
  update,
  updateRow,
  catalog,
  hexFor,
  realHexes,
  onGoToPanel,
}: ColorsTabProps) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<string>("All");
  const [picking, setPicking] = React.useState(false);
  const [visibleCount, setVisibleCount] = React.useState(120);

  // --- the catalogue ---------------------------------------------------------
  const colourNames = React.useMemo(() => {
    const seen = new Map<string, number>();
    for (const v of catalog.variants) {
      const name = v.options?.color ?? v.title?.split(" / ")[0] ?? "unknown";
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    return [...seen.keys()];
  }, [catalog.variants]);

  const sizeNames = React.useMemo(() => {
    const seen = new Set<string>();
    for (const v of catalog.variants) {
      const size = v.options?.size ?? v.title?.split(" / ")[1];
      if (size) seen.add(size);
    }
    return [...seen];
  }, [catalog.variants]);

  const sizeOrder = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
  const sortedSizes = React.useMemo(
    () =>
      [...sizeNames].sort((a, b) => {
        const ia = sizeOrder.indexOf(a);
        const ib = sizeOrder.indexOf(b);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return a.localeCompare(b);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sizeNames],
  );

  const catalogueIndex = React.useMemo(
    () => buildBlueprintIndex(catalog.blueprints),
    [catalog.blueprints],
  );

  const categoryList = React.useMemo(() => categoriesOfIndex(catalogueIndex), [catalogueIndex]);

  const filtered = React.useMemo(
    () => filterBlueprintIndex(catalogueIndex, query, category === "All" ? null : category),
    [catalogueIndex, query, category],
  );

  // A new search starts at the top of the results again.
  React.useEffect(() => {
    setVisibleCount(120);
  }, [query, category]);

  // The grid shows a page at a time, so a 2,900-product catalogue does not
  // mean 2,900 buttons in the DOM.
  const shown = filtered.slice(0, visibleCount);

  // --- selection helpers -----------------------------------------------------
  const variantCount = React.useCallback(
    (colors: string[], sizes: string[]) => {
      const colorSet = new Set(colors);
      const sizeSet = new Set(sizes);
      return catalog.variants.filter((v) => {
        const name = v.options?.color ?? v.title?.split(" / ")[0] ?? "";
        const size = v.options?.size ?? v.title?.split(" / ")[1] ?? "";
        if (!colorSet.has(name)) return false;
        return sizeSet.size === 0 || sizeSet.has(size);
      }).length;
    },
    [catalog.variants],
  );

  const rowVariantCount = (row: StudioRowId) =>
    variantCount(session.rows[row]?.colors ?? [], session.sizes);

  const overCap = (row: StudioRowId) => rowVariantCount(row) > MAX_VARIANTS;

  const toggleColor = (row: StudioRowId, name: string) => {
    const current = session.rows[row]?.colors ?? [];
    const next = current.includes(name) ? current.filter((c) => c !== name) : [...current, name];
    updateRow(row, {
      colors: next,
      blackInkColors: (session.rows[row]?.blackInkColors ?? []).filter((c) => next.includes(c)),
    });
  };

  /**
   * A STABLE click handler for every swatch in the grid.
   *
   * Each swatch carries its colour in `data-colour`, so one handler serves
   * them all. That matters: with a per-swatch closure the `onClick` prop
   * changed on every render, so React had to re-render all 140+ swatches for
   * one changed selection (measured at 63-108 renders per click).
   */
  const toggleRef = React.useRef(toggleColor);
  toggleRef.current = toggleColor;
  const handleSwatchClick = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    const element = event.currentTarget as HTMLElement;
    const name = element.getAttribute("data-colour");
    const row = element.closest("[data-row]")?.getAttribute("data-row") as StudioRowId | null;
    if (name && row) toggleRef.current(row, name);
  }, []);

  const toggleSize = (size: string) => {
    const current = session.sizes;
    const next = current.includes(size) ? current.filter((s) => s !== size) : [...current, size];
    update({ sizes: next });
  };

  const setInk = (name: string, ink: "black" | "white") => {
    const black = new Set(session.rows.ink?.blackInkColors ?? []);
    if (ink === "black") black.add(name);
    else black.delete(name);
    updateRow("ink", { blackInkColors: [...black] });
  };

  /** Marks the dark colours for white ink and the light ones for black ink. */
  const autoAssign = () => {
    const black: string[] = [];
    const mid: string[] = [];
    const unknown: string[] = [];
    for (const name of session.rows.ink?.colors ?? []) {
      // A colour we know nothing about is left alone: guessing would be
      // guessing twice, on a colour we cannot even see.
      if (!isKnownColour(name)) {
        unknown.push(name);
        continue;
      }
      const choice = suggestInk(hexFor(name));
      if (choice === "ambiguous") mid.push(name);
      else if (choice === "black") black.push(name);
    }
    updateRow("ink", { blackInkColors: black });
    const notes: string[] = [];
    if (mid.length) notes.push(`${mid.length} mid-tone colour(s) need a look`);
    if (unknown.length) notes.push(`${unknown.length} colour(s) are not in the colour table`);
    toast.success(
      notes.length
        ? `Assigned ${black.length} colour(s) to black ink. ${notes.join(" and ")}.`
        : `Assigned ${black.length} colour(s) to black ink.`,
    );
  };

  /** True when the colour's real hex is known - from a product or the table. */
  const isKnownColour = React.useCallback(
    (name: string) => realHexes.has(name) || knowsColourName(name),
    [realHexes],
  );

  const unknownColors = React.useMemo(
    () => (session.rows.ink?.colors ?? []).filter((name) => !isKnownColour(name)),
    [session.rows.ink, isKnownColour],
  );

  const midTones = React.useMemo(
    () => (session.rows.ink?.colors ?? []).filter((name) => suggestInk(hexFor(name)) === "ambiguous"),
    [session.rows.ink, hexFor],
  );

  const problems = React.useMemo(() => inkProblems(session, hexFor), [session, hexFor]);
  const invisible = problems.filter((p) => p.severity === "none");

  // --- the product picker ----------------------------------------------------
  const pickBlueprint = (id: number) => {
    // The print provider must serve the new blueprint, so the old one is
    // dropped - and with it the colours and sizes that went with it.
    update({ blueprintId: id, printProviderId: undefined });
    setPicking(false);
  };

  if (!catalog.configured) {
    return (
      <Card>
        <CardContent className="space-y-2 p-5">
          <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <Package className="h-4 w-4" /> Printify is not connected
          </div>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            {catalog.error ??
              "Paste a Printify API key in Settings to browse the catalogue and create listings. Your designs stay on this device either way."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* --- the product --------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px] flex-1 space-y-1.5">
              <Label className="text-[12px] text-ink-muted">Product</Label>
              <Button
                variant="outline"
                className="w-full justify-between"
                onClick={() => setPicking((p) => !p)}
                disabled={catalog.loading}
              >
                {session.blueprintId
                  ? (catalog.blueprints.find((b) => b.id === session.blueprintId)?.title ??
                    `Blueprint ${session.blueprintId}`)
                  : "Choose a product…"}
              </Button>
            </div>
            <div className="w-[220px] space-y-1.5">
              <Label className="text-[12px] text-ink-muted">Print provider</Label>
              <Select
                value={session.printProviderId ? String(session.printProviderId) : "none"}
                onValueChange={(v) => update({ printProviderId: v === "none" ? undefined : Number(v) })}
                disabled={!session.blueprintId || catalog.providers.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a provider…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {catalog.providers.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {picking && (
            <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-muted/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-[260px]">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search products…"
                    className="h-8 pl-8 text-[12px]"
                  />
                </div>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-8 w-[190px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">
                      All categories ({catalog.blueprints.length})
                    </SelectItem>
                    {categoryList.map((c) => (
                      <SelectItem key={c.category} value={c.category}>
                        {c.category} ({c.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-ink-subtle">
                  showing {Math.min(shown.length, filtered.length)} of {filtered.length} matching
                </span>
              </div>
              {catalog.loading && catalog.blueprints.length === 0 ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-24 animate-pulse rounded-md bg-surface-muted" />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState icon={<Search />} title="No products match" description="Try a different search." />
              ) : (
                <>
                  <div
                    role="list"
                    aria-label={`${filtered.length} matching products`}
                    className="scroll-thin grid max-h-[380px] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4"
                  >
                    {shown.map((entry) => {
                      const b = entry.blueprint;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          role="listitem"
                          onClick={() => pickBlueprint(b.id)}
                          className={`overflow-hidden rounded-md border text-left transition-colors hover:border-forest ${
                            session.blueprintId === b.id
                              ? "border-forest ring-1 ring-forest"
                              : "border-border-subtle bg-surface"
                          }`}
                        >
                          {b.image ?? b.images?.[0] ? (
                            <img
                              src={b.image ?? b.images?.[0]}
                              alt=""
                              loading="lazy"
                              className="h-20 w-full bg-surface-muted object-cover"
                            />
                          ) : (
                            <div className="h-20 w-full bg-surface-muted" />
                          )}
                          <div className="p-2">
                            <div className="truncate text-[12px] font-medium text-ink" title={b.title}>
                              {b.title}
                            </div>
                            <div className="truncate text-[10px] text-ink-subtle">{b.brand}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {filtered.length > shown.length && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setVisibleCount((n) => n + 120)}
                      className="w-full"
                    >
                      Show more ({shown.length} of {filtered.length})
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {catalog.error && (
            <p className="text-[12px] text-danger">{catalog.error}</p>
          )}
        </CardContent>
      </Card>

      {!session.blueprintId ? (
        <EmptyState
          icon={<Package />}
          title="Choose a product"
          description="Pick the product your designs will be printed on. The colour and size list comes from Printify's live catalogue."
        />
      ) : (
        <>
          {/* --- sizes ------------------------------------------------------ */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[14px] font-semibold text-ink">Sizes</h2>
                <span className="text-[11px] text-ink-muted">
                  {session.sizes.length === 0
                    ? "No size selected — every size will be listed."
                    : `${session.sizes.length} selected`}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sortedSizes.map((size) => {
                  const active = session.sizes.includes(size);
                  return (
                    <Button
                      key={size}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      onClick={() => toggleSize(size)}
                      className="h-7 min-w-[44px] px-2.5 text-[12px]"
                    >
                      {size}
                    </Button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* --- colours, one panel per row --------------------------------- */}
          {ROWS.map((row) => {
            const state = session.rows[row];
            const swatchCount = rowVariantCount(row);
            return (
              <Card key={row}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h2 className="text-[14px] font-semibold text-ink">
                        {ROW_LABELS[row]}{" "}
                        <span className="font-normal text-ink-subtle">
                          ({state?.colors.length ?? 0} colours)
                        </span>
                      </h2>
                      <p className="text-[11px] text-ink-muted">{ROW_HINTS[row]}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {row === "ink" && (
                        <Button size="sm" variant="outline" onClick={autoAssign}>
                          <Sparkles className="h-3.5 w-3.5" /> Auto-assign
                        </Button>
                      )}
                      <Badge variant={overCap(row) ? "danger" : "muted"}>
                        {swatchCount} variant{swatchCount === 1 ? "" : "s"}
                      </Badge>
                    </div>
                  </div>

                  {overCap(row) && (
                    <p className="flex items-center gap-1.5 text-[12px] text-danger">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Printify allows at most {MAX_VARIANTS} variants per product. Drop a colour or
                      a size.
                    </p>
                  )}

                  {colourNames.length === 0 ? (
                    <p className="text-[12px] text-ink-muted">
                      Choose a print provider to load its colours.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {colourNames.map((name) => {
                        const selected = state?.colors.includes(name) ?? false;
                        const hex = hexFor(name);
                        const isBlack = state?.blackInkColors.includes(name) ?? false;
                        const isMid = suggestInk(hex) === "ambiguous";
                        return (
                          <div key={name} data-row={row} className="relative">
                            {/* The same handler for every swatch: the colour is
                                read from `data-colour`, so the props stay
                                stable and only the swatch that changed
                                re-renders. */}
                            <ColorSwatch
                              name={name}
                              hex={hex}
                              selected={selected}
                              showInk={row === "ink" && selected}
                              ink={
                                row === "ink" ? (isBlack ? ("black" as const) : ("white" as const)) : undefined
                              }
                              onClick={handleSwatchClick}
                              className="h-7 w-7"
                            />
                            {isMid && selected && (
                              <span
                                title="Mid-tone colour — check the ink"
                                className="absolute -left-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-surface"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {row === "ink" && (state?.colors.length ?? 0) > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <p className="text-[12px] text-ink-muted">
                          The colours marked <strong>black</strong> print with the black ink; the
                          rest use the white ink.
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {(state?.colors ?? []).map((name) => {
                            const isBlack = state?.blackInkColors.includes(name) ?? false;
                            const contrast = inkContrast(hexFor(name), isBlack ? "black" : "white");
                            return (
                              <div
                                key={name}
                                className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface py-0.5 pl-1 pr-0.5"
                              >
                                <ColorSwatch name={name} hex={hexFor(name)} className="h-4 w-4" />
                                <span className="max-w-[120px] truncate text-[11px] text-ink">
                                  {name}
                                </span>
                                {contrast !== "ok" && (
                                  <span
                                    title={describeInkContrast(hexFor(name), isBlack ? "black" : "white")}
                                    className={cn(
                                      "h-2 w-2 shrink-0 rounded-full",
                                      contrast === "none" ? "bg-danger" : "bg-warning",
                                    )}
                                  />
                                )}
                                <Button
                                  size="sm"
                                  variant={isBlack ? "default" : "outline"}
                                  onClick={() => setInk(name, isBlack ? "white" : "black")}
                                  className="h-6 rounded-full px-2 text-[10px]"
                                >
                                  {isBlack ? "Black ink" : "White ink"}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                        {problems.length > 0 && (
                          <div className="space-y-1">
                            {invisible.length > 0 && (
                              <p className="text-[12px] font-medium text-danger">
                                {invisible.length} colour{invisible.length === 1 ? "" : "s"} would be
                                invisible with the ink you chose.
                              </p>
                            )}
                            {problems.map((p) => (
                              <p
                                key={p.name}
                                className={cn(
                                  "flex items-start gap-1.5 text-[12px]",
                                  p.severity === "none" ? "text-danger" : "text-warning",
                                )}
                              >
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>
                                  <strong>{p.name}</strong> — {p.message}
                                </span>
                              </p>
                            ))}
                          </div>
                        )}
                        {unknownColors.length > 0 && (
                          <p className="flex items-start gap-1.5 text-[12px] text-warning">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                              {unknownColors.length} colour{unknownColors.length === 1 ? "" : "s"} (
                              {unknownColors.slice(0, 4).join(", ")}
                              {unknownColors.length > 4 ? ", …" : ""}) {unknownColors.length === 1 ? "is" : "are"}{" "}
                              not in the colour table, so the ink cannot be suggested — check them by
                              hand.
                            </span>
                          </p>
                        )}
                        {midTones.length > 0 && (
                          <p className="flex items-start gap-1.5 text-[12px] text-warning">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {midTones.length} mid-tone colour{midTones.length === 1 ? "" : "s"} (
                            {midTones.slice(0, 4).join(", ")}
                            {midTones.length > 4 ? ", …" : ""}) — black and white ink both risk
                            disappearing on these. Check them before creating.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-card">
            <p className="text-[12px] text-ink-muted">
              {realHexes.size > 0
                ? "Colours use the real hexes from your Printify product."
                : "No existing product found for this colourway — showing the built-in colour table."}
            </p>
            <Button size="sm" onClick={onGoToPanel}>
              <Palette className="h-3.5 w-3.5" /> Place the artwork
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
