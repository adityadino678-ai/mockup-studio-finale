"use client";

// ---------------------------------------------------------------------------
// The catalogue slice the listing views need.
//
// The Studio page loads providers and variants too, but those drive the
// colour and placement UI, which stays in the Studio. The listing views only
// ever read the blueprint list (`catalogProductName(catalog.blueprints, ...)`
// for the `{product}` expansion and the drafts' product name), so this loader
// stops there. It calls the SAME cached `fetchBlueprints()` the Studio does,
// so both share one IndexedDB cache and one edge cache.
// ---------------------------------------------------------------------------

import * as React from "react";
import { fetchBlueprints } from "@/lib/printify/catalog-client";
import type { CatalogBlueprint } from "@/lib/printify/types";

export interface ListingCatalogState {
  configured: boolean;
  loading: boolean;
  error?: string;
  blueprints: CatalogBlueprint[];
}

/** Loads the blueprint catalogue once per mount, from cache when it is fresh. */
export function useListingCatalog(): ListingCatalogState {
  const [catalog, setCatalog] = React.useState<ListingCatalogState>({
    configured: true,
    loading: false,
    blueprints: [],
  });

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

  return catalog;
}
