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
  /** Background-removed version, if processed. Placements use this when present. */
  processedAssetId?: string;
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
  /** Ink variant applied to all designs in the job, unless overridden per design. */
  variantRule: InkVariant;
  /** Per-design variant overrides (designId → variant). */
  variantOverrides?: Record<string, InkVariant>;
  /** Optional placement template applied to all pairs without a saved placement. */
  placementTemplateId?: string;
  /** Skip combinations that already have a generated render. */
  skipExisting: boolean;
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
  /** Transform snapshot used for this render (reproducibility/retry). */
  transform: Transform;
  status: ItemStatus;
  outputAssetId?: string;
  error?: string;
  /** Human note, e.g. "Reused existing render". */
  note?: string;
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
  /** Product description carried into the Printify product. */
  description?: string;
  /** Price in cents applied to every enabled variant (Printify requires one). */
  priceCents?: number;
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
// Printify Studio — the bulk-listing session.
//
// One session describes a whole batch: which product, which colours, which
// sizes, where the artwork sits, and what has already been created. It is
// stored as a single blob in the `settings` table (key `printifyStudio:session`)
// so it survives a reload without a schema migration.
// ---------------------------------------------------------------------------

/** Which row of the designs grid a design belongs to. */
export type StudioRowId = "plain" | "ink";

/** The colour selection for one row of designs. */
export interface StudioRowState {
  /** Colour titles selected for this row. */
  colors: string[];
  /**
   * Colour titles (within `colors`) that are printed with the black-ink
   * artwork. Everything else in the row uses the white ink.
   */
  blackInkColors: string[];
}

/**
 * Where an artwork sits inside a print area, in Printify's convention:
 * centre-based coordinates in [0,1] and a width-relative scale.
 */
export interface StudioPlacement {
  /** Print area position, e.g. "front". */
  position: string;
  /** Centre X within the print area, 0..1 (0.5 = centred). */
  x: number;
  /** Centre Y within the print area, 0..1. */
  y: number;
  /** Image width as a fraction of the print-area width. */
  scale: number;
  /** Rotation in degrees, clockwise. */
  angle: number;
}

export interface StudioSession {
  blueprintId?: number;
  printProviderId?: number;
  /** Size labels shared by every row. */
  sizes: string[];
  rows: Record<StudioRowId, StudioRowState>;
  /**
   * The designs this batch covers - the ids ticked in the Designs tab. Empty
   * means "every design in the library", which the Design panel always says
   * out loud so a batch is never bigger than the user expects.
   */
  designIds: string[];
  /** When true, every design uses `universalPlacement`. */
  universal: boolean;
  universalPlacement: StudioPlacement;
  /** Per-design placement overrides, used when `universal` is false. */
  placements: Record<string, StudioPlacement>;
  /** Price in cents, applied to every enabled variant. */
  priceCents?: number;
  /** `{design}` and `{product}` are replaced when a product is created. */
  titleTemplate?: string;
  updatedAt: number;
}

/** A product created by the studio, and how it went. */
export interface StudioProductResult {
  designId: string;
  /** The title that was actually sent to Printify. */
  title: string;
  /** The design's name, for grouping. */
  designName: string;
  /** The Printify product id, once created. */
  remoteProductId?: string;
  status: "created" | "failed" | "skipped";
  error?: string;
  /** The Printify image ids uploaded for this product's artwork groups. */
  imageIds?: string[];
  createdAt: number;
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
  | "integration.save"
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
  /** Where the active credential came from, when configured. */
  source?: "browser" | "server" | null;
  providerLabel?: string;
  detail?: string;
  checkedAt: number;
}

// ---------------------------------------------------------------------------
// Agent chat — local-first conversation history. Persisted in IndexedDB only;
// the server never sees a stored transcript. Messages are a list of typed parts
// so a single assistant turn can carry text, collapsible reasoning, and tool
// activity without losing ordering.
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant" | "system";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallData {
  /** Stable id from the provider, or generated locally by the intent router. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  /** Rendered summary shown on the collapsed card. */
  summary?: string;
  /** Full result payload (JSON), when the tool ran. */
  result?: unknown;
  error?: string;
}

export interface ImagePartData {
  name: string;
  mime: string;
  /** Data URL, kept small; attachments are not uploaded anywhere. */
  dataUrl: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; call: ToolCallData }
  | { type: "image"; image: ImagePartData };

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  parts: MessagePart[];
  /** Provider/model used for this turn (assistant messages). */
  provider?: string;
  model?: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
