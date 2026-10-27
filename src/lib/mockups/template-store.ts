// ---------------------------------------------------------------------------
// User-saved mockup templates.
//
// A user customises a pre-built template (or builds one from scratch) and
// saves it here so it can be reused later. The whole store is one blob in the
// `settings` table (key `mockupTemplates:session`), exactly like the Printify
// Studio session - no Dexie schema migration needed, survives a reload.
//
// Everything is defensive: a malformed stored blob degrades gracefully
// instead of blanking the page.
// ---------------------------------------------------------------------------

import { getSetting, setSetting } from "@/lib/db/schema";
import type { MockupCategory, PrintAreaTemplatePayload } from "@/types/domain";

export const SESSION_KEY = "mockupTemplates:session";

/** One template the user has saved. */
export interface UserTemplate {
  id: string;
  name: string;
  category: MockupCategory;
  payload: PrintAreaTemplatePayload;
  createdAt: number;
  updatedAt: number;
}

interface TemplateStoreSession {
  templates: UserTemplate[];
  updatedAt: number;
}

export function emptyStore(): TemplateStoreSession {
  return { templates: [], updatedAt: Date.now() };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validTemplatePayload(value: unknown): value is PrintAreaTemplatePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PrintAreaTemplatePayload> & { source?: unknown };
  return (
    typeof v.type === "string" &&
    typeof v.areaWidth === "number" &&
    v.areaWidth > 0 &&
    typeof v.areaHeight === "number" &&
    v.areaHeight > 0 &&
    !!v.source && typeof v.source === "object" &&
    typeof (v.source as { kind?: string }).kind === "string" &&
    typeof v.label === "string" &&
    !!v.frame &&
    typeof v.frame === "object" &&
    typeof v.clipMode === "string"
  );
}

function templateArray(value: unknown): UserTemplate[] {
  if (!Array.isArray(value)) return [];
  const out: UserTemplate[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Partial<UserTemplate>;
    if (
      typeof t.id !== "string" || !t.id ||
      typeof t.name !== "string" || !t.name ||
      typeof t.category !== "string" ||
      !validTemplatePayload(t.payload)
    ) continue;
    out.push({
      id: t.id,
      name: t.name,
      category: t.category,
      payload: t.payload as PrintAreaTemplatePayload,
      createdAt: finiteNumber(t.createdAt) ?? Date.now(),
      updatedAt: finiteNumber(t.updatedAt) ?? Date.now(),
    });
  }
  return out;
}

/**
 * Reads the stored template store, repairing anything missing or malformed.
 */
export async function loadTemplateStore(): Promise<TemplateStoreSession> {
  const stored = await getSetting<Partial<TemplateStoreSession> | null>(SESSION_KEY, null);
  const base = emptyStore();
  if (!stored || typeof stored !== "object") return base;
  return {
    templates: templateArray(stored.templates),
    updatedAt: finiteNumber(stored.updatedAt) ?? base.updatedAt,
  };
}

export async function saveTemplateStore(store: TemplateStoreSession): Promise<void> {
  await setSetting(SESSION_KEY, { ...store, updatedAt: Date.now() });
}

export async function clearTemplateStore(): Promise<void> {
  await setSetting(SESSION_KEY, null);
}

/**
 * Saves (or replaces) one user template. A template with the same id is
 * replaced; a new id is appended.
 */
export async function saveUserTemplate(template: UserTemplate): Promise<TemplateStoreSession> {
  const store = await loadTemplateStore();
  const next = {
    ...store,
    templates: [
      ...store.templates.filter((t) => t.id !== template.id),
      { ...template, updatedAt: Date.now() },
    ],
    updatedAt: Date.now(),
  };
  await saveTemplateStore(next);
  return next;
}

/** Deletes a user template by id. Returns the new store. */
export async function deleteUserTemplate(id: string): Promise<TemplateStoreSession> {
  const store = await loadTemplateStore();
  if (!store.templates.some((t) => t.id === id)) return store;
  const next = {
    ...store,
    templates: store.templates.filter((t) => t.id !== id),
    updatedAt: Date.now(),
  };
  await saveTemplateStore(next);
  return next;
}

/** All user-saved templates, newest first. */
export async function listUserTemplates(): Promise<UserTemplate[]> {
  const store = await loadTemplateStore();
  return [...store.templates].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One user template by id. */
export async function getUserTemplate(id: string): Promise<UserTemplate | undefined> {
  const store = await loadTemplateStore();
  return store.templates.find((t) => t.id === id);
}

/**
 * Creates a user template from a pre-built template, with a new id and the
 * user's chosen name.
 */
export function makeUserTemplate(params: {
  name: string;
  category: MockupCategory;
  payload: PrintAreaTemplatePayload;
}): UserTemplate {
  return {
    id: crypto.randomUUID(),
    name: params.name,
    category: params.category,
    payload: { ...params.payload },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
