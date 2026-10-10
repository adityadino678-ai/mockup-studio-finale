import Dexie, { type EntityTable } from "dexie";
import type {
  ActivityRecord,
  AssetMeta,
  BatchItem,
  BatchJob,
  BgRemovalRecord,
  Design,
  ExportJob,
  ListingDraft,
  Mockup,
  Placement,
  ProductDraft,
  Template,
} from "@/types/domain";

/**
 * Blobs are stored separately from metadata so listings/queries stay fast and
 * a future migration can move binaries to object storage without touching the
 * metadata model.
 */
export interface BlobRecord {
  id: string;
  blob: Blob;
}

export interface ThumbRecord {
  id: string;
  blob: Blob;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export class MockupStudioDB extends Dexie {
  assets!: EntityTable<AssetMeta, "id">;
  blobs!: EntityTable<BlobRecord, "id">;
  thumbs!: EntityTable<ThumbRecord, "id">;
  designs!: EntityTable<Design, "id">;
  mockups!: EntityTable<Mockup, "id">;
  placements!: EntityTable<Placement, "id">;
  bgRemovals!: EntityTable<BgRemovalRecord, "id">;
  batchJobs!: EntityTable<BatchJob, "id">;
  batchItems!: EntityTable<BatchItem, "id">;
  templates!: EntityTable<Template, "id">;
  productDrafts!: EntityTable<ProductDraft, "id">;
  listingDrafts!: EntityTable<ListingDraft, "id">;
  exports!: EntityTable<ExportJob, "id">;
  activity!: EntityTable<ActivityRecord, "id">;
  settings!: EntityTable<SettingRecord, "key">;

  constructor() {
    super("mockup-studio");
    this.version(1).stores({
      assets: "id, kind, parentId, createdAt",
      blobs: "id",
      thumbs: "id",
      designs: "id, name, createdAt, updatedAt, *tags",
      mockups: "id, name, category, source, favorite, createdAt, *tags",
      placements: "id, [designId+mockupId], designId, mockupId, updatedAt",
      bgRemovals: "id, designId, status, createdAt",
      batchJobs: "id, status, createdAt",
      batchItems: "id, jobId, designId, mockupId, status, [jobId+status]",
      templates: "id, name, category, updatedAt",
      productDrafts: "id, designId, status, updatedAt",
      listingDrafts: "id, status, productDraftId, designId, updatedAt",
      exports: "id, status, createdAt",
      activity: "id, createdAt, type",
      settings: "key",
    });
  }
}

export const db = new MockupStudioDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rec = await db.settings.get(key);
  return rec ? (rec.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
