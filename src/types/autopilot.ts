// ---------------------------------------------------------------------------
// The listing autopilot's persisted state.
//
// A run is a small, browser-local job: it researches Etsy, drafts copy, waits
// for a human to approve the copy and images, builds unpublished Printify
// products, prepares the mockup payload, waits for the bookmarklet, and only
// then publishes after a second explicit approval.
//
// The run lives in IndexedDB so the task dock can show it on every page and a
// reload resumes it. It never auto-publishes.
// ---------------------------------------------------------------------------

import type { PrintifyMockupUpload } from "@/lib/printify/mockup-bridge";
import type { StudioSession } from "./domain";
import type { EtsyResearch } from "./etsy";

export type AutopilotRunStatus =
  | "running"
  | "needs-review"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AutopilotStage =
  | "research"
  | "copy-review"
  | "build"
  | "mockup-review"
  | "publish-review"
  | "publishing"
  | "done";

export type AutopilotListingStatus =
  | "pending"
  | "researching"
  | "drafted"
  | "creating"
  | "created"
  | "uploading"
  | "uploaded"
  | "publishing"
  | "published"
  | "failed"
  | "skipped";

export interface AutopilotCopy {
  title: string;
  description: string;
  tags: string[];
  priceCents: number;
  category?: string;
  quantity: number;
  /** True when live Etsy observations were part of the AI prompt. */
  groundedOnEtsy: boolean;
  disclaimer?: string;
}

export interface AutopilotListing {
  /** The listing id, which is the owner design's id. */
  id: string;
  designId: string;
  memberIds: string[];
  designName: string;
  partnerName?: string;
  status: AutopilotListingStatus;
  copy?: AutopilotCopy;
  /** Set when the human approved BOTH the copy and the selected images. */
  reviewApprovedAt?: number;
  productId?: string;
  shopId?: number;
  imageAssetIds?: string[];
  uploadedMockupIds?: string[];
  /**
   * The uploaded mockups, kept so a retry can rebuild the bookmarklet payload
   * without uploading the same images to Printify a second time.
   */
  uploadedUploads?: PrintifyMockupUpload[];
  error?: string;
  updatedAt: number;
}

export interface AutopilotLogEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface AutopilotBridgeProduct {
  shopId: number;
  productId: string;
  productTitle: string;
  uploadCount: number;
}

export interface AutopilotLease {
  tabId: string;
  expiresAt: number;
}

export interface AutopilotRun {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: AutopilotRunStatus;
  stage: AutopilotStage;
  /** The Etsy query used for the shared research. */
  query: string;
  niche: string;
  productName: string;
  blueprintId?: number;
  printProviderId?: number;
  shopId?: number;
  /** The explicit price, in cents, applied to every listing in the run. */
  priceCents: number;
  listings: AutopilotListing[];
  /** One shared Etsy search result, used to ground every listing's copy. */
  research?: EtsyResearch;
  /** The Studio session snapshot the products are built from. */
  session: StudioSession;
  /** The clipboard payload prepared for the bookmarklet. */
  bridgePayload?: string;
  bridgeProducts?: AutopilotBridgeProduct[];
  /** Set when the user confirms the bookmarklet step ran on printify.com. */
  mockupsAppliedAt?: number;
  /** Set when the user gives the final publish approval. */
  publishApprovedAt?: number;
  log: AutopilotLogEntry[];
  /** Renewed while a tab is running the job; stops two tabs racing. */
  lease?: AutopilotLease;
  error?: string;
}
