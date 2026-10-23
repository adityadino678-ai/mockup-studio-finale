import { unzip, zip, type Zippable } from "fflate";
import { db } from "@/lib/db/schema";
import { designMainAssetId, getAssetBlob } from "@/lib/db/repo";
import { sanitizeFilename } from "@/lib/image/image";
import { loadSession } from "@/lib/printify/studio-session";
import type { Design, ExportJob, ExportSelection, ListingDraft, Mockup } from "@/types/domain";

// ---------------------------------------------------------------------------
// ZIP export. Builds the documented structure:
//
//   MockupStudio_Export/
//     manifest.json
//     Design_A/
//       original.png
//       white-ink.png / black-ink.png
//       mockups/mockup_01.png
//       listing/listing.json, description.txt
//
// Only real, existing files are included. The archive is re-read and verified
// against the manifest before the job is marked successful.
// ---------------------------------------------------------------------------

export interface ExportProgress {
  (info: { phase: "collecting" | "packing" | "verifying"; done: number; total: number; current?: string }): void;
}

export interface ExportResult {
  blob: Blob;
  fileCount: number;
  missingAssets: string[];
  errors: string[];
}

interface ManifestDesign {
  design: string;
  files: string[];
  mockups: Array<{ mockup: string; file: string }>;
  listing?: { title: string; tags: string[]; price?: string; file: string; descriptionFile?: string };
  notes: string[];
}

async function extensionFor(blob: Blob, fallback = "png"): Promise<string> {
  if (blob.type === "image/jpeg") return "jpg";
  if (blob.type === "image/webp") return "webp";
  if (blob.type === "image/png") return "png";
  return fallback;
}

/** Unique, readable, filesystem-safe folder name for a design. */
function uniqueFolderName(name: string, used: Set<string>): string {
  let base = sanitizeFilename(name).replace(/\.[^.]+$/, "").trim() || "design";
  base = base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}_${i}`;
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function buildExportArchive(
  selection: ExportSelection,
  onProgress?: ExportProgress,
): Promise<ExportResult> {
  const designs = (await db.designs.bulkGet(selection.designIds)).filter((d): d is Design => !!d);
  const session = await loadSession();
  // A pair is ONE listing owned by the black-ink half. Its copy, price and
  // selected images live under that id, so the white half must look them up
  // there or it would export an unrelated fallback render set.
  const ownerByDesign = new Map<string, string>();
  for (const pair of session.inkPairs ?? []) {
    ownerByDesign.set(pair.blackInkDesignId, pair.blackInkDesignId);
    ownerByDesign.set(pair.whiteInkDesignId, pair.blackInkDesignId);
  }
  const files: Zippable = {};
  const missingAssets: string[] = [];
  const errors: string[] = [];
  const manifestDesigns: ManifestDesign[] = [];
  const usedFolders = new Set<string>();
  let totalFiles = 0;

  onProgress?.({ phase: "collecting", done: 0, total: selection.designIds.length });

  for (const [index, design] of designs.entries()) {
    const folder = `MockupStudio_Export/${uniqueFolderName(design.name, usedFolders)}`;
    const designFiles: string[] = [];
    const mockupEntries: ManifestDesign["mockups"] = [];
    const notes: string[] = [];

    // --- original (and its processed cutout when present) ---
    const mainAssetId = designMainAssetId(design);
    const originalAsset = await db.assets.get(design.originalAssetId);
    const originalBlob = await getAssetBlob(design.originalAssetId);
    if (originalBlob && originalAsset) {
      const ext = await extensionFor(originalBlob);
      const path = `${folder}/original.${ext}`;
      files[path] = [new Uint8Array(await originalBlob.arrayBuffer()), { level: 6 }];
      designFiles.push(`original.${ext}`);
      totalFiles++;
      if (mainAssetId !== design.originalAssetId) {
        const processedBlob = await getAssetBlob(mainAssetId);
        if (processedBlob) {
          const pExt = await extensionFor(processedBlob);
          const pPath = `${folder}/cutout.${pExt}`;
          files[pPath] = [new Uint8Array(await processedBlob.arrayBuffer()), { level: 6 }];
          designFiles.push(`cutout.${pExt}`);
          totalFiles++;
        }
      }
    } else {
      missingAssets.push(`${design.name}: original file missing`);
    }

    // --- ink variants ---
    const variantEntries: Array<[string, string | undefined]> = [
      ["white-ink", selection.includeWhiteInk ? design.whiteInkAssetId : undefined],
      ["black-ink", selection.includeBlackInk ? design.blackInkAssetId : undefined],
    ];
    for (const [label, assetId] of variantEntries) {
      if (!selection.includeWhiteInk && !selection.includeBlackInk) continue;
      if (!assetId) {
        if ((label === "white-ink" && selection.includeWhiteInk) || (label === "black-ink" && selection.includeBlackInk)) {
          notes.push(`${label} not created for this design`);
        }
        continue;
      }
      const blob = await getAssetBlob(assetId);
      if (!blob) {
        missingAssets.push(`${design.name}: ${label} file missing`);
        continue;
      }
      const ext = await extensionFor(blob);
      const path = `${folder}/${label}.${ext}`;
      files[path] = [new Uint8Array(await blob.arrayBuffer()), { level: 6 }];
      designFiles.push(`${label}.${ext}`);
      totalFiles++;
    }

    // --- the local listing draft (copy, tags, and the selected images) ---
    const ownerId = ownerByDesign.get(design.id) ?? design.id;
    const isPartner = ownerId !== design.id;
    const draftRows = await db.listingDrafts.where("designId").equals(ownerId).toArray();
    const listing: ListingDraft | undefined =
      draftRows.sort((a, b) => a.updatedAt - b.updatedAt)[draftRows.length - 1];
    const ownerName = isPartner
      ? ((await db.designs.get(ownerId))?.name ?? "the paired design")
      : design.name;

    // --- generated mockups for this design ---
    if (selection.includeMockupRenders) {
      // When the Studio selected the listing's images, export exactly those, in
      // click order. Otherwise fall back to every render that exists, which is
      // the old behaviour for designs that never went through Listing images.
      const ownerLocked = !!listing?.imageSelectionLocked;
      const selectedAssetIds =
        !isPartner && ownerLocked ? (listing?.imageAssetIds ?? []) : null;

      if (isPartner && ownerLocked) {
        // The pair's images live in the owner's folder. Exporting the white
        // half alone must not fall back to renders the user never picked.
        notes.push(
          `listing images belong to ${ownerName}; add that design to the export to include them`,
        );
      } else {
        const renders = selectedAssetIds
          ? []
          : await db.assets
              .where("sourceDesignId")
              .equals(design.id)
              .filter((a) => a.kind === "mockup-render")
              .sortBy("createdAt");

        const entries = selectedAssetIds
          ? await Promise.all(
              [...new Set(selectedAssetIds)].map(async (assetId) => ({
                blob: await getAssetBlob(assetId),
                meta: await db.assets.get(assetId),
                fallbackName: "listing image",
              })),
            )
          : await Promise.all(
              renders.map(async (render) => ({
                blob: await getAssetBlob(render.id),
                meta: render,
                fallbackName: "mockup",
              })),
            );

        let n = 0;
        for (const [index, entry] of entries.entries()) {
          if (!entry.blob) {
            const name = selectedAssetIds
              ? `selected image ${index + 1}`
              : `${entry.meta?.name ?? "render"}`;
            missingAssets.push(`${design.name}: ${name} missing`);
            continue;
          }
          const mockup = entry.meta?.sourceMockupId
            ? await db.mockups.get(entry.meta.sourceMockupId)
            : undefined;
          const mockupName = mockup?.name ?? entry.fallbackName;
          n += 1;
          const ext = await extensionFor(entry.blob);
          const base = `${String(n).padStart(2, "0")}-${sanitizeFilename(mockupName)}`;
          const path = `${folder}/mockups/${base}.${ext}`;
          files[path] = [new Uint8Array(await entry.blob.arrayBuffer()), { level: 6 }];
          mockupEntries.push({ mockup: mockupName, file: `mockups/${base}.${ext}` });
          totalFiles++;
        }
        if (n === 0) {
          notes.push(
            selectedAssetIds
              ? "no listing images selected for this design"
              : "no generated mockups for this design",
          );
        }
      }
    }

    // --- listing files ---
    let listingEntry: ManifestDesign["listing"];
    if (selection.includeListings) {
      if (listing) {
        const listingJson = {
          title: listing.title,
          description: listing.description,
          tags: listing.tags,
          priceCents: listing.priceCents,
          category: listing.category,
          quantity: listing.quantity,
          status: listing.status,
          generatedAt: new Date().toISOString(),
        };
        const jsonPath = `${folder}/listing/listing.json`;
        files[jsonPath] = [new TextEncoder().encode(JSON.stringify(listingJson, null, 2)), { level: 6 }];
        designFiles.push("listing/listing.json");
        totalFiles++;

        const descPath = `${folder}/listing/description.txt`;
        files[descPath] = [new TextEncoder().encode(listing.description), { level: 6 }];
        designFiles.push("listing/description.txt");
        totalFiles++;

        listingEntry = {
          title: listing.title,
          tags: listing.tags,
          price: listing.priceCents != null ? (listing.priceCents / 100).toFixed(2) : undefined,
          file: "listing/listing.json",
          descriptionFile: "listing/description.txt",
        };
      } else {
        notes.push("no listing draft for this design");
      }
    }

    manifestDesigns.push({ design: design.name, files: designFiles, mockups: mockupEntries, listing: listingEntry, notes });
    onProgress?.({ phase: "collecting", done: index + 1, total: designs.length, current: design.name });
  }

  // --- manifest ---
  const manifest = {
    app: "Mockup Studio",
    exportedAt: new Date().toISOString(),
    structure: "one folder per design containing original, ink variants, mockups/ and listing/",
    selection,
    designCount: manifestDesigns.length,
    fileCount: totalFiles + 1,
    missingAssets,
    designs: manifestDesigns,
  };
  files["MockupStudio_Export/manifest.json"] = [
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    { level: 6 },
  ];

  onProgress?.({ phase: "packing", done: totalFiles, total: totalFiles + 1 });
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });

  // --- verify archive contents before declaring success ---
  onProgress?.({ phase: "verifying", done: 0, total: 1 });
  const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(zipped, (err: Error | null, data: Record<string, Uint8Array>) => (err ? reject(err) : resolve(data)));
  });
  const expectedPaths = Object.keys(files);
  const missingEntries = expectedPaths.filter((p) => !(p in unzipped));
  const emptyEntries = expectedPaths.filter((p) => unzipped[p] && unzipped[p].length === 0);
  onProgress?.({ phase: "verifying", done: 1, total: 1 });

  if (missingEntries.length > 0) {
    errors.push(`Archive is missing ${missingEntries.length} entries: ${missingEntries.slice(0, 3).join(", ")}`);
  }
  if (emptyEntries.length > 0) {
    errors.push(`Archive contains ${emptyEntries.length} empty files`);
  }

  return { blob, fileCount: expectedPaths.length, missingAssets, errors };
}

export async function recordExportJob(job: ExportJob): Promise<void> {
  await db.exports.put(job);
}

export async function pruneOldExports(keep = 20): Promise<void> {
  const all = await db.exports.orderBy("createdAt").reverse().toArray();
  const extras = all.slice(keep);
  if (extras.length) await db.exports.bulkDelete(extras.map((e) => e.id));
}

export function exportFolderName(): string {
  return `MockupStudio_Export_${new Date().toISOString().slice(0, 10)}`;
}

export async function mockupNameById(id: string): Promise<Mockup | undefined> {
  return db.mockups.get(id);
}