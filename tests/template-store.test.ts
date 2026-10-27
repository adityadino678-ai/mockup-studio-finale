import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import {
  deleteUserTemplate,
  getUserTemplate,
  listUserTemplates,
  loadTemplateStore,
  makeUserTemplate,
  saveUserTemplate,
  SESSION_KEY,
} from "@/lib/mockups/template-store";
import type { PrintAreaTemplatePayload } from "@/types/domain";
import { templateForCategory } from "@/lib/mockups/templates";

function teeTemplate(): PrintAreaTemplatePayload {
  const base = templateForCategory("tshirt")!;
  return { ...base, label: "My Tee Template" };
}

async function clearDb(): Promise<void> {
  await db.delete();
  await db.open();
}

describe("template store", () => {
  beforeEach(async () => {
    await clearDb();
  });

  it("starts empty", async () => {
    const store = await loadTemplateStore();
    expect(store.templates).toEqual([]);
    expect(typeof store.updatedAt).toBe("number");
  });

  it("saves and reloads a user template", async () => {
    const template = makeUserTemplate({
      name: "My Tee",
      category: "tshirt",
      payload: teeTemplate(),
    });
    await saveUserTemplate(template);

    const store = await loadTemplateStore();
    expect(store.templates).toHaveLength(1);
    expect(store.templates[0].name).toBe("My Tee");
    expect(store.templates[0].category).toBe("tshirt");
    expect(store.templates[0].payload.label).toBe("My Tee Template");
  });

  it("survives a database reopen (simulates reload)", async () => {
    const template = makeUserTemplate({
      name: "Persistent",
      category: "mug",
      payload: teeTemplate(),
    });
    await saveUserTemplate(template);

    // Reopen the database - simulates a page refresh.
    db.close();
    await db.open();

    const reloaded = await loadTemplateStore();
    expect(reloaded.templates).toHaveLength(1);
    expect(reloaded.templates[0].name).toBe("Persistent");
  });

  it("replaces a template with the same id", async () => {
    const template = makeUserTemplate({
      name: "First",
      category: "tshirt",
      payload: teeTemplate(),
    });
    await saveUserTemplate(template);

    const updated = { ...template, name: "Second", payload: teeTemplate() };
    await saveUserTemplate(updated);

    const store = await loadTemplateStore();
    expect(store.templates).toHaveLength(1);
    expect(store.templates[0].name).toBe("Second");
  });

  it("lists templates newest first", async () => {
    const a = makeUserTemplate({ name: "A", category: "tshirt", payload: teeTemplate() });
    await saveUserTemplate(a);
    // Small delay so updatedAt differs.
    await new Promise((r) => setTimeout(r, 10));
    const b = makeUserTemplate({ name: "B", category: "mug", payload: teeTemplate() });
    await saveUserTemplate(b);

    const list = await listUserTemplates();
    expect(list[0].name).toBe("B");
    expect(list[1].name).toBe("A");
  });

  it("deletes a template by id", async () => {
    const template = makeUserTemplate({
      name: "To Delete",
      category: "tote",
      payload: teeTemplate(),
    });
    await saveUserTemplate(template);
    const id = template.id;

    await deleteUserTemplate(id);

    const store = await loadTemplateStore();
    expect(store.templates).toHaveLength(0);
    expect(await getUserTemplate(id)).toBeUndefined();
  });

  it("deleting a missing id is a no-op", async () => {
    const store = await deleteUserTemplate("does-not-exist");
    expect(store.templates).toEqual([]);
  });

  it("getUserTemplate returns undefined for a missing id", async () => {
    expect(await getUserTemplate("missing")).toBeUndefined();
  });

  it("degrades gracefully on a malformed stored blob", async () => {
    // Write garbage directly into the settings table.
    await db.settings.put({ key: SESSION_KEY, value: { templates: "not an array", updatedAt: 123 } });
    const store = await loadTemplateStore();
    expect(store.templates).toEqual([]);
  });

  it("keeps valid templates and drops invalid ones from a mixed blob", async () => {
    const valid = makeUserTemplate({ name: "Valid", category: "sticker", payload: teeTemplate() });
    await saveUserTemplate(valid);

    // Corrupt the store with an invalid entry mixed in.
    await db.settings.put({
      key: SESSION_KEY,
      value: {
        templates: [
          { id: "bad", name: "", category: "tshirt", payload: {} },
          { ...valid },
        ],
        updatedAt: Date.now(),
      },
    });
    const store = await loadTemplateStore();
    expect(store.templates).toHaveLength(1);
    expect(store.templates[0].name).toBe("Valid");
  });

  it("makeUserTemplate generates a UUID and timestamps", () => {
    const t = makeUserTemplate({ name: "N", category: "poster", payload: teeTemplate() });
    expect(typeof t.id).toBe("string");
    expect(t.id.length).toBeGreaterThan(0);
    expect(typeof t.createdAt).toBe("number");
    expect(typeof t.updatedAt).toBe("number");
    expect(t.name).toBe("N");
    expect(t.category).toBe("poster");
  });
});
