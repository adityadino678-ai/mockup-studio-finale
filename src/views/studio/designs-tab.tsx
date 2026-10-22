"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import {
  createDesignFromFile,
  deleteDesign,
  designAssetIdFor,
  duplicateDesign,
  getAssetBlob,
  logActivity,
  storeAsset,
  updateDesign,
} from "@/lib/db/repo";
import { removeBackgroundAuto } from "@/lib/printify/remove-background";
import {
  pairForDesign,
  planDesignColours,
  planPairedDesignColours,
  setInkPairRole,
  withInkPair,
  withoutInkPair,
} from "@/lib/printify/design-colours";
import {
  DesignGallery,
  productColourGroups,
  splitDesignsForSession,
  swatchesForPlan,
  type DesignColours,
  type DesignSwatch,
} from "@/views/studio/design-panel";
import type { DesignCardData } from "@/components/studio/design-card";
import { EditDesignDialog } from "@/components/studio/edit-design-dialog";
import { InkVariantsDialog } from "@/components/studio/ink-variants-dialog";
import { UploadDropzone } from "@/components/upload-dropzone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hexForColourName, suggestInk } from "@/lib/printify/colors";
import { ROWS } from "@/lib/printify/studio-session";
import type { Design, StudioRowId, StudioSession } from "@/types/domain";
import { Loader2, Link2, Search, Trash2, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DesignRow {
  id: string;
  name: string;
  tags: string[];
  originalAssetId: string;
  processedAssetId?: string;
  whiteInkAssetId?: string;
  blackInkAssetId?: string;
  createdAt: number;
  dimensions: string;
}

interface DesignsTabProps {
  session: StudioSession;
  /** Update the session - the ticked designs ARE the batch scope. */
  update: (patch: Partial<StudioSession>) => void;
  /** The resolved swatches for a row, so each design shows its colours. */
  swatchesForRow: (row: StudioRowId) => DesignSwatch[];
}

/**
 * How long a stage of the work stays on screen.
 *
 * The engine reports its stages as it works and more than one can arrive
 * within the same frame. A stage that is replaced before it was painted is a
 * stage the user never sees, so every stage stays up for a moment and the
 * next one waits its turn.
 */
const MIN_STAGE_MS = 900;

export function DesignsTab({ session, update, swatchesForRow }: DesignsTabProps) {
  const [uploading, setUploading] = React.useState(0);
  const [busy, setBusy] = React.useState<{
    done: number;
    total: number;
    current: string;
  } | null>(null);
  /** The search box and the tag chips, ported from the old Designs page. */
  const [query, setQuery] = React.useState("");
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<DesignRow | null>(null);
  const [inkDialogId, setInkDialogId] = React.useState<string | null>(null);
  const [inkRecord, setInkRecord] = React.useState<Design | null>(null);
  /** The stage of the work, as the engine reports it. */
  const [stage, setStage] = React.useState("");
  const stageQueue = React.useRef<string[]>([]);
  const stageShownAt = React.useRef(0);
  const stageTimer = React.useRef<number | null>(null);

  /**
   * Shows a stage of the work and keeps it up long enough to read it.
   *
   * The stages are queued rather than replaced: one that arrives while
   * another is on screen waits for its turn, so a message is never swallowed
   * by the step that follows it.
   */
  const showStage = React.useCallback((next: string) => {
    stageQueue.current.push(next);
    if (stageTimer.current !== null) return;
    const wait = Math.max(0, MIN_STAGE_MS - (Date.now() - stageShownAt.current));
    const pump = () => {
      const pending = stageQueue.current.shift();
      if (pending === undefined) {
        stageTimer.current = null;
        return;
      }
      setStage(pending);
      stageShownAt.current = Date.now();
      if (stageQueue.current.length > 0) {
        stageTimer.current = window.setTimeout(pump, MIN_STAGE_MS);
      } else {
        stageTimer.current = null;
      }
    };
    if (wait === 0) {
      pump();
    } else {
      stageTimer.current = window.setTimeout(pump, wait);
    }
  }, []);

  /** Throws the queued stages away - the run they belonged to is over. */
  const resetStages = React.useCallback(() => {
    if (stageTimer.current !== null) {
      window.clearTimeout(stageTimer.current);
      stageTimer.current = null;
    }
    stageQueue.current = [];
    stageShownAt.current = 0;
    setStage("");
  }, []);

  /**
   * The ticked designs are the batch the Design panel will create. It lives
   * in the session so the other tab can see it - and so the scope survives a
   * reload instead of silently becoming "every design".
   */
  const selected = session.designIds;

  const setSelected = (ids: string[]) => update({ designIds: ids });

  /** The designs the user marked as "has ink variants". */
  const inkPairIds = React.useMemo(() => session.inkPairIds ?? [], [session.inkPairIds]);
  /** The pairs of designs that print as ONE listing. */
  const inkPairs = React.useMemo(() => session.inkPairs ?? [], [session.inkPairs]);

  const toggleInkPair = (id: string) => {
    if (inkPairIds.includes(id)) {
      // Unticking one half of a pair breaks the pair: half of it would print
      // nothing, and the box says "this design has ink artwork", which is no
      // longer true.
      const found = pairForDesign(inkPairs, id);
      const members = found
        ? [found.pair.blackInkDesignId, found.pair.whiteInkDesignId]
        : [id];
      update({
        inkPairIds: inkPairIds.filter((x) => !members.includes(x)),
        inkPairs: withoutInkPair(inkPairs, id),
      });
      return;
    }
    update({ inkPairIds: [...inkPairIds, id] });
  };

  /**
   * Pairs two designs as ONE listing.
   *
   * The first id becomes the black-ink half (and therefore owns the title,
   * price and placement); the other becomes the white-ink half. The roles are
   * swappable on the cards, and nothing about the artwork infers which is
   * which.
   *
   * Both halves are also added to the batch scope: a pair IS a listing, so
   * leaving one half out of the batch would create nothing for it.
   */
  const pairTwo = (blackId: string, whiteId: string) => {
    if (!blackId || !whiteId || blackId === whiteId) return;
    const existing = pairForDesign(inkPairs, blackId);
    if (
      existing &&
      (existing.pair.blackInkDesignId === whiteId || existing.pair.whiteInkDesignId === whiteId)
    ) {
      toast.info("Those two designs are already paired.");
      return;
    }
    update({
      inkPairs: withInkPair(inkPairs, blackId, whiteId),
      inkPairIds: [...new Set([...inkPairIds, blackId, whiteId])],
      designIds: [...new Set([...selected, blackId, whiteId])],
    });
    toast.success(
      "Paired as one listing — use the Black ink / White ink boxes to set each design's role",
    );
  };

  /** The two ticked designs, from the batch checkboxes. */
  const pairSelected = () => {
    if (selected.length !== 2) return;
    pairTwo(selected[0], selected[1]);
  };

  /** Moves a paired design to the other half of its pair. */
  const setRole = (id: string, role: "black" | "white") => {
    update({ inkPairs: setInkPairRole(inkPairs, id, role) });
  };

  /** Breaks the pair a design belongs to. */
  const unpair = (id: string) => {
    const found = pairForDesign(inkPairs, id);
    if (!found) return;
    const members = [found.pair.blackInkDesignId, found.pair.whiteInkDesignId];
    update({
      inkPairs: withoutInkPair(inkPairs, id),
      inkPairIds: inkPairIds.filter((x) => !members.includes(x)),
    });
    toast.success("Pair broken — both designs are back in the no-ink-variants row");
  };

  const designs = useLiveQuery(async () => {
    const all = await db.designs.toArray();
    const metas = await db.assets.bulkGet(all.map((d) => d.originalAssetId));
    const metaMap = new Map(metas.filter(Boolean).map((m) => [m!.id, m!]));
    return all
      .map((d) => {
        const meta = metaMap.get(d.originalAssetId);
        return {
          id: d.id,
          name: d.name,
          tags: d.tags,
          originalAssetId: d.originalAssetId,
          processedAssetId: d.processedAssetId,
          whiteInkAssetId: d.whiteInkAssetId,
          blackInkAssetId: d.blackInkAssetId,
          createdAt: d.createdAt,
          dimensions: meta ? `${meta.width}×${meta.height}` : "—",
        } satisfies DesignRow;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }, []);

  /** The design whose ink artwork the dialog edits, read fresh from the DB. */
  React.useEffect(() => {
    let cancelled = false;
    if (!inkDialogId) {
      setInkRecord(null);
      return;
    }
    (async () => {
      const record = await db.designs.get(inkDialogId);
      if (!cancelled) setInkRecord(record ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [inkDialogId]);

  /** Every tag in the library, for the filter chips. */
  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    designs?.forEach((d) => d.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [designs]);

  /** The designs the search and the tag filter leave visible. */
  const visible = React.useMemo(() => {
    if (!designs) return undefined;
    const q = query.trim().toLowerCase();
    return designs.filter((d) => {
      if (tagFilter && !d.tags.includes(tagFilter)) return false;
      if (q && !d.name.toLowerCase().includes(q) && !d.tags.some((t) => t.includes(q))) return false;
      return true;
    });
  }, [designs, query, tagFilter]);

  /** The partner's name and this design's role, for the card. */
  const pairInfo = React.useCallback(
    (id: string) => {
      const found = pairForDesign(inkPairs, id);
      if (!found) return undefined;
      const partnerId =
        found.role === "black" ? found.pair.whiteInkDesignId : found.pair.blackInkDesignId;
      const partner = (designs ?? []).find((d) => d.id === partnerId);
      return { partnerName: partner?.name ?? "a deleted design", role: found.role };
    },
    [inkPairs, designs],
  );

  /**
   * The gallery split into the two rows.
   *
   * The split is the user's own ticks - nothing about the product, and
   * nothing about the ink artwork on file, moves a design between the rows.
   */
  const rows = React.useMemo(() => {
    const split = splitDesignsForSession(visible ?? [], session);
    return { plain: split.plain, ink: split.ink } as Record<StudioRowId, DesignRow[]>;
  }, [visible, session]);

  /**
   * The hex of every colour of the product.
   *
   * The swatches come from the page, which knows the real hexes of the
   * product; this map lets a design find the hex of a colour it prints on
   * whichever row that colour happens to live in.
   */
  const hexByColour = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of ROWS) {
      for (const swatch of swatchesForRow(row)) map.set(swatch.name, swatch.hex);
    }
    return map;
  }, [swatchesForRow]);

  /**
   * What each design prints on, for its card.
   *
   * A design the user did NOT pair prints its MAIN artwork on every colour of
   * the product; a paired one prints its main artwork on the plain colours and
   * its ink artwork on the ink ones. The card shows the colours either way, so
   * the user can see what each design will be printed on.
   */
  const designColours = React.useCallback(
    (design: DesignCardData): DesignColours => {
      const groups = productColourGroups(session);
      const pair = pairForDesign(inkPairs, design.id);
      const plan = pair
        ? planPairedDesignColours(pair.role, groups)
        : planDesignColours(
            {
              hasInkPair: inkPairIds.includes(design.id),
              hasBlackInk: Boolean(design.blackInkAssetId),
              hasWhiteInk: Boolean(design.whiteInkAssetId),
            },
            groups,
          );
      const hexFor = (name: string) => hexByColour.get(name) ?? hexForColourName(name);
      return { colors: plan.colors, swatches: swatchesForPlan(plan, hexFor) };
    },
    [session, hexByColour, inkPairIds, inkPairs],
  );

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

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
  };

  /**
   * Removes the background of every selected design, one at a time.
   *
   * The work is CPU-bound, so it is done sequentially with a yield between
   * designs: otherwise the progress bar never paints and the tab freezes.
   *
   * There is exactly one remover: the flood key for a solid background, then
   * the border model for a faded one. Both are local, need no key and have no
   * limit, and the engine throws a message the user can act on when the image
   * is outside what they can do.
   */
  const removeBackgrounds = async (ids: string[] = selected) => {
    if (ids.length === 0) return;
    setBusy({ done: 0, total: ids.length, current: "" });
    resetStages();
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      const design = await db.designs.get(id);
      if (!design) {
        done++;
        continue;
      }
      setBusy((b) => (b ? { ...b, current: design.name } : b));
      resetStages();
      try {
        // The ORIGINAL file, never the cutout: re-running on a transparent
        // image would have nothing left to remove.
        const blob = await getAssetBlob(design.originalAssetId);
        if (!blob) throw new Error(`Could not read "${design.name}" from storage`);
        const out = await removeBackgroundAuto(blob, { onProgress: showStage });
        // The engine does the honest checks itself - "nothing was removed"
        // and "the artwork itself was the background" are both thrown as
        // messages that are safe to show, so all that is left here is to
        // name the design the message is about.
        const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
          parentId: design.originalAssetId,
        });
        await db.designs.update(design.id, {
          processedAssetId: asset.id,
          updatedAt: Date.now(),
        });
        await logActivity(
          "bgremoval.run",
          `Removed background from "${design.name}" with the ${out.engine} engine (${Math.round(out.removed * 100)}% of pixels changed)`,
        );
      } catch (e) {
        failed++;
        const message = e instanceof Error ? e.message : `Could not process "${design.name}"`;
        toast.error(
          message.startsWith(`"${design.name}"`) ? message : `"${design.name}": ${message}`,
        );
      }
      done++;
      setBusy({ done, total: ids.length, current: design.name });
      // Let the browser paint the progress bar.
      await new Promise((r) => setTimeout(r, 0));
    }
    // The last stage ("Done") has to be seen before the box goes away.
    await new Promise((r) => setTimeout(r, MIN_STAGE_MS));
    setBusy(null);
    resetStages();
    if (failed === 0) {
      toast.success(`Removed the background from ${done} design${done > 1 ? "s" : ""}`);
      setSelected(selected.filter((id) => !ids.includes(id)));
    } else {
      toast.error(`${failed} of ${done} failed`);
    }
  };

  const removeSelected = async () => {
    if (selected.length === 0) return;
    for (const id of selected) await deleteDesign(id);
    toast.success(`Deleted ${selected.length} design${selected.length > 1 ? "s" : ""}`);
    setSelected([]);
  };

  /** Deletes ONE design, from that card's menu. */
  const removeOne = async (id: string) => {
    const row = (designs ?? []).find((d) => d.id === id);
    await deleteDesign(id);
    setSelected(selected.filter((x) => x !== id));
    toast.success(row ? `Deleted "${row.name}"` : "Design deleted");
  };

  /**
   * Saves the artwork of the design's ACTIVE variant.
   *
   * `designAssetIdFor` is the same choice the batch renderer makes, so
   * what is downloaded is what would be printed.
   */
  const downloadDesign = async (id: string) => {
    const design = await db.designs.get(id);
    if (!design) return;
    const blob = await getAssetBlob(designAssetIdFor(design, design.activeVariant));
    if (!blob) {
      toast.error("Could not read that design from storage");
      return;
    }
    const ext =
      blob.type === "image/jpeg" ? "jpg" : blob.type.startsWith("image/") ? blob.type.split("/")[1] : "png";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${design.name}.${ext || "png"}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`Downloaded "${design.name}"`);
  };

  const duplicateOne = async (id: string) => {
    const copy = await duplicateDesign(id);
    if (copy) toast.success(`Duplicated "${copy.name}"`);
    else toast.error("Could not duplicate that design");
  };

  const saveEdit = async (name: string, tags: string[]) => {
    if (!editing) return;
    await updateDesign(editing.id, { name, tags });
    setEditing(null);
    toast.success("Design updated");
  };

  /**
   * Pairs of handlers for a gallery row, so the two rows cannot wire the
   * actions up differently.
   *
   * The ink dialog is per-design, so it resolves the record itself; the other
   * actions already take an id.
   */
  const cardActions = {
    onEditDesign: (id: string) => setEditing((designs ?? []).find((d) => d.id === id) ?? null),
    onInkVariants: (id: string) => setInkDialogId(id),
    onRemoveBackground: (id: string) => removeBackgrounds([id]),
    onDownload: (id: string) => downloadDesign(id),
    onDuplicate: (id: string) => duplicateOne(id),
    onDelete: (id: string) => removeOne(id),
  };

  /**
   * Ticks every design, or clears the tick.
   *
   * Only the batch scope: "Ink variants" is a per-design decision and is
   * never applied in bulk, because that is exactly the guess this page no
   * longer makes.
   */
  const toggleAll = () => {
    if (selected.length === (designs ?? []).length) setSelected([]);
    else setSelected((designs ?? []).map((d) => d.id));
  };

  return (
    <div className="space-y-5 pb-16">
      <UploadDropzone
        label={
          uploading > 0
            ? `Processing ${uploading} file${uploading > 1 ? "s" : ""}…`
            : "Drop designs here, or click to browse"
        }
        hint="PNG, JPEG or WebP · up to 40 MB each · multiple files welcome"
        onFiles={handleFiles}
      />

      {busy && (
        <div
          className="rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-card"
          data-bg-progress=""
        >
          <div className="flex items-center gap-2 text-[13px] text-ink">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="truncate">
              {busy.current ? `Removing background from "${busy.current}"` : "Working…"}
            </span>
            <span className="ml-auto shrink-0 text-ink-subtle">
              {busy.done} / {busy.total}
            </span>
          </div>
          {stage && (
            <p className="mt-1 pl-[22px] text-[11px] text-ink-muted" data-bg-stage="">
              {stage}
            </p>
          )}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-forest transition-[width] duration-200"
              style={{ width: `${Math.round((busy.done / Math.max(1, busy.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {selected.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-forest/25 bg-sage-soft px-4 py-3 shadow-card">
          <span className="text-[13px] font-medium text-ink">
            {selected.length} design{selected.length > 1 ? "s" : ""} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => removeBackgrounds()} disabled={!!busy}>
              <Wand2 className="h-3.5 w-3.5" /> Remove background
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={pairSelected}
              disabled={selected.length !== 2}
              title={
                selected.length === 2
                  ? "Print these two designs on one listing: the first is the black-ink half"
                  : "Tick exactly two designs to pair them"
              }
            >
              <Link2 className="h-3.5 w-3.5" /> Pair for one listing
            </Button>
            <Button size="sm" variant="outline" onClick={toggleAll}>
              {selected.length === (designs ?? []).length ? "Clear" : "Select all"}
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={removeSelected}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        </div>
      )}

      {(designs ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-design-search="">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search designs and tags…"
              aria-label="Search designs and tags"
              className="pl-8"
            />
          </div>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              className={cn(
                "cursor-pointer rounded-full border px-2.5 py-0.5 text-[12px] transition-colors",
                tagFilter === tag
                  ? "border-forest bg-forest text-white"
                  : "border-border-strong text-ink-muted hover:bg-surface-muted",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {visible && visible.length === 0 && (designs ?? []).length > 0 ? (
        // A filter that matches nothing says so. The two rows would both read
        // "no designs yet", which is not what happened.
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-muted/40 px-4 py-3">
          <p className="text-[12px] font-medium text-ink">No designs match</p>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            Try a different search or clear the tag filter.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              setQuery("");
              setTagFilter(null);
            }}
          >
            Clear search
          </Button>
        </div>
      ) : (
        ROWS.map((row) => (
          <DesignGallery
            key={row}
            row={row}
            designs={rows[row]}
            swatches={swatchesForRow(row)}
            designColours={designColours}
            selectedIds={selected}
            showCheckbox
            onToggle={toggle}
            inkPairIds={inkPairIds}
            onToggleInkPair={toggleInkPair}
            pairInfo={pairInfo}
            onSetInkRole={setRole}
            onUnpair={unpair}
            onPairInk={pairTwo}
            {...cardActions}
          />
        ))
      )}

      <EditDesignDialog design={editing} onClose={() => setEditing(null)} onSave={saveEdit} />

      {inkRecord && (
        <InkVariantsDialog design={inkRecord} onClose={() => setInkDialogId(null)} />
      )}
    </div>
  );
}

/** The swatches a design's colours resolve to, used by the design cards. */
export function swatchesForColors(
  colors: string[],
  blackInkColors: string[],
  hasInkVariants: boolean,
): DesignSwatch[] {
  return colors.map((name) => {
    const hex = hexForColourName(name);
    if (!hasInkVariants) return { name, hex };
    const ink = blackInkColors.includes(name) ? "black" : "white";
    return { name, hex, ink };
  });
}

/** The ink a colour would use by default, from the colour's own lightness. */
export function autoInkForColor(name: string): "black" | "white" | "ambiguous" {
  return suggestInk(hexForColourName(name));
}
