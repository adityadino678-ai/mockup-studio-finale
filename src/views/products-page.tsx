"use client";

import * as React from "react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { designMainAssetId, getAssetBlob, logActivity, uid } from "@/lib/db/repo";
import { authedFetch } from "@/lib/client/integrations";
import { artworkToBase64, MAX_ARTWORK_BYTES } from "@/lib/client/artwork";
import { Link } from "@/lib/client/nav";
import type { Design, ProductDraft } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import { Cloud, KeyRound, Package, Plus, RefreshCw, Send, Trash2, TriangleAlert } from "lucide-react";

interface Blueprint {
  id: number;
  title: string;
  brand: string;
  category?: string;
}
/** Blueprint detail carries identity only — variants need a print provider. */
interface BlueprintDetail extends Blueprint {
  description?: string;
}
interface Placeholder {
  position: string;
  decoration_method?: string;
  width?: number;
  height?: number;
}
interface Variant {
  id: number;
  title: string;
  options?: Record<string, string>;
  placeholders?: Placeholder[];
  available?: boolean;
}
interface PrintAreaOption {
  position: string;
  label: string;
  width?: number;
  height?: number;
}
interface CatalogState {
  configured: boolean;
  blueprints?: Blueprint[];
  blueprint?: BlueprintDetail;
  error?: string;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Printify rejects a product with more than this many enabled variants. */
const MAX_VARIANTS = 100;

export function ProductBuilderPage() {
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const drafts = useLiveQuery(() => db.productDrafts.orderBy("updatedAt").reverse().toArray(), []);

  const [catalog, setCatalog] = React.useState<CatalogState | null>(null);
  const [loadingCatalog, setLoadingCatalog] = React.useState(false);
  const [editing, setEditing] = React.useState<ProductDraft | null>(null);
  const [creating, setCreating] = React.useState(false);

  const loadCatalog = async () => {
    setLoadingCatalog(true);
    try {
      const res = await authedFetch("/api/printify/catalog");
      const data = await res.json();
      setCatalog(data);
      if (data.configured) {
        toast.success(`Loaded ${data.blueprints?.length ?? 0} blueprints from Printify`);
      }
    } catch (e) {
      setCatalog({ configured: false, error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setLoadingCatalog(false);
    }
  };

  React.useEffect(() => {
    void loadCatalog();
  }, []);

  const startDraft = (design: Design) => {
    const now = Date.now();
    setEditing({
      id: uid(),
      name: `${design.name} — product`,
      designId: design.id,
      designAssetId: designMainAssetId(design),
      variantSelection: {},
      printAreaConfig: {},
      status: "local-draft",
      createdAt: now,
      updatedAt: now,
    });
  };

  const saveDraft = async (draft: ProductDraft) => {
    await db.productDrafts.put({ ...draft, updatedAt: Date.now() });
    await logActivity("product.create", `Saved product draft "${draft.name}"`);
    toast.success("Product draft saved locally");
    setEditing(null);
    setCreating(false);
  };

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader
        title="Product Builder"
        description="Prepare products locally. Connect Printify to use the live catalog — nothing is published without your confirmation."
        actions={
          <Button size="sm" variant="outline" onClick={loadCatalog} disabled={loadingCatalog}>
            <RefreshCw className={`h-3.5 w-3.5 ${loadingCatalog ? "animate-spin" : ""}`} />
            Check Printify
          </Button>
        }
      />

      {/* Connection status */}
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sage-soft text-forest">
              <Cloud className="h-4 w-4" />
            </div>
            <div>
              <div className="text-[14px] font-medium text-ink">Printify</div>
              <div className="text-[12px] text-ink-muted">
                {!catalog
                  ? "Checking connection…"
                  : catalog.configured
                    ? `Connected — ${catalog.blueprints?.length ?? 0} blueprints available`
                    : "Not configured. Local drafts work without an account."}
              </div>
            </div>
          </div>
          <Badge variant={catalog?.configured ? "forest" : "outline"}>
            {catalog?.configured ? "connected" : "not configured"}
          </Badge>
        </CardContent>
        {catalog && !catalog.configured && (
          <>
            <Separator />
            <CardContent className="space-y-1.5 pt-4">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <KeyRound className="h-3.5 w-3.5" /> To enable the live catalog
              </p>
              <ol className="list-inside list-decimal space-y-1 text-[12px] leading-relaxed text-ink-muted">
                <li>
                  Create a free API key at{" "}
                  <span className="font-mono">developers.printify.com</span>.
                </li>
                <li>
                  Paste it under{" "}
                  <Link href="/settings" className="text-forest underline">
                    Settings → API connections
                  </Link>{" "}
                  (stored only in your browser), then press “Test connection”.
                </li>
                <li>
                  Or Add <code className="rounded bg-surface-muted px-1">PRINTIFY_API_KEY=…</code> to{" "}
                  <code className="rounded bg-surface-muted px-1">.env.local</code> on the server, then
                  press “Check Printify”.
                </li>
              </ol>
              {catalog.error && (
                <p className="text-[12px] text-ink-subtle">{catalog.error}</p>
              )}
            </CardContent>
          </>
        )}
        {catalog?.error && catalog.configured && (
          <>
            <Separator />
            <CardContent className="pt-4">
              <p className="flex items-center gap-1.5 text-[12px] text-danger">
                <TriangleAlert className="h-3.5 w-3.5" /> {catalog.error}
              </p>
            </CardContent>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* Designs → new draft */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-[14px]">Start from a design</CardTitle>
          </CardHeader>
          <CardContent>
            {!designs ? (
              <div className="h-16 animate-pulse rounded-md bg-surface-muted" />
            ) : designs.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-ink-muted">Upload designs first.</p>
            ) : (
              <div className="scroll-thin max-h-[320px] space-y-1 overflow-y-auto pr-1">
                {designs.map((d) => (
                  <div key={d.id} className="flex items-center gap-2.5 rounded-md p-1.5 hover:bg-surface-muted">
                    <AssetThumb assetId={designMainAssetId(d)} className="h-10 w-10 shrink-0 rounded-md" checkerboard />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
                    <Button variant="ghost" size="icon-sm" title="Create product draft" onClick={() => startDraft(d)}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Drafts */}
        <div>
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Product drafts</h2>
          {!drafts ? (
            <div className="h-24 animate-pulse rounded-lg bg-surface-muted" />
          ) : drafts.length === 0 ? (
            <EmptyState
              icon={<Package />}
              title="No product drafts"
              description="Product drafts are stored locally and track what you would send to Printify. They are never published automatically."
            />
          ) : (
            <div className="space-y-2">
              {drafts.map((d) => {
                const design = designs?.find((x) => x.id === d.designId);
                return (
                  <Card key={d.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      {design && <AssetThumb assetId={designMainAssetId(design)} className="h-11 w-11 rounded-md" checkerboard />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">{d.name}</span>
                          <Badge variant={d.status === "created-remote" ? "forest" : d.status === "publish-error" ? "danger" : "muted"}>
                            {d.status}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-ink-subtle">
                          {d.blueprintId ? `blueprint ${d.blueprintId}` : "no blueprint selected"} ·{" "}
                          {d.priceCents ? `$${(d.priceCents / 100).toFixed(2)} · ` : ""}
                          {Object.values(d.variantSelection).filter(Boolean).length} variants · updated{" "}
                          {formatDateTime(d.updatedAt)}
                        </div>
                        {d.remoteProductId && (
                          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-subtle">
                            <span className="font-mono">Printify {d.remoteProductId}</span>
                            <a
                              href={d.remotePermalink || "https://printify.com/app/products"}
                              target="_blank"
                              rel="noreferrer"
                              className="text-forest underline"
                            >
                              {d.remotePermalink ? "Open listing" : "View in Printify"}
                            </a>
                          </div>
                        )}
                        {d.error && <div className="text-[11px] text-danger">{d.error}</div>}
                      </div>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => setEditing(d)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await db.productDrafts.delete(d.id);
                            toast.success("Draft deleted");
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <DraftEditor
          draft={editing}
          catalogConfigured={!!catalog?.configured}
          onClose={() => setEditing(null)}
          onSave={saveDraft}
        />
      )}
      {creating && (
        <DraftEditor
          draft={{
            id: uid(),
            name: "New product draft",
            designId: designs?.[0]?.id ?? "",
            designAssetId: designs?.[0] ? designMainAssetId(designs[0]) : "",
            variantSelection: {},
            printAreaConfig: {},
            status: "local-draft",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }}
          catalogConfigured={!!catalog?.configured}
          onClose={() => setCreating(false)}
          onSave={saveDraft}
        />
      )}
    </div>
  );
}

function DraftEditor({
  draft,
  catalogConfigured,
  onClose,
  onSave,
}: {
  draft: ProductDraft;
  catalogConfigured: boolean;
  onClose: () => void;
  onSave: (d: ProductDraft) => Promise<void>;
}) {
  const [name, setName] = React.useState(draft.name);
  const [description, setDescription] = React.useState(draft.description ?? "");
  const [priceInput, setPriceInput] = React.useState(
    draft.priceCents ? String(draft.priceCents / 100) : "19.99",
  );
  const [blueprints, setBlueprints] = React.useState<Blueprint[]>([]);
  const [detail, setDetail] = React.useState<BlueprintDetail | null>(null);
  const [blueprintId, setBlueprintId] = React.useState<number | null>(draft.blueprintId ?? null);
  const [providers, setProviders] = React.useState<Array<{ id: number; title: string }>>([]);
  const [printProviderId, setPrintProviderId] = React.useState<number | null>(draft.printProviderId ?? null);
  const [variants, setVariants] = React.useState<Variant[]>([]);
  const [areas, setAreas] = React.useState<PrintAreaOption[]>([]);
  const [printArea, setPrintArea] = React.useState<string>("front");
  const [selectedVariants, setSelectedVariants] = React.useState<Record<number, boolean>>({});
  const [variantFilter, setVariantFilter] = React.useState("");
  const [sizeLabels, setSizeLabels] = React.useState<string[]>([]);
  const [colorLabels, setColorLabels] = React.useState<string[]>([]);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [loadingVariants, setLoadingVariants] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!catalogConfigured || blueprints.length > 0) return;
    (async () => {
      const res = await authedFetch("/api/printify/catalog");
      const data = await res.json();
      if (data.blueprints) setBlueprints(data.blueprints);
    })();
  }, [catalogConfigured, blueprints.length]);

  React.useEffect(() => {
    if (!blueprintId) {
      setDetail(null);
      setVariants([]);
      setAreas([]);
      return;
    }
    setLoadingDetail(true);
    setApiError(null);
    setVariants([]);
    setAreas([]);
    setSelectedVariants({});
    (async () => {
      const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}`);
      const data = await res.json();
      setLoadingDetail(false);
      if (data.blueprint) {
        setDetail(data.blueprint as BlueprintDetail);
      } else {
        setApiError(data.error ?? "Could not load blueprint");
      }
    })();
  }, [blueprintId]);

  // Print providers are required by Printify, so load them for the blueprint.
  React.useEffect(() => {
    if (!blueprintId || !catalogConfigured) {
      setProviders([]);
      return;
    }
    (async () => {
      const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}&providers=1`);
      const data = await res.json();
      const list: Array<{ id: number; title: string }> = Array.isArray(data.providers) ? data.providers : [];
      setProviders(list);
      // Keep a saved provider only when this blueprint still offers it.
      setPrintProviderId((current) => (current && list.some((p) => p.id === current) ? current : list[0]?.id ?? null));
    })();
  }, [blueprintId, catalogConfigured]);

  // Variants and printable areas are provider-scoped in the Printify catalog
  // (the blueprint detail itself has neither).
  React.useEffect(() => {
    if (!blueprintId || !printProviderId || !catalogConfigured) {
      setVariants([]);
      setAreas([]);
      setSelectedVariants({});
      return;
    }
    setLoadingVariants(true);
    setApiError(null);
    (async () => {
      const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}&provider=${printProviderId}`);
      const data = await res.json();
      setLoadingVariants(false);
      const list: Variant[] = Array.isArray(data.variants) ? data.variants : [];
      if (!res.ok || list.length === 0) {
        setVariants([]);
        setAreas([]);
        setSelectedVariants({});
        setApiError(data.error ?? "That print provider has no variants for this product.");
        return;
      }
      setVariants(list);
      setSelectedVariants(
        Object.fromEntries(
          list
            .filter((v) => v.available !== false)
            .slice(0, MAX_VARIANTS)
            .map((v) => [v.id, true]),
        ),
      );

      const sizes = new Set<string>();
      const colors = new Set<string>();
      for (const v of list) {
        if (v.options?.size) sizes.add(v.options.size);
        if (v.options?.color) colors.add(v.options.color);
      }
      setSizeLabels([...sizes]);
      setColorLabels([...colors]);

      const byPosition = new Map<string, PrintAreaOption>();
      for (const v of list) {
        for (const p of v.placeholders ?? []) {
          if (!p.position || byPosition.has(p.position)) continue;
          const decoration = p.decoration_method ? ` · ${p.decoration_method}` : "";
          byPosition.set(p.position, {
            position: p.position,
            label: titleCase(p.position) + decoration,
            width: p.width,
            height: p.height,
          });
        }
      }
      const areaList = [...byPosition.values()];
      setAreas(areaList);
      setPrintArea((current) =>
        areaList.some((a) => a.position === current) ? current : areaList[0]?.position ?? "front",
      );
    })();
  }, [blueprintId, printProviderId, catalogConfigured]);

  const createRemote = async () => {
    if (!blueprintId || !printProviderId || variants.length === 0) return;
    const priceCents = Math.round(Number(priceInput) * 100);
    if (!(priceCents > 0)) {
      setApiError("Enter a price greater than zero before creating the product.");
      return;
    }
    if (selectedCount > MAX_VARIANTS) {
      setApiError(
        `Printify allows at most ${MAX_VARIANTS} variants per product — deselect ${
          selectedCount - MAX_VARIANTS
        } and try again.`,
      );
      return;
    }
    setCreating(true);
    setApiError(null);
    try {
      const design = await db.designs.get(draft.designId);
      const blob = await getAssetBlob(draft.designAssetId);
      let artwork: { base64: string; filename: string; printAreaId: string } | undefined;
      if (blob && design) {
        const base64 = await artworkToBase64(blob, MAX_ARTWORK_BYTES);
        artwork = { base64, filename: `${design.name}.png`, printAreaId: printArea };
      }
      const res = await authedFetch("/api/printify/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          title: name,
          description,
          blueprintId,
          printProviderId,
          variants: { [String(blueprintId)]: Object.keys(selectedVariants).map(Number) },
          price: priceCents,
          printAreas: printArea ? { [printArea]: "pending" } : undefined,
          artwork,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setApiError(data.error ?? `HTTP ${res.status}`);
        await db.productDrafts.put({ ...draft, status: "publish-error", error: data.error, updatedAt: Date.now() });
        return;
      }
      await db.productDrafts.put({
        ...draft,
        name,
        blueprintId,
        printProviderId,
        description,
        priceCents,
        variantSelection: Object.fromEntries(Object.entries(selectedVariants).map(([k, v]) => [k, v])),
        status: "created-remote",
        remoteProductId: data.product?.id,
        remotePermalink: data.product?.permalink,
        error: undefined,
        updatedAt: Date.now(),
      });
      await logActivity("product.create", `Created Printify product "${name}" (${data.product?.id ?? "unknown id"})`);
      toast.success("Product created on Printify");
      onClose();
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setCreating(false);
    }
  };

  const selectedCount = Object.values(selectedVariants).filter(Boolean).length;
  const selectableVariants = variants.filter((v) => v.available !== false);
  const variantQuery = variantFilter.trim().toLowerCase();
  const shownVariants = variantQuery
    ? selectableVariants.filter((v) => v.title.toLowerCase().includes(variantQuery))
    : selectableVariants;
  const overVariantCap = selectedCount > MAX_VARIANTS;
  const selectUpToCap = () =>
    setSelectedVariants(
      Object.fromEntries(selectableVariants.slice(0, MAX_VARIANTS).map((v) => [v.id, true])),
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Product draft</DialogTitle>
          <DialogDescription>
            Stored locally. Creating a product on Printify uploads your artwork to Printify — you must
            confirm that step explicitly.
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-thin -mr-2 flex-1 space-y-3 overflow-y-auto pr-2">
          <div className="space-y-1.5">
            <Label>Product title</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[70px]" />
          </div>
          <div className="space-y-1.5">
            <Label>Price (USD)</Label>
            <Input
              type="number"
              min="0.5"
              step="0.01"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
            />
            <p className="text-[11px] text-ink-subtle">
              Applied to every selected variant. Printify requires a price per variant.
            </p>
          </div>

          {!catalogConfigured ? (
            <div className="rounded-md bg-surface-muted px-3 py-2.5 text-[12px] leading-relaxed text-ink-muted">
              Printify isn’t configured, so the live catalog is unavailable. You can still save this
              draft locally and come back once an API key is added.
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Blueprint (live catalog)</Label>
                <Select value={blueprintId ? String(blueprintId) : "none"} onValueChange={(v) => setBlueprintId(v === "none" ? null : Number(v))}>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingDetail ? "Loading…" : "Choose a blueprint"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {blueprints.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.title} — {b.brand}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Print provider</Label>
                <Select
                  value={printProviderId ? String(printProviderId) : "none"}
                  onValueChange={(v) => setPrintProviderId(v === "none" ? null : Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={providers.length ? "Choose a print provider" : "Loading providers…"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-ink-subtle">
                  Printify requires a print provider for every product.
                </p>
              </div>

              {apiError && (
                <div className="rounded-md bg-danger-soft px-3 py-2 text-[12px] text-danger">{apiError}</div>
              )}

              {loadingVariants && (
                <p className="text-[11px] text-ink-subtle">Loading variants for that print provider…</p>
              )}

              {variants.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label>Variants ({selectedCount} of {selectableVariants.length})</Label>
                      <span className="text-[11px] text-ink-subtle">
                        {sizeLabels.length > 0 ? `${sizeLabels.length} sizes · ` : ""}
                        {colorLabels.length > 0 ? `${colorLabels.length} colors` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        value={variantFilter}
                        onChange={(e) => setVariantFilter(e.target.value)}
                        placeholder="Filter variants (e.g. White / M)"
                        className="h-8 text-[12px]"
                      />
                      <Button size="sm" variant="outline" onClick={selectUpToCap}>
                        All
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setSelectedVariants({})}>
                        None
                      </Button>
                    </div>
                    {overVariantCap && (
                      <p className="text-[11px] text-danger">
                        Printify allows at most {MAX_VARIANTS} variants per product — {selectedCount} are
                        selected. Deselect {selectedCount - MAX_VARIANTS} to continue.
                      </p>
                    )}
                    {shownVariants.length === 0 ? (
                      <p className="text-[12px] text-ink-subtle">No variants match that filter.</p>
                    ) : (
                      <div className="scroll-thin flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                        {shownVariants.map((v) => (
                          <Button
                            key={v.id}
                            size="sm"
                            variant={selectedVariants[v.id] ? "default" : "outline"}
                            onClick={() =>
                              setSelectedVariants((s) => ({ ...s, [v.id]: !s[v.id] }))
                            }
                          >
                            {v.title}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>

                  {areas.length > 0 && (
                    <div className="space-y-1.5">
                      <Label>Print area for your artwork</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {areas.map((a) => (
                          <Button
                            key={a.position}
                            size="sm"
                            variant={printArea === a.position ? "default" : "outline"}
                            onClick={() => setPrintArea(a.position)}
                          >
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border-subtle pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              onSave({
                ...draft,
                name,
                description,
                priceCents: Math.round(Number(priceInput) * 100) || undefined,
                blueprintId: blueprintId ?? undefined,
                printProviderId: printProviderId ?? undefined,
              })
            }
          >
            Save locally
          </Button>
          <Button
            size="sm"
            disabled={
              !catalogConfigured ||
              !blueprintId ||
              !detail ||
              !printProviderId ||
              variants.length === 0 ||
              overVariantCap ||
              !(Number(priceInput) > 0) ||
              selectedCount === 0 ||
              creating
            }
            onClick={createRemote}
          >
            {creating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Create on Printify…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}