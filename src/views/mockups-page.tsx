"use client";

import * as React from "react";
import { useRouter } from "@/lib/client/nav";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { createMockupFromFile, deleteMockup, updateMockup } from "@/lib/db/repo";
import { useMockupSelection } from "@/lib/store/selection";
import type { Mockup, MockupCategory } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { UploadDropzone } from "@/components/upload-dropzone";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  Heart,
  Layers,
  MoreHorizontal,
  Search,
  Shapes,
  Star,
  Trash2,
} from "lucide-react";

const CATEGORY_LABELS: Record<MockupCategory, string> = {
  tshirt: "T-shirts",
  hoodie: "Hoodies",
  mug: "Mugs",
  poster: "Posters",
  tote: "Tote bags",
  sticker: "Stickers",
  other: "Other",
};

export function MockupsPage() {
  const router = useRouter();
  const selected = useMockupSelection((s) => s.selectedMockupIds);
  const toggleSelect = useMockupSelection((s) => s.toggle);
  const clearSelection = useMockupSelection((s) => s.clear);

  const [query, setQuery] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<"all" | MockupCategory | "favorites">("all");
  const [uploading, setUploading] = React.useState(0);
  const [uploadCategory, setUploadCategory] = React.useState<MockupCategory>("tshirt");
  const [confirmDelete, setConfirmDelete] = React.useState<Mockup | null>(null);
  const [detail, setDetail] = React.useState<Mockup | null>(null);

  const mockups = useLiveQuery(() => db.mockups.orderBy("createdAt").reverse().toArray(), []);

  const filtered = React.useMemo(() => {
    if (!mockups) return undefined;
    const q = query.trim().toLowerCase();
    return mockups.filter((m) => {
      if (categoryFilter === "favorites" ? !m.favorite : categoryFilter !== "all" && m.category !== categoryFilter) return false;
      if (q && !m.name.toLowerCase().includes(q) && !m.tags.some((t) => t.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [mockups, query, categoryFilter]);

  const handleFiles = async (files: File[]) => {
    let ok = 0;
    const errors: string[] = [];
    setUploading(files.length);
    for (const file of files) {
      const result = await createMockupFromFile(file, uploadCategory);
      if (result.mockup) ok++;
      if (result.error) errors.push(result.error);
      setUploading((n) => n - 1);
    }
    if (ok > 0) toast.success(`Uploaded ${ok} mockup${ok > 1 ? "s" : ""} to ${CATEGORY_LABELS[uploadCategory]}`);
    errors.slice(0, 3).forEach((e) => toast.error(e));
    if (errors.length > 3) toast.error(`${errors.length - 3} more files failed`);
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    await deleteMockup(confirmDelete.id);
    toast.success(`Deleted mockup "${confirmDelete.name}"`);
    setConfirmDelete(null);
  };

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    mockups?.forEach((m) => map.set(m.category, (map.get(m.category) ?? 0) + 1));
    return map;
  }, [mockups]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Mockups"
        description="Photos of your products. Uploaded mockups stay on this device."
        actions={
          selected.length > 0 ? (
            <>
              <span className="mr-1 text-[13px] text-ink-muted">{selected.length} selected</span>
              <Button size="sm" onClick={() => router.push("/batch")}>
                <Layers className="h-3.5 w-3.5" /> Use in Batch
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}>Clear</Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mockupsâ€¦" className="pl-8" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip label="All" count={mockups?.length ?? 0} active={categoryFilter === "all"} onClick={() => setCategoryFilter("all")} />
          {(Object.keys(CATEGORY_LABELS) as MockupCategory[]).map((cat) => (
            <FilterChip
              key={cat}
              label={CATEGORY_LABELS[cat]}
              count={counts.get(cat) ?? 0}
              active={categoryFilter === cat}
              onClick={() => setCategoryFilter(cat)}
            />
          ))}
          <FilterChip label="Favorites" count={mockups?.filter((m) => m.favorite).length ?? 0} active={categoryFilter === "favorites"} onClick={() => setCategoryFilter("favorites")} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="upload-category" className="text-ink-muted">Upload as</Label>
          <Select value={uploadCategory} onValueChange={(v) => setUploadCategory(v as MockupCategory)}>
            <SelectTrigger id="upload-category" className="w-[140px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CATEGORY_LABELS) as MockupCategory[]).map((c) => (
                <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <UploadDropzone
        label={uploading > 0 ? `Processing ${uploading} file${uploading > 1 ? "s" : ""}â€¦` : "Drop mockup photos here, or click to browse"}
        hint="PNG, JPEG or WebP Â· up to 40 MB each"
        onFiles={handleFiles}
        className="mb-4"
        compact
      />

      {!filtered ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <div className="aspect-[4/3] animate-pulse bg-surface-muted" />
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Shapes />}
          title={mockups && mockups.length > 0 ? "No mockups match this filter" : "No mockups yet"}
          description={
            mockups && mockups.length > 0
              ? "Try a different category, search, or clear the filter."
              : "Upload photos of blank products â€” t-shirts, hoodies, mugs â€” and place your designs on them in the editor."
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((m) => {
            const isSelected = selected.includes(m.id);
            return (
              <Card key={m.id} className={cn("group overflow-hidden", isSelected && "ring-2 ring-forest")}>
                <div className="relative cursor-pointer" onClick={() => toggleSelect(m.id)}>
                  <AssetThumb assetId={m.assetId} className="aspect-[4/3] w-full bg-surface-muted" />
                  {m.favorite && (
                    <Star className="absolute right-2 top-2 h-3.5 w-3.5 fill-warning text-warning" />
                  )}
                  <Badge variant="muted" className="absolute left-2 top-2 bg-white/85">
                    {CATEGORY_LABELS[m.category]}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-1 border-t border-border-subtle px-3 py-2">
                  <button
                    className="min-w-0 text-left"
                    onClick={() => setDetail(m)}
                    title="View details"
                  >
                    <div className="truncate text-[13px] font-medium text-ink">{m.name}</div>
                    <div className="text-[11px] text-ink-subtle">
                      {m.width}Ã—{m.height} Â· user upload
                    </div>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => updateMockup(m.id, { favorite: !m.favorite })}
                      >
                        <Heart /> {m.favorite ? "Remove favorite" : "Add favorite"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => router.push(`/editor?mockup=${m.id}`)}>
                        <Shapes /> Open in editor
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-danger focus:bg-danger-soft" onClick={() => setConfirmDelete(m)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.width}Ã—${detail.height} Â· ${CATEGORY_LABELS[detail.category]} Â· uploaded ${new Date(detail.createdAt).toLocaleDateString()}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && <AssetThumb assetId={detail.assetId} className="max-h-[380px] w-full rounded-md bg-surface-muted" />}
          <DialogFooter>
            <Button size="sm" onClick={() => { if (detail) router.push(`/editor?mockup=${detail.id}`); setDetail(null); }}>
              Open in editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{confirmDelete?.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              Placements using this mockup will be removed. Generated batch images already made are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors cursor-pointer",
        active ? "border-forest bg-forest text-white" : "border-border-strong text-ink-muted hover:bg-surface-muted",
      )}
    >
      {label} <span className={cn("ml-0.5", active ? "opacity-75" : "text-ink-subtle")}>{count}</span>
    </button>
  );
}
