"use client";

import * as React from "react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { logActivity, savePlacement, uid } from "@/lib/db/repo";
import { useDesignSelection } from "@/lib/store/selection";
import type { Design, Template, TemplateCategory } from "@/types/domain";
import { DEFAULT_TRANSFORM } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { designMainAssetId } from "@/lib/db/repo";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Textarea } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import { Boxes, Copy, MoreHorizontal, Pencil, Play, Plus, Search, Trash2 } from "lucide-react";

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  placement: "Placement",
  "mockup-collection": "Mockup collection",
  product: "Product",
  "ink-rules": "Ink rules",
  listing: "Listing",
  workflow: "Workflow",
  seo: "SEO",
};

function describeTemplate(t: Template): string {
  if (t.payload.type === "placement") {
    const tr = t.payload.transform;
    return `x ${(tr.x * 100).toFixed(0)}% · y ${(tr.y * 100).toFixed(0)}% · width ${(tr.scale * 100).toFixed(0)}% · rotate ${tr.rotation.toFixed(0)}°${tr.flipX ? " · flipX" : ""}${tr.flipY ? " · flipY" : ""}`;
  }
  if (t.payload.type === "mockup-collection") return `${t.payload.mockupIds.length} mockups`;
  if (t.payload.type === "ink-rules") return `batch variant: ${t.payload.batchVariant}`;
  if (t.payload.type === "listing")
    return `${t.payload.tags.length} tags${t.payload.priceCents ? ` · $${(t.payload.priceCents / 100).toFixed(2)}` : ""}`;
  if (t.payload.type === "workflow") return `${t.payload.steps.length} steps`;
  if (t.payload.type === "seo") return `${t.payload.keywords.length} keywords`;
  return "";
}

export default function TemplatesPage() {
  const templates = useLiveQuery(() => db.templates.orderBy("updatedAt").reverse().toArray(), []);
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const selection = useDesignSelection((s) => s.selectedDesignIds);

  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<TemplateCategory | "all">("all");
  const [editing, setEditing] = React.useState<Template | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [applying, setApplying] = React.useState<Template | null>(null);
  const [applyTargets, setApplyTargets] = React.useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = React.useState<Template | null>(null);

  const filtered = React.useMemo(() => {
    if (!templates) return undefined;
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (q && !t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [templates, query, category]);

  const saveTemplate = async (tpl: Template) => {
    await db.templates.put(tpl);
    await logActivity("template.apply", `Saved template "${tpl.name}"`);
    toast.success(`Template "${tpl.name}" saved`);
  };

  const duplicate = async (tpl: Template) => {
    const copy: Template = {
      ...tpl,
      id: uid(),
      name: `${tpl.name} (copy)`,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.templates.put(copy);
    toast.success(`Duplicated as "${copy.name}"`);
  };

  const applyToDesigns = async () => {
    if (!applying || applyTargets.length === 0) return;
    if (applying.payload.type === "placement") {
      const transform = applying.payload.transform;
      for (const designId of applyTargets) {
        // Apply to every saved placement of this design, or create one per mockup
        // that already has a placement. Designs without placements are skipped
        // (placement needs a target mockup).
        const placements = await db.placements.where("designId").equals(designId).toArray();
        if (placements.length === 0) continue;
        for (const p of placements) {
          await savePlacement({
            designId,
            mockupId: p.mockupId,
            designAssetId: p.designAssetId,
            transform,
            behindMockup: p.behindMockup,
          });
        }
      }
      toast.success(`Applied "${applying.name}" to ${applyTargets.length} design(s)`);
    } else if (applying.payload.type === "mockup-collection") {
      toast.info("Mockup collections are used inside Batch Studio");
    } else {
      toast.info(`Template type "${applying.payload.type}" is informational — no artwork is changed`);
    }
    setApplying(null);
  };

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader
        title="Templates"
        description="Reusable settings for placements, mockup sets, ink rules and more."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setQuery("");
              setCategory("all");
            }}
          >
            <Plus className="h-3.5 w-3.5" /> New template
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates…" className="pl-8" />
        </div>
        <Tabs value={category} onValueChange={(v) => setCategory(v as TemplateCategory | "all")}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="placement">Placement</TabsTrigger>
            <TabsTrigger value="mockup-collection">Mockups</TabsTrigger>
            <TabsTrigger value="seo">SEO</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!filtered ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-muted" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title={templates && templates.length > 0 ? "No templates match" : "No templates yet"}
          description={
            templates && templates.length > 0
              ? "Try another search or category."
              : "Save a placement from the editor (“Save as template”) or create one here."
          }
          actions={[
            {
              label: "Create template",
              icon: <Plus className="h-3.5 w-3.5" />,
              onClick: () => setCreating(true),
            },
          ]}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((tpl) => (
            <Card key={tpl.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium text-ink">{tpl.name}</span>
                  <Badge>{CATEGORY_LABELS[tpl.category]}</Badge>
                  {tpl.version > 1 && <Badge variant="muted">v{tpl.version}</Badge>}
                </div>
                <p className="mt-1 text-[12px] text-ink-muted">{describeTemplate(tpl) || tpl.description}</p>
                <p className="mt-0.5 text-[11px] text-ink-subtle">updated {formatDateTime(tpl.updatedAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setApplying(tpl);
                    setApplyTargets(selection);
                  }}
                >
                  <Play className="h-3.5 w-3.5" /> Apply
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => { setEditing(tpl); setCreating(false); }}>
                      <Pencil /> Edit / rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => duplicate(tpl)}>
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-danger focus:bg-danger-soft" onClick={() => setConfirmDelete(tpl)}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <TemplateEditor
          initial={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={saveTemplate}
        />
      )}

      {applying && (
        <Dialog open onOpenChange={(o) => !o && setApplying(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Apply &ldquo;{applying.name}&rdquo;</DialogTitle>
              <DialogDescription>
                {applying.payload.type === "placement"
                  ? `This sets ${describeTemplate(applying)} on the placements of the designs you select. Designs without a saved placement are skipped — open them in the editor first.`
                  : "This template does not change artwork. Continue to see its details."}
              </DialogDescription>
            </DialogHeader>
            <div className="scroll-thin max-h-[300px] space-y-1 overflow-y-auto pr-1">
              {designs?.map((d: Design) => (
                <label key={d.id} className="flex cursor-pointer items-center gap-3 rounded-md p-1.5 hover:bg-surface-muted">
                  <Checkbox
                    checked={applyTargets.includes(d.id)}
                    onCheckedChange={() =>
                      setApplyTargets((cur) => (cur.includes(d.id) ? cur.filter((x) => x !== d.id) : [...cur, d.id]))
                    }
                  />
                  <AssetThumb assetId={designMainAssetId(d)} className="h-9 w-9 rounded-md" checkerboard />
                  <span className="text-[13px]">{d.name}</span>
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setApplying(null)}>Cancel</Button>
              <Button size="sm" disabled={applyTargets.length === 0} onClick={applyToDesigns}>
                Apply to {applyTargets.length} design{applyTargets.length > 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete &ldquo;{confirmDelete.name}&rdquo;?</DialogTitle>
              <DialogDescription>The template is removed permanently. Artwork and placements are not affected.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  await db.templates.delete(confirmDelete.id);
                  toast.success("Template deleted");
                  setConfirmDelete(null);
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function TemplateEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Template | null;
  onClose: () => void;
  onSave: (t: Template) => Promise<void>;
}) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [category, setCategory] = React.useState<TemplateCategory>(initial?.category ?? "placement");
  const [transform, setTransform] = React.useState(
    initial?.payload.type === "placement" ? initial.payload.transform : { ...DEFAULT_TRANSFORM },
  );

  const submit = async () => {
    if (!name.trim()) return;
    const now = Date.now();
    const tpl: Template = {
      id: initial?.id ?? uid(),
      name: name.trim(),
      category,
      description: description.trim() || "Created manually",
      version: initial ? initial.version + 1 : 1,
      payload:
        category === "placement"
          ? { type: "placement", transform }
          : category === "mockup-collection"
            ? { type: "mockup-collection", mockupIds: [] }
            : category === "ink-rules"
              ? { type: "ink-rules", batchVariant: "main" }
              : category === "listing"
                ? { type: "listing", tags: [] }
                : category === "workflow"
                  ? { type: "workflow", steps: [] }
                  : { type: "seo", keywords: [], titleDrafts: [], tags: [], savedAt: now },
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    };
    await onSave(tpl);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            {initial ? "Saving creates a new version of this template." : "Templates store reusable settings you can apply later."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Center chest 35%" />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[60px]" />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(CATEGORY_LABELS) as TemplateCategory[]).map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={category === c ? "default" : "outline"}
                  onClick={() => setCategory(c)}
                >
                  {CATEGORY_LABELS[c]}
                </Button>
              ))}
            </div>
          </div>
          {category === "placement" && (
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["x %", "x", transform.x * 100],
                  ["y %", "y", transform.y * 100],
                  ["width %", "scale", transform.scale * 100],
                  ["rotation °", "rotation", transform.rotation],
                ] as const
              ).map(([label, key, value]) => (
                <div key={key} className="space-y-1">
                  <Label className="text-ink-muted">{label}</Label>
                  <Input
                    type="number"
                    defaultValue={Math.round(value * 100) / 100}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isFinite(v)) return;
                      setTransform((t) => ({
                        ...t,
                        [key]: key === "rotation" ? v : v / 100,
                      }));
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!name.trim()} onClick={submit}>
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}