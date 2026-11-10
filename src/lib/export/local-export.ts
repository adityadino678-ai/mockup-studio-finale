// ---------------------------------------------------------------------------
// The local-first export: IndexedDB -> a folder the user chooses.
//
// Everything local lives in this browser's IndexedDB and all of it is the
// user's own work, so there must be a way to take it out. The files go
// STRAIGHT from this browser to the folder the user picks - nothing is
// uploaded, and no network call happens on this path.
//
// Two transports, one layout:
//  - Chrome/Edge: the File System Access API writes each file straight into
//    the picked directory; an interrupted run is resumable (the handle and
//    the finished paths live in the tiny `exportHandles` table, schema v6).
//  - Everywhere else (Firefox, Safari): the same entries are bundled into
//    ZIP parts with fflate and downloaded one by one, at most 500 MB each.
//
// Layout, identical on both paths:
//   manifest.json
//   tables/<table>.json        one JSON file per metadata table
//   blobs/<asset id>           the binary payloads, keyed by asset id
//   thumbs/<id>                the thumbnails
//
// Secrets (saved API keys in `settings.integrations`) are deliberately left
// out unless the user ticks the box: the export is usually a backup, and a
// backup that silently carries keys is one more thing to leak.
// ---------------------------------------------------------------------------

import { zip, type Zippable } from "fflate";
import { db } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Pure planning helpers - no DOM, no Dexie, unit tested directly.
// ---------------------------------------------------------------------------

/** The `settings` keys whose value holds credentials. */
export const SECRET_SETTING_KEYS = ["integrations"] as const;

export function isSecretSettingKey(key: string): boolean {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Duck-typed Blob check. `instanceof Blob` fails across realms (the storage
 * layer's structured clone hands back the Node realm's Blob when it runs in a
 * test or a worker), and a shape check never misfires on real records.
 */
function asBlob(value: unknown): Blob | null {
  if (value instanceof Blob) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).arrayBuffer === "function"
  ) {
    return value as Blob;
  }
  return null;
}

/** One ZIP part is at most this big, so Firefox downloads stay sane. */
export const PART_LIMIT_BYTES = 500 * 1024 * 1024;

/** How many at-most-500 MB parts a payload of N bytes needs. */
export function planBytes(totalBytes: number, limit = PART_LIMIT_BYTES): number {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (totalBytes <= 0) return 1;
  return Math.ceil(totalBytes / safeLimit);
}

/** Greedily splits entry sizes into parts that each stay within the limit. */
export function planParts(
  sizes: number[],
  limit = PART_LIMIT_BYTES,
): Array<{ from: number; to: number }> {
  const parts: Array<{ from: number; to: number }> = [];
  let start = 0;
  let total = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    const size = Math.max(0, sizes[i]);
    if (i > start && total + size > limit) {
      parts.push({ from: start, to: i });
      start = i;
      total = 0;
    }
    total += size;
  }
  parts.push({ from: start, to: sizes.length });
  return parts;
}

/** `MockupStudio_Export_2026-11-10_1-of-2.zip` */
export function partFileName(index: number, total: number, date: string): string {
  const safeIndex = Math.max(1, Math.floor(index));
  const safeTotal = Math.max(safeIndex, Math.floor(total));
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "export";
  return `MockupStudio_Export_${iso}_${pad(safeIndex)}-of-${pad(safeTotal)}.zip`;
}

function pad(n: number): string {
  return String(Math.max(1, Math.floor(n))).padStart(2, "0");
}

export interface LocalExportManifest {
  app: "mockup-studio";
  /** The Dexie schema version the export was taken from. */
  schemaVersion: number;
  exportedAt: number;
  /** True only when the user ticked the secrets box. */
  includesSecrets: boolean;
  /** One row per exported table. */
  counts: Record<string, number>;
  /** ZIP fallback only: how many parts the payload was split into. */
  parts?: number;
}

export function buildManifest(input: {
  schemaVersion: number;
  exportedAt: number;
  includeSecrets: boolean;
  counts: Record<string, number>;
  parts?: number;
}): LocalExportManifest {
  const manifest: LocalExportManifest = {
    app: "mockup-studio",
    schemaVersion: input.schemaVersion,
    exportedAt: input.exportedAt,
    includesSecrets: input.includeSecrets,
    counts: input.counts,
  };
  if (input.parts !== undefined) manifest.parts = input.parts;
  return manifest;
}

export type StorageNoticeLevel = "attention" | "urgent";

export interface StorageNotice {
  level: StorageNoticeLevel;
  message: string;
}

/**
 * When the browser's storage estimate crosses 80% of the quota the user
 * should think about a backup; at 95% it is the actual next step.
 */
export function storageNotice(usage: number, quota: number | undefined): StorageNotice | null {
  if (!quota || quota <= 0 || usage <= 0) return null;
  const fraction = usage / quota;
  if (fraction >= 0.95) {
    return {
      level: "urgent",
      message:
        "This browser's storage is 95% full. Renders can start failing soon - export your workspace and clear space.",
    };
  }
  if (fraction >= 0.8) {
    return {
      level: "attention",
      message: "This browser's storage is 80% full. Export a copy so a cleanup cannot lose your work.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Export catalogue: the tables, their typed accessors and the entry collation.
// ---------------------------------------------------------------------------

export const EXPORT_TABLES = [
  "designs",
  "mockups",
  "assets",
  "blobs",
  "thumbs",
  "placements",
  "bgRemovals",
  "batchJobs",
  "batchItems",
  "templates",
  "productDrafts",
  "listingDrafts",
  "exports",
  "activity",
  "settings",
  "conversations",
  "messages",
] as const;

export type ExportTableId = (typeof EXPORT_TABLES)[number];

export interface ExportEntry {
  path: string;
  blob: Blob;
}

/**
 * Reads one export table's raw records. The Dexie implementation is the
 * default; the tests inject one so binary rows can carry real Blobs without
 * relying on the storage layer's Blob round-trip.
 */
export type TableLoader = (
  table: ExportTableId,
  includeSecrets: boolean,
) => Promise<Array<Record<string, unknown>>>;

const dexieLoader: TableLoader = (table, includeSecrets) =>
  table === "settings"
    ? filteredSettings(includeSecrets)
    : db.table<Record<string, unknown>, string>(table).toArray();

/** The production loader, exported so tests can compose with it. */
export const defaultTableLoader = dexieLoader;

/** One file per metadata table; binaries get one entry each. */
export async function collectEntries(
  includeSecrets: boolean,
  loader: TableLoader = dexieLoader,
): Promise<{ entries: ExportEntry[]; counts: Record<string, number>; totalBytes: number }> {
  const counts: Record<string, number> = {};
  const entries: ExportEntry[] = [];
  let totalBytes = 0;

  for (const table of EXPORT_TABLES) {
    const rows = await loader(table, includeSecrets);
    if (table === "blobs" || table === "thumbs") {
      for (const row of rows) {
      const blob = asBlob(row.blob);
      if (!blob) continue;
        const id = typeof row.id === "string" ? row.id : "";
        if (!id) continue;
        const path = table === "blobs" ? `blobs/${id}` : `thumbs/${id}`;
        entries.push({ path, blob });
        totalBytes += blob.size;
        counts[table] = (counts[table] ?? 0) + 1;
      }
      continue;
    }
    const payload = JSON.stringify({ table, rows }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    entries.push({ path: `tables/${table}.json`, blob });
    totalBytes += blob.size;
    counts[table] = rows.length;
  }

  return { entries, counts, totalBytes };
}

/**
 * Reads the settings table, dropping credential rows unless the user opted in.
 * Non-secret settings (the studio session, UI memory, cached model lists)
 * always export: they are the workspace, not a secret.
 */
async function filteredSettings(includeSecrets: boolean): Promise<Array<Record<string, unknown>>> {
  const rows = await db.settings.toArray();
  const plain = rows.map((row): Record<string, unknown> => ({ key: row.key, value: row.value }));
  return includeSecrets ? plain : plain.filter((row) => !isSecretSettingKey(row.key as string));
}

// ---------------------------------------------------------------------------
// Resume bookkeeping (File System Access path only).
//
// An interrupted run keeps the directory handle plus the paths already
// written; resuming re-verifies permission and skips the finished files.
// Dexie stores FileSystemDirectoryHandle fine - it is structured-clonable.
// ---------------------------------------------------------------------------

export interface ExportResumeRecord {
  id: string;
  handle: FileSystemDirectoryHandle;
  startedAt: number;
  donePaths: string[];
}

const RESUME_ID = "local-export";

export async function saveExportResume(handle: FileSystemDirectoryHandle, donePaths: string[]): Promise<void> {
  await db.exportHandles.put({ id: RESUME_ID, handle, startedAt: Date.now(), donePaths: [...donePaths] });
}

export async function loadExportResume(): Promise<ExportResumeRecord | undefined> {
  return db.exportHandles.get(RESUME_ID);
}

export async function clearExportResume(): Promise<void> {
  await db.exportHandles.delete(RESUME_ID);
}

// ---------------------------------------------------------------------------
// File System Access API. `lib.dom` carries the handle types but not the
// picker entry point, so it is declared here.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
  // The permission surface lives on FileSystemHandle in the spec but older
  // typings may not carry it; declared optional so both worlds typecheck.
  interface FileSystemHandle {
    queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
    requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  }
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/**
 * Opens the folder picker and returns the handle in readwrite mode.
 * Returns null when the user backed out of the picker - that is not an error.
 */
export async function pickExportDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsDirectoryPicker()) return null;
  try {
    return await window.showDirectoryPicker!({ id: "mockup-studio-export", mode: "readwrite" });
  } catch {
    // A DOMException named AbortError is the picker's way of saying "cancel".
    return null;
  }
}

/** A permission may need re-asking after a reload or a tab suspension. */
export async function ensureReadWrite(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const state = await handle.queryPermission?.({ mode: "readwrite" });
  if (state === "granted") return true;
  return (await handle.requestPermission?.({ mode: "readwrite" })) === "granted";
}

export interface LocalExportProgress {
  phase: "collecting" | "writing";
  /** For "writing": files finished so far. */
  done: number;
  /** For "writing": total files planned. */
  total: number;
  label?: string;
}

export interface LocalExportOptions {
  includeSecrets: boolean;
  /** Present on the File System Access path; omitted by the ZIP fallback. */
  directory?: FileSystemDirectoryHandle;
  onProgress?: (progress: LocalExportProgress) => void;
  shouldCancel?: () => boolean;
  /** Resume support: paths already written by the interrupted run. */
  skipPaths?: Set<string>;
}

export interface LocalExportResult {
  cancelled: boolean;
  files: number;
  bytes: number;
  folderName?: string;
}

/**
 * Writes the export straight into the chosen directory. Every file is
 * created locally via the handle; nothing is uploaded to anyone.
 *
 * Cancellation is cooperative: checked between files. An interrupted run
 * leaves its handle + progress in `exportHandles` for the resume button.
 */
export async function exportToLocalFolder(options: LocalExportOptions): Promise<LocalExportResult> {
  const { directory } = options;
  if (!directory) throw new Error("exportToLocalFolder needs a directory handle");
  options.onProgress?.({ phase: "collecting", done: 0, total: 0, label: "Collecting your workspace" });
  const { entries, counts } = await collectEntries(options.includeSecrets);
  const schemaVersion = db.verno;
  const manifest = buildManifest({
    schemaVersion,
    exportedAt: Date.now(),
    includeSecrets: options.includeSecrets,
    counts,
  });
  const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const all: ExportEntry[] = [{ path: "manifest.json", blob: manifestBlob }, ...entries];
  const skip = options.skipPaths ?? new Set<string>();

  const tableDir = await directory.getDirectoryHandle("tables", { create: true });
  const blobsDir = await directory.getDirectoryHandle("blobs", { create: true });
  const thumbsDir = await directory.getDirectoryHandle("thumbs", { create: true });

  let files = 0;
  let bytes = 0;
  const donePaths: string[] = [...skip];
  for (const entry of all) {
    if (options.shouldCancel?.()) {
      // An interrupted run (fresh or resumed) is always resumable.
      await saveExportResume(directory, donePaths);
      return { cancelled: true, files, bytes, folderName: directory.name };
    }
    if (skip.has(entry.path)) {
      files += 1;
      continue;
    }
    const [dir, name] = splitPath(entry.path, tableDir, blobsDir, thumbsDir);
    try {
      await writeBlob(dir, name, entry.blob);
    } catch (error) {
      // A failure is just as resumable as a cancel: everything written so
      // far stays in the folder, and this record says which paths those are.
      await saveExportResume(directory, donePaths).catch(() => undefined);
      throw error;
    }
    donePaths.push(entry.path);
    files += 1;
    bytes += entry.blob.size;
    options.onProgress?.({ phase: "writing", done: files, total: all.length });
  }
  // A completed run is not resumable.
  await clearExportResume();
  return { cancelled: false, files, bytes, folderName: directory.name };
}

function splitPath(
  path: string,
  tableDir: FileSystemDirectoryHandle,
  blobsDir: FileSystemDirectoryHandle,
  thumbsDir: FileSystemDirectoryHandle,
): [FileSystemDirectoryHandle, string] {
  if (path.startsWith("tables/")) return [tableDir, path.slice("tables/".length)];
  if (path.startsWith("blobs/")) return [blobsDir, path.slice("blobs/".length)];
  if (path.startsWith("thumbs/")) return [thumbsDir, path.slice("thumbs/".length)];
  return [blobsDir, path];
}

async function writeBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    // Leave no half-written file behind.
    try {
      await writable.abort();
    } catch {
      /* the close already failed; nothing more to release */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ZIP fallback for browsers without the File System Access API.
// ---------------------------------------------------------------------------

export interface ZipPartResult {
  name: string;
  blob: Blob;
  index: number;
  total: number;
}

/**
 * Builds the same layout as ZIP parts, at most 500 MB per part, for browsers
 * that cannot write folders. The parts are returned in order and the caller
 * downloads them one after another - still entirely local.
 */
export async function buildZipParts(
  includeSecrets: boolean,
  options: {
    limit?: number;
    onProgress?: (progress: LocalExportProgress) => void;
    shouldCancel?: () => boolean;
  } = {},
): Promise<ZipPartResult[]> {
  options.onProgress?.({ phase: "collecting", done: 0, total: 0, label: "Collecting your workspace" });
  const { entries, counts } = await collectEntries(includeSecrets);
  const schemaVersion = db.verno;
  const limit = options.limit ?? PART_LIMIT_BYTES;
  // The manifest always opens part 1; the entries fill the rest greedily. The
  // manifest's own size depends on the parts count, so converge in two steps:
  // plan without `parts`, then rebuild and re-plan with the stable count.
  const buildManifestBlob = (total?: number): Blob => {
    const manifest = buildManifest({
      schemaVersion,
      exportedAt: Date.now(),
      includeSecrets,
      counts,
      ...(total === undefined ? {} : { parts: total }),
    });
    return new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  };
  let manifestBlob = buildManifestBlob();
  const all: ExportEntry[] = [{ path: "manifest.json", blob: manifestBlob }, ...entries];
  let parts = planParts(all.map((entry) => entry.blob.size), limit);
  if (parts.length > 1) {
    manifestBlob = buildManifestBlob(parts.length);
    all[0] = { path: "manifest.json", blob: manifestBlob };
    parts = planParts(all.map((entry) => entry.blob.size), limit);
  }
  const date = new Date().toISOString().slice(0, 10);
  const results: ZipPartResult[] = [];
  const total = parts.length;

  for (let index = 0; index < parts.length; index += 1) {
    if (options.shouldCancel?.()) break;
    const { from, to } = parts[index];
    const zippable: Zippable = {};
    for (let i = from; i < to; i += 1) {
      const entry = all[i];
      if (!entry) continue;
      zippable[entry.path] = new Uint8Array(await entry.blob.arrayBuffer());
    }
    const zipped = await new Promise<Uint8Array>((resolve, reject) => {
      zip(zippable, (error, data) => (error ? reject(error) : resolve(data)));
    });
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
    const name = partFileName(index + 1, total, date);
    results.push({ name, blob, index, total });
    options.onProgress?.({ phase: "writing", done: index + 1, total, label: name });
  }
  return results;
}
