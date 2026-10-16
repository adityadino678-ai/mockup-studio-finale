"use client";

import * as React from "react";
import { useRouter } from "@/lib/client/nav";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import {
  createDesignFromFile,
  deleteDesign,
  designAssetIdFor,
  duplicateDesign,
  getAssetBlob,
  updateDesign,
} from "@/lib/db/repo";
import { useDesignSelection } from "@/lib/store/selection";
import { BgRemovalDialog } from "@/components/designs/bg-removal-dialog";
import { InkVariantsDialog } from "@/components/designs/ink-variants-dialog";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { UploadDropzone } from "@/components/upload-dropzone";
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
} from "@/components/ui/primitives";
import { cn, formatBytes } from "@/lib/utils";
import {
  Copy,
  Download,
  Images,
  Layers,
  MoreHorizontal,
  Palette,
  Pencil,
  PenTool,
  Search,
  Tag,
  Trash2,
  Wand2,
} from "lucide-react";

interface DesignRow {
  id: string;
  name: string;
  tags: string[];
  originalAssetId: string;
  mainAssetId: string;
  hasCutout: boolean;
  hasWhite: boolean;
  hasBlack: boolean;
  activeVariant: "main" | "white" | "black";
  createdAt: number;
  dimensions: string;
  size: number;
}

export function DesignsPage() {
  const router = useRouter();
  const selected = useDesignSelection((s) => s.selectedDesignIds);
  const toggleSelect = useDesignSelection((s) => s.toggle);
  const clearSelection = useDesignSelection((s) => s.clear);

  const [query, setQuery] = React.useState("");
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(0);
  const [editing, setEditing] = React.useState<DesignRow | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<DesignRow[] | null>(null);
  const [downloadUrl, setDownloadUrl] = React.useState<{ url: string; name: string } | null>(null);
  const [bgDialogIds, setBgDialogIds] = React.useState<string[] | null>(null);
  const [inkDialogId, setInkDialogId] = React.useState<string | null>(null);
  const [designRecords, setDesignRecords] = React.useState<import("@/types/domain").Design[] | null>(null);
  const [inkRecord, setInkRecord] = React.useState<import("@/types/domain").Design | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!bgDialogIds) {
      setDesignRecords(null);
      return;
    }
    (async () => {
      const recs = await db.designs.bulkGet(bgDialogIds);
      if (!cancelled) setDesignRecords(recs.filter(Boolean) as import("@/types/domain").Design[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [bgDialogIds]);

  React.useEffect(() => {
    let cancelled = false;
    if (!inkDialogId) {
      setInkRecord(null);
      return;
    }
    (async () => {
      const rec = await db.designs.get(inkDialogId);
      if (!cancelled) setInkRecord(rec ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [inkDialogId]);

  const designs = useLiveQuery(async () => {
    const all = await db.designs.toArray();
    const assetIds = all.flatMap((d) => [d.originalAssetId, d.whiteInkAssetId, d.blackInkAssetId].filter(Boolean) as string[]);
    const metas = await db.assets.bulkGet(assetIds);
    const metaMap = new Map(metas.filter(Boolean).map((m) => [m!.id, m!]));
    return all.map((d) => {
      const meta = metaMap.get(d.originalAssetId);
      return {
        id: d.id,
        name: d.name,
        tags: d.tags,
        originalAssetId: d.originalAssetId,
        mainAssetId: d.processedAssetId ?? d.originalAssetId,
        hasCutout: !!d.processedAssetId,
        hasWhite: !!d.whiteInkAssetId,
        hasBlack: !!d.blackInkAssetId,
        activeVariant: d.activeVariant,
        createdAt: d.createdAt,
        dimensions: meta ? `${meta.width}Ã—${meta.height}` : "â€”",
        size: meta?.size ?? 0,
      };
    });
  }, []);

  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    designs?.forEach((d) => d.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [designs]);

  const filtered = React.useMemo(() => {
    if (!designs) return undefined;
    const q = query.trim().toLowerCase();
    return designs.filter((d) => {
      if (tagFilter && !d.tags.includes(tagFilter)) return false;
      if (q && !d.name.toLowerCase().includes(q) && !d.tags.some((t) => t.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [designs, query, tagFilter]);

  const handleFiles = async (files: File[]) => {
    let ok = 0;
    const errors: string[] = [];
    setUploading(files.length);
    for (const file of files) {
      const result = await createDesignFromFile(file);
      if (result.design) ok++;
      if (result.error) errors.push(result.error);
      setUploading((n) => n - 1);
    }
    if (ok > 0) toast.success(`Uploaded ${ok} design${ok > 1 ? "s" : ""}`);
    errors.slice(0, 3).forEach((e) => toast.error(e));
    if (errors.length > 3) toast.error(`${errors.length - 3} more files failed`);
  };

  const handleDuplicate = async (row: DesignRow) => {
    const copy = await duplicateDesign(row.id);
    if (copy) toast.success(`Duplicated "${row.name}"`);
  };

  const handleDownload = async (designId: string, name: string) => {
    const design = await db.designs.get(designId);
    if (!design) return;
    const blob = await getAssetBlob(designAssetIdFor(design, design.activeVariant));
    if (!blob) {
      toast.error("Original file could not be read from storage");
      return;
    }
    const url = URL.createObjectURL(blob);
    const ext = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1] ?? "png";
    setDownloadUrl({ url, name: `${name}.${ext}` });
  };

  const confirmDownload = () => {
    if (!downloadUrl) return;
    const a = document.createElement("a");
    a.href = downloadUrl.url;
    a.download = downloadUrl.name;
    a.click();
    URL.revokeObjectURL(downloadUrl.url);
    setDownloadUrl(null);
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    for (const row of confirmDelete) await deleteDesign(row.id);
    toast.success(`Deleted ${confirmDelete.length} design${confirmDelete.length > 1 ? "s" : ""}`);
    clearSelection();
    setConfirmDelete(null);
  };

  const openEditor = (designId: string) => {
    const mockupId = "";
    router.push(`/editor?design=${designId}${mockupId ? `&mockup=${mockupId}` : ""}`);
  };

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Designs"
        description="Your artwork library. Files stay on this device."
        actions={
          <>
            {selected.length > 0 && (
              <>
                <span className="mr-1 text-[13px] text-ink-muted">{selected.length} selected</span>
                <Button size="sm" variant="secondary" onClick={() => router.push("/batch")}>
                  <Layers className="h-3.5 w-3.5" />
                  Use in Batch
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSelection}>
                  Clear
                </Button>
              </>
            )}
          </>
        }
      />

      <UploadDropzone
        label={uploading > 0 ? `Processing ${uploading} file${uploading > 1 ? "s" : ""}â€¦` : "Drop designs here, or click to browse"}
        hint="PNG, JPEG or WebP Â· up to 40 MB each Â· multiple files welcome"
        onFiles={handleFiles}
        className="mb-4"
      />

      {!filtered ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <div className="aspect-square animate-pulse bg-surface-muted" />
              <div className="p-3">
                <div className="h-4 w-3/4 animate-pulse rounded bg-surface-muted" />
              </div>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 && designs && designs.length > 0 ? (
        <EmptyState
          icon={<Search />}
          title="No designs match"
          description="Try a different search or clear the tag filter."
          actions={tagFilter ? [{ label: "Clear tag filter", onClick: () => setTagFilter(null) }] : undefined}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Images />}
          title="No designs yet"
          description="Upload your artwork above â€” PNG files with transparent backgrounds work best for print-on-demand."
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search designs and tagsâ€¦"
                className="pl-8"
              />
            </div>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors cursor-pointer",
                  tagFilter === tag
                    ? "border-forest bg-forest text-white"
                    : "border-border-strong text-ink-muted hover:bg-surface-muted",
                )}
              >
                {tag}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((d) => {
              const isSelected = selected.includes(d.id);
              return (
                <Card
                  key={d.id}
                  className={cn(
                    "group relative overflow-hidden transition-shadow",
                    isSelected && "ring-2 ring-forest",
                  )}
                >
                  <div
                    className="relative cursor-pointer checkerboard"
                    onClick={() => toggleSelect(d.id)}
                    title="Click to select/deselect"
                  >
                    <AssetThumb
                      assetId={d.mainAssetId}
                      className="aspect-square w-full"
                    />
                    <div className="absolute left-2 top-2">
                      <Checkbox
                        checked={isSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(d.id);
                        }}
                        className="bg-white/80"
                      />
                    </div>
                    {(d.hasWhite || d.hasBlack || d.hasCutout) && (
                      <div className="absolute right-2 top-2 flex gap-1">
                        {d.hasCutout && <Badge>cutout</Badge>}
                        {d.hasWhite && <Badge>white ink</Badge>}
                        {d.hasBlack && <Badge>black ink</Badge>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1 border-t border-border-subtle px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-ink" title={d.name}>
                        {d.name}
                      </div>
                      <div className="text-[11px] text-ink-subtle">
                        {d.dimensions} Â· {formatBytes(d.size)}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(d)}>
                          <Pencil /> Rename / tag
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setInkDialogId(d.id)}>
                          <Palette /> Ink variants
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setBgDialogIds([d.id])}>
                          <Wand2 /> Remove background
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openEditor(d.id)}>
                          <PenTool /> Open in editor
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDownload(d.id, d.name)}>
                          <Download /> Download
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicate(d)}>
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-danger focus:bg-danger-soft"
                          onClick={() => setConfirmDelete([d])}
                        >
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </Card>
              );
            })}
          </div>

          {selected.length > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-card">
              <span className="text-[13px] text-ink-muted">
                {selected.length} designs selected
              </span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setBgDialogIds(selected)}>
                  <Wand2 className="h-3.5 w-3.5" /> Remove backgrounds
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(filtered.filter((d) => selected.includes(d.id)))}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete selected
                </Button>
                <Button size="sm" onClick={() => router.push("/batch")}>
                  <Layers className="h-3.5 w-3.5" /> Use in Batch
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Rename / tags dialog */}
      <EditDesignDialog
        row={editing}
        onClose={() => setEditing(null)}
        onSave={async (name, tags) => {
          if (!editing) return;
          await updateDesign(editing.id, { name, tags });
          toast.success("Design updated");
          setEditing(null);
        }}
      />

      {/* Background removal dialog */}
      {bgDialogIds && designRecords && designRecords.length > 0 && (
        <BgRemovalDialog
          designs={designRecords}
          onClose={() => setBgDialogIds(null)}
        />
      )}

      {/* Ink variants dialog */}
      {inkRecord && <InkVariantsDialog design={inkRecord} onClose={() => setInkDialogId(null)} />}

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {confirmDelete?.length === 1 ? `"${confirmDelete[0].name}"` : `${confirmDelete?.length} designs`}?</DialogTitle>
            <DialogDescription>
              This permanently removes the designs, their ink variants, placements and generated
              mockups from local storage. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Download confirm */}
      <Dialog open={!!downloadUrl} onOpenChange={(o) => !o && confirmDownload()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Download design?</DialogTitle>
            <DialogDescription>
              The active variant file will be saved as {downloadUrl?.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { if (downloadUrl) URL.revokeObjectURL(downloadUrl.url); setDownloadUrl(null); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmDownload}>
              <Download className="h-3.5 w-3.5" /> Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditDesignDialog({
  row,
  onClose,
  onSave,
}: {
  row: DesignRow | null;
  onClose: () => void;
  onSave: (name: string, tags: string[]) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [tagsText, setTagsText] = React.useState("");

  React.useEffect(() => {
    if (row) {
      setName(row.name);
      setTagsText(row.tags.join(", "));
    }
  }, [row]);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit design</DialogTitle>
          <DialogDescription>Rename the design or manage its tags (comma separated).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="design-name">Name</Label>
            <Input id="design-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="design-tags" className="flex items-center gap-1.5">
              <Tag className="h-3 w-3" /> Tags
            </Label>
            <Textarea
              id="design-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="funny, christmas, cat"
              className="min-h-[60px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() =>
              onSave(
                name.trim(),
                tagsText.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
