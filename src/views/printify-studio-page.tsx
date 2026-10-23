"use client";

import * as React from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { DesignsTab } from "@/views/studio/designs-tab";
import { ColorsTab } from "@/views/studio/colors-tab";
import { PlacementTab } from "@/views/studio/placement-tab";
import { ListingImagesTab } from "@/views/studio/listing-images-tab";
import { ListingDetailsTab } from "@/views/studio/listing-details-tab";
import {
  fetchBlueprints,
  fetchColourSource,
  fetchProviders,
  fetchVariants,
  type ColourSource,
} from "@/lib/printify/catalog-client";
import { emptySession, loadSession, saveSession, ROWS } from "@/lib/printify/studio-session";
import { hexForColourName, primaryHex, suggestInk } from "@/lib/printify/colors";
import type { CatalogBlueprint, CatalogProvider, CatalogVariant } from "@/lib/printify/types";
import type { StudioRowId, StudioSession } from "@/types/domain";
import { Cloud, FileText, Images, Layers, Palette, Wand2 } from "lucide-react";

type StudioTab = "designs" | "colors" | "panel" | "images" | "details";

export interface StudioCatalogState {
  configured: boolean;
  loading: boolean;
  error?: string;
  blueprints: CatalogBlueprint[];
  providers: CatalogProvider[];
  variants: CatalogVariant[];
  colourSource: ColourSource | null;
}

/**
 * The Printify Studio: upload designs, pick the product and its colours, and
 * place the artwork - then create the listings.
 *
 * The session (product, colours, sizes, placement) is stored in IndexedDB, so
 * switching tabs or reloading keeps your work.
 */
export function PrintifyStudioPage() {
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());
  const [loaded, setLoaded] = React.useState(false);
  const [tab, setTab] = React.useState<StudioTab>("designs");
  const [catalog, setCatalog] = React.useState<StudioCatalogState>({
    configured: true,
    loading: false,
    blueprints: [],
    providers: [],
    variants: [],
    colourSource: null,
  });

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
      void saveSession(session).catch(() => toast.error("Could not save the studio session"));
    }, 400);
    return () => clearTimeout(timer);
  }, [session, loaded]);

  const update = React.useCallback((patch: Partial<StudioSession>) => {
    setSession((prev) => ({ ...prev, ...patch, updatedAt: Date.now() }));
  }, []);

  const updateRow = React.useCallback((row: StudioRowId, patch: Partial<StudioSession["rows"][StudioRowId]>) => {
    setSession((prev) => ({
      ...prev,
      rows: { ...prev.rows, [row]: { ...prev.rows[row], ...patch } },
      updatedAt: Date.now(),
    }));
  }, []);

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
      setCatalog((c) => ({ ...c, providers: [], variants: [], colourSource: null }));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const providers = await fetchProviders(blueprintId);
        if (!cancelled) setCatalog((c) => ({ ...c, providers }));
      } catch (e) {
        if (!cancelled) {
          setCatalog((c) => ({ ...c, error: e instanceof Error ? e.message : "Could not load providers" }));
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
      setCatalog((c) => ({ ...c, variants: [], colourSource: null }));
      return;
    }
    let cancelled = false;
    (async () => {
      setCatalog((c) => ({ ...c, loading: true, variants: [], colourSource: null }));
      try {
        const [variants, colourSource] = await Promise.all([
          fetchVariants(blueprintId, printProviderId),
          fetchColourSource(blueprintId, printProviderId).catch(() => null),
        ]);
        if (cancelled) return;
        setCatalog((c) => ({ ...c, variants, colourSource, loading: false }));

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
      } catch (e) {
        if (!cancelled) {
          setCatalog((c) => ({
            ...c,
            loading: false,
            error: e instanceof Error ? e.message : "Could not load the product colours",
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.blueprintId, session.printProviderId]);

  // --- the colours a row resolves to -----------------------------------------
  const realHexes = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const value of catalog.colourSource?.colors ?? []) {
      map.set(value.title, value.colors ?? []);
    }
    return map;
  }, [catalog.colourSource]);

  const hexFor = React.useCallback(
    (name: string) => primaryHex(realHexes.get(name), hexForColourName(name)),
    [realHexes],
  );

  const swatchesForRow = React.useCallback(
    (row: StudioRowId) =>
      (session.rows[row]?.colors ?? []).map((name) => {
        const hex = hexFor(name);
        if (row === "plain") return { name, hex };
        const ink = session.rows.ink?.blackInkColors?.includes(name)
          ? ("black" as const)
          : ("white" as const);
        return { name, hex, ink };
      }),
    [session.rows, hexFor],
  );

  const selectedBlueprint = React.useMemo(
    () => catalog.blueprints.find((b) => b.id === session.blueprintId),
    [catalog.blueprints, session.blueprintId],
  );

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Printify Studio"
        description="Upload designs, choose the product and its colours, place the artwork, and create the listings in one go. Everything stays on this device until you publish."
        actions={
          catalog.configured ? (
            <Button size="sm" variant="outline" onClick={() => setTab("colors")}>
              <Cloud className="h-3.5 w-3.5" />
              {selectedBlueprint ? selectedBlueprint.title : "Choose a product"}
            </Button>
          ) : (
            <span className="text-[12px] text-ink-muted">Printify is not connected</span>
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
          <TabsTrigger value="images">
            <Images className="h-3.5 w-3.5" /> Listing images
          </TabsTrigger>
          <TabsTrigger value="details">
            <FileText className="h-3.5 w-3.5" /> Listing details
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

        <TabsContent value="images" forceMount>
          <ListingImagesTab
            session={session}
            update={update}
            catalog={catalog}
            onGoToDesigns={() => setTab("designs")}
            onGoToPanel={() => setTab("panel")}
            onGoToDetails={() => setTab("details")}
          />
        </TabsContent>

        <TabsContent value="details" forceMount>
          <ListingDetailsTab
            session={session}
            update={update}
            catalog={catalog}
            loaded={loaded}
            onGoToDesigns={() => setTab("designs")}
            onGoToImages={() => setTab("images")}
            onGoToPanel={() => setTab("panel")}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The ink a colour would use if the user has not decided. */
export function defaultInkForColor(name: string, hex: string): "black" | "white" | "ambiguous" {
  return suggestInk(hex);
}
