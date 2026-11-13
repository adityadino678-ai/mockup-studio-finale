"use client";

import * as React from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { HowItWorks } from "@/components/ui/how-it-works";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { DesignsTab } from "@/views/studio/designs-tab";
import { ColorsTab } from "@/views/studio/colors-tab";
import { PlacementTab } from "@/views/studio/placement-tab";
import {
  fetchBlueprints,
  fetchColourSource,
  fetchProviders,
  fetchVariants,
  loadCachedColourSource,
  loadColourOverrides,
  loadLearnedColours,
  saveColourOverride,
  type ColourSource,
} from "@/lib/printify/catalog-client";
import { emptySession, loadSession, saveSession, ROWS } from "@/lib/printify/studio-session";
import { primaryHex, resolveColour } from "@/lib/printify/colors";
import type { CatalogBlueprint, CatalogProvider, CatalogVariant } from "@/lib/printify/types";
import type { StudioRowId, StudioSession } from "@/types/domain";
import { Cloud, Layers, Palette, Wand2 } from "lucide-react";

type StudioTab = "designs" | "colors" | "panel";

export interface StudioCatalogState {
  configured: boolean;
  loading: boolean;
  /** True while the provider list for the chosen product is loading. */
  providersLoading: boolean;
  /** True while the colour/size list for the chosen provider is loading. The
   * previous list stays on screen (dimmed) until the new one arrives. */
  variantsLoading: boolean;
  error?: string;
  blueprints: CatalogBlueprint[];
  providers: CatalogProvider[];
  variants: CatalogVariant[];
  colourSource: ColourSource | null;
  colourError?: string;
  colourLoading?: boolean;
}

/**
 * The Printify Studio: upload designs, pick the product and its colours, and
 * place the artwork - then create one Printify product per design.
 *
 * The session (product, colours, sizes, placement) is stored in IndexedDB, so
 * switching tabs or reloading keeps your work.
 *
 * The listing work has its own pages now - Listing images, Listing details
 * and Listing preview. They read and write the SAME session blob, so a batch
 * ticked here is exactly what those pages configure, and a placement changed
 * here is what their renders use.
 */
export function PrintifyStudioPage() {
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());
  const [loaded, setLoaded] = React.useState(false);
  /**
   * Fields this tab has edited since the last save.
   *
   * The session is one blob written by the Studio, the Mockups panel and the
   * agent. Saving the whole local copy after a Mockups placement edit would
   * silently put the old placement back. This set lets the save merge the
   * latest stored session: local keys win only when this tab actually changed
   * them, everything else comes from storage.
   */
  const dirtyKeys = React.useRef<Set<keyof StudioSession>>(new Set());
  /** The latest local session, for an async save that started earlier. */
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const [tab, setTab] = React.useState<StudioTab>("designs");
  const [catalog, setCatalog] = React.useState<StudioCatalogState>({
    configured: true,
    loading: false,
    providersLoading: false,
    variantsLoading: false,
    blueprints: [],
    providers: [],
    variants: [],
    colourSource: null,
  });
  const [learned, setLearned] = React.useState<Record<string, string>>({});
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});
  const [colourRetryTick, setColourRetryTick] = React.useState(0);

  // Learned dictionary + user overrides paint in the same frame as variants.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [l, o] = await Promise.all([loadLearnedColours(), loadColourOverrides()]);
      if (!cancelled) {
        setLearned(l);
        setOverrides(o);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setColourHex = React.useCallback(async (name: string, hex: string) => {
    await saveColourOverride(name, hex);
    setOverrides((prev) => ({ ...prev, [name.trim().toLowerCase()]: hex }));
  }, []);

  // --- session ---------------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadSession();
      if (!cancelled) {
        setSession(stored);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void (async () => {
        // Snapshot before the await: a key edited while the load is in
        // flight must stay dirty for the next save.
        const saving = new Set(dirtyKeys.current);
        if (saving.size === 0) return;
        try {
          const latest = await loadSession();
          const merged: StudioSession = { ...latest };
          for (const key of Object.keys(session) as Array<keyof StudioSession>) {
            if (saving.has(key)) {
              (merged as unknown as Record<string, unknown>)[key] = session[key];
            }
          }
          merged.updatedAt = Date.now();
          await saveSession(merged);
          // Only clear the keys whose local value this save actually wrote.
          // A newer edit (e.g. a placement changed while this was loading)
          // keeps its key dirty and is saved by the next effect.
          const current = sessionRef.current;
          for (const key of saving) {
            if (Object.is(current[key], session[key])) dirtyKeys.current.delete(key);
          }
        } catch {
          toast.error("Could not save the studio session");
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [session, loaded]);

  const markDirty = React.useCallback((keys: Array<keyof StudioSession>) => {
    for (const key of keys) dirtyKeys.current.add(key);
  }, []);

  const update = React.useCallback((patch: Partial<StudioSession>) => {
    markDirty(Object.keys(patch) as Array<keyof StudioSession>);
    setSession((prev) => ({ ...prev, ...patch, updatedAt: Date.now() }));
  }, [markDirty]);

  /**
   * Patches one row of the session. `patch` can be a partial row object or an
   * updater function `(prev) => partial` - the latter avoids stale-state bugs
   * when multiple taps fire before React re-renders (e.g. rapid ink-chip
   * clicks in the Colors tab).
   */
  const updateRow = React.useCallback(
    (
      row: StudioRowId,
      patch:
        | Partial<StudioSession["rows"][StudioRowId]>
        | ((prev: StudioSession) => Partial<StudioSession["rows"][StudioRowId]>),
    ) => {
      markDirty(["rows"]);
      setSession((prev) => {
        const resolved =
          typeof patch === "function"
            ? (patch as (prev: StudioSession) => Partial<StudioSession["rows"][StudioRowId]>)(prev)
            : patch;
        return {
          ...prev,
          rows: { ...prev.rows, [row]: { ...prev.rows[row], ...resolved } },
          updatedAt: Date.now(),
        };
      });
    },
    [markDirty],
  );

  // --- catalogue -------------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setCatalog((c) => ({ ...c, loading: true, error: undefined }));
      try {
        const blueprints = await fetchBlueprints();
        if (!cancelled) {
          setCatalog((c) => ({ ...c, blueprints, loading: false, configured: true }));
        }
      } catch (e) {
        if (!cancelled) {
          setCatalog((c) => ({
            ...c,
            loading: false,
            configured: false,
            error: e instanceof Error ? e.message : "Could not reach Printify",
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const blueprintId = session.blueprintId;
    if (!blueprintId) {
      setCatalog((c) => ({
        ...c,
        providers: [],
        providersLoading: false,
        variants: [],
        variantsLoading: false,
        colourSource: null,
      }));
      return;
    }
    let cancelled = false;
    (async () => {
      // Clear the previous product's providers at once: the old list belongs
      // to another blueprint, and offering it lets the user pick a provider
      // that does not serve this product.
      setCatalog((c) => ({ ...c, providers: [], providersLoading: true }));
      try {
        const providers = await fetchProviders(blueprintId);
        if (!cancelled) setCatalog((c) => ({ ...c, providers, providersLoading: false }));
      } catch (e) {
        if (!cancelled) {
          setCatalog((c) => ({
            ...c,
            providersLoading: false,
            error: e instanceof Error ? e.message : "Could not load providers",
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.blueprintId]);

  React.useEffect(() => {
    const blueprintId = session.blueprintId;
    const printProviderId = session.printProviderId;
    if (!blueprintId || !printProviderId) {
      setCatalog((c) => ({ ...c, variants: [], variantsLoading: false, colourSource: null }));
      return;
    }
    let cancelled = false;
    (async () => {
      // Keep the previous provider's palette on screen (dimmed) until the new
      // one arrives instead of blanking it, and do NOT wait for the colour
      // hexes: those come from a different, much slower lookup (shops + product
      // list + product detail) and only affect the swatch shades, not which
      // colours exist. The palette renders from the variants as soon as they
      // land; the real hexes swap in in the background.
      setCatalog((c) => ({ ...c, variantsLoading: true, colourSource: null, colourError: undefined }));
      // Instant paint: stale cached hexes + learned/fallback swatches in one frame.
      const stale = await loadCachedColourSource(blueprintId, printProviderId);
      if (!cancelled && stale && stale.colors.length > 0) {
        setCatalog((c) => ({ ...c, colourSource: stale, colourLoading: true }));
      }
      let variants;
      try {
        variants = await fetchVariants(blueprintId, printProviderId);
      } catch (e) {
        if (!cancelled) {
          setCatalog((c) => ({
            ...c,
            variantsLoading: false,
            error: e instanceof Error ? e.message : "Could not load the product colours",
          }));
        }
        return;
      }
      if (cancelled) return;
      setCatalog((c) => ({ ...c, variants, variantsLoading: false }));

      // Real hexes in the background (stale-while-revalidate). Never silent:
      // a failure surfaces an inline status with Retry and the swatches stay usable.
      setCatalog((c) => ({ ...c, colourLoading: true }));
      try {
        const source = await fetchColourSource(blueprintId, printProviderId);
        if (!cancelled) {
          setCatalog((c) => ({ ...c, colourSource: source, colourLoading: false, colourError: undefined }));
          // A "no colours" answer is a FAILED lookup (the throwaway template
          // could not be provisioned, or the key cannot create products) -
          // never silence it: the palette would sit approximate with no
          // explanation and no retry.
          if (source.colors.length === 0) {
            setCatalog((c) => ({
              ...c,
              colourError:
                "Could not read this product type's exact colours — the palette is approximate. Retry, or right-click a swatch to set the exact hex.",
            }));
          }
          if (source.colors.length > 0) {
            const nextLearned = await loadLearnedColours();
            setLearned(nextLearned);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setCatalog((c) => ({
            ...c,
            colourLoading: false,
            colourError: e instanceof Error ? e.message : "Could not load exact colours",
          }));
        }
      }

        // A different print provider offers a different colour and size list.
        // A selection that names colours or sizes the new provider does not
        // have would silently resolve to nothing, so drop the stale entries
        // and say what was dropped.
        const colourNames = new Set<string>();
        const sizeNames = new Set<string>();
        for (const v of variants) {
          const colour = v.options?.color ?? v.title?.split(" / ")[0] ?? "";
          const size = v.options?.size ?? v.title?.split(" / ")[1] ?? "";
          if (colour) colourNames.add(colour);
          if (size) sizeNames.add(size);
        }
        dirtyKeys.current.add("rows");
        dirtyKeys.current.add("sizes");
        setSession((prev) => {
          const droppedColors: string[] = [];
          const droppedSizes: string[] = [];
          const rows = { ...prev.rows };
          for (const row of ROWS) {
            const state = rows[row];
            if (!state) continue;
            const kept = state.colors.filter((c) => colourNames.has(c));
            if (kept.length !== state.colors.length) {
              droppedColors.push(
                ...state.colors.filter((c) => !colourNames.has(c)).map((c) => `${c} (${row})`),
              );
            }
            rows[row] = {
              ...state,
              colors: kept,
              blackInkColors: state.blackInkColors.filter((c) => kept.includes(c)),
              whiteInkColors: (state.whiteInkColors ?? []).filter((c) => kept.includes(c)),
            };
          }
          const keptSizes = prev.sizes.filter((s) => sizeNames.has(s));
          droppedSizes.push(...prev.sizes.filter((s) => !sizeNames.has(s)));
          if (droppedColors.length === 0 && droppedSizes.length === 0) return prev;
          window.setTimeout(() => {
            toast.warning(
              `This print provider does not offer ${[
                droppedColors.length ? droppedColors.join(", ") : "",
                droppedSizes.length ? `sizes: ${droppedSizes.join(", ")}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}. They were removed from the selection.`,
            );
          }, 0);
          return {
            ...prev,
            rows,
            sizes: keptSizes,
            updatedAt: Date.now(),
          };
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [session.blueprintId, session.printProviderId, colourRetryTick]);

  // --- the colours a row resolves to -----------------------------------------
  const realHexes = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const value of catalog.colourSource?.colors ?? []) {
      map.set(value.title, value.colors ?? []);
    }
    return map;
  }, [catalog.colourSource]);

  const resolvedFor = React.useCallback(
    (name: string) => {
      const exactArr = realHexes.get(name);
      const exact = exactArr?.[0];
      if (exact) {
        const r = resolveColour(name, { overrides: overrides as Record<string, string>, learned, exactHexes: new Map([[name, exactArr as string[]]]) });
        if (r.source === "override" || r.source === "learned") return r;
        return { hex: primaryHex(exactArr), approximate: catalog.colourSource?.approximate === true, source: "exact" as const };
      }
      return resolveColour(name, { overrides, learned });
    },
    [realHexes, learned, overrides, catalog.colourSource?.approximate],
  );

  const hexFor = React.useCallback((name: string) => resolvedFor(name).hex, [resolvedFor]);
  const isApprox = React.useCallback((name: string) => resolvedFor(name).approximate, [resolvedFor]);

  const swatchesForRow = React.useCallback(
    (row: StudioRowId) =>
      (session.rows[row]?.colors ?? []).map((name) => {
        const hex = hexFor(name);
        if (row === "plain") return { name, hex };
        const ink = session.rows.ink?.blackInkColors?.includes(name)
          ? ("black" as const)
          : session.rows.ink?.whiteInkColors?.includes(name)
            ? ("white" as const)
            : ("ambiguous" as const);
        return { name, hex, ink };
      }),
    [session.rows, hexFor],
  );

  const selectedBlueprint = React.useMemo(
    () => catalog.blueprints.find((b) => b.id === session.blueprintId),
    [catalog.blueprints, session.blueprintId],
  );

  return (
    <div className="mx-auto max-w-6xl p-5 sm:p-8">
      <PageHeader
        title="Printify Studio"
        description="Upload designs, pick a product, create listings."
        actions={
          catalog.configured ? (
            <>
              <HowItWorks
                title="Printify Studio"
                steps={[
                  "Upload designs in the Designs tab.",
                  "Pick a product and colours in the Colors tab.",
                  "Place the artwork in the Design panel.",
                  "Create one Printify product per design. Send creates an unpublished draft.",
                ]}
              />
              <Button size="sm" variant="outline" onClick={() => setTab("colors")}>
                <Cloud className="h-3.5 w-3.5" />
                {selectedBlueprint ? selectedBlueprint.title : "Choose a product"}
              </Button>
            </>
          ) : (
            <span className="text-xs text-ink-muted">Printify is not connected</span>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as StudioTab)}>
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="designs">
            <Wand2 className="h-3.5 w-3.5" /> Designs
          </TabsTrigger>
          <TabsTrigger value="colors">
            <Palette className="h-3.5 w-3.5" /> Colors
          </TabsTrigger>
          <TabsTrigger value="panel">
            <Layers className="h-3.5 w-3.5" /> Design panel
          </TabsTrigger>
        </TabsList>

        <TabsContent value="designs">
          <DesignsTab session={session} update={update} swatchesForRow={swatchesForRow} />
        </TabsContent>

        <TabsContent value="colors">
          <ColorsTab
            session={session}
            update={update}
            updateRow={updateRow}
            catalog={catalog}
            hexFor={hexFor}
            realHexes={realHexes}
            isApprox={isApprox}
            onSetHex={setColourHex}
            onRetry={() => setColourRetryTick((n) => n + 1)}
            onGoToPanel={() => setTab("panel")}
          />
        </TabsContent>

        <TabsContent value="panel">
          <PlacementTab
            session={session}
            update={update}
            catalog={catalog}
            hexFor={hexFor}
            onGoToColors={() => setTab("colors")}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
