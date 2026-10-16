"use client";

import * as React from "react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { logActivity, uid } from "@/lib/db/repo";
import {
  validateListing,
  ETSY_TAG_MAX_COUNT,
  ETSY_TAG_MAX_LENGTH,
  ETSY_TITLE_MAX,
} from "@/lib/listings/validation";
import type { Design, ListingDraft } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { designMainAssetId } from "@/lib/db/repo";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent, Separator } from "@/components/ui/card";
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
import { formatDateTime } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Copy,
  Info,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

type StatusFilter = "all" | "local-draft" | "submitted" | "active" | "submission-failed";

const STATUS_VARIANT: Record<string, "muted" | "default" | "forest" | "danger"> = {
  "local-draft": "muted",
  "validation-error": "danger",
  submitting: "default",
  submitted: "default",
  active: "forest",
  "submission-failed": "danger",
};

export function ListingsPage() {
  const listings = useLiveQuery(() => db.listingDrafts.orderBy("updatedAt").reverse().toArray(), []);
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const productDrafts = useLiveQuery(() => db.productDrafts.toArray(), []);

  const [editing, setEditing] = React.useState<ListingDraft | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [bulkOpen, setBulkOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    if (!listings) return undefined;
    return listings.filter((l) => filter === "all" || l.status === filter);
  }, [listings, filter]);

  const bulkGenerate = async () => {
    if (!designs || designs.length === 0) return;
    const now = Date.now();
    const drafts: ListingDraft[] = designs.map((d) => ({
      id: uid(),
      title: `${d.name} — custom design`.slice(0, ETSY_TITLE_MAX),
      description: `A custom ${d.name} design.\n\n• Print-on-demand\n• Ships in 2–4 business days\n\nAdd your own description in the listing editor.`,
      tags: ["custom design", "gift", d.name.toLowerCase().slice(0, ETSY_TAG_MAX_LENGTH)]
        .filter(Boolean)
        .slice(0, ETSY_TAG_MAX_COUNT),
      priceCents: 2499,
      quantity: 1,
      designId: d.id,
      imageAssetIds: [],
      status: "local-draft",
      createdAt: now,
      updatedAt: now,
    }));
    await db.listingDrafts.bulkPut(drafts);
    await logActivity("listing.submit", `Generated ${drafts.length} listing drafts locally`);
    toast.success(`Created ${drafts.length} local drafts — edit before exporting or submitting`);
    setBulkOpen(false);
  };

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader
        title="Listings"
        description="Etsy-ready drafts with validation. Saved locally until you submit them."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={bulkGenerate} disabled={!designs || designs.length === 0}>
              <Sparkles className="h-3.5 w-3.5" /> Generate drafts from designs
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setEditing({
                  id: uid(),
                  title: "",
                  description: "",
                  tags: [],
                  priceCents: 2499,
                  quantity: 1,
                  imageAssetIds: [],
                  status: "local-draft",
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                })
              }
            >
              <Plus className="h-3.5 w-3.5" /> New listing
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {(
          [
            ["all", "All"],
            ["local-draft", "Local drafts"],
            ["submitted", "Submitted"],
            ["active", "Active"],
            ["submission-failed", "Failed"],
          ] as Array<[StatusFilter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
              filter === value
                ? "border-forest bg-forest text-white"
                : "border-border-strong text-ink-muted hover:bg-surface-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Card className="mb-5">
        <CardContent className="flex items-start gap-2.5 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-forest" />
          <p className="text-[12px] leading-relaxed text-ink-muted">
            Drafts live in this browser only. Nothing is sent to Etsy until an API key is configured and
            you confirm a submission. Etsy limits: title ≤ {ETSY_TITLE_MAX} characters, up to{" "}
            {ETSY_TAG_MAX_COUNT} tags of {ETSY_TAG_MAX_LENGTH} characters each — these are enforced below.
          </p>
        </CardContent>
      </Card>

      {!filtered ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-muted" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ClipboardList />}
          title={listings && listings.length > 0 ? "No listings in this view" : "No listing drafts yet"}
          description={
            listings && listings.length > 0
              ? "Try another status filter."
              : "Create one manually or generate drafts for every design in your library."
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((l) => {
            const design = designs?.find((d) => d.id === l.designId);
            const validation = validateListing(l);
            return (
              <Card key={l.id} className="p-3">
                <div className="flex flex-wrap items-center gap-3">
                  {design && <AssetThumb assetId={designMainAssetId(design)} className="h-12 w-12 rounded-md" checkerboard />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-ink">
                        {l.title || "Untitled listing"}
                      </span>
                      <Badge variant={STATUS_VARIANT[l.status] ?? "muted"}>{l.status}</Badge>
                      {validation.valid ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-forest" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-danger" />
                      )}
                    </div>
                    <div className="truncate text-[12px] text-ink-muted">{l.description.split("\n")[0]}</div>
                    <div className="text-[11px] text-ink-subtle">
                      {l.tags.length}/{ETSY_TAG_MAX_COUNT} tags ·{" "}
                      {l.priceCents != null ? `$${(l.priceCents / 100).toFixed(2)}` : "no price"} · updated{" "}
                      {formatDateTime(l.updatedAt)}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setEditing(l)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Duplicate"
                      onClick={async () => {
                        const copy = { ...l, id: uid(), title: `${l.title} (copy)`.slice(0, ETSY_TITLE_MAX), status: "local-draft" as const, createdAt: Date.now(), updatedAt: Date.now() };
                        await db.listingDrafts.put(copy);
                        toast.success("Draft duplicated");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await db.listingDrafts.delete(l.id);
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

      {editing && (
        <ListingEditor
          listing={editing}
          designs={designs ?? []}
          productDrafts={productDrafts ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {bulkOpen && null}
    </div>
  );
}

function ListingEditor({
  listing,
  designs,
  productDrafts,
  onClose,
}: {
  listing: ListingDraft;
  designs: Design[];
  productDrafts: Array<{ id: string; name: string; designId: string }>;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState<ListingDraft>(listing);
  const [tagsText, setTagsText] = React.useState(listing.tags.join(", "));

  const tags = React.useMemo(
    () =>
      tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 40),
    [tagsText],
  );

  const validation = validateListing({
    title: draft.title,
    description: draft.description,
    tags,
    priceCents: draft.priceCents,
    quantity: draft.quantity,
  });

  const save = async () => {
    const next: ListingDraft = {
      ...draft,
      tags,
      status: validation.valid ? "local-draft" : "validation-error",
      updatedAt: Date.now(),
    };
    await db.listingDrafts.put(next);
    await logActivity("listing.submit", `Saved listing draft "${next.title || "Untitled"}"`);
    toast.success(validation.valid ? "Listing draft saved" : "Saved with validation issues");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Listing draft</DialogTitle>
          <DialogDescription>
            Saved in this browser. Validation runs against Etsy’s documented limits as you type.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="listing-title">Title</Label>
              <span className={`text-[11px] ${draft.title.length > ETSY_TITLE_MAX ? "text-danger" : "text-ink-subtle"}`}>
                {draft.title.length}/{ETSY_TITLE_MAX}
              </span>
            </div>
            <Input
              id="listing-title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="e.g. Funny Cat T-Shirt, Gifts for Cat Lovers"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              className="min-h-[140px]"
              placeholder="Describe the product, material, printing method and shipping."
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="listing-tags">Tags (comma separated)</Label>
              <span className={`text-[11px] ${tags.length > ETSY_TAG_MAX_COUNT ? "text-danger" : "text-ink-subtle"}`}>
                {tags.length}/{ETSY_TAG_MAX_COUNT}
              </span>
            </div>
            <Input
              id="listing-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="cat tshirt, funny cat shirt, cat lover gift"
            />
            {tags.filter((t) => t.length > ETSY_TAG_MAX_LENGTH).length > 0 && (
              <p className="text-[11px] text-danger">
                {tags.filter((t) => t.length > ETSY_TAG_MAX_LENGTH).length} tag(s) exceed{" "}
                {ETSY_TAG_MAX_LENGTH} characters — Etsy will reject these.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Price (USD)</Label>
              <Input
                type="number"
                min="1"
                step="0.01"
                value={draft.priceCents != null ? (draft.priceCents / 100).toFixed(2) : ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, priceCents: Math.round(parseFloat(e.target.value || "0") * 100) }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <Input
                type="number"
                min="1"
                value={draft.quantity ?? 1}
                onChange={(e) => setDraft((d) => ({ ...d, quantity: parseInt(e.target.value || "1", 10) }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Linked design</Label>
              <select
                className="h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px]"
                value={draft.designId ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, designId: e.target.value || undefined }))}
              >
                <option value="">None</option>
                {designs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Linked product draft</Label>
              <select
                className="h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px]"
                value={draft.productDraftId ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, productDraftId: e.target.value || undefined }))}
              >
                <option value="">None</option>
                {productDrafts
                  .filter((p) => !draft.designId || p.designId === draft.designId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <Separator />

          {/* Validation feedback */}
          <div className="space-y-1.5">
            {validation.errors.length === 0 && validation.warnings.length === 0 ? (
              <p className="flex items-center gap-1.5 text-[12px] text-forest">
                <CheckCircle2 className="h-3.5 w-3.5" /> Ready for Etsy’s listing requirements.
              </p>
            ) : (
              <>
                {validation.errors.map((e) => (
                  <p key={e} className="flex items-center gap-1.5 text-[12px] text-danger">
                    <AlertTriangle className="h-3.5 w-3.5" /> {e}
                  </p>
                ))}
                {validation.warnings.map((w) => (
                  <p key={w} className="flex items-center gap-1.5 text-[12px] text-warning">
                    <Info className="h-3.5 w-3.5" /> {w}
                  </p>
                ))}
              </>
            )}
            <p className="text-[11px] text-ink-subtle">
              Submitting to Etsy requires an API key in <code>.env.local</code> and your explicit confirmation.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={draft.title.trim().length === 0}>
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}