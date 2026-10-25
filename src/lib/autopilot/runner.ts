"use client";

// ---------------------------------------------------------------------------
// The listing autopilot runner.
//
// It is deliberately a small client-side state machine, not a server job:
// every design, mockup and key is browser-local, and a Cloudflare Worker must
// never hold the user's Printify session.
//
// The pipeline is review-gated in two places:
//
//   research + draft  ->  HUMAN review of copy and images
//   build + upload   ->  HUMAN bookmarklet step
//   final publish    ->  HUMAN publish approval
//
// A run is persisted in IndexedDB after every step. The task dock can show it
// on any page, and a reload can resume it. A short tab lease stops two tabs
// from running the same job at once.
// ---------------------------------------------------------------------------

import { authedFetch } from "@/lib/client/integrations";
import { mockupImageForUpload } from "@/lib/client/mockup-upload";
import { createStudioProduct } from "@/lib/client/studio-create";
import { getAssetBlob, uid } from "@/lib/db/repo";
import { db } from "@/lib/db/schema";
import {
  buildAutopilotListings,
  fallbackCopy,
  mergeAiCopy,
  normaliseTags,
  withCurrentRenderState,
  type AiListingResult,
} from "@/lib/autopilot/plan";
import { fetchVariants } from "@/lib/printify/catalog-client";
import { buildStudioListings } from "@/lib/printify/listing-plan";
import { freshListingRenders } from "@/lib/printify/listing-drafts";
import {
  buildBridgePayload,
  bridgePayloadJson,
  type PrintifyBridgeProduct,
  type PrintifyMockupUpload,
} from "@/lib/printify/mockup-bridge";
import { buildStudioPlan, studioPlanProblems, type StudioPlan } from "@/lib/printify/studio-plan";
import { listingMockupIds, loadSession } from "@/lib/printify/studio-session";
import type {
  AutopilotCopy,
  AutopilotListing,
  AutopilotRun,
} from "@/types/autopilot";
import type { ListingDraft, StudioSession } from "@/types/domain";
import type { EtsyResearch } from "@/types/etsy";

const LEASE_MS = 2 * 60 * 1000;
const MAX_LOG = 200;
const MAX_IMAGES_PER_UPLOAD = 8;

const TAB_ID = (() => {
  if (typeof window === "undefined") return `tab-${Math.random().toString(36).slice(2)}`;
  const key = "autopilot:tabId";
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = `tab-${crypto.randomUUID()}`;
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
})();

/** Same-tab concurrency guard: two views cannot advance one run at once. */
const active = new Set<string>();

function logEntry(
  level: "info" | "warn" | "error" | "success",
  message: string,
): AutopilotRun["log"][number] {
  return { id: uid(), at: Date.now(), level, message };
}

function addLog(
  run: AutopilotRun,
  level: "info" | "warn" | "error" | "success",
  message: string,
): AutopilotRun {
  return { ...run, log: [...run.log, logEntry(level, message)].slice(-MAX_LOG) };
}

async function mutateRun(
  runId: string,
  mutate: (run: AutopilotRun) => AutopilotRun,
): Promise<AutopilotRun | null> {
  return db.transaction("rw", db.autopilotRuns, async () => {
    const run = await db.autopilotRuns.get(runId);
    if (!run) return null;
    const next = mutate(run);
    next.updatedAt = Date.now();
    await db.autopilotRuns.put(next);
    return next;
  });
}

async function claimRun(runId: string): Promise<AutopilotRun | null> {
  return db.transaction("rw", db.autopilotRuns, async () => {
    const run = await db.autopilotRuns.get(runId);
    if (!run) return null;
    const now = Date.now();
    if (run.lease && run.lease.tabId !== TAB_ID && run.lease.expiresAt > now) return null;
    const next: AutopilotRun = {
      ...run,
      lease: { tabId: TAB_ID, expiresAt: now + LEASE_MS },
      updatedAt: now,
    };
    await db.autopilotRuns.put(next);
    return next;
  });
}

async function renewLease(runId: string): Promise<boolean> {
  return db.transaction("rw", db.autopilotRuns, async () => {
    const run = await db.autopilotRuns.get(runId);
    if (!run || run.status !== "running" || run.lease?.tabId !== TAB_ID) return false;
    await db.autopilotRuns.put({
      ...run,
      lease: { tabId: TAB_ID, expiresAt: Date.now() + LEASE_MS },
      updatedAt: Date.now(),
    });
    return true;
  });
}

async function releaseLease(runId: string): Promise<void> {
  await mutateRun(runId, (run) => {
    if (run.lease?.tabId !== TAB_ID) return run;
    const { lease: _lease, ...rest } = run;
    return rest as AutopilotRun;
  });
}

async function failRun(runId: string, message: string): Promise<void> {
  await mutateRun(runId, (run) => {
    const failed = addLog(run, "error", message);
    const { lease: _lease, ...rest } = failed;
    return { ...(rest as AutopilotRun), status: "failed", error: message };
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A listing that was never configured starts with EVERY mockup, matching the
 * Listing images page. The snapshot records that choice so the run cannot
 * silently ignore mockups added halfway through.
 */
async function snapshotSessionImages(
  session: StudioSession,
  listingIds: string[],
): Promise<StudioSession> {
  const mockups = await db.mockups.orderBy("createdAt").toArray();
  const everyMockup = mockups.map((mockup) => mockup.id);
  const listingImages = { ...(session.listingImages ?? {}) };
  for (const listingId of listingIds) {
    if (listingImages[listingId] === undefined && !session.listingImageCleared?.[listingId]) {
      listingImages[listingId] = everyMockup;
    }
  }
  return { ...session, listingImages };
}

export interface StartAutopilotInput {
  query: string;
  niche: string;
  productName: string;
  priceCents: number;
  shopId: number;
  session: StudioSession;
  plan: StudioPlan;
}

/** Creates a run at the research stage. It starts working immediately. */
export async function startAutopilot(input: StartAutopilotInput): Promise<AutopilotRun> {
  if (input.plan.items.length === 0) {
    throw new Error("There is nothing to create. Tick at least one design in the Studio.");
  }
  if (input.priceCents < 100) {
    throw new Error("Enter a deliberate price of at least 1.00 before starting.");
  }
  const now = Date.now();
  const session = await snapshotSessionImages(
    input.session,
    input.plan.items.map((item) => item.listingId),
  );
  const run: AutopilotRun = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    status: "running",
    stage: "research",
    query: input.query.trim(),
    niche: input.niche.trim() || input.query.trim(),
    productName: input.productName,
    ...(session.blueprintId ? { blueprintId: session.blueprintId } : {}),
    ...(session.printProviderId ? { printProviderId: session.printProviderId } : {}),
    shopId: input.shopId,
    priceCents: input.priceCents,
    listings: buildAutopilotListings(input.plan),
    session,
    log: [
      logEntry(
        "info",
        `Started. Researching Etsy for "${input.query.trim()}" and drafting ${input.plan.items.length} listing(s).`,
      ),
    ],
  };
  await db.autopilotRuns.put(run);
  void advance(run.id);
  return run;
}

async function fetchEtsyResearch(query: string): Promise<EtsyResearch> {
  const response = await authedFetch("/api/etsy/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = (await response.json().catch(() => null)) as {
    research?: EtsyResearch;
    error?: string;
  } | null;
  if (!response.ok || !data?.research) {
    throw new Error(data?.error ?? `Etsy research failed (HTTP ${response.status}).`);
  }
  return data.research;
}

async function fetchAiCopy(
  run: AutopilotRun,
  listing: AutopilotListing,
  research: EtsyResearch,
): Promise<AiListingResult> {
  const response = await authedFetch("/api/ai/seo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      niche: run.niche,
      productType: run.productName,
      seedKeyword: listing.designName,
      research,
    }),
  });
  const data = (await response.json().catch(() => null)) as {
    result?: AiListingResult;
    error?: string;
  } | null;
  if (!response.ok || !data?.result) {
    throw new Error(data?.error ?? `AI copy failed (HTTP ${response.status}).`);
  }
  return data.result;
}

async function updateListing(
  runId: string,
  listingId: string,
  patch: Partial<AutopilotListing>,
  log?: { level: "info" | "warn" | "error" | "success"; message: string },
): Promise<AutopilotRun | null> {
  return mutateRun(runId, (run) => {
    const listings = run.listings.map((listing) =>
      listing.id === listingId ? { ...listing, ...patch, updatedAt: Date.now() } : listing,
    );
    const next = { ...run, listings };
    return log ? addLog(next, log.level, log.message) : next;
  });
}

async function runResearch(run: AutopilotRun): Promise<void> {
  await mutateRun(run.id, (current) =>
    addLog({ ...current, status: "running", stage: "research", error: undefined }, "info", "Searching Etsy active listings…"),
  );

  let research: EtsyResearch;
  try {
    research = await fetchEtsyResearch(run.query);
  } catch (error) {
    await failRun(run.id, errorMessage(error, "Etsy research failed."));
    return;
  }

  await mutateRun(run.id, (current) =>
    addLog(
      { ...current, research },
      "success",
      `Etsy returned ${research.activeListings.toLocaleString()} active listing(s); sampled ${research.sampled}.`,
    ),
  );

  const current = await db.autopilotRuns.get(run.id);
  const listings = current?.listings ?? run.listings;
  for (const listing of listings) {
    if (!(await renewLease(run.id))) return;
    await updateListing(run.id, listing.id, { status: "researching", error: undefined });

    const base = fallbackCopy(
      listing,
      run.session,
      run.productName,
      run.priceCents,
      research,
    );
    let copy: AutopilotCopy = base;
    try {
      const ai = await fetchAiCopy(run, listing, research);
      copy = mergeAiCopy(base, ai, research);
      await mutateRun(run.id, (state) =>
        addLog(state, "info", `${listing.designName}: AI copy drafted from the observed Etsy terms.`),
      );
    } catch (error) {
      await mutateRun(run.id, (state) =>
        addLog(
          state,
          "warn",
          `${listing.designName}: AI copy unavailable (${errorMessage(
            error,
            "unknown error",
          )}); using the Studio's templates.`,
        ),
      );
    }

    await updateListing(run.id, listing.id, {
      copy,
      status: "drafted",
      error: undefined,
    });
  }

  // Do not move a run the user paused (or another tab claimed) to the review
  // gate; the resumed run must pick up from research again.
  const latest = await db.autopilotRuns.get(run.id);
  if (!latest || latest.status !== "running" || latest.lease?.tabId !== TAB_ID) return;

  await mutateRun(run.id, (state) =>
    addLog(
      { ...state, stage: "copy-review", status: "needs-review" },
      "success",
      "Copy is ready. Review the copy and the selected images, then approve to build.",
    ),
  );
}

async function saveAutopilotDraft(
  listing: AutopilotListing,
  images: Awaited<ReturnType<typeof freshListingRenders>>,
): Promise<void> {
  if (!listing.copy) return;
  const existingRows = await db.listingDrafts.where("designId").equals(listing.id).toArray();
  const existing = existingRows.sort((a, b) => a.updatedAt - b.updatedAt)[existingRows.length - 1];
  const productRows = await db.productDrafts.where("designId").equals(listing.id).toArray();
  const product = productRows.sort((a, b) => b.createdAt - a.createdAt)[0];
  const draft: ListingDraft = {
    id: existing?.id ?? uid(),
    title: listing.copy.title,
    description: listing.copy.description,
    tags: listing.copy.tags,
    category: listing.copy.category,
    priceCents: listing.copy.priceCents,
    quantity: listing.copy.quantity,
    productDraftId: product?.id,
    designId: listing.id,
    imageAssetIds: images.map((image) => image.assetId),
    imageSelectionLocked: images.length > 0,
    status: existing?.status ?? "local-draft",
    error: undefined,
    remoteListingId: existing?.remoteListingId,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await db.listingDrafts.put(draft);
}

async function uploadListingMockups(params: {
  shopId: number;
  productId: string;
  title: string;
  images: Awaited<ReturnType<typeof freshListingRenders>>;
}): Promise<PrintifyMockupUpload[]> {
  const uploads: PrintifyMockupUpload[] = [];
  for (let start = 0; start < params.images.length; start += MAX_IMAGES_PER_UPLOAD) {
    const chunk = params.images.slice(start, start + MAX_IMAGES_PER_UPLOAD);
    const payloadImages: Array<{ base64: string; filename: string }> = [];
    for (const image of chunk) {
      const blob = await getAssetBlob(image.assetId);
      if (!blob) throw new Error("A selected render is missing from storage. Render it again.");
      payloadImages.push(
        await mockupImageForUpload(blob, `${params.title}-${image.mockupId}`),
      );
    }
    const response = await authedFetch("/api/printify/mockups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        shopId: params.shopId,
        productId: params.productId,
        expectedTitle: params.title,
        images: payloadImages,
      }),
    });
    const data = (await response.json().catch(() => null)) as {
      uploads?: PrintifyMockupUpload[];
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(data?.error ?? `Mockup upload failed (HTTP ${response.status}).`);
    }
    if (!Array.isArray(data?.uploads) || data.uploads.length !== chunk.length) {
      throw new Error("Printify did not return one custom mockup per image.");
    }
    uploads.push(...data.uploads);
  }
  return uploads;
}

async function runBuild(run: AutopilotRun): Promise<void> {
  const unapproved = run.listings.filter((listing) => !listing.reviewApprovedAt);
  if (unapproved.length > 0) {
    await mutateRun(run.id, (current) =>
      addLog(
        { ...current, stage: "copy-review", status: "needs-review" },
        "warn",
        "Every listing must be approved before building.",
      ),
    );
    return;
  }

  if (!run.blueprintId || !run.printProviderId) {
    await failRun(run.id, "The Studio snapshot has no product or print provider. Start again from the Studio.");
    return;
  }

  let variants;
  try {
    variants = await fetchVariants(run.blueprintId, run.printProviderId);
  } catch (error) {
    await failRun(run.id, errorMessage(error, "Could not load the Printify catalogue."));
    return;
  }

  const designs = await db.designs.toArray();
  // Renders are saved while the run waits for review, so use the current
  // placement and render map while keeping the run's start-time mockup
  // selection. Persist it so a retry starts from the same frame.
  const session = withCurrentRenderState(run.session, await loadSession());
  await mutateRun(run.id, (current) => ({ ...current, session }));

  const plan = buildStudioPlan(designs, session, variants);
  if (!plan) {
    await failRun(run.id, "The Studio plan could not be rebuilt. Check the product, colours and designs.");
    return;
  }
  const planProblems = studioPlanProblems(plan, designs, session);
  if (planProblems.length > 0) {
    await failRun(
      run.id,
      `The Studio plan has ${planProblems.length} problem(s): ${planProblems.slice(0, 3).join(" ")}`,
    );
    return;
  }

  const studioListings = buildStudioListings(designs, session);
  const bridgeProducts: PrintifyBridgeProduct[] = [];

  for (const listing of run.listings) {
    if (!(await renewLease(run.id))) return;
    if (!listing.copy) {
      await updateListing(run.id, listing.id, {
        status: "failed",
        error: "This listing has no reviewed copy.",
      });
      continue;
    }
    const item = plan.items.find((entry) => entry.listingId === listing.id);
    const studioListing = studioListings.find((entry) => entry.listingId === listing.id);
    if (!item || !studioListing) {
      await updateListing(run.id, listing.id, {
        status: "failed",
        error: "The Studio plan no longer contains this listing. Start a new run.",
      });
      continue;
    }

    // A retry (or a resumed run) must not upload the same images twice. The
    // saved uploads are enough to rebuild the bookmarklet payload.
    if (
      (listing.status === "uploaded" || listing.status === "published") &&
      listing.productId &&
      listing.shopId != null &&
      (listing.uploadedUploads?.length ?? 0) > 0
    ) {
      bridgeProducts.push({
        shopId: listing.shopId,
        productId: listing.productId,
        productTitle: listing.copy.title,
        uploads: listing.uploadedUploads ?? [],
      });
      continue;
    }

    const selected = listingMockupIds(session, listing.id);
    const images = await freshListingRenders(session, studioListing);
    if (images.length === 0 || images.length !== selected.length) {
      const message =
        selected.length === 0
          ? "No mockups are selected for this listing. Choose images in Listing images first."
          : `Only ${images.length} of ${selected.length} selected images have a current render. Open Listing images and press Save & render.`;
      await updateListing(
        run.id,
        listing.id,
        { status: "failed", error: message },
        { level: "error", message: `${listing.designName}: ${message}` },
      );
      continue;
    }

    let productId = listing.productId;
    // A product always carries the shop that owns it. The saved run shop is a
    // safe fallback for an older run, and the server still resolves the real
    // owner before writing; creating a second product would leave a duplicate.
    let shopId = listing.shopId ?? (listing.productId ? run.shopId : undefined);
    if (!productId) {
      await updateListing(run.id, listing.id, { status: "creating", error: undefined });
      const created = await createStudioProduct(
        {
          session: { ...session, priceCents: run.priceCents },
          plan,
          productName: run.productName,
          overrides: {
            title: listing.copy.title,
            description: listing.copy.description,
            tags: listing.copy.tags,
            priceCents: listing.copy.priceCents,
          },
        },
        item,
      );

      if (created.status !== "created" || !created.remoteProductId || created.shopId == null) {
        await updateListing(
          run.id,
          listing.id,
          { status: "failed", error: created.error ?? "Printify did not create the product." },
          {
            level: "error",
            message: `${listing.designName}: ${created.error ?? "product creation failed"}`,
          },
        );
        continue;
      }
      productId = created.remoteProductId;
      shopId = created.shopId;
      await updateListing(
        run.id,
        listing.id,
        {
          status: "created",
          productId,
          shopId,
          imageAssetIds: images.map((image) => image.assetId),
          error: undefined,
        },
        {
          level: "success",
          message: `${listing.designName}: created product ${productId}.`,
        },
      );
    } else {
      if (shopId == null) {
        await updateListing(
          run.id,
          listing.id,
          {
            status: "failed",
            error: `Product ${productId} exists but its Printify shop is unknown. Start a new run or link the product to the saved shop.`,
          },
          {
            level: "error",
            message: `${listing.designName}: the product's shop is unknown, so no mockups were uploaded.`,
          },
        );
        continue;
      }
      // A retry after a failed upload must reuse the product it already
      // created; creating another one would leave a duplicate draft behind.
      await updateListing(run.id, listing.id, {
        status: "created",
        imageAssetIds: images.map((image) => image.assetId),
        error: undefined,
      });
    }

    if (!productId || shopId == null) continue;

    const createdListing: AutopilotListing = {
      ...listing,
      status: "created",
      productId,
      shopId,
      imageAssetIds: images.map((image) => image.assetId),
      error: undefined,
      updatedAt: Date.now(),
    };
    await saveAutopilotDraft(createdListing, images);

    await updateListing(run.id, listing.id, { status: "uploading" });
    try {
      const uploads = await uploadListingMockups({
        shopId,
        productId,
        title: listing.copy.title,
        images,
      });
      bridgeProducts.push({
        shopId,
        productId,
        productTitle: listing.copy.title,
        uploads,
      });
      await updateListing(
        run.id,
        listing.id,
        {
          status: "uploaded",
          uploadedMockupIds: uploads.map((upload) => upload.mockupId),
          uploadedUploads: uploads,
          error: undefined,
        },
        {
          level: "success",
          message: `${listing.designName}: product ${productId} created and ${uploads.length} mockup(s) uploaded.`,
        },
      );
    } catch (error) {
      await updateListing(
        run.id,
        listing.id,
        { status: "failed", error: errorMessage(error, "Mockup upload failed.") },
        {
          level: "error",
          message: `${listing.designName}: ${errorMessage(error, "mockup upload failed")}`,
        },
      );
    }
  }

  const afterBuild = await db.autopilotRuns.get(run.id);
  const failedAfterBuild =
    afterBuild?.listings.filter((entry) => entry.status === "failed").length ?? 0;
  if (failedAfterBuild > 0) {
    await failRun(
      run.id,
      `${failedAfterBuild} of ${run.listings.length} listing(s) could not be prepared. Fix the error above and use Retry build; the products and mockups that did succeed will be reused, not uploaded again.`,
    );
    return;
  }

  if (bridgeProducts.length === 0) {
    await failRun(
      run.id,
      "No product could be prepared. Fix the listing errors above and use Retry build.",
    );
    return;
  }

  const payload = buildBridgePayload(bridgeProducts);
  const json = bridgePayloadJson(payload);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    // The page shows the payload and a Copy button; clipboard permission is
    // not required for the run to be correct.
  }

  const latest = await db.autopilotRuns.get(run.id);
  if (!latest || latest.status !== "running" || latest.lease?.tabId !== TAB_ID) return;

  await mutateRun(run.id, (current) =>
    addLog(
      {
        ...current,
        stage: "mockup-review",
        status: "needs-review",
        bridgePayload: json,
        bridgeProducts: bridgeProducts.map((product) => ({
          shopId: product.shopId,
          productId: product.productId,
          productTitle: product.productTitle,
          uploadCount: product.uploads.length,
        })),
        error: undefined,
      },
      "success",
      "Products created and mockups uploaded. Run the bookmarklet on printify.com, then confirm the mockups were applied.",
    ),
  );
}

async function runPublish(run: AutopilotRun): Promise<void> {
  if (!run.publishApprovedAt) {
    await mutateRun(run.id, (current) =>
      addLog(
        { ...current, stage: "publish-review", status: "needs-review" },
        "warn",
        "Publishing needs a final human approval.",
      ),
    );
    return;
  }

  for (const listing of run.listings) {
    if (!(await renewLease(run.id))) return;
    if (listing.status === "published") continue;
    if (listing.status !== "uploaded" || !listing.productId || listing.shopId == null) {
      await updateListing(run.id, listing.id, {
        status: "failed",
        error: "This listing was not fully prepared (product + mockups) and was not published.",
      });
      continue;
    }
    await updateListing(run.id, listing.id, { status: "publishing", error: undefined });
    const response = await authedFetch("/api/printify/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        productId: listing.productId,
        shopId: listing.shopId,
      }),
    });
    const data = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    if (!response.ok) {
      const message = data?.error ?? data?.message ?? `Publish failed (HTTP ${response.status}).`;
      await updateListing(
        run.id,
        listing.id,
        { status: "failed", error: message },
        { level: "error", message: `${listing.designName}: ${message}` },
      );
      await failRun(run.id, `${listing.designName}: ${message}`);
      return;
    }
    await updateListing(
      run.id,
      listing.id,
      { status: "published", error: undefined },
      { level: "success", message: `${listing.designName}: published to Printify.` },
    );
  }

  const latest = await db.autopilotRuns.get(run.id);
  if (!latest || latest.status !== "running" || latest.lease?.tabId !== TAB_ID) return;

  await mutateRun(run.id, (current) => {
    const failed = current.listings.filter((listing) => listing.status === "failed").length;
    const published = current.listings.filter((listing) => listing.status === "published").length;
    return addLog(
      { ...current, stage: "done", status: failed > 0 ? "failed" : "completed", error: failed > 0 ? current.error : undefined },
      failed > 0 ? "warn" : "success",
      failed > 0
        ? `Finished with ${published} published and ${failed} failed listing(s).`
        : `Published ${published} listing(s).`,
    );
  });
}

/** Advances one run until it reaches a human gate or finishes. */
export async function advance(runId: string): Promise<void> {
  if (active.has(runId)) return;
  const before = await db.autopilotRuns.get(runId);
  if (!before) return;
  if (before.status !== "running") return;
  if (before.stage !== "research" && before.stage !== "build" && before.stage !== "publishing") {
    return;
  }
  const claimed = await claimRun(runId);
  if (!claimed) return;

  active.add(runId);
  try {
    for (;;) {
      const run = await db.autopilotRuns.get(runId);
      if (!run || run.lease?.tabId !== TAB_ID) return;
      if (run.status !== "running") return;
      if (run.stage === "research") await runResearch(run);
      else if (run.stage === "build") await runBuild(run);
      else if (run.stage === "publishing") await runPublish(run);
      else return;

      const after = await db.autopilotRuns.get(runId);
      if (!after || after.status !== "running") return;
      if (after.stage === run.stage) return;
    }
  } catch (error) {
    await failRun(runId, errorMessage(error, "The autopilot stopped unexpectedly."));
  } finally {
    active.delete(runId);
    await releaseLease(runId);
  }
}

/** Starts any run a previous page load left working. */
export async function resumeActiveRuns(): Promise<void> {
  const runs = await db.autopilotRuns.where("status").equals("running").toArray();
  for (const run of runs) {
    if (run.stage === "research" || run.stage === "build" || run.stage === "publishing") {
      void advance(run.id);
    }
  }
}

/** Saves an edit and clears the approval, because the reviewed text changed. */
export async function updateAutopilotCopy(
  runId: string,
  listingId: string,
  copy: Partial<AutopilotCopy>,
): Promise<AutopilotRun | null> {
  return mutateRun(runId, (run) => {
    const listings = run.listings.map((listing) => {
      if (listing.id !== listingId || !listing.copy) return listing;
      const next: AutopilotCopy = {
        ...listing.copy,
        ...copy,
        title: (copy.title ?? listing.copy.title).trim().slice(0, 140),
        description: (copy.description ?? listing.copy.description).trim().slice(0, 5000),
        tags: normaliseTags(copy.tags ?? listing.copy.tags),
        priceCents: Math.max(100, Math.round(copy.priceCents ?? listing.copy.priceCents)),
        quantity: Math.max(1, Math.round(copy.quantity ?? listing.copy.quantity)),
      };
      return {
        ...listing,
        copy: next,
        reviewApprovedAt: undefined,
        error: undefined,
        updatedAt: Date.now(),
      };
    });
    return addLog({ ...run, listings }, "info", "Copy edited; approve it again before building.");
  });
}

/** Approves one listing's copy and images. */
export async function approveAutopilotListing(
  runId: string,
  listingId: string,
): Promise<AutopilotRun | null> {
  return mutateRun(runId, (run) => {
    const listings = run.listings.map((listing) =>
      listing.id === listingId
        ? { ...listing, reviewApprovedAt: Date.now(), error: undefined, updatedAt: Date.now() }
        : listing,
    );
    const approved = listings.find((listing) => listing.id === listingId);
    return addLog(
      { ...run, listings },
      "success",
      `${approved?.designName ?? "Listing"}: approved for build.`,
    );
  });
}

/** Requires every listing to be approved. */
export async function startAutopilotBuild(runId: string): Promise<AutopilotRun | null> {
  const run = await db.autopilotRuns.get(runId);
  if (!run) throw new Error("The run no longer exists.");
  if (run.stage !== "copy-review") {
    throw new Error("The copy review is already closed for this run.");
  }
  const unapproved = run.listings.filter((listing) => !listing.reviewApprovedAt);
  if (unapproved.length > 0) {
    throw new Error(`Approve every listing first (${unapproved.length} still waiting).`);
  }

  // Check every listing's images BEFORE the first product is created. The
  // build repeats these checks defensively, but failing here means a missing
  // render cannot leave a half-created batch behind.
  const designs = await db.designs.toArray();
  const session = withCurrentRenderState(run.session, await loadSession());
  const studioListings = buildStudioListings(designs, session);
  const imageProblems: string[] = [];
  for (const listing of run.listings) {
    const studioListing = studioListings.find((entry) => entry.listingId === listing.id);
    if (!studioListing) {
      imageProblems.push(`${listing.designName}: it is no longer in the Studio batch.`);
      continue;
    }
    const selected = listingMockupIds(session, listing.id);
    const fresh = await freshListingRenders(session, studioListing);
    if (selected.length === 0) {
      imageProblems.push(
        `${listing.designName}: no mockups are selected. Add some in Listing images.`,
      );
    } else if (fresh.length !== selected.length) {
      imageProblems.push(
        `${listing.designName}: ${fresh.length} of ${selected.length} selected images have a current render. Open Listing images and press Save & render for this run's selection.`,
      );
    }
  }
  if (imageProblems.length > 0) {
    throw new Error(imageProblems.join(" "));
  }

  const next = await mutateRun(runId, (current) =>
    addLog(
      { ...current, session, stage: "build", status: "running", error: undefined },
      "info",
      "Building Printify products and uploading mockups…",
    ),
  );
  void advance(runId);
  return next;
}

/** The human confirms the bookmarklet step ran on printify.com. */
export async function markAutopilotMockupsApplied(runId: string): Promise<AutopilotRun | null> {
  return mutateRun(runId, (run) => {
    if (run.stage !== "mockup-review") return run;
    return addLog(
      {
        ...run,
        mockupsAppliedAt: Date.now(),
        stage: "publish-review",
        status: "needs-review",
        error: undefined,
      },
      "success",
      "Mockups marked as applied. The final publish still needs your approval.",
    );
  });
}

/** The second, final human gate. Nothing is published before this. */
export async function publishAutopilotRun(runId: string): Promise<AutopilotRun | null> {
  const run = await db.autopilotRuns.get(runId);
  if (!run) throw new Error("The run no longer exists.");
  if (run.stage !== "publish-review" || !run.mockupsAppliedAt) {
    throw new Error("Apply the mockups first, then approve publishing.");
  }
  const next = await mutateRun(runId, (current) =>
    addLog(
      {
        ...current,
        publishApprovedAt: Date.now(),
        stage: "publishing",
        status: "running",
        error: undefined,
      },
      "warn",
      "Publish approved by the user. Publishing the prepared products…",
    ),
  );
  void advance(runId);
  return next;
}

export async function pauseAutopilotRun(runId: string): Promise<void> {
  await mutateRun(runId, (run) => {
    const { lease: _lease, ...rest } = run;
    return addLog({ ...(rest as AutopilotRun), status: "paused" }, "info", "Paused by the user.");
  });
}

export async function resumeAutopilotRun(runId: string): Promise<void> {
  const run = await db.autopilotRuns.get(runId);
  if (!run) return;
  if (run.stage === "copy-review" || run.stage === "mockup-review" || run.stage === "publish-review") {
    await mutateRun(runId, (current) => ({ ...current, status: "needs-review", error: undefined }));
    return;
  }
  await mutateRun(runId, (current) =>
    addLog({ ...current, status: "running", error: undefined }, "info", "Resumed."),
  );
  void advance(runId);
}

export async function cancelAutopilotRun(runId: string): Promise<void> {
  await mutateRun(runId, (run) => {
    const { lease: _lease, ...rest } = run;
    return addLog({ ...(rest as AutopilotRun), status: "cancelled" }, "warn", "Cancelled by the user.");
  });
}

export async function retryAutopilotResearch(runId: string): Promise<void> {
  const existing = await db.autopilotRuns.get(runId);
  if (!existing) throw new Error("The run no longer exists.");
  if (existing.listings.some((listing) => listing.productId)) {
    throw new Error(
      "Printify products already exist for this run. Retrying research would leave them with stale copy; start a new run instead.",
    );
  }
  await mutateRun(runId, (run) =>
    addLog(
      {
        ...run,
        stage: "research",
        status: "running",
        error: undefined,
        research: undefined,
        listings: run.listings.map((listing) => ({
          ...listing,
          status: "pending",
          copy: undefined,
          reviewApprovedAt: undefined,
          error: undefined,
          updatedAt: Date.now(),
        })),
      },
      "info",
      "Retrying the Etsy research.",
    ),
  );
  void advance(runId);
}

export async function retryAutopilotBuild(runId: string): Promise<void> {
  await mutateRun(runId, (run) =>
    addLog(
      {
        ...run,
        stage: "build",
        status: "running",
        error: undefined,
        listings: run.listings.map((listing) =>
          listing.status === "failed"
            ? { ...listing, status: "pending", error: undefined, updatedAt: Date.now() }
            : listing,
        ),
      },
      "info",
      "Retrying the build for the failed listings.",
    ),
  );
  void advance(runId);
}

/**
 * Retries publishing after an upstream publish failure.
 *
 * The human publish approval is NOT repeated here: it was already given, and
 * the failed listing kept its prepared product and mockups. An already
 * published listing is skipped by the runner, and Printify's "already
 * published" error is surfaced verbatim instead of being retried silently.
 */
export async function retryAutopilotPublish(runId: string): Promise<void> {
  const run = await db.autopilotRuns.get(runId);
  if (!run) throw new Error("The run no longer exists.");
  if (!run.publishApprovedAt) {
    throw new Error("Publishing was never approved for this run.");
  }
  await mutateRun(runId, (current) =>
    addLog(
      {
        ...current,
        stage: "publishing",
        status: "running",
        error: undefined,
        listings: current.listings.map((listing) =>
          listing.status === "failed" &&
          listing.productId &&
          (listing.uploadedUploads?.length ?? 0) > 0
            ? { ...listing, status: "uploaded", error: undefined, updatedAt: Date.now() }
            : listing,
        ),
      },
      "warn",
      "Retrying the publish after an upstream failure.",
    ),
  );
  void advance(runId);
}

export async function deleteAutopilotRun(runId: string): Promise<void> {
  await db.autopilotRuns.delete(runId);
}
