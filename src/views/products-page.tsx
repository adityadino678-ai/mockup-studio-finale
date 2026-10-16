"use client";

import * as React from "react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { designMainAssetId, getAssetBlob, logActivity, uid } from "@/lib/db/repo";
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
  category: string;
}
interface BlueprintDetail extends Blueprint {
  variants: Array<{ id: number; title: string; options: number[]; available: boolean }>;
  print_areas: Array<{ id: string; title?: string; width?: number; height?: number }>;
}
interface CatalogState {
  configured: boolean;
  blueprints?: Blueprint[];
  blueprint?: BlueprintDetail;
  error?: string;
}

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
      const res = await fetch("/api/printify/catalog");
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
                  Add <code className="rounded bg-surface-muted px-1">PRINTIFY_API_KEY=…</code> to{" "}
                  <code className="rounded bg-surface-muted px-1">.env.local</code> in the project root.
                </li>
                <li>Restart the dev server and press “Check Printify”.</li>
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
                          {Object.keys(d.variantSelection).length} variant groups · updated{" "}
                          {formatDateTime(d.updatedAt)}
                        </div>
                        {d.remotePermalink && (
                          <a
                            href={d.remotePermalink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-forest underline"
                          >
                            {d.remotePermalink}
                          </a>
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
  const [description, setDescription] = React.useState("");
  const [blueprints, setBlueprints] = React.useState<Blueprint[]>([]);
  const [detail, setDetail] = React.useState<BlueprintDetail | null>(null);
  const [blueprintId, setBlueprintId] = React.useState<number | null>(draft.blueprintId ?? null);
  const [printArea, setPrintArea] = React.useState<string>("front");
  const [selectedVariants, setSelectedVariants] = React.useState<Record<number, boolean>>({});
  const [sizeOptions, setSizeOptions] = React.useState<number[]>([]);
  const [colorOptions, setColorOptions] = React.useState<number[]>([]);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!catalogConfigured || blueprints.length > 0) return;
    (async () => {
      const res = await fetch("/api/printify/catalog");
      const data = await res.json();
      if (data.blueprints) setBlueprints(data.blueprints);
    })();
  }, [catalogConfigured, blueprints.length]);

  React.useEffect(() => {
    if (!blueprintId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    setApiError(null);
    (async () => {
      const res = await fetch(`/api/printify/catalog?id=${blueprintId}`);
      const data = await res.json();
      setLoadingDetail(false);
      if (data.blueprint) {
        const bp: BlueprintDetail = data.blueprint;
        setDetail(bp);
        setSelectedVariants(Object.fromEntries(bp.variants.map((v: { id: number }) => [v.id, true])));
        setSizeOptions(bp.variants.find((v: { title: string }) => /size/i.test(v.title))?.options ?? []);
        setColorOptions(bp.variants.find((v: { title: string }) => /colou?r/i.test(v.title))?.options ?? []);
      } else {
        setApiError(data.error ?? "Could not load blueprint");
      }
    })();
  }, [blueprintId]);

  const createRemote = async () => {
    if (!blueprintId || !detail) return;
    setCreating(true);
    setApiError(null);
    try {
      const design = await db.designs.get(draft.designId);
      const blob = await getAssetBlob(draft.designAssetId);
      let artwork: { base64: string; filename: string; printAreaId: string } | undefined;
      if (blob && design) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) {
          binary += String.fromCharCode(...buf.subarray(i, i + chunk));
        }
        artwork = { base64: btoa(binary), filename: `${design.name}.png`, printAreaId: printArea };
      }
      const res = await fetch("/api/printify/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          title: name,
          description,
          blueprintId,
          variants: { [String(blueprintId)]: Object.keys(selectedVariants).map(Number) },
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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Product draft</DialogTitle>
          <DialogDescription>
            Stored locally. Creating a product on Printify uploads your artwork to Printify — you must
            confirm that step explicitly.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Product title</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[70px]" />
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

              {apiError && (
                <div className="rounded-md bg-danger-soft px-3 py-2 text-[12px] text-danger">{apiError}</div>
              )}

              {detail && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Variants ({selectedCount} selected)</Label>
                      <span className="text-[11px] text-ink-subtle">
                        {sizeOptions.length > 0 ? `${sizeOptions.length} sizes · ` : ""}
                        {colorOptions.length > 0 ? `${colorOptions.length} colors` : ""}
                      </span>
                    </div>
                    <div className="scroll-thin flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                      {detail.variants.map((v) => (
                        <Button
                          key={v.id}
                          size="sm"
                          variant={selectedVariants[v.id] ? "default" : "outline"}
                          disabled={!v.available}
                          onClick={() =>
                            setSelectedVariants((s) => ({ ...s, [v.id]: !s[v.id] }))
                          }
                        >
                          {v.title}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {detail.print_areas.length > 0 && (
                    <div className="space-y-1.5">
                      <Label>Print area for your artwork</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {detail.print_areas.map((a) => (
                          <Button
                            key={a.id}
                            size="sm"
                            variant={printArea === a.id ? "default" : "outline"}
                            onClick={() => setPrintArea(a.id)}
                          >
                            {a.title ?? a.id}
                            {a.width && a.height ? ` (${a.width}×${a.height})` : ""}
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

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" size="sm" onClick={() => onSave({ ...draft, name })}>
            Save locally
          </Button>
          <Button
            size="sm"
            disabled={!catalogConfigured || !blueprintId || !detail || selectedCount === 0 || creating}
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