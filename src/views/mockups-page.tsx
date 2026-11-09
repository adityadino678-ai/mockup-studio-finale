"use client";

// ---------------------------------------------------------------------------
// The Mockups page.
//
// Three tabs:
//
//   Mockups     - the product photos. A sub-category is a user-created named
//                 template inside a main category ("Hanging", "Front flat"),
//                 chosen with a dropdown.
//   Info Cards  - the fixed information images (size charts, "what you get")
//                 that follow the product photos on a listing. They are filed
//                 under MAIN categories only and they never get a print area.
//   Print areas - unchanged. A print area maps a real Printify print area
//                 onto a product photo, which an info card is not.
//
// An info card lives in the SAME `mockups` table as a product photo, so it
// gets the same library UI, but every product surface filters it out.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db, getSetting, setSetting } from "@/lib/db/schema";
import { createMockupFromFile, deleteMockup, updateMockup } from "@/lib/db/repo";
import type { Mockup, MockupCategory } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { HowItWorks } from "@/components/ui/how-it-works";
import { AssetThumb } from "@/components/asset-thumb";
import { UploadDropzone } from "@/components/upload-dropzone";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PrintAreasTab } from "@/views/mockups/print-areas-tab";
import { printAreaOf } from "@/lib/mockups/print-area";
import { CATEGORY_LABELS } from "@/lib/mockups/categories";
import {
  DEFAULT_SUBCATEGORY,
  infoCardMockups,
  isInfoCard,
  productMockups,
  subCategoriesFor,
  subCategoryOf,
} from "@/lib/mockups/info-cards";
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
  Crop,
  Heart,
  Info,
  MoreHorizontal,
  Search,
  Shapes,
  Star,
  Trash2,
} from "lucide-react";

/** Where the user-created sub-category names are remembered. */
const SUBCATEGORY_KEY = "mockups:subCategories";
/** The sentinel value the "new sub-category" entry carries. */
const NEW_SUBCATEGORY = "__new__";

type SubCategoryStore = Record<string, string[]>;

export function MockupsPage() {
  const [tab, setTab] = React.useState<"library" | "info" | "areas">("library");
  /** The mockup the Print areas tab should open on, when the library sent it. */
  const [areaMockupId, setAreaMockupId] = React.useState<string | null>(null);

  const mockups = useLiveQuery(() => db.mockups.orderBy("createdAt").reverse().toArray(), []);
  /** The product photos. An info card is never one of these. */
  const products = React.useMemo(() => productMockups(mockups ?? []), [mockups]);
  /** The info cards, in the order they follow the mockups on a listing. */
  const cards = React.useMemo(() => infoCardMockups(mockups ?? []), [mockups]);

  /**
   * Opens the Print areas tab on one mockup.
   *
   * This is what the old "Open in editor" action became: the design's
   * placement lives in the Printify Studio now, and the mockups tab is where
   * a mockup gets the frame that carries that design.
   */
  const openPrintArea = (id: string) => {
    setAreaMockupId(id);
    setTab("areas");
  };

  const areasCount = React.useMemo(
    () =>
      products.filter(
        (m) =>
          printAreaOf(m) !== undefined ||
          Object.values(m.designAreas ?? {}).some((area) => area != null),
      ).length,
    [products],
  );

  return (
    <div className={cn("mx-auto p-5 sm:p-8", tab === "areas" ? "max-w-[1600px]" : "max-w-6xl")}>
      <PageHeader
        title="Mockups"
        description="Your product photos."
        actions={
          <HowItWorks
            title="Mockups"
            steps={[
              "Upload mockup photos.",
              "Map a Printify print area onto a photo.",
              "Save renders for listings and export.",
            ]}
          />
        }
      />

      {/* The upper section: the library, the info cards, and the print areas. */}
      <div className="mb-4 flex items-center gap-1 border-b border-border-subtle">
        <TabButton
          active={tab === "library"}
          label="Mockups"
          count={products.length}
          onClick={() => setTab("library")}
        />
        <TabButton
          active={tab === "info"}
          label="Info Cards"
          count={cards.length}
          onClick={() => setTab("info")}
        />
        <TabButton
          active={tab === "areas"}
          label="Print areas"
          count={areasCount}
          onClick={() => setTab("areas")}
        />
      </div>

      {tab === "areas" ? (
        <PrintAreasTab initialMockupId={areaMockupId} />
      ) : tab === "info" ? (
        <MockupLibrary kind="info-card" rows={cards} />
      ) : (
        <MockupLibrary kind="product" rows={products} onOpenPrintArea={openPrintArea} />
      )}
    </div>
  );
}

/** One tab in the upper bar. */
function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold transition-colors",
        active
          ? "border-forest text-forest"
          : "border-transparent text-ink-muted hover:text-ink",
      )}
    >
      {label}
      <span className="rounded-full bg-surface-muted px-1.5 py-px text-[11px] font-medium text-ink-subtle">
        {count}
      </span>
    </button>
  );
}

/**
 * The library, shared by the Mockups and the Info Cards tabs.
 *
 * The only difference between the two is the KIND of row and the actions:
 * an info card never gets a print area, and it is filed under main categories
 * only. Everything else - the search, the category chips, the upload, the
 * grid - is the same screen.
 */
function MockupLibrary({
  kind,
  rows,
  onOpenPrintArea,
}: {
  kind: "product" | "info-card";
  rows: Mockup[];
  onOpenPrintArea?(id: string): void;
}) {
  const [query, setQuery] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<"all" | MockupCategory | "favorites">(
    "all",
  );
  const [subFilter, setSubFilter] = React.useState("all");
  const [uploadCategory, setUploadCategory] = React.useState<MockupCategory>("tshirt");
  const [uploadSub, setUploadSub] = React.useState(DEFAULT_SUBCATEGORY);
  const [uploading, setUploading] = React.useState(0);
  const [confirmDelete, setConfirmDelete] = React.useState<Mockup | null>(null);
  const [detail, setDetail] = React.useState<Mockup | null>(null);
  /** The names the user created, per main category. */
  const [storedSubs, setStoredSubs] = React.useState<SubCategoryStore>({});
  /** The "new sub-category" dialog, and what it is for. */
  const [newSub, setNewSub] = React.useState<
    { mode: "upload" } | { mode: "card"; mockupId: string; category: MockupCategory } | null
  >(null);
  const [newSubName, setNewSubName] = React.useState("");

  const isInfo = kind === "info-card";

  React.useEffect(() => {
    let live = true;
    void getSetting<SubCategoryStore>(SUBCATEGORY_KEY, {}).then((saved) => {
      if (live && saved && typeof saved === "object") setStoredSubs(saved);
    });
    return () => {
      live = false;
    };
  }, []);

  /** Remembers a user-created sub-category name for its main category. */
  const rememberSubCategory = React.useCallback(
    async (category: MockupCategory, name: string) => {
      const next = { ...storedSubs };
      const list = next[category] ?? [];
      if (!list.includes(name)) next[category] = [...list, name];
      setStoredSubs(next);
      await setSetting(SUBCATEGORY_KEY, next);
    },
    [storedSubs],
  );

  /**
   * The sub-categories in one main category: the ones in use, plus the ones
   * the user created but has not used yet.
   */
  const subCategoriesForCategory = React.useCallback(
    (category: MockupCategory): string[] => {
      const names = new Set(subCategoriesFor(rows, category, kind));
      for (const name of storedSubs[category] ?? []) names.add(name);
      return [...names].sort((a, b) => {
        if (a === DEFAULT_SUBCATEGORY) return -1;
        if (b === DEFAULT_SUBCATEGORY) return 1;
        return a.localeCompare(b);
      });
    },
    [rows, kind, storedSubs],
  );

  /** The sub-categories the filter offers, across the current category scope. */
  const filterSubCategories = React.useMemo(() => {
    const scope =
      categoryFilter === "all" || categoryFilter === "favorites"
        ? (Object.keys(CATEGORY_LABELS) as MockupCategory[])
        : [categoryFilter];
    const names = new Set<string>();
    for (const category of scope) {
      for (const name of subCategoriesForCategory(category)) names.add(name);
    }
    return [...names].sort((a, b) => {
      if (a === DEFAULT_SUBCATEGORY) return -1;
      if (b === DEFAULT_SUBCATEGORY) return 1;
      return a.localeCompare(b);
    });
  }, [categoryFilter, subCategoriesForCategory]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((m) => {
      if (
        categoryFilter === "favorites"
          ? !m.favorite
          : categoryFilter !== "all" && m.category !== categoryFilter
      ) {
        return false;
      }
      if (subFilter !== "all" && subCategoryOf(m) !== subFilter) return false;
      if (q && !m.name.toLowerCase().includes(q) && !m.tags.some((t) => t.toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [rows, query, categoryFilter, subFilter]);

  const handleFiles = async (files: File[]) => {
    let ok = 0;
    const errors: string[] = [];
    setUploading(files.length);
    for (const file of files) {
      const result = await createMockupFromFile(file, {
        category: uploadCategory,
        kind,
        subCategory: isInfo ? undefined : uploadSub,
        // An info card joins the end of its category's cards.
        infoCardOrder: isInfo ? Date.now() : undefined,
      });
      if (result.mockup) ok++;
      if (result.error) errors.push(result.error);
      setUploading((n) => n - 1);
    }
    if (ok > 0) {
      toast.success(
        `Uploaded ${ok} ${isInfo ? "info card" : "mockup"}${ok > 1 ? "s" : ""} to ${
          CATEGORY_LABELS[uploadCategory]
        }`,
      );
    }
    errors.slice(0, 3).forEach((e) => toast.error(e));
    if (errors.length > 3) toast.error(`${errors.length - 3} more files failed`);
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    await deleteMockup(confirmDelete.id);
    toast.success(`Deleted ${isInfo ? "info card" : "mockup"} "${confirmDelete.name}"`);
    setConfirmDelete(null);
  };

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((m) => map.set(m.category, (map.get(m.category) ?? 0) + 1));
    return map;
  }, [rows]);

  const openNewSub = (target: { mode: "upload" } | { mode: "card"; mockupId: string; category: MockupCategory }) => {
    setNewSubName("");
    setNewSub(target);
  };

  const saveNewSub = async () => {
    const name = newSubName.trim();
    if (!newSub || !name) return;
    const category = newSub.mode === "card" ? newSub.category : uploadCategory;
    await rememberSubCategory(category, name);
    if (newSub.mode === "card") {
      await updateMockup(newSub.mockupId, { subCategory: name });
    } else {
      setUploadSub(name);
    }
    setNewSub(null);
    toast.success(`Added the sub-category "${name}".`);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isInfo ? "Search info cards…" : "Search mockups…"}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="All"
            count={rows.length}
            active={categoryFilter === "all"}
            onClick={() => {
              setCategoryFilter("all");
              setSubFilter("all");
            }}
          />
          {(Object.keys(CATEGORY_LABELS) as MockupCategory[]).map((cat) => (
            <FilterChip
              key={cat}
              label={CATEGORY_LABELS[cat]}
              count={counts.get(cat) ?? 0}
              active={categoryFilter === cat}
              onClick={() => {
                setCategoryFilter(cat);
                setSubFilter("all");
              }}
            />
          ))}
          <FilterChip
            label="Favorites"
            count={rows.filter((m) => m.favorite).length}
            active={categoryFilter === "favorites"}
            onClick={() => {
              setCategoryFilter("favorites");
              setSubFilter("all");
            }}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Label htmlFor="upload-category" className="text-ink-muted">
            Upload as
          </Label>
          <Select
            value={uploadCategory}
            onValueChange={(v) => {
              setUploadCategory(v as MockupCategory);
              setUploadSub(DEFAULT_SUBCATEGORY);
            }}
          >
            <SelectTrigger id="upload-category" className="w-[140px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CATEGORY_LABELS) as MockupCategory[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* The sub-category is a user-created named template inside the main
              category. Info cards are filed under main categories only. */}
          {!isInfo && (
            <Select
              value={uploadSub}
              onValueChange={(v) => {
                if (v === NEW_SUBCATEGORY) {
                  openNewSub({ mode: "upload" });
                  return;
                }
                setUploadSub(v);
              }}
            >
              <SelectTrigger id="upload-subcategory" className="w-[160px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {subCategoriesForCategory(uploadCategory).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_SUBCATEGORY}>＋ New sub-category…</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {!isInfo && filterSubCategories.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <Label htmlFor="filter-subcategory" className="text-ink-muted">
            Sub-category
          </Label>
          <Select value={subFilter} onValueChange={setSubFilter}>
            <SelectTrigger id="filter-subcategory" className="w-[200px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sub-categories</SelectItem>
              {filterSubCategories.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <UploadDropzone
        label={
          uploading > 0
            ? `Processing ${uploading} file${uploading > 1 ? "s" : ""}…`
            : isInfo
              ? "Drop info card images here, or click to browse"
              : "Drop mockup photos here, or click to browse"
        }
        hint="PNG, JPEG or WebP · up to 40 MB each"
        onFiles={handleFiles}
        className="mb-4"
        compact
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={isInfo ? <Info /> : <Shapes />}
          title={
            rows.length > 0
              ? isInfo
                ? "No info cards match this filter"
                : "No mockups match this filter"
              : isInfo
                ? "No info cards yet"
                : "No mockups yet"
          }
          description={
            rows.length > 0
              ? "Try a different category, search, or clear the filter."
              : isInfo
                ? "Upload the information images that follow your product photos — a size chart, a “what you get” panel."
                : "Upload product photos; place designs on them in Printify Studio."
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((m) => {
            const subNames = subCategoriesForCategory(m.category);
            return (
              <Card key={m.id} className="group overflow-hidden">
                <div className="relative cursor-pointer" onClick={() => setDetail(m)}>
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
                      {m.width}×{m.height} · {isInfo ? "info card" : "user upload"}
                      {!isInfo ? ` · ${subCategoryOf(m)}` : ""}
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
                      {/* An info card is not a product photo, so it never gets a
                          print area. */}
                      {!isInfo && onOpenPrintArea && (
                        <DropdownMenuItem onClick={() => onOpenPrintArea(m.id)}>
                          <Crop /> Set the print area
                        </DropdownMenuItem>
                      )}
                      {!isInfo && (
                        <>
                          <DropdownMenuSeparator />
                          {subNames.map((name) => (
                            <DropdownMenuItem
                              key={name}
                              onClick={() => updateMockup(m.id, { subCategory: name })}
                            >
                              {name}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuItem
                            onClick={() =>
                              openNewSub({ mode: "card", mockupId: m.id, category: m.category })
                            }
                          >
                            ＋ New sub-category…
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-danger focus:bg-danger-soft"
                        onClick={() => setConfirmDelete(m)}
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
      )}

      {/* Detail dialog */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.width}×${detail.height} · ${CATEGORY_LABELS[detail.category]} · ${
                    isInfoCard(detail) ? "info card" : "uploaded"
                  } ${new Date(detail.createdAt).toLocaleDateString()}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <AssetThumb assetId={detail.assetId} className="max-h-[380px] w-full rounded-md bg-surface-muted" />
          )}
          <DialogFooter>
            {detail && !isInfo && onOpenPrintArea && (
              <Button size="sm" onClick={() => { if (detail) onOpenPrintArea(detail.id); setDetail(null); }}>
                Set the print area
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Delete &ldquo;{confirmDelete?.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              {isInfo
                ? "This info card is removed from the listings it follows."
                : "Placements using this mockup will be removed. Generated batch images already made are kept."}
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

      {/* The new sub-category dialog */}
      <Dialog open={!!newSub} onOpenChange={(o) => !o && setNewSub(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New sub-category</DialogTitle>
            <DialogDescription>
              A named template inside {newSub ? CATEGORY_LABELS[newSub.mode === "card" ? newSub.category : uploadCategory] : ""}.
              It is yours to name — “Hanging”, “Front flat”, “Lifestyle”.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newSubName}
            onChange={(e) => setNewSubName(e.target.value)}
            placeholder="Sub-category name"
            aria-label="Sub-category name"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setNewSub(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!newSubName.trim()} onClick={() => void saveNewSub()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
