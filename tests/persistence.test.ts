import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { clearPrintArea, designAssetIdFor, savePrintArea } from "@/lib/db/repo";
import { createBatchJob, recoverStaleJobs } from "@/lib/batch/runner";
import { applyPrintAreaToMockups } from "@/lib/mockups/propagate";
import { printAreaOf } from "@/lib/mockups/print-area";
import type { Design, Mockup, MockupPrintArea } from "@/types/domain";

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

/** A 4500 x 5400 DTG area, the one the mockups panel writes. */
function printArea(patch: Partial<MockupPrintArea> = {}): MockupPrintArea {
  return {
    areaWidth: 4500,
    areaHeight: 5400,
    source: { kind: "manual" },
    label: "Front",
    frame: { x: 0.5, y: 0.4, scale: 0.4, rotation: 0 },
    clipMode: "area",
    updatedAt: 0,
    ...patch,
  };
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

describe("print areas are per design", () => {
  const OTHER_FRAME = { x: 0.15, y: 0.15, scale: 0.15, rotation: 0 };

  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  /** Three mockups: two tees and a mug, all with a shared base area. */
  async function seedMockups(): Promise<MockupPrintArea> {
    const now = Date.now();
    const base = printArea();
    const tee: Mockup = {
      id: "m1",
      name: "Tee front",
      category: "tshirt",
      tags: [],
      favorite: false,
      assetId: "img1",
      width: 1200,
      height: 1500,
      source: "user",
      printArea: base,
      designAreas: { other: printArea({ frame: { ...OTHER_FRAME } }) },
      createdAt: now,
    };
    await db.mockups.bulkPut([
      tee,
      { ...tee, id: "m2", name: "Tee back", assetId: "img2" },
      { ...tee, id: "m3", name: "Mug", assetId: "img3", category: "mug" },
    ]);
    return base;
  }

  it("writes only that design's overrides across the scope", async () => {
    const base = await seedMockups();
    const next = printArea({ frame: { x: 0.7, y: 0.6, scale: 0.5, rotation: 5 } });

    const result = await applyPrintAreaToMockups({
      sourceMockupId: "m1",
      area: next,
      scope: "category",
      designId: "design-a",
    });

    expect(result.updated).toBe(2);
    for (const id of ["m1", "m2"]) {
      const mockup = (await db.mockups.get(id))!;
      // This design's override is the new frame.
      expect(printAreaOf(mockup, "design-a")?.frame).toEqual(next.frame);
      // The shared base never moved, so other designs keep their default.
      expect(mockup.printArea?.frame).toEqual(base.frame);
      // And the other design's own override is preserved.
      expect(printAreaOf(mockup, "other")?.frame).toEqual(OTHER_FRAME);
    }

    // A mockup of another type is out of scope, so it is untouched.
    const mug = (await db.mockups.get("m3"))!;
    expect(mug.designAreas?.["design-a"]).toBeUndefined();
    expect(printAreaOf(mug, "design-a")?.frame).toEqual(base.frame);
  });

  it("saves and clears one design's area without touching the base", async () => {
    const base = await seedMockups();
    const next = printArea({ frame: { x: 0.35, y: 0.25, scale: 0.3, rotation: 0 } });

    await savePrintArea("m1", next, "design-a");
    let mockup = (await db.mockups.get("m1"))!;
    expect(printAreaOf(mockup, "design-a")?.frame).toEqual(next.frame);
    expect(mockup.printArea?.frame).toEqual(base.frame);
    expect(printAreaOf(mockup, "other")?.frame).toEqual(OTHER_FRAME);

    // Clearing writes a deliberate `null`, not a missing key: the shared base
    // must not quietly take over again.
    await clearPrintArea("m1", "design-a");
    mockup = (await db.mockups.get("m1"))!;
    expect(mockup.designAreas?.["design-a"]).toBeNull();
    expect(printAreaOf(mockup, "design-a")).toBeUndefined();
    expect(printAreaOf(mockup)?.frame).toEqual(base.frame);
    expect(printAreaOf(mockup, "other")?.frame).toEqual(OTHER_FRAME);
  });

  it("keeps the legacy no-design call writing the shared base", async () => {
    await seedMockups();
    const baseNext = printArea({ frame: { x: 0.2, y: 0.2, scale: 0.2, rotation: 0 } });

    await savePrintArea("m1", baseNext);
    let mockup = (await db.mockups.get("m1"))!;
    expect(mockup.printArea?.frame).toEqual(baseNext.frame);
    // The per-design override that was already there did not move.
    expect(printAreaOf(mockup, "other")?.frame).toEqual(OTHER_FRAME);

    const scopedNext = printArea({ frame: { x: 0.6, y: 0.3, scale: 0.25, rotation: 0 } });
    await applyPrintAreaToMockups({
      sourceMockupId: "m1",
      area: scopedNext,
      scope: "this",
    });
    mockup = (await db.mockups.get("m1"))!;
    expect(mockup.printArea?.frame).toEqual(scopedNext.frame);
    expect(mockup.designAreas?.other?.frame).toEqual(OTHER_FRAME);
  });

  it("clears the shared base only without a design id", async () => {
    await seedMockups();
    await clearPrintArea("m1");
    const mockup = (await db.mockups.get("m1"))!;
    expect(mockup.printArea).toBeUndefined();
    expect(printAreaOf(mockup, "other")?.frame).toEqual(OTHER_FRAME);
  });
});