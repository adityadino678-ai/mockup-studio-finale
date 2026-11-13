"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
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
import { db } from "@/lib/db/schema";
import {
  buildBlueprintIndex,
  categoriesOfIndex,
  filterBlueprintIndex,
} from "@/lib/printify/catalog-client";
import { inkProblems } from "@/lib/printify/studio-session";
import { ROW_HINTS, ROW_LABELS, ROWS } from "@/lib/printify/studio-session";
import { cn } from "@/lib/utils";
import type { StudioCatalogState } from "@/views/printify-studio-page";
import type { StudioRowId, StudioSession } from "@/types/domain";
import { AlertTriangle, Package, Palette, Search } from "lucide-react";

interface ColorsTabProps {
  session: StudioSession;
  update: (patch: Partial<StudioSession>) => void;
  updateRow: (
    row: StudioRowId,
    patch:
      | Partial<StudioSession["rows"][StudioRowId]>
      | ((prev: StudioSession) => Partial<StudioSession["rows"][StudioRowId]>),
  ) => void;
  catalog: StudioCatalogState;
  hexFor: (name: string) => string;
  realHexes: Map<string, string[]>;
  isApprox?: (name: string) => boolean;
  onSetHex?: (name: string, hex: string) => void | Promise<void>;
  onRetry?: () => void;
  onGoToPanel: () => void;
}

/** Printify's own limit on enabled variants per product. */
const MAX_VARIANTS = 100;

/** "White, Cream and Navy" / "White and 12 more" - never the whole list. */
function joinShort(names: string[], max = 3): string {
  if (names.length <= max) {
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function ColorsTab({
  session,
  update,
  updateRow,
  catalog,
  hexFor,
  realHexes: _realHexes,
  isApprox,
  onSetHex,
  onRetry,
  onGoToPanel,
}: ColorsTabProps) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<string>("All");
  const [picking, setPicking] = React.useState(false);
  const [visibleCount, setVisibleCount] = React.useState(120);
  const [editingHex, setEditingHex] = React.useState<{ name: string; value: string } | null>(null);

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
    updateRow(row, (prev: StudioSession) => {
      const current = prev.rows[row]?.colors ?? [];
      const isSelecting = !current.includes(name);
      const next = isSelecting ? [...current, name] : current.filter((c) => c !== name);

      // No automatic ink here. A colour just selected is UNDECIDED: guessing
      // sent colours to the black design (or, before that, to the white one)
      // without the user ever saying so. Only the Black ink / White ink
      // buttons decide, and Create stays blocked while a colour is undecided.
      return {
        colors: next,
        blackInkColors: (prev.rows[row]?.blackInkColors ?? []).filter((c) => next.includes(c)),
        whiteInkColors: (prev.rows[row]?.whiteInkColors ?? []).filter((c) => next.includes(c)),
      };
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
    updateRow("ink", (prev: StudioSession) => {
      const colors = [...(prev.rows.ink?.colors ?? [])];
      const black = new Set(prev.rows.ink?.blackInkColors ?? []);
      const white = new Set(prev.rows.ink?.whiteInkColors ?? []);
      if (ink === "black") {
        black.add(name);
        white.delete(name);
        // Ensure the colour is in the ink panel so loadSession keeps the choice.
        if (!colors.includes(name)) colors.push(name);
      } else {
        white.add(name);
        black.delete(name);
        if (!colors.includes(name)) colors.push(name);
      }
      return { colors, blackInkColors: [...black], whiteInkColors: [...white] };
    });
  };

  const problems = React.useMemo(() => inkProblems(session, hexFor), [session, hexFor]);
  const invisible = problems.filter((p) => p.severity === "none");

  // --- the ink split readout -------------------------------------------------
  // The whole point of the two panels: which colours the black-ink designs
  // get, which the white-ink designs get, and which the no-ink designs get.
  const inkColors = session.rows.ink?.colors ?? [];
  const blackInkColors = session.rows.ink?.blackInkColors ?? [];
  const whiteInkColors = session.rows.ink?.whiteInkColors ?? [];
  const blackInkList = inkColors.filter((c) => blackInkColors.includes(c));
  const whiteInkList = inkColors.filter((c) => whiteInkColors.includes(c) && !blackInkColors.includes(c));
  const undecidedInkList = inkColors.filter(
    (c) => !blackInkColors.includes(c) && !whiteInkColors.includes(c),
  );
  const plainColors = session.rows.plain?.colors ?? [];

  // --- the palette's honest state --------------------------------------------
  // The coarse `colourSource` flag says where the panel's hexes CAME FROM,
  // but the SHIPPED colour seed means a palette can be exact even when no
  // template product was read. What the user cares about is per colour: is
  // THIS swatch's hex real. `isApprox` (the resolver's per-swatch verdict)
  // is the truth, so the pills and banners report counts, not the source.
  const selectedNames = [...new Set([...plainColors, ...inkColors])];
  const approxNames = isApprox ? selectedNames.filter((name) => isApprox(name)) : selectedNames;
  const allSelectedExact = selectedNames.length > 0 && approxNames.length === 0;

  // --- which design actually prints each side --------------------------------
  // The arrow in the routing table must name the real design, not "the white
  // one" in the abstract. Names come from the library, the same rows the
  // Designs tab shows. A pair wins; otherwise a design counts on a side when
  // its INK ARTWORK for that side exists. Never a lightness guess.
  const designs = useLiveQuery(async () => {
    const all = await db.designs.toArray();
    return all
      .map((d) => ({
        id: d.id,
        name: d.name,
        blackInkAssetId: d.blackInkAssetId,
        whiteInkAssetId: d.whiteInkAssetId,
        createdAt: d.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }, []);

  const inkRoutes = React.useMemo(() => {
    const byId = new Map((designs ?? []).map((d) => [d.id, d]));
    const ticked = session.inkPairIds
      .map((id) => byId.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    const pair = session.inkPairs.find(
      (p) =>
        session.inkPairIds.includes(p.blackInkDesignId) &&
        session.inkPairIds.includes(p.whiteInkDesignId),
    );
    const names = (ids: string[]) =>
      ids.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n));
    return {
      black: names(
        pair ? [pair.blackInkDesignId] : ticked.filter((d) => d.blackInkAssetId).map((d) => d.id),
      ),
      white: names(
        pair ? [pair.whiteInkDesignId] : ticked.filter((d) => d.whiteInkAssetId).map((d) => d.id),
      ),
    };
  }, [designs, session.inkPairIds, session.inkPairs]);

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
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Package className="h-4 w-4" /> Printify is not connected
          </div>
          <p className="text-sm leading-relaxed text-ink-muted">
            {catalog.error ??
              "Paste a Printify API key in Settings to browse the catalogue and create listings. Your designs stay on this device either way."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {session.inkReset && (
        <div
          role="status"
          data-ink-reset=""
          className="flex items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2"
        >
          <p className="text-xs leading-relaxed text-ink">
            The old automatic colour split was cleared. A colour no longer inherits the ink of a
            similar shade — <strong>only your Black ink / White ink marks decide</strong>. Your
            &ldquo;No ink variants&rdquo; colours were not touched.
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            onClick={() => update({ inkReset: false })}
          >
            Dismiss
          </Button>
        </div>
      )}
      {/* --- the product --------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px] flex-1 space-y-1.5">
              <Label className="text-xs text-ink-muted">Product</Label>
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
              <Label className="text-xs text-ink-muted">Print provider</Label>
              <Select
                value={session.printProviderId ? String(session.printProviderId) : "none"}
                onValueChange={(v) => update({ printProviderId: v === "none" ? undefined : Number(v) })}
                disabled={!session.blueprintId || catalog.providers.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      catalog.providersLoading ? "Loading providers…" : "Choose a provider…"
                    }
                  />
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
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search products…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-8 w-[190px] text-xs">
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
                <span className="text-xs text-ink-muted">
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
                            <div className="truncate text-xs font-medium text-ink" title={b.title}>
                              {b.title}
                            </div>
                            <div className="truncate text-xs text-ink-muted">{b.brand}</div>
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
            <p className="text-xs text-danger">{catalog.error}</p>
          )}
        </CardContent>
      </Card>

      {!session.blueprintId ? (
        <EmptyState
          icon={<Package />}
          title="Choose a product"
          description="Choose a product."
        />
      ) : (
        <>
          {/* --- sizes ------------------------------------------------------ */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">Sizes</h2>
                <span className="text-xs text-ink-muted">
                  {session.sizes.length === 0
                    ? "No size selected — every size will be listed."
                    : `${session.sizes.length} selected`}
                </span>
              </div>
              <div
                className={cn(
                  "flex flex-wrap gap-1.5",
                  catalog.variantsLoading && "pointer-events-none opacity-50",
                )}
              >
                {sortedSizes.map((size) => {
                  const active = session.sizes.includes(size);
                  return (
                    <Button
                      key={size}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      onClick={() => toggleSize(size)}
                      className="h-7 min-w-[44px] px-2.5 text-xs"
                    >
                      {size}
                    </Button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* --- colours, one panel per row --------------------------------- */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Which colours each row prints</h2>
              <span
                data-colour-status=""
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
                  allSelectedExact ||
                    (catalog.colourSource?.source === "product" &&
                      !catalog.colourSource?.approximate)
                    ? "border-forest/30 bg-surface"
                    : "border-dashed border-ink-muted/40 bg-surface-muted/50",
                )}
              >
                {catalog.colourLoading && !catalog.colourSource
                  ? "Reading exact colours…"
                  : allSelectedExact ||
                    (catalog.colourSource?.source === "product" && !catalog.colourSource?.approximate)
                    ? "Exact colours"
                    : approxNames.length > 0 && selectedNames.length > 0
                      ? `Approximate — ${approxNames.length} of ${selectedNames.length}`
                      : "Approximate colours"}
              </span>
            </div>
            <p className="text-xs text-ink-muted">Panels are independent.
            </p>
            {catalog.colourError && (
              <div
                role="status"
                data-colour-error=""
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2"
              >
                <span className="text-xs text-ink-muted">Using approximate colours</span>
                {onRetry && (
                  <Button size="sm" variant="outline" onClick={onRetry} disabled={catalog.colourLoading}>
                    Retry
                  </Button>
                )}
              </div>
            )}
          </div>
          {editingHex && (
            <div
              role="dialog"
              aria-label={`Set hex for ${editingHex.name}`}
              data-hex-editor=""
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2"
            >
              <span className="text-xs text-ink">
                {editingHex.name}
              </span>
              <input
                type="color"
                aria-label={`Colour picker for ${editingHex.name}`}
                value={editingHex.value.startsWith("#") && editingHex.value.length === 7 ? editingHex.value : "#000000"}
                onChange={(e) => setEditingHex((h) => (h ? { ...h, value: e.target.value } : h))}
                className="h-8 w-10 cursor-pointer"
              />
              <Input
                value={editingHex.value}
                onChange={(e) => setEditingHex((h) => (h ? { ...h, value: e.target.value } : h))}
                aria-label={`Hex value for ${editingHex.name}`}
                className="h-8 w-28 text-xs"
                placeholder="#000000"
              />
              <Button
                size="sm"
                onClick={() => {
                  if (onSetHex && editingHex.value.trim()) void onSetHex(editingHex.name, editingHex.value.trim());
                  setEditingHex(null);
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingHex(null)}>
                Cancel
              </Button>
            </div>
          )}
          {ROWS.map((row) => {
            const state = session.rows[row];
            const swatchCount = rowVariantCount(row);
            return (
              <Card key={row}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">
                        {ROW_LABELS[row]}{" "}
                        <span className="font-normal text-ink-muted">
                          ({state?.colors.length ?? 0} colours)
                        </span>
                      </h2>
                      <p className="text-xs text-ink-muted">{ROW_HINTS[row]}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={overCap(row) ? "danger" : "muted"}>
                        {swatchCount} variant{swatchCount === 1 ? "" : "s"}
                      </Badge>
                    </div>
                  </div>

                  {overCap(row) && (
                    <p className="flex items-center gap-1.5 text-xs text-danger">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Printify allows at most {MAX_VARIANTS} variants per product. Drop a colour or
                      a size.
                    </p>
                  )}

                  {colourNames.length === 0 ? (
                    catalog.variantsLoading ? (
                      <div
                        role="status"
                        data-variants-loading=""
                        className="flex flex-wrap gap-1.5"
                        aria-label="Loading colours"
                      >
                        {Array.from({ length: 24 }).map((_, i) => (
                          <div
                            key={i}
                            className="h-7 w-7 animate-pulse rounded-full bg-surface-muted"
                          />
                        ))}
                        <span className="w-full text-xs text-ink-muted">
                          Loading colours…
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-ink-muted">
                        Choose a print provider to load its colours.
                      </p>
                    )
                  ) : (
                    <div
                      className={cn(
                        "flex flex-wrap gap-1.5",
                        catalog.variantsLoading && "pointer-events-none opacity-50",
                      )}
                    >
                      {catalog.variantsLoading && (
                        <span
                          role="status"
                          className="w-full text-xs text-ink-muted"
                        >
                          Loading colours for this provider…
                        </span>
                      )}
                      {colourNames.map((name) => {
                        const selected = state?.colors.includes(name) ?? false;
                        const hex = hexFor(name);
                        const approx = isApprox ? isApprox(name) : false;
                        const isBlack = state?.blackInkColors.includes(name) ?? false;
                        const isWhite = state?.whiteInkColors.includes(name) ?? false;
                        return (
                          <div key={name} data-row={row} className="relative">
                            {/* The same handler for every swatch: the colour is
                                read from `data-colour`, so the props stay
                                stable and only the swatch that changed
                                re-renders. Right-click sets a custom hex. */}
                            <ColorSwatch
                              name={name}
                              hex={hex}
                              selected={selected}
                              approximate={approx}
                              showInk={row === "ink" && selected}
                              ink={
                                row === "ink"
                                  ? isBlack
                                    ? ("black" as const)
                                    : isWhite
                                      ? ("white" as const)
                                      : ("ambiguous" as const)
                                  : undefined
                              }
                              onClick={handleSwatchClick}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setEditingHex({ name, value: hex });
                              }}
                              className="h-7 w-7"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {row === "ink" && (state?.colors.length ?? 0) > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <p className="text-xs text-ink-muted">
                          Switch each colour between <strong>Black ink</strong> and{" "}
                          <strong>White ink</strong>. A colour prints with the ink you mark and with
                          nothing else — an unmarked colour is not printed by either design.
                        </p>
                        <p className="text-xs font-medium text-ink">
                          Black ink: {blackInkList.length} colour
                          {blackInkList.length === 1 ? "" : "s"}
                          {blackInkList.length > 0 ? ` (${joinShort(blackInkList)})` : ""} · White
                          ink: {whiteInkList.length} colour{whiteInkList.length === 1 ? "" : "s"}
                          {whiteInkList.length > 0 ? ` (${joinShort(whiteInkList)})` : ""}
                        </p>
                        {/* The per-colour controls live in "Where each colour
                            prints" below, so there is ONE control per colour -
                            two would let the same label address two buttons. */}
                        {problems.length > 0 && (
                          <div className="space-y-1">
                            {invisible.length > 0 && (
                              <p className="text-xs font-medium text-danger">
                                {invisible.length} colour{invisible.length === 1 ? "" : "s"} would be
                                invisible with the ink you chose.
                              </p>
                            )}
                            {problems.map((p) => (
                              <p
                                key={p.name}
                                className={cn(
                                  "flex items-start gap-1.5 text-xs",
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
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* --- where each colour prints ----------------------------------- */}
          {inkColors.length > 0 && (
            <Card data-ink-routing="">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">Where each colour prints</h2>
                    <p className="text-xs text-ink-muted">
                      One row per ink colour. The arrow names the design that will print it, so a
                      misroute is visible before you create anything.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateRow("ink", { blackInkColors: [], whiteInkColors: [] })}
                  >
                    Clear all ink marks
                  </Button>
                </div>
                <ul className="divide-y divide-border-subtle">
                  {inkColors.map((name) => {
                    const isBlack = blackInkColors.includes(name);
                    const isWhite = whiteInkColors.includes(name) && !isBlack;
                    const undecided = !isBlack && !isWhite;
                    const names = isBlack ? inkRoutes.black : isWhite ? inkRoutes.white : [];
                    return (
                      <li
                        key={name}
                        data-ink-route={name}
                        data-ink-route-to={undecided ? "none" : isBlack ? "black" : "white"}
                        className={cn(
                          "flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5",
                          undecided && "-mx-2 rounded-md bg-warning-soft px-2",
                        )}
                      >
                        <span className="flex min-w-[130px] flex-1 items-center gap-2">
                          <ColorSwatch name={name} hex={hexFor(name)} approximate={isApprox ? isApprox(name) : false} className="h-5 w-5" />
                          <span className="truncate text-sm text-ink">{name}</span>
                          {onSetHex && (
                            <input
                              type="color"
                              aria-label={`Set hex for ${name}`}
                              value={hexFor(name).startsWith("#") && hexFor(name).length === 7 ? hexFor(name) : "#000000"}
                              onChange={(e) => void onSetHex(name, e.target.value)}
                              className="h-6 w-8 shrink-0 cursor-pointer"
                            />
                          )}
                        </span>
                        <span className="flex items-center">
                          <Button
                            size="sm"
                            variant={isBlack ? "default" : "outline"}
                            aria-pressed={isBlack}
                            aria-label={`${name}: print with black ink`}
                            onClick={() => setInk(name, "black")}
                            className="h-7 rounded-l-md px-2.5 text-xs"
                          >
                            Black ink
                          </Button>
                          <Button
                            size="sm"
                            variant={isWhite ? "default" : "outline"}
                            aria-pressed={isWhite}
                            aria-label={`${name}: print with white ink`}
                            onClick={() => setInk(name, "white")}
                            className="-ml-px h-7 rounded-r-md px-2.5 text-xs"
                          >
                            White ink
                          </Button>
                        </span>
                        <span
                          className={cn(
                            "min-w-[190px] flex-1 text-xs",
                            undecided ? "text-warning" : "text-forest",
                          )}
                        >
                          {undecided ? (
                            <>
                              <span aria-hidden="true">! </span>
                              No design yet — pick an ink
                            </>
                          ) : names.length > 0 ? (
                            <>
                              <span aria-hidden="true">→ </span>
                              {isBlack ? "Black-ink design" : "White-ink design"} ·{" "}
                              {joinShort(names)}
                            </>
                          ) : (
                            <>
                              <span aria-hidden="true">→ </span>
                              {isBlack ? "Black-ink design" : "White-ink design"} — no design with
                              that ink artwork yet
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* --- the live split readout ------------------------------------- */}
          <Card>
            <CardContent className="space-y-1.5 p-4">
              <h2 className="text-sm font-semibold text-ink">The split, at a glance</h2>
              <p className="text-xs text-ink-muted">
                No ink variants row →{" "}
                <strong>
                  {plainColors.length} colour{plainColors.length === 1 ? "" : "s"}
                </strong>
                {plainColors.length > 0 ? ` (${joinShort(plainColors)})` : " — pick colours in its panel"}
                . Has ink variants row →{" "}
                <strong>
                  {inkColors.length} colour{inkColors.length === 1 ? "" : "s"}
                </strong>
                {inkColors.length > 0 ? ` (${joinShort(inkColors)})` : " — pick colours in its panel"}
                , of which {blackInkList.length} use black ink and {whiteInkList.length} use white
                ink.{undecidedInkList.length > 0 ? `, ${undecidedInkList.length} still to decide` : ""}
              </p>
              {undecidedInkList.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {undecidedInkList.length} colour
                    {undecidedInkList.length === 1 ? "" : "s"} undecided ({joinShort(undecidedInkList)}). Undecided colours print nothing and block Create.
                  </span>
                </p>
              )}
              {inkColors.length > 0 && blackInkList.length === inkColors.length && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Every ink colour is on black ink, so the white-ink design would print on
                    nothing. Switch at least one colour to White ink.
                  </span>
                </p>
              )}
              {inkColors.length > 0 && whiteInkList.length === inkColors.length && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Every ink colour is on white ink, so the black-ink design would print on
                    nothing. Switch at least one colour to Black ink.
                  </span>
                </p>
              )}
              {plainColors.length > 0 && inkColors.length > 0 && (
                <p className="text-xs text-ink-muted">
                  Colours in both panels: {plainColors.filter((c) => inkColors.includes(c)).length}
                  {(() => {
                    const both = plainColors.filter((c) => inkColors.includes(c));
                    return both.length > 0 ? ` (${joinShort(both)})` : "";
                  })()}
                  . That is fine — each row prints it with its own artwork.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-card">
            <p className="text-xs text-ink-muted">
              {catalog.colourLoading && !catalog.colourSource
                ? "Reading this product type's exact colours — the first time can take a few seconds."
                : catalog.colourSource?.source === "product" && !catalog.colourSource?.approximate
                  ? "Colours use the real hexes from your Printify product."
                  : allSelectedExact
                    ? "Colours use exact hexes from the built-in colour seed."
                    : approxNames.length > 0 && selectedNames.length > 0
                      ? `${approxNames.length} of ${selectedNames.length} colours are approximate — right-click a swatch to set the exact hex.`
                      : "Approximate colours — right-click a swatch to set the exact hex."}
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
