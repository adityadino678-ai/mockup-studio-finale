import { db } from "./schema";
import {
  decodeImage,
  getImageInfo,
  makeThumbnail,
  sanitizeFilename,
  validateImageFile,
} from "@/lib/image/image";
import type {
  ActivityRecord,
  ActivityType,
  AssetKind,
  AssetMeta,
  Design,
  InkVariant,
  Mockup,
  MockupCategory,
  Placement,
  Transform,
} from "@/types/domain";
import { DEFAULT_TRANSFORM } from "@/types/domain";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function logActivity(
  type: ActivityType,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const rec: ActivityRecord = { id: uid(), type, message, meta, createdAt: Date.now() };
  await db.activity.add(rec);
  // Keep activity log bounded.
  const count = await db.activity.count();
  if (count > 2000) {
    const oldest = await db.activity.orderBy("createdAt").limit(count - 2000).toArray();
    await db.activity.bulkDelete(oldest.map((r) => r.id));
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function storeAsset(
  file: Blob,
  originalName: string,
  kind: AssetKind,
  opts: {
    parentId?: string;
    makeThumb?: boolean;
    sourceDesignId?: string;
    sourceMockupId?: string;
  } = {},
): Promise<AssetMeta> {
  const info = await getImageInfo(file);
  const id = uid();
  const meta: AssetMeta = {
    id,
    kind,
    name: sanitizeFilename(originalName),
    mime: file.type || "image/png",
    width: info.width,
    height: info.height,
    size: file.size,
    createdAt: Date.now(),
    parentId: opts.parentId,
    sourceDesignId: opts.sourceDesignId,
    sourceMockupId: opts.sourceMockupId,
  };
  await db.blobs.put({ id, blob: file });
  await db.assets.put(meta);
  if (opts.makeThumb !== false) {
    try {
      const thumb = await makeThumbnail(file);
      await db.thumbs.put({ id, blob: thumb });
    } catch {
      // Thumbnails are an optimization; ignore failures.
    }
  }
  return meta;
}

export async function getAssetBlob(assetId: string): Promise<Blob | undefined> {
  const rec = await db.blobs.get(assetId);
  return rec?.blob;
}

export async function getThumbBlob(assetId: string): Promise<Blob | undefined> {
  const rec = await db.thumbs.get(assetId);
  if (rec) return rec.blob;
  return getAssetBlob(assetId);
}

export async function deleteAsset(assetId: string): Promise<void> {
  await db.transaction("rw", db.assets, db.blobs, db.thumbs, async () => {
    await db.assets.delete(assetId);
    await db.blobs.delete(assetId);
    await db.thumbs.delete(assetId);
  });
}

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

export interface UploadDesignResult {
  design?: Design;
  error?: string;
}

export async function createDesignFromFile(file: File): Promise<UploadDesignResult> {
  const validation = validateImageFile(file);
  if (!validation.ok) {
    return { error: validation.error };
  }
  let meta: AssetMeta;
  try {
    meta = await storeAsset(file, file.name, "design-original");
  } catch (e) {
    return { error: `Could not read "${file.name}": ${e instanceof Error ? e.message : "unknown error"}` };
  }
  const now = Date.now();
  const design: Design = {
    id: uid(),
    name: meta.name.replace(/\.[^.]+$/, ""),
    tags: [],
    originalAssetId: meta.id,
    activeVariant: "main",
    createdAt: now,
    updatedAt: now,
  };
  await db.designs.put(design);
  await logActivity("design.upload", `Uploaded design "${design.name}" (${meta.width}×${meta.height})`, {
    designId: design.id,
  });
  return { design };
}

export async function createDesignFromBlob(
  blob: Blob,
  name: string,
  kind: AssetKind = "design-processed",
  parentId?: string,
): Promise<Design> {
  const meta = await storeAsset(blob, name, kind, { parentId });
  const now = Date.now();
  const design: Design = {
    id: uid(),
    name: meta.name.replace(/\.[^.]+$/, ""),
    tags: [],
    originalAssetId: meta.id,
    activeVariant: "main",
    createdAt: now,
    updatedAt: now,
  };
  await db.designs.put(design);
  await logActivity("design.upload", `Created design "${design.name}" from processed asset`);
  return design;
}

export async function updateDesign(designId: string, patch: Partial<Pick<Design, "name" | "tags" | "activeVariant">>): Promise<void> {
  const design = await db.designs.get(designId);
  if (!design) return;
  await db.designs.put({ ...design, ...patch, updatedAt: Date.now() });
  await logActivity("design.update", `Updated design "${design.name}"`);
}

export async function duplicateDesign(designId: string): Promise<Design | undefined> {
  const design = await db.designs.get(designId);
  if (!design) return undefined;
  const now = Date.now();
  const newId = uid();
  const copyAssets = async (assetId: string | undefined, kind: AssetKind): Promise<string | undefined> => {
    if (!assetId) return undefined;
    const blob = await getAssetBlob(assetId);
    if (!blob) return undefined;
    const srcMeta = await db.assets.get(assetId);
    const meta = await storeAsset(blob, srcMeta?.name ?? "asset.png", kind, { parentId: assetId });
    return meta.id;
  };
  const newDesign: Design = {
    ...design,
    id: newId,
    name: `${design.name} (copy)`,
    originalAssetId: (await copyAssets(design.originalAssetId, "design-original")) ?? design.originalAssetId,
    whiteInkAssetId: await copyAssets(design.whiteInkAssetId, "design-white-ink"),
    blackInkAssetId: await copyAssets(design.blackInkAssetId, "design-black-ink"),
    createdAt: now,
    updatedAt: now,
  };
  await db.designs.put(newDesign);
  await logActivity("design.update", `Duplicated design "${design.name}"`);
  return newDesign;
}

export async function deleteDesign(designId: string): Promise<void> {
  const design = await db.designs.get(designId);
  if (!design) return;
  const assetIds = [design.originalAssetId, design.whiteInkAssetId, design.blackInkAssetId].filter(
    (v): v is string => !!v,
  );
  // Also remove derived renders/processed assets.
  const derived = await db.assets.where("parentId").anyOf([...assetIds, designId]).toArray();
  const derivedIds = derived
    .filter((a) => a.kind === "design-processed" || a.kind === "mockup-render")
    .map((a) => a.id);
  await db.transaction(
    "rw",
    [
      db.designs,
      db.assets,
      db.blobs,
      db.thumbs,
      db.placements,
      db.batchItems,
      db.bgRemovals,
      db.productDrafts,
      db.listingDrafts,
    ],
    async () => {
      await db.designs.delete(designId);
      for (const id of [...assetIds, ...derivedIds]) await deleteAsset(id);
      await db.placements.where("designId").equals(designId).delete();
      await db.bgRemovals.where("designId").equals(designId).delete();
      await db.productDrafts.where("designId").equals(designId).delete();
      await db.listingDrafts.where("designId").equals(designId).delete();
      // Detach (not delete) batch items referencing this design.
      await db.batchItems.where("designId").equals(designId).modify({ status: "cancelled", error: "Design deleted" });
    },
  );
  await logActivity("design.delete", `Deleted design "${design.name}"`);
}

export function designAssetIdFor(design: Design, variant: InkVariant): string {
  const mainAsset = design.processedAssetId ?? design.originalAssetId;
  if (variant === "white" && design.whiteInkAssetId) return design.whiteInkAssetId;
  if (variant === "black" && design.blackInkAssetId) return design.blackInkAssetId;
  return mainAsset;
}

/** The asset shown/placed as the design's main artwork. */
export function designMainAssetId(design: Design): string {
  return design.processedAssetId ?? design.originalAssetId;
}

export async function setInkVariantAsset(
  designId: string,
  variant: "white" | "black",
  blob: Blob,
  name: string,
): Promise<string> {
  const design = await db.designs.get(designId);
  if (!design) throw new Error("Design not found");
  const meta = await storeAsset(blob, name, variant === "white" ? "design-white-ink" : "design-black-ink", {
    parentId: design.originalAssetId,
  });
  const patch = variant === "white" ? { whiteInkAssetId: meta.id } : { blackInkAssetId: meta.id };
  await db.designs.put({ ...design, ...patch, updatedAt: Date.now() });
  await logActivity("ink.variant", `Set ${variant} ink variant for "${design.name}"`);
  return meta.id;
}

// ---------------------------------------------------------------------------
// Mockups
// ---------------------------------------------------------------------------

export interface UploadMockupResult {
  mockup?: Mockup;
  error?: string;
}

export async function createMockupFromFile(file: File, category: MockupCategory = "other"): Promise<UploadMockupResult> {
  const validation = validateImageFile(file);
  if (!validation.ok) {
    return { error: validation.error };
  }
  let meta: AssetMeta;
  try {
    meta = await storeAsset(file, file.name, "mockup");
  } catch (e) {
    return { error: `Could not read "${file.name}": ${e instanceof Error ? e.message : "unknown error"}` };
  }
  const mockup: Mockup = {
    id: uid(),
    name: meta.name.replace(/\.[^.]+$/, ""),
    category,
    tags: [],
    favorite: false,
    assetId: meta.id,
    width: meta.width,
    height: meta.height,
    source: "user",
    createdAt: Date.now(),
  };
  await db.mockups.put(mockup);
  await logActivity("mockup.upload", `Uploaded mockup "${mockup.name}" (${meta.width}×${meta.height})`);
  return { mockup };
}

export async function updateMockup(
  mockupId: string,
  patch: Partial<Pick<Mockup, "name" | "category" | "tags" | "favorite">>,
): Promise<void> {
  const mockup = await db.mockups.get(mockupId);
  if (!mockup) return;
  await db.mockups.put({ ...mockup, ...patch });
}

export async function deleteMockup(mockupId: string): Promise<void> {
  const mockup = await db.mockups.get(mockupId);
  if (!mockup) return;
  await db.transaction(
    "rw",
    [db.mockups, db.assets, db.blobs, db.thumbs, db.placements, db.batchItems],
    async () => {
    await db.mockups.delete(mockupId);
    await deleteAsset(mockup.assetId);
    await db.placements.where("mockupId").equals(mockupId).delete();
    await db.batchItems.where("mockupId").equals(mockupId).modify({ status: "cancelled", error: "Mockup deleted" });
  });
  await logActivity("mockup.delete", `Deleted mockup "${mockup.name}"`);
}

// ---------------------------------------------------------------------------
// Placements (editor saves)
// ---------------------------------------------------------------------------

export async function savePlacement(params: {
  designId: string;
  mockupId: string;
  designAssetId: string;
  transform: Transform;
  behindMockup?: boolean;
  name?: string;
}): Promise<Placement> {
  const existing = await db.placements
    .where("[designId+mockupId]")
    .equals([params.designId, params.mockupId])
    .first();
  const now = Date.now();
  const design = await db.designs.get(params.designId);
  const placement: Placement = existing
    ? {
        ...existing,
        designAssetId: params.designAssetId,
        transform: params.transform,
        behindMockup: params.behindMockup ?? false,
        updatedAt: now,
      }
    : {
        id: uid(),
        name: params.name ?? `${design?.name ?? "Design"} placement`,
        designId: params.designId,
        mockupId: params.mockupId,
        designAssetId: params.designAssetId,
        transform: params.transform,
        behindMockup: params.behindMockup ?? false,
        createdAt: now,
        updatedAt: now,
      };
  await db.placements.put(placement);
  await logActivity("placement.save", `Saved placement for "${design?.name ?? "design"}"`);
  return placement;
}

export async function getPlacement(designId: string, mockupId: string): Promise<Placement | undefined> {
  return db.placements.where("[designId+mockupId]").equals([designId, mockupId]).first();
}

export function defaultPlacementFor(designId: string, mockupId: string, designAssetId: string): Placement {
  const now = Date.now();
  return {
    id: uid(),
    name: "Untitled placement",
    designId,
    mockupId,
    designAssetId,
    transform: { ...DEFAULT_TRANSFORM },
    createdAt: now,
    updatedAt: now,
  };
}
