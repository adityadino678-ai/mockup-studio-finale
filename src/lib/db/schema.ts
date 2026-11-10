import Dexie, { type EntityTable } from "dexie";
import type {
  ActivityRecord,
  AssetMeta,
  BatchItem,
  BatchJob,
  BgRemovalRecord,
  ChatMessage,
  Conversation,
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

/**
 * Where an interrupted local export left off. The handle is a
 * FileSystemDirectoryHandle - structured-clonable, so IndexedDB stores it
 * directly and Dexie needs no extra typing.
 */
export interface ExportHandleRecord {
  id: string;
  handle: FileSystemDirectoryHandle;
  startedAt: number;
  donePaths: string[];
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
  conversations!: EntityTable<Conversation, "id">;
  messages!: EntityTable<ChatMessage, "id">;
  exportHandles!: EntityTable<ExportHandleRecord, "id">;

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
    // v2: add render provenance indexes for batch dedupe and export queries.
    this.version(2).stores({
      assets: "id, kind, parentId, sourceDesignId, sourceMockupId, createdAt",
    });
    // v3: agent chat history (local-first; never stored on the server).
    this.version(3).stores({
      conversations: "id, updatedAt, createdAt, pinned",
      messages: "id, conversationId, createdAt, [conversationId+createdAt]",
    });
    // v4: review-gated listing autopilot runs. They hold the review state,
    // not the products: a run can be resumed after a reload.
    this.version(4).stores({
      autopilotRuns: "id, status, stage, updatedAt",
    });
    // v5: the Autopilot page, engine and its stored runs are gone. Dexie
    // deletes a table by naming it with `null`; the v4 block stays because an
    // installed v4 database still has to upgrade through it.
    this.version(5).stores({ autopilotRuns: null });
    // v6: resume state for the local export (Settings -> Local storage). One
    // tiny table; the handle itself is the payload, so no indexes beyond the key.
    this.version(6).stores({ exportHandles: "id" });
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
