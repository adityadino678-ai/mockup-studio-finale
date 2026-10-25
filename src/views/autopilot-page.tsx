"use client";

// ---------------------------------------------------------------------------
// The listing autopilot.
//
// The page is a REVIEW surface, not a "go" button. The only automatic part is
// research + drafting and, after a human approves, product creation + mockup
// upload. The bookmarklet step and the final publish are explicit human gates.
//
// Everything is read from IndexedDB, so a reload shows the same run and the
// task dock can resume it from any page.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
} from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  activeProviderConfig,
  integrationHeaders,
  loadIntegrations,
  saveIntegrations,
  type IntegrationConfig,
} from "@/lib/client/integrations";
import {
  approveAutopilotListing,
  cancelAutopilotRun,
  markAutopilotMockupsApplied,
  pauseAutopilotRun,
  publishAutopilotRun,
  resumeAutopilotRun,
  retryAutopilotBuild,
  retryAutopilotPublish,
  retryAutopilotResearch,
  startAutopilot,
  startAutopilotBuild,
  updateAutopilotCopy,
} from "@/lib/autopilot/runner";
import { autopilotStartProblems, suggestedPrice, withCurrentRenderState } from "@/lib/autopilot/plan";
import { db } from "@/lib/db/schema";
import {
  buildStudioListings,
  catalogProductName,
} from "@/lib/printify/listing-plan";
import { freshListingRenders } from "@/lib/printify/listing-drafts";
import {
  fetchVariants,
  loadCachedBlueprints,
} from "@/lib/printify/catalog-client";
import { buildStudioPlan, studioPlanProblems } from "@/lib/printify/studio-plan";
import {
  emptySession,
  listingMockupIds,
  loadSession,
} from "@/lib/printify/studio-session";
import type { CatalogBlueprint, CatalogVariant } from "@/lib/printify/types";
import type { AutopilotCopy, AutopilotListing, AutopilotRun } from "@/types/autopilot";
import type { Design, StudioSession } from "@/types/domain";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  FileSearch,
  Hammer,
  Images,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  X,
} from "lucide-react";

interface ShopOption {
  id: number;
  title: string;
  salesChannel: string;
  connected: boolean;
}

interface ImageReadiness {
  selected: number;
  fresh: number;
}

const STAGE_LABEL: Record<AutopilotRun["stage"], string> = {
  research: "Researching Etsy",
  "copy-review": "Copy & image review",
  build: "Building products",
  "mockup-review": "Bookmarklet step",
  "publish-review": "Final publish approval",
  publishing: "Publishing",
  done: "Done",
};

const LISTING_STATUS_LABEL: Record<AutopilotListing["status"], string> = {
  pending: "Waiting",
  researching: "Researching",
  drafted: "Drafted",
  creating: "Creating",
  created: "Product created",
  uploading: "Uploading mockups",
  uploaded: "Ready",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  skipped: "Skipped",
};

/** Accepts `24.99` or `24,99`, and refuses ambiguous input. */
function parsePrice(value: string): number | undefined {
  const normalised = value.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return undefined;
  const cents = Math.round(Number(normalised) * 100);
  return cents >= 100 ? cents : undefined;
}

function money(cents: number | undefined): string {
  if (cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function runStatusLabel(run: AutopilotRun): string {
  switch (run.status) {
    case "running":
      return "Working";
    case "needs-review":
      return "Needs review";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function runBadge(run: AutopilotRun): "default" | "warning" | "danger" | "muted" {
  if (run.status === "completed") return "default";
  if (run.status === "failed") return "danger";
  if (run.status === "needs-review" || run.status === "paused") return "warning";
  return "muted";
}

function listingBadge(status: AutopilotListing["status"]): "default" | "warning" | "danger" | "muted" {
  if (status === "published" || status === "uploaded") return "default";
  if (status === "failed") return "danger";
  if (status === "created" || status === "uploading") return "warning";
  return "muted";
}

function uniqueProblems(problems: string[]): string[] {
  return [...new Set(problems.filter(Boolean))];
}

export function AutopilotPage() {
  const designs = useLiveQuery(() => db.designs.orderBy("createdAt").toArray(), [], undefined);
  const mockups = useLiveQuery(() => db.mockups.orderBy("createdAt").toArray(), [], undefined);
  const runs = useLiveQuery(
    () => db.autopilotRuns.orderBy("updatedAt").reverse().limit(20).toArray(),
    [],
    undefined,
  );

  const [session, setSession] = React.useState<StudioSession | null>(null);
  const [config, setConfig] = React.useState<IntegrationConfig | null>(null);
  const [blueprints, setBlueprints] = React.useState<CatalogBlueprint[]>([]);
  const [variants, setVariants] = React.useState<CatalogVariant[] | null>(null);
  const [variantsError, setVariantsError] = React.useState<string | null>(null);
  const [shops, setShops] = React.useState<ShopOption[] | null>(null);
  const [shopsError, setShopsError] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [niche, setNiche] = React.useState("personalized gifts");
  const [price, setPrice] = React.useState("");
  const [productName, setProductName] = React.useState("custom product");
  const [starting, setStarting] = React.useState(false);
  const [runId, setRunId] = React.useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("run");
  });
  const [forceNew, setForceNew] = React.useState(false);
  const [plannedReadiness, setPlannedReadiness] = React.useState<
    Record<string, ImageReadiness> | null
  >(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loadedSession, loadedConfig, cachedBlueprints] = await Promise.all([
        loadSession(),
        loadIntegrations(),
        loadCachedBlueprints(),
      ]);
      if (cancelled) return;
      setSession(loadedSession);
      setConfig(loadedConfig);
      setBlueprints(cachedBlueprints ?? []);
      const name = catalogProductName(cachedBlueprints ?? [], loadedSession.blueprintId);
      setProductName(name);
      const suggested = suggestedPrice(loadedSession, loadedSession.designIds[0]);
      setPrice((current) => current || (suggested / 100).toFixed(2));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/printify/shops", {
          headers: integrationHeaders(config),
        });
        const data = (await response.json().catch(() => null)) as {
          shops?: ShopOption[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!response.ok) {
          setShops([]);
          setShopsError(data?.error ?? `Could not load Printify shops (HTTP ${response.status}).`);
          return;
        }
        setShops(Array.isArray(data?.shops) ? data.shops : []);
        setShopsError(null);
      } catch (error) {
        if (cancelled) return;
        setShops([]);
        setShopsError(error instanceof Error ? error.message : "Could not load Printify shops.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  React.useEffect(() => {
    if (!session?.blueprintId || !session.printProviderId) {
      setVariants([]);
      setVariantsError(null);
      return;
    }
    let cancelled = false;
    setVariants(null);
    setVariantsError(null);
    void (async () => {
      try {
        const loaded = await fetchVariants(session.blueprintId!, session.printProviderId!);
        if (!cancelled) setVariants(loaded);
      } catch (error) {
        if (!cancelled) {
          setVariants([]);
          setVariantsError(
            error instanceof Error ? error.message : "Could not load the Printify catalogue.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.blueprintId, session?.printProviderId]);

  const plan = React.useMemo(() => {
    if (!designs || !session || !variants) return null;
    return buildStudioPlan(designs, session, variants);
  }, [designs, session, variants]);

  const planProblems = React.useMemo(() => {
    if (!designs || !session || !plan) return [];
    return studioPlanProblems(plan, designs, session);
  }, [designs, session, plan]);

  const plannedListings = React.useMemo(() => {
    if (!designs || !session) return [];
    return buildStudioListings(designs, session);
  }, [designs, session]);

  const checkSession = React.useMemo(() => {
    if (!session || !mockups) return null;
    const everyMockup = mockups.map((mockup) => mockup.id);
    const listingImages = { ...(session.listingImages ?? {}) };
    for (const listing of plannedListings) {
      if (
        listingImages[listing.listingId] === undefined &&
        !session.listingImageCleared?.[listing.listingId]
      ) {
        listingImages[listing.listingId] = everyMockup;
      }
    }
    return { ...session, listingImages };
  }, [session, mockups, plannedListings]);

  React.useEffect(() => {
    if (!checkSession) {
      setPlannedReadiness(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, ImageReadiness> = {};
      for (const listing of plannedListings) {
        const selected = listingMockupIds(checkSession, listing.listingId).length;
        const fresh = await freshListingRenders(checkSession, listing);
        next[listing.listingId] = { selected, fresh: fresh.length };
      }
      if (!cancelled) setPlannedReadiness(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [checkSession, plannedListings]);

  const latestRun = runs?.[0];
  const selectedRun = runId ? runs?.find((run) => run.id === runId) : undefined;
  const run = selectedRun ?? (forceNew ? undefined : latestRun);

  const selectRun = (id: string | null) => {
    setRunId(id);
    setForceNew(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("run", id);
      else url.searchParams.delete("run");
      window.history.replaceState(null, "", url.toString());
    }
  };

  const priceCents = parsePrice(price) ?? 0;
  const localProblems: string[] = [];
  if (!query.trim()) {
    localProblems.push("Enter the Etsy search query the autopilot should research.");
  }
  if (!niche.trim()) {
    localProblems.push("Enter the niche the copy should speak to.");
  }
  if (!config) {
    localProblems.push("Reading the saved API connections…");
  }
  if (!config?.etsyKeystring?.trim()) {
    localProblems.push("Add an Etsy developer keystring in Settings -> API connections.");
  }
  if (shops === null) {
    localProblems.push("Reading the Printify shop list…");
  }
  if (variantsError) localProblems.push(variantsError);
  if (shopsError) localProblems.push(shopsError);
  if (shops && config?.printifyShopId) {
    const selectedShop = shops.find((shop) => shop.id === config.printifyShopId);
    if (!selectedShop) {
      localProblems.push("The saved Printify shop is not on this account. Choose another shop.");
    } else if (!selectedShop.connected) {
      localProblems.push(
        `"${selectedShop.title}" has no sales channel. Connect an Etsy channel in Printify -> My stores before publishing.`,
      );
    }
  }
  if (plannedReadiness) {
    for (const listing of plannedListings) {
      const readiness = plannedReadiness[listing.listingId];
      if (!readiness || readiness.selected === 0) {
        localProblems.push(
          `${listing.designName}: no mockups are selected. Open Listing images and include at least one.`,
        );
      } else if (readiness.fresh < readiness.selected) {
        localProblems.push(
          `${listing.designName}: ${readiness.fresh} of ${readiness.selected} selected images have a current render. Open Listing images and press Save & render.`,
        );
      }
    }
  }

  const startProblems = uniqueProblems([
    ...(session && designs
      ? autopilotStartProblems({
          designs,
          session,
          plan,
          planProblems,
          priceCents,
          hasEtsyKey: Boolean(config?.etsyKeystring?.trim()),
          shopId: config?.printifyShopId,
        })
      : ["Loading the Studio session…"]),
    ...localProblems,
  ]);
  const canStart =
    !starting &&
    Boolean(session && designs && plan && config?.printifyShopId && priceCents >= 100) &&
    startProblems.length === 0;

  const onStart = async () => {
    if (!session || !plan || !config?.printifyShopId) return;
    const cents = parsePrice(price);
    if (!cents) {
      toast.error("Enter a deliberate price of at least 1.00.");
      return;
    }
    if (startProblems.length > 0) {
      toast.error(startProblems[0]);
      return;
    }
    setStarting(true);
    try {
      const created = await startAutopilot({
        query: query.trim(),
        niche: niche.trim(),
        productName: productName.trim() || "custom product",
        priceCents: cents,
        shopId: config.printifyShopId,
        session,
        plan,
      });
      selectRun(created.id);
      toast.success("Autopilot started. Etsy research is running in the background.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the autopilot.");
    } finally {
      setStarting(false);
    }
  };

  const updateShop = async (shopId: number) => {
    if (!config) return;
    const next = { ...config, printifyShopId: shopId };
    setConfig(next);
    await saveIntegrations(next);
    toast.success("Printify shop saved for creation, Send and Publish.");
  };

  const showStartForm = !run || forceNew;

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Listing autopilot"
        description="Research Etsy, draft complete listings, build the products and pause for every human decision. It never publishes without your final approval."
        actions={
          run ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setForceNew(true);
                selectRun(null);
              }}
            >
              <Sparkles className="h-4 w-4" /> New run
            </Button>
          ) : undefined
        }
      />

      {showStartForm ? (
        <StartCard
          session={session}
          config={config}
          shops={shops}
          shopsError={shopsError}
          blueprints={blueprints}
          productName={productName}
          setProductName={setProductName}
          query={query}
          setQuery={setQuery}
          niche={niche}
          setNiche={setNiche}
          price={price}
          setPrice={setPrice}
          problems={startProblems}
          canStart={canStart}
          starting={starting}
          onStart={onStart}
          onShopChange={updateShop}
          recentRuns={runs ?? []}
          onOpenRun={selectRun}
        />
      ) : (
        <RunPanel
          run={run}
          designs={designs}
          session={session}
          onNew={() => {
            setForceNew(true);
            selectRun(null);
          }}
          onOpenRun={selectRun}
          recentRuns={runs ?? []}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

interface StartCardProps {
  session: StudioSession | null;
  config: IntegrationConfig | null;
  shops: ShopOption[] | null;
  shopsError: string | null;
  blueprints: CatalogBlueprint[];
  productName: string;
  setProductName: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  niche: string;
  setNiche: (value: string) => void;
  price: string;
  setPrice: (value: string) => void;
  problems: string[];
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  onShopChange: (shopId: number) => void;
  recentRuns: AutopilotRun[];
  onOpenRun: (id: string) => void;
}

function StartCard(props: StartCardProps) {
  const session = props.session ?? emptySession();
  const selectedShop = props.shops?.find((shop) => shop.id === props.config?.printifyShopId);
  const productLabel = catalogProductName(props.blueprints, session.blueprintId);
  const aiConfigured = Boolean(
    props.config ? activeProviderConfig(props.config).apiKey.trim() : false,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-forest" /> Start a run
          </CardTitle>
          <CardDescription>
            One shared Etsy query grounds every listing. The Studio batch, its colours and its
            placements are snapshotted when the run starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="autopilot-query">Etsy search query</Label>
              <Input
                id="autopilot-query"
                value={props.query}
                onChange={(event) => props.setQuery(event.target.value)}
                placeholder="personalized gift for her"
              />
              <p className="text-[11px] text-ink-subtle">
                This is a real read-only Etsy Open API v3 search. It never scrapes and never claims
                search volume or sales.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="autopilot-niche">Niche / buyer</Label>
              <Input
                id="autopilot-niche"
                value={props.niche}
                onChange={(event) => props.setNiche(event.target.value)}
                placeholder="personalized gifts"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="autopilot-price">Price for every listing</Label>
              <Input
                id="autopilot-price"
                value={props.price}
                onChange={(event) => props.setPrice(event.target.value)}
                inputMode="decimal"
                placeholder="24.99"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="autopilot-product">Product name for the copy</Label>
              <Input
                id="autopilot-product"
                value={props.productName}
                onChange={(event) => props.setProductName(event.target.value)}
                placeholder={productLabel}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="autopilot-shop">Printify shop</Label>
              {props.shops === null ? (
                <div className="flex h-9 items-center gap-2 rounded-md border border-border-subtle px-3 text-[13px] text-ink-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading shops…
                </div>
              ) : props.shops.length === 0 ? (
                <p className="text-[12px] text-warning">
                  No shops were returned.{" "}
                  <a className="underline" href="/settings">
                    Add a Printify key in Settings
                  </a>
                  .
                </p>
              ) : (
                <select
                  id="autopilot-shop"
                  className="h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-ink"
                  value={props.config?.printifyShopId ?? ""}
                  onChange={(event) => {
                    const id = Number(event.target.value);
                    if (Number.isFinite(id) && id > 0) void props.onShopChange(id);
                  }}
                >
                  <option value="">Choose a shop…</option>
                  {props.shops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.title}
                      {shop.connected ? " (Etsy connected)" : " (no Etsy channel)"}
                    </option>
                  ))}
                </select>
              )}
              {props.shopsError && <p className="text-[12px] text-danger">{props.shopsError}</p>}
              {selectedShop && !selectedShop.connected && (
                <p className="text-[12px] text-danger">
                  This shop has no Etsy sales channel. Publishing would fail with the original
                  8254. Connect it in{" "}
                  <a
                    className="underline"
                    href="https://printify.com/app/account/my-stores"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Printify → My stores
                  </a>
                  .
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div className="space-y-2 text-[12px] text-ink-muted">
            <CheckLine ok={Boolean(session.blueprintId)}>
              {session.blueprintId
                ? `Product: ${productLabel}`
                : "Choose a product in the Printify Studio."}
            </CheckLine>
            <CheckLine ok={session.designIds.length > 0}>
              {session.designIds.length > 0
                ? `${session.designIds.length} design(s) ticked in the Studio.`
                : "Tick at least one design in the Studio."}
            </CheckLine>
            <CheckLine ok={Boolean(props.config?.etsyKeystring?.trim())}>
              Etsy developer keystring is {props.config?.etsyKeystring?.trim() ? "saved." : "missing."}
            </CheckLine>
            <CheckLine ok={aiConfigured}>
              AI copy is {aiConfigured ? "configured." : "not configured; the Studio templates will be used."}
            </CheckLine>
            <CheckLine ok={Boolean(props.config?.printifyShopId)}>
              {props.config?.printifyShopId
                ? "Printify shop is selected."
                : "Choose a Printify shop."}
            </CheckLine>
          </div>

          {props.problems.length > 0 ? (
            <div className="rounded-md border border-warning/40 bg-warning-soft p-3">
              <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5" /> Fix these before starting
              </div>
              <ul className="list-disc space-y-1 pl-4 text-[12px] text-ink-muted">
                {props.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-md border border-forest/20 bg-sage-soft p-3 text-[12px] text-forest">
              Ready. The autopilot will research Etsy, draft each listing and pause for review.
            </div>
          )}

          <Button className="w-full" disabled={!props.canStart} onClick={props.onStart}>
            {props.starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {props.starting ? "Starting…" : "Research Etsy & draft listings"}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Images className="h-4 w-4 text-forest" /> Before you start
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-[12px] text-ink-muted">
            <p>
              The run snapshots the Listing images selection. Every selected mockup needs a current
              render, or the build will stop honestly and tell you which listing is missing one.
            </p>
            <a className="inline-flex items-center gap-1 text-forest underline" href="/listing-images">
              Open Listing images <ArrowRight className="h-3 w-3" />
            </a>
            <p>
              Placement comes from the Studio and Mockups tabs, so check the print area once before
              starting.
            </p>
          </CardContent>
        </Card>

        {props.recentRuns.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-[14px]">Recent runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {props.recentRuns.slice(0, 5).map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-2 text-left text-[12px] hover:bg-surface-muted"
                  onClick={() => props.onOpenRun(run.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{run.query}</span>
                    <span className="text-ink-subtle">
                      {run.listings.length} listing(s) · {new Date(run.updatedAt).toLocaleTimeString()}
                    </span>
                  </span>
                  <Badge variant={runBadge(run)}>{runStatusLabel(run)}</Badge>
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function CheckLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
      ) : (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      )}
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface RunPanelProps {
  run: AutopilotRun;
  designs: Design[] | undefined;
  session: StudioSession | null;
  onNew: () => void;
  onOpenRun: (id: string) => void;
  recentRuns: AutopilotRun[];
}

function RunPanel({ run, designs, session, onNew, onOpenRun, recentRuns }: RunPanelProps) {
  const [readiness, setReadiness] = React.useState<Record<string, ImageReadiness>>({});
  const [busy, setBusy] = React.useState(false);
  const [confirmingPublish, setConfirmingPublish] = React.useState(false);
  const [showLog, setShowLog] = React.useState(false);

  React.useEffect(() => {
    if (!designs || !session) return;
    let cancelled = false;
    void (async () => {
      // The run froze its mockup selection at start, but renders saved during
      // review live in the current session. Merge those in so the page does
      // not keep asking for a render that already exists.
      const buildSession = withCurrentRenderState(run.session, session);
      const studioListings = buildStudioListings(designs, buildSession);
      const next: Record<string, ImageReadiness> = {};
      for (const listing of run.listings) {
        const studioListing = studioListings.find((entry) => entry.listingId === listing.id);
        const selected = listingMockupIds(buildSession, listing.id).length;
        const fresh = studioListing
          ? (await freshListingRenders(buildSession, studioListing)).length
          : 0;
        next[listing.id] = { selected, fresh };
      }
      if (!cancelled) setReadiness(next);
    })();
    return () => {
      cancelled = true;
    };
    // `run.session` and `run.listings` are structured clones: their identity
    // changes on every live-query refresh (including each log line). The
    // readiness only needs to be recomputed for a different run, a different
    // design set, or a different listing count, so depend on those scalars.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designs, run.id, run.listings.length, session]);

  const approved = run.listings.filter((listing) => listing.reviewApprovedAt).length;
  const published = run.listings.filter((listing) => listing.status === "published").length;
  const failed = run.listings.filter((listing) => listing.status === "failed").length;
  const allApproved = run.listings.length > 0 && approved === run.listings.length;
  const allImagesReady =
    run.listings.length > 0 &&
    run.listings.every((listing) => {
      const entry = readiness[listing.id];
      return entry !== undefined && entry.selected > 0 && entry.fresh >= entry.selected;
    });
  const canEditCopy = run.stage === "copy-review";
  const active = run.status === "running";

  const act = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await work();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };

  const copyPayload = async () => {
    if (!run.bridgePayload) return;
    try {
      await navigator.clipboard.writeText(run.bridgePayload);
      toast.success("Payload copied. Run the bookmarklet on printify.com.");
    } catch {
      toast.error("The clipboard was blocked. Select the payload and copy it manually.");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-forest" /> {run.query}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={runBadge(run)}>{runStatusLabel(run)}</Badge>
              <Badge variant="outline">{STAGE_LABEL[run.stage]}</Badge>
            </div>
          </div>
          <CardDescription>
            {run.listings.length} listing(s) · {approved}/{run.listings.length} approved ·{" "}
            {published}/{run.listings.length} published
            {failed > 0 ? ` · ${failed} failed` : ""} · price {money(run.priceCents)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-forest transition-all"
              style={{
                width: `${run.listings.length ? (published / run.listings.length) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {active ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => act(() => pauseAutopilotRun(run.id), "Paused.")}
              >
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
            ) : run.status === "paused" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => act(() => resumeAutopilotRun(run.id), "Resumed.")}
              >
                <Play className="h-3.5 w-3.5" /> Resume
              </Button>
            ) : null}
            {run.status !== "completed" && run.status !== "cancelled" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Cancel this run? Created Printify products are not deleted.")) {
                    void act(() => cancelAutopilotRun(run.id), "Run cancelled.");
                  }
                }}
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            {run.status === "failed" && run.stage === "research" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => act(() => retryAutopilotResearch(run.id), "Research restarted.")}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry research
              </Button>
            )}
            {run.status === "failed" &&
              (run.stage === "build" ||
                run.stage === "mockup-review" ||
                (run.stage === "done" && failed > 0)) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act(() => retryAutopilotBuild(run.id), "Build retried.")}
                >
                  <Hammer className="h-3.5 w-3.5" /> Retry build
                </Button>
              )}
            {run.status === "failed" && run.stage === "publishing" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(
                    () => retryAutopilotPublish(run.id),
                    "Publish retried. Printify's answer is shown in the log.",
                  )
                }
              >
                <Rocket className="h-3.5 w-3.5" /> Retry publish
              </Button>
            )}
            {(run.status === "failed" || run.status === "completed" || run.status === "cancelled") && (
              <Button size="sm" variant="outline" onClick={onNew}>
                <Sparkles className="h-3.5 w-3.5" /> New run
              </Button>
            )}
          </div>
          {run.error && (
            <div className="rounded-md border border-danger/30 bg-danger-soft p-3 text-[12px] text-danger">
              {run.error}
            </div>
          )}
        </CardContent>
      </Card>

      {run.research && <ResearchCard run={run} />}

      {run.stage === "research" && run.status === "running" && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-[13px] text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-forest" />
            Searching Etsy active listings and drafting copy. Make sure you have a developer
            keystring in Settings.
          </CardContent>
        </Card>
      )}

      {run.stage === "copy-review" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSearch className="h-4 w-4 text-forest" /> Human review
            </CardTitle>
            <CardDescription>
              Read every title, description, tag set and image selection. Editing copy clears its
              approval. The build only starts after every listing is approved.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || allApproved || !allImagesReady}
              onClick={() =>
                act(async () => {
                  for (const listing of run.listings) {
                    if (!listing.reviewApprovedAt) {
                      await approveAutopilotListing(run.id, listing.id);
                    }
                  }
                }, "All listings approved.")
              }
            >
              <Check className="h-3.5 w-3.5" /> Approve all
            </Button>
            <Button
              size="sm"
              disabled={busy || !allApproved}
              onClick={() => act(() => startAutopilotBuild(run.id), "Building products…")}
            >
              <Hammer className="h-3.5 w-3.5" /> Build products & upload mockups
            </Button>
            {!allImagesReady && (
              <span className="text-[12px] text-warning">
                Every selected mockup needs a current render before the images can be approved.
              </span>
            )}
            {!allApproved && (
              <span className="text-[12px] text-ink-muted">
                {run.listings.length - approved} listing(s) still need approval.
              </span>
            )}
          </CardContent>
        </Card>
      )}

      {run.stage === "build" && run.status === "running" && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-[13px] text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-forest" />
            Creating the Printify products and uploading the selected renders. This can take a
            while; you can leave this page and the task dock will continue.
          </CardContent>
        </Card>
      )}

      {run.stage === "mockup-review" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCopy className="h-4 w-4 text-forest" /> One manual step: the bookmarklet
            </CardTitle>
            <CardDescription>
              The products and their images are uploaded. Printify only lets a printify.com tab
              select the product&rsquo;s mockups, so run the bookmarklet once per product, then
              confirm here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border border-border-subtle bg-surface-muted p-3 text-[12px] text-ink-muted">
              <ol className="list-decimal space-y-1 pl-4">
                <li>Copy the payload below.</li>
                <li>
                  Open each Printify product and click the Mockup Studio bookmarklet. It applies
                  the images using only your printify.com session.
                </li>
                <li>Come back and press “I ran the bookmarklet”.</li>
              </ol>
            </div>
            {run.bridgePayload ? (
              <>
                <Textarea
                  readOnly
                  className="h-24 font-mono text-[11px]"
                  value={run.bridgePayload}
                  aria-label="Autopilot bookmarklet payload"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={copyPayload}>
                    <ClipboardCopy className="h-3.5 w-3.5" /> Copy payload
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <a href="/printify-bookmarklet" target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" /> Install the bookmarklet
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || run.status === "paused"}
                    onClick={() =>
                      act(
                        () => markAutopilotMockupsApplied(run.id),
                        "Mockups confirmed. Final publish approval is next.",
                      )
                    }
                  >
                    <Check className="h-3.5 w-3.5" /> I ran the bookmarklet
                  </Button>
                </div>
                {run.status === "paused" && (
                  <p className="text-[12px] text-warning">
                    This run is paused. Resume it before confirming the bookmarklet step.
                  </p>
                )}
              </>
            ) : (
              <p className="text-[12px] text-warning">
                No payload was stored for this run. Retry the build to prepare it again.
              </p>
            )}
            {run.bridgeProducts && run.bridgeProducts.length > 0 && (
              <div className="space-y-1.5">
                {run.bridgeProducts.map((product) => (
                  <a
                    key={product.productId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-2 text-[12px] hover:bg-surface-muted"
                    href={`https://printify.com/app/products/${product.productId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="min-w-0 truncate text-ink">{product.productTitle}</span>
                    <span className="flex items-center gap-2 text-ink-subtle">
                      {product.uploadCount} image(s) <ExternalLink className="h-3 w-3" />
                    </span>
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {run.stage === "publishing" && run.status === "running" && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-[13px] text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-danger" />
            Publishing the approved listings to Printify. This is not retried automatically; a
            failure is shown verbatim so you can fix the shop or connection first.
          </CardContent>
        </Card>
      )}

      {run.stage === "publish-review" && (
        <Card className="border-danger/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-danger" /> Final publish approval
            </CardTitle>
            <CardDescription>
              This is the only step that publishes. The products become live on Printify. Nothing
              has been published yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {confirmingPublish ? (
              <div className="rounded-md border border-danger/40 bg-danger-soft p-3">
                <p className="text-[12px] text-danger">
                  Publish {run.listings.filter((listing) => listing.productId).length} listing(s)
                  now? Publishing is not retried automatically, because a second publish errors
                  upstream.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || run.status === "paused"}
                    onClick={() =>
                      act(() => publishAutopilotRun(run.id), "Publishing approved.")
                    }
                  >
                    <Rocket className="h-3.5 w-3.5" /> Yes, publish
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingPublish(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || run.status === "paused"}
                onClick={() => setConfirmingPublish(true)}
              >
                <Rocket className="h-3.5 w-3.5" /> Publish {run.listings.length} listing(s)…
              </Button>
            )}
            {run.status === "paused" && (
              <p className="text-[12px] text-warning">
                This run is paused. Resume it before giving the final publish approval.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {run.listings.map((listing) => (
          <ListingCard
            key={listing.id}
            run={run}
            listing={listing}
            readiness={readiness[listing.id]}
            editable={canEditCopy}
            busy={busy}
            act={act}
          />
        ))}
      </div>

      <Card>
        <CardHeader className="cursor-pointer" onClick={() => setShowLog((value) => !value)}>
          <CardTitle className="flex items-center justify-between text-[14px]">
            <span className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-forest" /> Activity log ({run.log.length})
            </span>
            <span className="text-[12px] text-ink-subtle">{showLog ? "Hide" : "Show"}</span>
          </CardTitle>
        </CardHeader>
        {showLog && (
          <CardContent>
            <div className="scroll-thin max-h-72 space-y-1.5 overflow-y-auto">
              {[...run.log].reverse().map((entry) => (
                <div key={entry.id} className="flex gap-2 text-[12px]">
                  <span className="w-16 shrink-0 text-ink-subtle">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                  <span
                    className={
                      entry.level === "error"
                        ? "text-danger"
                        : entry.level === "warn"
                          ? "text-warning"
                          : entry.level === "success"
                            ? "text-forest"
                            : "text-ink-muted"
                    }
                  >
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      {recentRuns.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[14px]">Other runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentRuns
              .filter((entry) => entry.id !== run.id)
              .slice(0, 5)
              .map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-2 text-left text-[12px] hover:bg-surface-muted"
                  onClick={() => onOpenRun(entry.id)}
                >
                  <span className="min-w-0 truncate text-ink">{entry.query}</span>
                  <Badge variant={runBadge(entry)}>{runStatusLabel(entry)}</Badge>
                </button>
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ResearchCard({ run }: { run: AutopilotRun }) {
  const research = run.research;
  if (!research) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <Search className="h-4 w-4 text-forest" /> Etsy research
        </CardTitle>
        <CardDescription>{research.disclaimer}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Active listings" value={research.activeListings.toLocaleString()} />
          <Metric label="Sampled" value={String(research.sampled)} />
          <Metric label="Median price" value={money(research.medianPriceCents)} />
          <Metric label="Currency" value={research.currency ?? "—"} />
        </div>
        {research.topTags.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
              Most repeated tags
            </div>
            <div className="flex flex-wrap gap-1">
              {research.topTags.slice(0, 10).map((tag) => (
                <Badge key={tag.term} variant="muted">
                  {tag.term} <span className="text-ink-subtle">×{tag.count}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
        {research.titleTerms.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
              Frequent title terms
            </div>
            <div className="flex flex-wrap gap-1">
              {research.titleTerms.slice(0, 10).map((term) => (
                <Badge key={term.term} variant="outline">
                  {term.term} <span className="text-ink-subtle">×{term.count}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-subtle">{label}</div>
      <div className="text-[14px] font-medium text-ink">{value}</div>
    </div>
  );
}

interface ListingCardProps {
  run: AutopilotRun;
  listing: AutopilotListing;
  readiness: ImageReadiness | undefined;
  editable: boolean;
  busy: boolean;
  act: (work: () => Promise<unknown>, success?: string) => Promise<void>;
}

function ListingCard({ run, listing, readiness, editable, busy, act }: ListingCardProps) {
  const imagesReady =
    readiness && readiness.selected > 0 && readiness.fresh >= readiness.selected;
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-[14px]">
            {listing.designName}
            {listing.partnerName ? (
              <span className="font-normal text-ink-muted"> + {listing.partnerName}</span>
            ) : null}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {listing.reviewApprovedAt && (
              <Badge variant="default">
                <Check className="h-3 w-3" /> Copy & images approved
              </Badge>
            )}
            <Badge variant={listingBadge(listing.status)}>
              {LISTING_STATUS_LABEL[listing.status]}
            </Badge>
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span>{run.priceCents ? money(listing.copy?.priceCents ?? run.priceCents) : "No price"}</span>
          {listing.productId && (
            <a
              className="inline-flex items-center gap-1 text-forest underline"
              href={`https://printify.com/app/products/${listing.productId}`}
              target="_blank"
              rel="noreferrer"
            >
              Product {listing.productId.slice(0, 8)}… <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {readiness && (
            <span className={imagesReady ? "text-forest" : "text-warning"}>
              {readiness.fresh}/{readiness.selected} selected image(s) rendered
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {listing.error && (
          <div className="rounded-md border border-danger/30 bg-danger-soft p-2.5 text-[12px] text-danger">
            {listing.error}
          </div>
        )}
        {readiness && !imagesReady && (
          <div className="rounded-md border border-warning/40 bg-warning-soft p-2.5 text-[12px] text-warning">
            This listing cannot be built until every selected mockup has a current render.{" "}
            <a className="underline" href="/listing-images">
              Open Listing images
            </a>{" "}
            and press Save & render. This run keeps the image selection it started with.
          </div>
        )}
        {listing.copy ? (
          <CopyEditor
            key={`${listing.id}:${listing.updatedAt}`}
            runId={run.id}
            listing={listing}
            editable={editable}
            busy={busy || !imagesReady}
            act={act}
          />
        ) : (
          <p className="text-[12px] text-ink-muted">Waiting for the Etsy-grounded copy…</p>
        )}
      </CardContent>
    </Card>
  );
}

interface CopyEditorProps {
  runId: string;
  listing: AutopilotListing;
  editable: boolean;
  busy: boolean;
  act: (work: () => Promise<unknown>, success?: string) => Promise<void>;
}

function CopyEditor({ runId, listing, editable, busy, act }: CopyEditorProps) {
  const copy = listing.copy as AutopilotCopy;
  const [title, setTitle] = React.useState(copy.title);
  const [description, setDescription] = React.useState(copy.description);
  const [tags, setTags] = React.useState(copy.tags.join(", "));
  const [price, setPrice] = React.useState((copy.priceCents / 100).toFixed(2));

  if (!editable) {
    return (
      <div className="space-y-2">
        <ReadOnly label="Title" value={copy.title} />
        <ReadOnly label="Description" value={copy.description} />
        <ReadOnly label="Tags" value={copy.tags.join(", ") || "—"} />
        {copy.disclaimer && (
          <p className="text-[11px] text-ink-subtle">{copy.disclaimer}</p>
        )}
      </div>
    );
  }

  const save = async (approve: boolean) => {
    const cents = parsePrice(price);
    if (!cents) {
      return Promise.reject(new Error("Enter a price of at least 1.00."));
    }
    await updateAutopilotCopy(runId, listing.id, {
      title,
      description,
      tags: tags.split(/[,\n]/),
      priceCents: cents,
      quantity: copy.quantity,
    });
    if (approve) await approveAutopilotListing(runId, listing.id);
  };

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <Label htmlFor={`title-${listing.id}`}>Title ({title.length}/140)</Label>
        <Input
          id={`title-${listing.id}`}
          value={title}
          maxLength={140}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`description-${listing.id}`}>Description</Label>
        <Textarea
          id={`description-${listing.id}`}
          value={description}
          className="min-h-[96px]"
          maxLength={5000}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]">
        <div className="space-y-1">
          <Label htmlFor={`tags-${listing.id}`}>Tags (13 max, 20 characters each)</Label>
          <Input
            id={`tags-${listing.id}`}
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="personalized gift, custom shirt"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`price-${listing.id}`}>Price</Label>
          <Input
            id={`price-${listing.id}`}
            value={price}
            inputMode="decimal"
            onChange={(event) => setPrice(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(() => save(false), "Copy saved.")}
        >
          Save draft
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => act(() => save(true), "Copy and images approved.")}
        >
          <Check className="h-3.5 w-3.5" /> Save & approve
        </Button>
        {listing.reviewApprovedAt && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => act(() => approveAutopilotListing(runId, listing.id), "Approved.")}
          >
            Approve without changes
          </Button>
        )}
        <span className="text-[11px] text-ink-subtle">
          Editing clears the approval until you save and approve again.
        </span>
      </div>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-subtle">{label}</div>
      <div className="whitespace-pre-wrap text-[12px] text-ink-muted">{value}</div>
    </div>
  );
}
