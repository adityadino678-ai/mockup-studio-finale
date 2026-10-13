import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { designAssetIdFor } from "@/lib/db/repo";
import { createBatchJob, recoverStaleJobs } from "@/lib/batch/runner";
import type { Design, Mockup } from "@/types/domain";

/**
 * These tests exercise the persistence layer (IndexedDB via fake-indexeddb).
 * They cover the behaviours acceptance testing depends on: designs survive
 * "reload", ink variants are independent, and batch jobs are created with the
 * correct item count and provenance.
 */

async function seed() {
  const now = Date.now();
  const design: Design = {
    id: "d1",
    name: "Cat design",
    tags: ["funny"],
    originalAssetId: "a1",
    whiteInkAssetId: "a2",
    createdAt: now,
    updatedAt: now,
    activeVariant: "main",
  };
  const mockup: Mockup = {
    id: "m1",
    name: "T-shirt front",
    category: "tshirt",
    tags: [],
    favorite: false,
    assetId: "a3",
    width: 1200,
    height: 1500,
    source: "user",
    createdAt: now,
  };
  await db.designs.put(design);
  await db.mockups.put(mockup);
  return { design, mockup };
}

describe("IndexedDB persistence", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("stores and reloads designs across a database reopen", async () => {
    const { design } = await seed();
    // Reopen the same database — simulates a page refresh.
    db.close();
    await db.open();
    const reloaded = await db.designs.get("d1");
    expect(reloaded?.name).toBe(design.name);
    expect(reloaded?.tags).toEqual(["funny"]);
  });

  it("keeps ink variants independent from the original asset", async () => {
    await seed();
    const stored = await db.designs.get("d1");
    expect(stored?.originalAssetId).toBe("a1");
    expect(stored?.whiteInkAssetId).toBe("a2");
    // Selecting the variant must not mutate the original reference.
    expect(designAssetIdFor(stored!, "main")).toBe("a1");
    expect(designAssetIdFor(stored!, "white")).toBe("a2");
    expect(designAssetIdFor(stored!, "black")).toBe("a1");
  });

  it("prefers the processed cutout as the main artwork when present", async () => {
    await seed();
    const d = (await db.designs.get("d1"))!;
    await db.designs.put({ ...d, processedAssetId: "a9" });
    const updated = (await db.designs.get("d1"))!;
    expect(designAssetIdFor(updated, "main")).toBe("a9");
  });

  it("creates a batch job with one item per design/mockup combination", async () => {
    await seed();
    const mockup2: Mockup = { ...(await db.mockups.get("m1"))!, id: "m2", name: "Mug", category: "mug", width: 1000, height: 1000 };
    await db.mockups.put(mockup2);

    const { jobId, total, reused } = await createBatchJob({
      designIds: ["d1"],
      mockupIds: ["m1", "m2"],
      variantRule: "main",
      variantOverrides: {},
      concurrency: 1,
      skipExisting: false,
    });

    expect(total).toBe(2);
    expect(reused).toBe(0);
    const items = await db.batchItems.where("jobId").equals(jobId).toArray();
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(items.every((i) => i.designAssetId === "a1")).toBe(true);
  });

  it("honours per-design variant overrides", async () => {
    await seed();
    const { total } = await createBatchJob({
      designIds: ["d1"],
      mockupIds: ["m1"],
      variantRule: "main",
      variantOverrides: { d1: "white" },
      concurrency: 1,
      skipExisting: false,
    });
    expect(total).toBe(1);
    const [item] = await db.batchItems.toArray();
    expect(item.designAssetId).toBe("a2"); // white ink asset
  });

  it("reuses an existing render instead of queueing a duplicate", async () => {
    await seed();
    const now = Date.now();
    await db.assets.put({
      id: "render1",
      kind: "mockup-render",
      name: "r.png",
      mime: "image/png",
      width: 100,
      height: 100,
      size: 10,
      createdAt: now,
      parentId: "a1",
      sourceDesignId: "d1",
      sourceMockupId: "m1",
    });
    const { total, reused } = await createBatchJob({
      designIds: ["d1"],
      mockupIds: ["m1"],
      variantRule: "main",
      variantOverrides: {},
      concurrency: 1,
      skipExisting: true,
    });
    expect(total).toBe(1);
    expect(reused).toBe(1);
    const [item] = await db.batchItems.toArray();
    expect(item.status).toBe("done");
    expect(item.outputAssetId).toBe("render1");
    expect(item.note).toMatch(/Reused/);
  });

  it("marks interrupted jobs as retryable failures instead of stuck processing", async () => {
    await seed();
    const now = Date.now();
    await db.batchJobs.put({
      id: "job1",
      name: "interrupted",
      status: "running",
      concurrency: 1,
      variantRule: "main",
      skipExisting: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.batchItems.put({
      id: "job1:item1",
      jobId: "job1",
      designId: "d1",
      mockupId: "m1",
      designAssetId: "a1",
      transform: { x: 0.5, y: 0.5, scale: 0.35, rotation: 0, flipX: false, flipY: false, opacity: 1, stretch: 1 },
      status: "processing",
    });

    await recoverStaleJobs();

    const job = await db.batchJobs.get("job1");
    const item = await db.batchItems.get("job1:item1");
    expect(job?.status).toBe("completed-with-errors");
    expect(item?.status).toBe("failed");
    expect(item?.error).toMatch(/Interrupted/);
  });
});