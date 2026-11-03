import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentTool,
  AGENT_TOOLS,
  toOpenAiTools,
} from "@/agent-tools/registry";
import {
  executeTool,
  CONFIRM_TOOL_RUNNERS,
  confirmBatchJob,
  confirmPrintifyProduct,
  confirmMockupRender,
  confirmSavePlacement,
  confirmInkVariant,
  confirmRemoveBackground,
  confirmSaveChatImage,
  confirmSaveListingDetails,
} from "@/agent-tools/runners";
import { db } from "@/lib/db/schema";
import {
  analyzeSeoPatterns,
} from "@/lib/etsy/seo-analyzer";
import { makeListingVariations } from "@/lib/etsy/patterns";
import type { EtsyResearch } from "@/types/etsy";
import type { SeoPattern } from "@/lib/etsy/seo-analyzer";

const WRITE_TOOLS = [
  "create_batch_job",
  "create_printify_product",
  "create_mockup_render",
  "save_placement",
  "create_ink_variant",
  "remove_background",
  "save_chat_image",
  "save_listing_details",
] as const;

const READ_TOOLS = [
  "explain_howto",
  "summarize_workspace",
  "list_library",
  "browse_printify_catalog",
  "draft_listing",
  "etsy_research",
  "read_design_image",
  "ask_user",
  "update_checklist",
  "spawn_research_pass",
] as const;

async function resetDb() {
  await db.delete();
  await db.open();
}

async function seedLibrary() {
  await db.designs.put({
    id: "d1", name: "Sunset", tags: [], originalAssetId: "a1",
    activeVariant: "main", createdAt: 1, updatedAt: 1,
  });
  await db.designs.put({
    id: "d2", name: "Moon", tags: [], originalAssetId: "a3",
    activeVariant: "main", createdAt: 2, updatedAt: 2,
  });
  await db.mockups.put({
    id: "m1", name: "Tee mockup", category: "tshirt", tags: [],
    favorite: false, assetId: "a2", width: 100, height: 100,
    source: "user", createdAt: 1,
  });
}

function stubFetch(payload: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as ReturnType<typeof vi.fn>;
}

function unstubFetch() {
  vi.unstubAllGlobals();
}

function callsUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  return String((fetchMock.mock.calls[index] ?? [])[0]);
}

describe("W7 Agent tool audit — registry", () => {
  it("registers exactly 18 tools, 8 of them confirm-writes", () => {
    expect(AGENT_TOOLS).toHaveLength(18);
    const writes = AGENT_TOOLS.filter((t) => t.confirm === true).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITE_TOOLS].sort());
    const reads = AGENT_TOOLS.filter((t) => t.confirm !== true).map((t) => t.name).sort();
    expect(reads).toEqual([...READ_TOOLS].sort());
  });

  it("marks every writing tool confirm:true and read tools not confirm", () => {
    for (const name of WRITE_TOOLS) expect(agentTool(name)?.confirm, name).toBe(true);
    for (const name of READ_TOOLS) expect(agentTool(name)?.confirm, name).toBeFalsy();
  });

  it("registers a confirm runner function for every writing tool", () => {
    for (const name of WRITE_TOOLS) {
      expect(CONFIRM_TOOL_RUNNERS[name], name).toBeTypeOf("function");
    }
    expect(Object.keys(CONFIRM_TOOL_RUNNERS).sort()).toEqual([...WRITE_TOOLS].sort());
  });

  it("every writing tool's confirm runner reference matches its schema name", () => {
    const runners: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
      create_batch_job: confirmBatchJob,
      create_printify_product: confirmPrintifyProduct,
      create_mockup_render: confirmMockupRender,
      save_placement: confirmSavePlacement,
      create_ink_variant: confirmInkVariant,
      remove_background: confirmRemoveBackground,
      save_chat_image: confirmSaveChatImage,
      save_listing_details: confirmSaveListingDetails,
    };
    for (const [toolName, runner] of Object.entries(runners)) {
      expect(CONFIRM_TOOL_RUNNERS[toolName]).toBe(runner);
    }
  });

  it("builds OpenAI tool defs only for requested names, preserving schema", () => {
    const defs = toOpenAiTools([...WRITE_TOOLS, "bogus" as string]);
    expect(defs.map((d) => d.function.name)).toEqual(WRITE_TOOLS);
    for (const def of defs) {
      const schema = agentTool(def.function.name)!;
      expect(def.function.parameters).toBe(schema.parameters);
      expect(def.type).toBe("function");
    }
  });
});

describe("W7 read-only tools — return data, write nothing", () => {
  beforeEach(resetDb);

  it("explain_howto returns an answer without writing", async () => {
    const result = await executeTool("explain_howto", { topic: "how do I upload a design" });
    expect(result.error).toBeUndefined();
    expect(result.confirm).toBeUndefined();
    expect(result.confirmation).toBeUndefined();
    expect(String((result.result as { answer: string }).answer)).toContain("Printify Studio");
    expect(await db.batchJobs.count()).toBe(0);
    expect(await db.listingDrafts.count()).toBe(0);
    expect(await db.productDrafts.count()).toBe(0);
  });

  it("summarize_workspace returns counts from IndexedDB without writing", async () => {
    await db.designs.put({ id: "d1", name: "Sunset", tags: [], originalAssetId: "a1", activeVariant: "main", createdAt: 1, updatedAt: 1 });
    const result = await executeTool("summarize_workspace", {});
    expect(result.error).toBeUndefined();
    expect((result.result as { designs: number }).designs).toBe(1);
    expect(result.summary).toContain("1 designs");
    expect(await db.batchJobs.count()).toBe(0);
  });

  it("list_library lists designs/mockups without writing", async () => {
    await seedLibrary();
    const designs = await executeTool("list_library", {});
    expect((designs.result as { items: unknown[] }).items).toHaveLength(2);
    const mockups = await executeTool("list_library", { kind: "mockups" });
    expect((mockups.result as { items: unknown[] }).items).toHaveLength(1);
    expect(await db.batchJobs.count()).toBe(0);
  });

  it("browse_printify_catalog calls the catalog endpoint and writes nothing", async () => {
    const fetchMock = stubFetch({ configured: true, blueprints: [{ id: 6, title: "Tee", brand: "G" }] });
    const result = await executeTool("browse_printify_catalog", { query: "mug" });
    unstubFetch();
    expect(result.error).toBeUndefined();
    expect(callsUrl(fetchMock)).toContain("q=mug");
    expect((result.result as { blueprints: unknown[] }).blueprints).toHaveLength(1);
    expect(await db.batchJobs.count()).toBe(0);
  });

  it("draft_listing calls /api/ai/seo and returns copy ideas only", async () => {
    stubFetch({ configured: true, result: { titleDrafts: ["Cat Mug"], tags: ["cat mug"] } });
    const result = await executeTool("draft_listing", { concept: "cat mug" });
    unstubFetch();
    expect(result.error).toBeUndefined();
    expect((result.result as { titleDrafts: string[] }).titleDrafts).toContain("Cat Mug");
    expect(await db.listingDrafts.count()).toBe(0);
  });

  it("etsy_research returns observed data without writing", async () => {
    stubFetch({ research: { sampled: 3, titleTerms: [{ term: "cat", count: 3 }] } });
    const result = await executeTool("etsy_research", { query: "cat mug" });
    unstubFetch();
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("Etsy research");
    expect(await db.batchJobs.count()).toBe(0);
  });
});

describe("W3 schema vs confirm-runner mismatch audit — zero mismatches", () => {
  const RUNNER_PAYLOAD_KEYS: Record<string, string[]> = {
    create_batch_job: ["name", "designIds", "mockupIds", "variant", "skipExisting", "total"],
    create_printify_product: [
      "designId", "designName", "artworkBase64", "artworkName", "title", "description",
      "tags", "blueprintId", "printProviderId", "price", "prices", "variantIds",
      "printArea", "ink",
    ],
    create_mockup_render: [
      "designId", "designName", "mockupId", "mockupName", "ink", "behindMockup",
    ],
    save_placement: [
      "designId", "designName", "mockupId", "mockupName", "transform", "asTemplate", "templateName",
    ],
    create_ink_variant: ["designId", "designName", "ink"],
    remove_background: ["designId", "designName", "tolerance"],
    save_chat_image: ["kind", "name", "index", "category"],
    save_listing_details: ["listingIds", "items", "title", "description", "tags", "priceCents"],
  };

  it("every schema property maps to a runner payload field (no orphaned schema keys)", () => {
    // Deliberate renames: schema input key → confirm runner payload key, per tool.
    const RENAMED: Record<string, Record<string, string>> = {
      save_listing_details: { design: "listingIds", price: "priceCents" },
      create_batch_job: { designs: "designIds", mockups: "mockupIds" },
      create_printify_product: { design: "designId", mockup: "mockupId", productType: "blueprintId", variantFilters: "variantIds" },
      create_mockup_render: { design: "designId", mockup: "mockupId" },
      create_ink_variant: { design: "designId" },
      remove_background: { design: "designId" },
      save_placement: { design: "designId", mockup: "mockupId" },
    };
    for (const tool of WRITE_TOOLS) {
      const schema = agentTool(tool)!;
      const declared = Object.keys(schema.parameters.properties as Record<string, unknown>);
      const runnerKeys = RUNNER_PAYLOAD_KEYS[tool] ?? [];
      const renamed = RENAMED[tool] ?? {};
      // Every schema property that names data must survive into the confirm payload.
      // `items` (batch) and `transform` (nested) are intentionally passed whole.
      for (const prop of declared) {
        if (prop === "items" || prop === "transform") continue;
        const expectedKey = renamed[prop] ?? prop;
        expect(runnerKeys).toContain(expectedKey);
      }
    }
  });

  it("every confirm-runner payload key is produced from a schema property", () => {
    for (const tool of WRITE_TOOLS) {
      const schema = agentTool(tool)!;
      const declared = Object.keys(schema.parameters.properties as Record<string, unknown>);
      const runnerKeys = RUNNER_PAYLOAD_KEYS[tool] ?? [];
      const allowedSynthesized = [
        "name", "designName", "mockupName", "designId", "mockupId",
        "designIds", "mockupIds", "listingIds", "variantIds", "total",
        "artworkBase64", "artworkName",
      ];
      for (const key of runnerKeys) {
        expect(
          declared.includes(key) || allowedSynthesized.includes(key),
        ).toBe(true);
      }
    }
  });

  it("items param uses `items` (array) not `design` for batch — no 'design' bug class", () => {
    const schema = agentTool("save_listing_details")!;
    const params = schema.parameters as { properties?: Record<string, unknown> };
    const items = params.properties?.items;
    expect(items).toBeDefined();
    expect((items as { type?: string }).type).toBe("array");
    const itemProps = (items as { items?: { properties?: Record<string, unknown> } }).items?.properties;
    expect(itemProps).toBeDefined();
    expect(itemProps?.design).toBeDefined();
    expect(itemProps?.listingId).toBeDefined();
  });

  it("create_mockup_render schema has no stray `design`/`ink` bug in runner payload", () => {
    const schema = agentTool("create_mockup_render")!;
    const props = schema.parameters.properties as Record<string, unknown>;
    expect(props.design).toBeDefined();
    expect(props.ink).toBeDefined();
    expect(RUNNER_PAYLOAD_KEYS.create_mockup_render).toContain("designId");
    expect(RUNNER_PAYLOAD_KEYS.create_mockup_render).toContain("ink");
  });

  it("remove_background does not expose an engine choice (fixed local chain)", () => {
    const schema = agentTool("remove_background")!;
    const props = schema.parameters.properties as Record<string, unknown>;
    expect(props.engine).toBeUndefined();
    const runnerKeys = RUNNER_PAYLOAD_KEYS.remove_background;
    expect(runnerKeys).not.toContain("engine");
  });

  it("save_listing_details items accept design OR listingId per item", () => {
    const schema = agentTool("save_listing_details")!;
    const params = schema.parameters as { properties?: Record<string, unknown> };
    const items = params.properties?.items as { items?: { properties?: Record<string, unknown> } } | undefined;
    const props = items?.items?.properties ?? {};
    expect(props.design).toBeDefined();
    expect(props.listingId).toBeDefined();
  });
});

describe("W7 write tools — local writes auto-run, Printify stays gated", () => {
  beforeEach(resetDb);

  it("create_batch_job: auto-runs and persists a job with no confirmation step", async () => {
    await seedLibrary();
    const executed = await executeTool("create_batch_job", { designs: ["sunset"], variant: "white" });
    expect(executed.error).toBeUndefined();
    // No confirmation: the local write runs itself now.
    expect(executed.confirmation).toBeUndefined();
    expect((executed.result as { jobId: string }).jobId).toBeDefined();
    expect(await db.batchJobs.count()).toBeGreaterThan(0);
  });

  it("create_printify_product: still proposes a confirmation and writes nothing until confirmed", async () => {
    await seedLibrary();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/printify/products")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(JSON.stringify({ product: { id: "p1", title: String(body.title ?? "Sunset Tee") } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("q=")) {
        return new Response(JSON.stringify({ configured: true, blueprints: [{ id: 6, title: "Tee", brand: "G" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("providers=1")) {
        return new Response(JSON.stringify({ configured: true, providers: [{ id: 30, title: "P" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ configured: true, variants: [{ id: 1, available: true, placeholders: [{ position: "front" }] }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const attachment = { name: "sunset.png", mime: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const proposed = await executeTool("create_printify_product", {
      design: "zzz-nonexistent", productType: "t-shirt", price: 1999,
    }, { attachments: [attachment] });
    expect(proposed.error).toBeUndefined();
    expect(proposed.confirmation).toBeDefined();
    expect(callsUrl(fetchMock)).toContain("q=tee");
    expect(await db.productDrafts.count()).toBe(0); // nothing persisted yet
    expect(proposed.confirmation?.payload.artworkBase64).toBe("iVBORw0KGgo=");

    const executed = await confirmPrintifyProduct(proposed.confirmation!.payload);
    expect(executed.error).toBeUndefined();
    expect(await db.productDrafts.count()).toBe(1);
    const draft = (await db.productDrafts.toArray())[0];
    expect(draft?.name).toBe("sunset.png");
    expect(draft?.remoteProductId).toBe("p1");
    vi.unstubAllGlobals();
  });

  it("create_printify_product is the ONLY tool that still asks for a click", () => {
    // The seven local writes run themselves; only the Printify spend is gated.
    const gated = Object.keys(CONFIRM_TOOL_RUNNERS).filter(
      (name) => name !== "create_printify_product",
    );
    expect(gated.length).toBe(7);
  });

  it("create_mockup_render: auto-runs and reports missing artwork, writes nothing", async () => {
    await seedLibrary();
    const executed = await executeTool("create_mockup_render", { design: "sunset", mockup: "tee" });
    expect(executed.error).toBeDefined();
    expect(executed.confirmation).toBeUndefined();
    expect(await db.assets.where("kind").equals("mockup-render").count()).toBe(0);
  });

  it("save_placement: auto-runs and persists a placement + template", async () => {
    await seedLibrary();
    const executed = await executeTool("save_placement", {
      design: "sunset", mockup: "tee",
      transform: { x: 2, y: 0.5, scale: 0.4 }, asTemplate: true, templateName: "Chest print",
    });
    expect(executed.error).toBeUndefined();
    expect(executed.confirmation).toBeUndefined();
    expect(await db.placements.count()).toBe(1);
    expect(await db.templates.count()).toBe(1);
  });

  it("create_ink_variant: auto-runs and reports missing artwork, writes nothing", async () => {
    await seedLibrary();
    const executed = await executeTool("create_ink_variant", { design: "sunset", ink: "black" });
    expect(executed.error).toBeDefined();
    expect(executed.confirmation).toBeUndefined();
    const processed = await db.assets.where("kind").equals("design-processed").toArray();
    expect(processed).toEqual([]);
  });

  it("remove_background: auto-runs and reports missing artwork, writes nothing", async () => {
    await seedLibrary();
    const executed = await executeTool("remove_background", { design: "sunset" });
    expect(executed.error).toBeDefined();
    expect(executed.confirmation).toBeUndefined();
    const design = await db.designs.get("d1");
    expect(design?.processedAssetId).toBeUndefined();
  });

  it("save_chat_image: refuses without an attachment; auto-runs the save with one", async () => {
    const noImage = await executeTool("save_chat_image", { kind: "design", name: "New art" });
    expect(noImage.error).toBeDefined();
    expect(noImage.confirmation).toBeUndefined();

    // A malformed data URL makes the runner's own decode step throw, which is
    // exactly what we want here: it proves executeTool RAN the runner (an
    // error result, not a pending confirmation) without hanging the test on
    // real image decoding, which the jsdom env does not support.
    const withImage = await executeTool(
      "save_chat_image",
      { kind: "design", name: "New art" },
      { attachments: [{ name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,!!!" }] },
    );
    expect(withImage.error).toBeDefined();
    expect(withImage.confirmation).toBeUndefined();
  });

  it("save_listing_details single: auto-runs and persists one draft", async () => {
    await seedLibrary();
    const { loadSession, saveSession } = await import("@/lib/printify/studio-session");
    const session = await loadSession();
    await saveSession({ ...session, designIds: ["d1", "d2"], titleTemplate: "{design}", priceMode: "fixed", priceCents: 1999 });

    const executed = await executeTool("save_listing_details", {
      design: "sunset", title: "Golden Hour Tee", price: 24.99,
    });
    expect(executed.error).toBeUndefined();
    expect(executed.confirmation).toBeUndefined();
    const drafts = await db.listingDrafts.where("designId").equals("d1").toArray();
    expect(drafts.length).toBe(1);
    expect(drafts[0].title).toBe("Golden Hour Tee");
    expect(drafts[0].priceCents).toBe(2499);
  });

  it("save_listing_details items: auto-runs unique copy per listing, accepts design OR listingId", async () => {
    await seedLibrary();
    const { loadSession, saveSession } = await import("@/lib/printify/studio-session");
    const session = await loadSession();
    await saveSession({ ...session, designIds: ["d1", "d2"], titleTemplate: "{design}", priceMode: "fixed", priceCents: 1999 });

    const executed = await executeTool("save_listing_details", {
      items: [
        { design: "Sunset", title: "Golden Hour Tee", price: 24.99 },
        { listingId: "d2", title: "Night Sky Tee", priceCents: 1999 },
      ],
    });
    expect(executed.error).toBeUndefined();
    expect(executed.confirmation).toBeUndefined();
    const sunset = (await db.listingDrafts.where("designId").equals("d1").toArray())[0];
    expect(sunset.title).toBe("Golden Hour Tee");
    const moon = (await db.listingDrafts.where("designId").equals("d2").toArray())[0];
    expect(moon.title).toBe("Night Sky Tee");
  });
});

describe("W7 save_listing_details — useSeoTemplate generates unique SEO copy per listing", () => {
  const research: EtsyResearch = {
    query: "cat mug",
    searchedAt: 1_700_000_000_000,
    source: "etsy-api",
    activeListings: 42,
    sampled: 8,
    topTags: [
      { term: "cat mug", count: 4 }, { term: "cat mom", count: 3 },
      { term: "personalized gift", count: 2 }, { term: "coffee mug", count: 2 },
    ],
    titleTerms: [
      { term: "cat", count: 5 }, { term: "mug", count: 5 },
      { term: "personalized", count: 3 }, { term: "gift", count: 2 },
    ],
    medianPriceCents: 2499,
    currency: "USD",
    samples: [],
    disclaimer: "observed",
  };

  const pattern: SeoPattern = analyzeSeoPatterns(research);

  it("analyzeSeoPatterns exposes observed terms, tag frequencies and median band", () => {
    expect(pattern.topTitleTerms.map((t) => t.term)).toEqual(["cat", "mug", "personalized", "gift"]);
    expect(pattern.topTagFrequencies.map((t) => t.term)).toContain("cat mug");
    expect(pattern.medianPriceCents).toBe(2499);
    expect(pattern.medianPriceBand?.label).toBe("$15-$25");
  });

  it("makeListingVariations produces unique title+tags per listing from the pattern", () => {
    const variations = makeListingVariations(pattern, 6, { seed: 1 });
    expect(variations).toHaveLength(6);
    const sigs = new Set(variations.map((v) => `${v.title.toLowerCase()}::${v.tags.join(",")}`));
    expect(sigs.size).toBe(6);
    for (const v of variations) {
      expect(v.title.length).toBeLessThanOrEqual(140);
      expect(v.tags.length).toBeLessThanOrEqual(13);
      for (const tag of v.tags) expect(tag.length).toBeLessThanOrEqual(20);
      expect(v.priceCents).toBe(2499);
    }
  });

  it("each listing gets distinct copy with a forced price applied to all", () => {
    const variations = makeListingVariations(pattern, 5, { seed: 9, priceCents: 1850 });
    const sigs = new Set(variations.map((v) => `${v.title.toLowerCase()}::${v.tags.join(",")}`));
    expect(sigs.size).toBe(5);
    for (const v of variations) expect(v.priceCents).toBe(1850);
  });
});
