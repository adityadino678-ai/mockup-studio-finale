import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import {
  buildManifest,
  collectEntries,
  defaultTableLoader,
  isSecretSettingKey,
  PART_LIMIT_BYTES,
  partFileName,
  planBytes,
  planParts,
  storageNotice,
} from "@/lib/export/local-export";

// ---------------------------------------------------------------------------
// The local export: all of IndexedDB -> a folder the user chooses. The pure
// helpers here keep the planning honest; `collectEntries` pins what actual
// tables land in the folder and what is held back as a secret.
// ---------------------------------------------------------------------------

describe("planning helpers", () => {
  it("isSecretSettingKey matches exactly the credential settings", () => {
    expect(isSecretSettingKey("integrations")).toBe(true);
    expect(isSecretSettingKey("printifyStudio:session")).toBe(false);
    expect(isSecretSettingKey("ai:models:openrouter")).toBe(false);
    expect(isSecretSettingKey("ai:speakReplies")).toBe(false);
  });

  it("planBytes rounds up under the 500 MB part limit", () => {
    expect(planBytes(0)).toBe(1);
    expect(planBytes(1)).toBe(1);
    expect(planBytes(PART_LIMIT_BYTES)).toBe(1);
    expect(planBytes(PART_LIMIT_BYTES + 1)).toBe(2);
    expect(planBytes(3 * PART_LIMIT_BYTES)).toBe(3);
  });

  it("a small limit still yields parts", () => {
    // A degenerate limit is clamped to 1 byte, so every byte is one part.
    expect(planBytes(10, 0)).toBe(10);
    expect(planBytes(10, 4)).toBe(3);
  });

  it("planParts greedily fills parts up to the limit", () => {
    // sizes 6, 4, 2, 3 with limit 7 -> [6,4] fits (10 > 7, so first part is
    // just 6), second part 4+2=6, third 3.
    expect(planParts([6, 4, 2, 3], 7)).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 3 },
      { from: 3, to: 4 },
    ]);
  });

  it("planParts keeps one huge item alone and never returns an empty part", () => {
    expect(planParts([100, 1, 1], 50)).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 3 },
    ]);
    expect(planParts([], 50)).toEqual([{ from: 0, to: 0 }]);
  });

  it("partFileName is stable, zero-padded and range-labelled", () => {
    expect(partFileName(1, 2, "2026-11-10")).toBe("MockupStudio_Export_2026-11-10_01-of-02.zip");
    expect(partFileName(2, 2, "2026-11-10")).toBe("MockupStudio_Export_2026-11-10_02-of-02.zip");
    // A malformed date must not produce an unexpected filename.
    expect(partFileName(1, 1, "nope")).toContain("MockupStudio_Export_export_01-of-01");
  });

  it("buildManifest carries the schema version and the secrets flag", () => {
    const manifest = buildManifest({
      schemaVersion: 6,
      exportedAt: 1000,
      includeSecrets: false,
      counts: { designs: 2, blobs: 5 },
    });
    expect(manifest).toEqual({
      app: "mockup-studio",
      schemaVersion: 6,
      exportedAt: 1000,
      includesSecrets: false,
      counts: { designs: 2, blobs: 5 },
    });
    // `parts` is optional and only appears on the ZIP path.
    expect("parts" in manifest).toBe(false);
    expect(buildManifest({ schemaVersion: 6, exportedAt: 1, includeSecrets: true, counts: {}, parts: 3 }).parts).toBe(3);
  });

  it("storageNotice speaks at 80% and stretches at 95%", () => {
    expect(storageNotice(10, 100)).toBeNull();
    expect(storageNotice(0, 100)).toBeNull();
    expect(storageNotice(10, 0)).toBeNull();
    expect(storageNotice(80, 100)?.level).toBe("attention");
    expect(storageNotice(94, 100)?.level).toBe("attention");
    expect(storageNotice(95, 100)?.level).toBe("urgent");
    expect(storageNotice(100, 100)?.level).toBe("urgent");
  });
});

describe("collectEntries against the real schema", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  /** Seeds a small workspace: one design -> one asset -> one blob + thumb. */
  async function seedWorkspace() {
    await db.designs.put({
      id: "d1",
      name: "cat",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    await db.mockups.put({
      id: "m1",
      name: "tee",
      category: "tshirt",
      tags: [],
      favorite: false,
      assetId: "a1",
      width: 1000,
      height: 1000,
      source: "user",
      createdAt: 1,
    });
    await db.assets.put({
      id: "a1",
      kind: "design-original",
      name: "cat.png",
      mime: "image/png",
      width: 8,
      height: 8,
      size: 100,
      createdAt: 1,
    });
    await db.blobs.put({ id: "a1", blob: new Blob(["png-bytes"], { type: "image/png" }) });
    await db.thumbs.put({ id: "a1", blob: new Blob(["thumb"], { type: "image/webp" }) });
    await db.settings.put({ key: "integrations", value: { printifyKey: "secret" } });
    await db.settings.put({ key: "printifyStudio:session", value: { designIds: ["d1"] } });
  }

  it("exports every table with binaries as their own files", async () => {
    await seedWorkspace();
    // fake-indexeddb cannot round-trip a Blob (its clone flattens it), so the
    // binary rows come from an injected loader carrying real Blobs; every
    // other table still reads the real store.
    const { entries, counts } = await collectEntries(false, (table, secrets) =>
      table === "blobs"
        ? Promise.resolve([{ id: "a1", blob: new Blob(["png-bytes"], { type: "image/png" }) }])
        : table === "thumbs"
          ? Promise.resolve([{ id: "a1", blob: new Blob(["thumb"], { type: "image/webp" }) }])
          : defaultTableLoader(table, secrets),
    );

    const paths = entries.map((entry) => entry.path);
    // One JSON file per metadata table...
    for (const table of ["designs", "mockups", "assets", "settings"]) {
      expect(paths).toContain(`tables/${table}.json`);
    }
    // ...and one file per binary, keyed by id.
    expect(paths).toContain("blobs/a1");
    expect(paths).toContain("thumbs/a1");

    const designs = (await readJson(entries, "tables/designs.json")) as {
      rows: Array<{ name: string }>;
    };
    expect(designs.rows).toHaveLength(1);
    expect(designs.rows[0].name).toBe("cat");
    const blobEntry = entries.find((candidate) => candidate.path === "blobs/a1");
    expect(blobEntry).toBeDefined();
    expect(await blobEntry!.blob.text()).toBe("png-bytes");

    expect(counts.designs).toBe(1);
    expect(counts.mockups).toBe(1);
    expect(counts.blobs).toBe(1);
    expect(counts.thumbs).toBe(1);
  });

  it("leaves the saved API keys out unless the user opts in", async () => {
    await seedWorkspace();
    const { entries: safe } = await collectEntries(false);
    const safeSettings = (await readJson(safe, "tables/settings.json")) as {
      rows: Array<{ key: string }>;
    };
    const safeKeys = safeSettings.rows.map((row) => row.key);
    expect(safeKeys).toContain("printifyStudio:session");
    expect(safeKeys).not.toContain("integrations");

    const { entries: withSecrets } = await collectEntries(true);
    const fullSettings = (await readJson(withSecrets, "tables/settings.json")) as {
      rows: Array<{ key: string }>;
    };
    const fullKeys = fullSettings.rows.map((row) => row.key);
    expect(fullKeys).toContain("integrations");
  });

  it("an empty workspace still exports a manifest-worth of empty tables", async () => {
    const { entries, counts } = await collectEntries(false);
    expect(entries.length).toBeGreaterThan(0);
    const settings = (await readJson(entries, "tables/settings.json")) as {
      rows: unknown[];
    };
    expect(settings.rows).toEqual([]);
    expect(counts.designs).toBe(0);
  });

  it("the exportHandles resume table exists on schema v6", () => {
    expect(db.verno).toBeGreaterThanOrEqual(6);
    expect(db.exportHandles.schema.primKey.name).toBe("id");
  });
});

/** Reads one export entry back, whether it is JSON or a raw blob. */
async function readJson(
  entries: Array<{ path: string; blob: Blob }>,
  path: string,
): Promise<unknown> {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`missing ${path}`);
  if (entry.blob.type === "application/json") return JSON.parse(await entry.blob.text());
  return entry.blob;
}
