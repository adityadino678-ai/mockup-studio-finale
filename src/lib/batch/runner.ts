import { db } from "@/lib/db/schema";
import {
  designAssetIdFor,
  getAssetBlob,
  storeAsset,
  uid,
  logActivity,
  getPlacement,
} from "@/lib/db/repo";
import { canvasToBlob, decodeImage } from "@/lib/image/image";
import { composeToCanvas } from "@/lib/canvas/compose";
import { clipFor, printAreaOf } from "@/lib/mockups/print-area";
import { transformFromPrintArea } from "@/lib/mockups/resolve";
import {
  DEFAULT_TRANSFORM,
  type BatchItem,
  type BatchJob,
  type Design,
  type InkVariant,
  type Mockup,
  type Transform,
} from "@/types/domain";

// ---------------------------------------------------------------------------
// Batch job engine.
//
// Renders sequentially on the main thread using the SAME compositing function
// as Save render (composeToCanvas), yielding to the event loop between items so
// the UI stays responsive and status updates stream in live. Item status lives
// in IndexedDB and is read by the UI through dexie live queries, so progress is
// always real counts — never an estimate.
// ---------------------------------------------------------------------------

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

interface RunState {
  cancelled: boolean;
}

const running = new Map<string, RunState>();

/**
 * Composes one design onto one mockup and stores the result as a
 * `mockup-render` asset. This is the same code path the batch engine uses, so
 * a single render and a batch render are pixel-identical.
 */
export async function renderComposition(params: {
  designId: string;
  mockupId: string;
  designAssetId: string;
  transform: Transform;
  behindMockup?: boolean;
}): Promise<string> {
  const mockup = await db.mockups.get(params.mockupId);
  if (!mockup) throw new Error("Mockup no longer exists");
  const [mockupBlob, designBlob] = await Promise.all([
    getAssetBlob(mockup.assetId),
    getAssetBlob(params.designAssetId),
  ]);
  if (!mockupBlob || !designBlob) throw new Error("Source image missing from storage");

  const [mockupBmp, designBmp] = await Promise.all([decodeImage(mockupBlob), decodeImage(designBlob)]);
  try {
    const canvas = document.createElement("canvas");
    // A mockup with a print area clips the design to it: whatever falls
    // outside the printable area is not on the product either.
    const area = printAreaOf(mockup);
    const clip = area
      ? clipFor(area, area.frame, mockup.width, mockup.height)
      : undefined;
    const composed = composeToCanvas(canvas, mockupBmp, designBmp, params.transform, {
      drawDesignFirst: params.behindMockup ?? area?.clipMode === "behind-garment",
      clip,
    });
    if (!composed) throw new Error("Compositing failed");
    const blob = await canvasToBlob(canvas, "image/png");
    canvas.width = 0;
    canvas.height = 0;
    const design = await db.designs.get(params.designId);
    const asset = await storeAsset(
      blob,
      `${design?.name ?? "design"}-${mockup.name}.png`,
      "mockup-render",
      {
        parentId: params.designAssetId,
        sourceDesignId: params.designId,
        sourceMockupId: params.mockupId,
      },
    );
    return asset.id;
  } finally {
    mockupBmp.close();
    designBmp.close();
  }
}

async function renderItem(item: BatchItem): Promise<string> {
  const placement = await getPlacement(item.designId, item.mockupId);
  return renderComposition({
    designId: item.designId,
    mockupId: item.mockupId,
    designAssetId: item.designAssetId,
    transform: item.transform,
    behindMockup: placement?.behindMockup ?? false,
  });
}

async function resolveTransform(
  designId: string,
  mockupId: string,
  placementTemplateId: string | undefined,
): Promise<{ transform: Transform }> {
  // A mockup with a print area takes its placement from the Printify Studio:
  // that is the placement the product was (or will be) listed with, so the
  // mockup and the product cannot disagree. It wins over a saved placement
  // for the same reason.
  const mockup = await db.mockups.get(mockupId);
  if (mockup && printAreaOf(mockup)) {
    const fromStudio = await transformFromPrintArea({ designId, mockup });
    if (fromStudio) return { transform: fromStudio };
  }
  const saved = await getPlacement(designId, mockupId);
  if (saved) return { transform: { ...saved.transform } };
  if (placementTemplateId) {
    const tpl = await db.templates.get(placementTemplateId);
    if (tpl && tpl.payload.type === "placement") return { transform: { ...tpl.payload.transform } };
  }
  return { transform: { ...DEFAULT_TRANSFORM } };
}

/** Creates a job and its items (reusing existing renders when asked), then runs it. */
export async function createBatchJob(params: {
  name?: string;
  designIds: string[];
  mockupIds: string[];
  variantRule: InkVariant;
  variantOverrides: Record<string, InkVariant>;
  concurrency: number;
  placementTemplateId?: string;
  skipExisting: boolean;
}): Promise<{ jobId: string; total: number; reused: number }> {
  const designs = (await db.designs.bulkGet(params.designIds)).filter((d): d is Design => !!d);
  const mockups = (await db.mockups.bulkGet(params.mockupIds)).filter((m): m is Mockup => !!m);
  const now = Date.now();
  const jobId = uid();
  const job: BatchJob = {
    id: jobId,
    name: params.name ?? `Batch ${new Date(now).toLocaleString()}`,
    status: "queued",
    concurrency: params.concurrency,
    variantRule: params.variantRule,
    variantOverrides: { ...params.variantOverrides },
    placementTemplateId: params.placementTemplateId,
    skipExisting: params.skipExisting,
    createdAt: now,
    updatedAt: now,
  };
  await db.batchJobs.put(job);

  const items: BatchItem[] = [];
  let reused = 0;
  for (const design of designs) {
    for (const mockup of mockups) {
      const variant: InkVariant = params.variantOverrides[design.id] ?? params.variantRule;
      const designAssetId = designAssetIdFor(design, variant);
      const itemId = `${jobId}:${design.id}:${mockup.id}:${designAssetId}`;
      const { transform } = await resolveTransform(design.id, mockup.id, params.placementTemplateId);
      let item: BatchItem = {
        id: itemId,
        jobId,
        designId: design.id,
        mockupId: mockup.id,
        designAssetId,
        transform,
        status: "pending",
      };
      if (params.skipExisting) {
        const existing = await db.assets
          .where("sourceDesignId")
          .equals(design.id)
          .filter(
            (a) => a.kind === "mockup-render" && a.sourceMockupId === mockup.id && a.parentId === designAssetId,
          )
          .first();
        if (existing) {
          item = {
            ...item,
            status: "done",
            outputAssetId: existing.id,
            note: "Reused existing render",
            finishedAt: now,
          };
          reused++;
        }
      }
      items.push(item);
    }
  }
  await db.batchItems.bulkPut(items);
  await logActivity(
    "batch.start",
    `Started batch "${job.name}" with ${items.length} combinations (${reused} reused)`,
    { jobId },
  );
  return { jobId, total: items.length, reused };
}

export async function runBatchJob(jobId: string): Promise<void> {
  const job = await db.batchJobs.get(jobId);
  if (!job) return;
  if (job.status === "running") return;
  await db.batchJobs.update(jobId, { status: "running", updatedAt: Date.now() });

  const state: RunState = { cancelled: false };
  running.set(jobId, state);

  try {
    // Items already marked done (reused renders) are skipped automatically.
    for (;;) {
      if (state.cancelled) break;
      const next = await db.batchItems
        .where("[jobId+status]")
        .equals([jobId, "pending"])
        .first();
      if (!next) break;
      await db.batchItems.update(next.id, { status: "processing", startedAt: Date.now() });
      await yieldToUi();
      try {
        const assetId = await renderItem(next);
        await db.batchItems.update(next.id, {
          status: state.cancelled ? "cancelled" : "done",
          outputAssetId: assetId,
          finishedAt: Date.now(),
          error: undefined,
        });
      } catch (err) {
        await db.batchItems.update(next.id, {
          status: "failed",
          error: err instanceof Error ? err.message : "Render failed",
          finishedAt: Date.now(),
        });
      }
      await yieldToUi();
    }

    if (state.cancelled) {
      await db.batchItems
        .where("[jobId+status]")
        .equals([jobId, "pending"])
        .modify({ status: "cancelled", error: "Cancelled" });
    }

    const all = await db.batchItems.where("jobId").equals(jobId).toArray();
    const anyFailed = all.some((i) => i.status === "failed");
    const anyCancelled = all.some((i) => i.status === "cancelled");
    const status = state.cancelled
      ? "cancelled"
      : anyFailed || anyCancelled
        ? "completed-with-errors"
        : "completed";
    await db.batchJobs.update(jobId, { status, updatedAt: Date.now() });
    await logActivity(
      "batch.item",
      `Batch finished: ${all.filter((i) => i.status === "done").length} done, ${all.filter((i) => i.status === "failed").length} failed`,
      { jobId },
    );
  } finally {
    running.delete(jobId);
  }
}

export async function cancelBatchJob(jobId: string): Promise<void> {
  const state = running.get(jobId);
  if (state) {
    state.cancelled = true;
    return;
  }
  await db.batchItems
    .where("[jobId+status]")
    .equals([jobId, "pending"])
    .modify({ status: "cancelled", error: "Cancelled" });
  await db.batchJobs.update(jobId, { status: "cancelled", updatedAt: Date.now() });
}

export function isJobRunning(jobId: string): boolean {
  return running.has(jobId);
}

/** Retry a single failed or cancelled item. */
export async function retryBatchItem(jobId: string, itemId: string): Promise<void> {
  const item = await db.batchItems.get(itemId);
  if (!item || (item.status !== "failed" && item.status !== "cancelled")) return;
  await db.batchItems.update(itemId, { status: "processing", error: undefined, note: undefined, startedAt: Date.now() });
  try {
    const assetId = await renderItem(item);
    await db.batchItems.update(itemId, {
      status: "done",
      outputAssetId: assetId,
      finishedAt: Date.now(),
      error: undefined,
    });
  } catch (err) {
    await db.batchItems.update(itemId, {
      status: "failed",
      error: err instanceof Error ? err.message : "Render failed",
      finishedAt: Date.now(),
    });
  }
}

export async function deleteBatchJob(jobId: string): Promise<void> {
  cancelBatchJob(jobId);
  await db.transaction("rw", [db.batchJobs, db.batchItems], async () => {
    await db.batchJobs.delete(jobId);
    await db.batchItems.where("jobId").equals(jobId).delete();
  });
  await logActivity("batch.start", "Deleted batch job", { jobId });
}

/**
 * On app load: a job that claims to be running/queued but has no live runner
 * was interrupted by a page reload. Mark its in-flight items as retryable
 * failures rather than showing fake "processing" forever.
 */
export async function recoverStaleJobs(): Promise<void> {
  const active = await db.batchJobs.where("status").anyOf(["running", "queued"]).toArray();
  for (const job of active) {
    if (running.has(job.id)) continue;
    await db.batchItems
      .where("jobId")
      .equals(job.id)
      .filter((i) => i.status === "processing" || i.status === "pending")
      .modify({ status: "failed", error: "Interrupted (app was reloaded) — retry to re-render" });
    await db.batchJobs.update(job.id, { status: "completed-with-errors", updatedAt: Date.now() });
  }
}