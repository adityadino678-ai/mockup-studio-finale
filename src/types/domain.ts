// ---------------------------------------------------------------------------
// Mockup Studio — domain types
// Stable identifiers are string UUIDs. Image binary data lives in the blobs
// table, keyed by asset id; everything else is metadata.
// ---------------------------------------------------------------------------

export type AssetKind =
  | "design-original"
  | "design-processed"
  | "design-white-ink"
  | "design-black-ink"
  | "mockup"
  | "mockup-render";

export interface AssetMeta {
  id: string;
  kind: AssetKind;
  /** Sanitized base filename (no path), with extension. */
  name: string;
  mime: string;
  width: number;
  height: number;
  /** Bytes. */
  size: number;
  createdAt: number;
  /** For processed/variant/render assets: the asset this derives from. */
  parentId?: string;
  /** For mockup-render assets: which design produced this render. */
  sourceDesignId?: string;
  /** For mockup-render assets: which mockup was used. */
  sourceMockupId?: string;
}

export type InkVariant = "main" | "white" | "black";

export interface Design {
  id: string;
  name: string;
  tags: string[];
  originalAssetId: string;
  whiteInkAssetId?: string;
  blackInkAssetId?: string;
  /** Which variant is used by default in editor/batch outputs. */
  activeVariant: InkVariant;
  createdAt: number;
  updatedAt: number;
}

export type MockupCategory =
  | "tshirt"
  | "hoodie"
  | "mug"
  | "poster"
  | "tote"
  | "sticker"
  | "other";

export interface Mockup {
  id: string;
  name: string;
  category: MockupCategory;
  tags: string[];
  favorite: boolean;
  assetId: string;
  width: number;
  height: number;
  /** user = uploaded by the user; provider = fetched from an external provider. */
  source: "user" | "provider";
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Placement / transform — mockup-relative units so placements survive canvas
// resize and can be reused across mockups via templates.
// ---------------------------------------------------------------------------

export interface Transform {
  /** Design center X as a fraction of mockup width (0..1). */
  x: number;
  /** Design center Y as a fraction of mockup height (0..1). */
  y: number;
  /** Design width as a fraction of mockup width. */
  scale: number;
  /** Rotation in degrees, clockwise. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** 0..1 */
  opacity: number;
  /** Vertical stretch multiplier (1 = aspect locked). */
  stretch: number;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.45,
  scale: 0.35,
  rotation: 0,
  flipX: false,
  flipY: false,
  opacity: 1,
  stretch: 1,
};

export interface Placement {
  id: string;
  name: string;
  designId: string;
  mockupId: string;
  /** The specific asset placed (main design or an ink variant). */
  designAssetId: string;
  transform: Transform;
  /** Render the design behind a transparent mockup PNG (e.g. folded garments). */
  behindMockup?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Batch jobs
// ---------------------------------------------------------------------------

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed-with-errors"
  | "cancelled"
  | "failed";

export type ItemStatus = "pending" | "processing" | "done" | "failed" | "cancelled";

export interface BatchJob {
  id: string;
  name: string;
  status: JobStatus;
  /** Max items processed concurrently. */
  concurrency: number;
  /** Ink variant applied to all designs in the job, unless overridden per item. */
  variantRule: InkVariant;
  createdAt: number;
  updatedAt: number;
}

export interface BatchItem {
  /** `${jobId}:${designId}:${mockupId}:${designAssetId}` */
  id: string;
  jobId: string;
  designId: string;
  mockupId: string;
  designAssetId: string;
  status: ItemStatus;
  outputAssetId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type BgRemovalJobStatus =
  | "pending"
  | "processing"
  | "done"
  | "failed";

export interface BgRemovalRecord {
  id: string;
  designId: string;
  sourceAssetId: string;
  status: BgRemovalJobStatus;
  outputAssetId?: string;
  error?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateCategory =
  | "placement"
  | "mockup-collection"
  | "product"
  | "ink-rules"
  | "listing"
  | "workflow"
  | "seo";

export interface PlacementTemplatePayload {
  type: "placement";
  transform: Transform;
  /** Whether the template also pins which mockups it applies to. */
  mockupIds?: string[];
}

export interface MockupCollectionTemplatePayload {
  type: "mockup-collection";
  mockupIds: string[];
}

export interface InkRulesTemplatePayload {
  type: "ink-rules";
  /** Variant to use per output context. */
  batchVariant: InkVariant;
  perMockupVariant?: Record<string, InkVariant>;
}

export interface ListingTemplatePayload {
  type: "listing";
  titlePattern?: string;
  descriptionPattern?: string;
  tags: string[];
  priceCents?: number;
}

export interface WorkflowTemplatePayload {
  type: "workflow";
  steps: string[];
  placementTemplateId?: string;
  mockupCollectionTemplateId?: string;
  inkRulesTemplateId?: string;
}

export interface SeoTemplatePayload {
  type: "seo";
  niche?: string;
  audience?: string;
  season?: string;
  keywords: string[];
  titleDrafts: string[];
  descriptionDraft?: string;
  tags: string[];
  savedAt: number;
}

export type TemplatePayload =
  | PlacementTemplatePayload
  | MockupCollectionTemplatePayload
  | InkRulesTemplatePayload
  | ListingTemplatePayload
  | WorkflowTemplatePayload
  | SeoTemplatePayload;

export interface Template {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  version: number;
  payload: TemplatePayload;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Product drafts (Printify) and listing drafts (Etsy)
// ---------------------------------------------------------------------------

export type ProductDraftStatus =
  | "local-draft"
  | "ready"
  | "created-remote"
  | "publish-error";

export interface ProductDraft {
  id: string;
  name: string;
  designId: string;
  designAssetId: string;
  /** Printify blueprint id, once selected. */
  blueprintId?: number;
  printProviderId?: number;
  variantSelection: Record<string, unknown>;
  printAreaConfig: Record<string, unknown>;
  status: ProductDraftStatus;
  /** Populated after remote creation. */
  remoteProductId?: string;
  remotePermalink?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type ListingDraftStatus =
  | "local-draft"
  | "validation-error"
  | "submitting"
  | "submitted"
  | "active"
  | "submission-failed";

export interface ListingDraft {
  id: string;
  title: string;
  description: string;
  /** Etsy allows 13 tags of 20 characters each. */
  tags: string[];
  category?: string;
  priceCents?: number;
  quantity?: number;
  productDraftId?: string;
  designId?: string;
  /** Asset ids for the images attached to this listing. */
  imageAssetIds: string[];
  status: ListingDraftStatus;
  error?: string;
  /** Set when the draft exists on Etsy. */
  remoteListingId?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface ExportSelection {
  designIds: string[];
  includeMain: boolean;
  includeWhiteInk: boolean;
  includeBlackInk: boolean;
  includeMockupRenders: boolean;
  includeListings: boolean;
}

export interface ExportedFileRecord {
  path: string;
  size: number;
}

export interface ExportJob {
  id: string;
  name: string;
  selection: ExportSelection;
  status: JobStatus | "packing" | "verifying";
  files: ExportedFileRecord[];
  missingAssets: string[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

// ---------------------------------------------------------------------------
// Activity + settings
// ---------------------------------------------------------------------------

export type ActivityType =
  | "design.upload"
  | "design.delete"
  | "design.update"
  | "mockup.upload"
  | "mockup.delete"
  | "placement.save"
  | "batch.start"
  | "batch.item"
  | "bgremoval.run"
  | "ink.variant"
  | "template.apply"
  | "export.run"
  | "product.create"
  | "listing.submit"
  | "integration.test"
  | "error";

export interface ActivityRecord {
  id: string;
  type: ActivityType;
  message: string;
  meta?: Record<string, unknown>;
  createdAt: number;
}

export interface IntegrationStatus {
  key: "printify" | "etsy" | "ai";
  configured: boolean;
  providerLabel?: string;
  detail?: string;
  checkedAt: number;
}
