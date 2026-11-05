import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The extension's apply function runs inside printify.com with the user's own
// session. The selection write is the part that decides whether Printify keeps
// its generated mockups, so these tests pin the PUT body, not just the result.
//
// `chrome.scripting.executeScript({ func })` serialises the function by source,
// so it is loaded the same way here: from the file, with no imports or closure.
// ---------------------------------------------------------------------------

const source = readFileSync(join(process.cwd(), "extension", "printify-apply.js"), "utf8");
const applyMockups = new Function(`${source}\nreturn applyMockups;`)() as (
  payload: unknown,
) => Promise<Array<{ id: string; ok: boolean; error?: string }>>;

interface Layout {
  groups: Array<{
    group_key: string;
    label: string;
    variant_ids: number[];
    mockup_ids: string[];
  }>;
  selected_mockups: Record<string, unknown>;
}

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

const layout: Layout = {
  groups: [
    {
      group_key: "not_linked",
      label: "not_linked",
      variant_ids: [1],
      mockup_ids: ["old-1", "old-2"],
    },
    { group_key: "front", label: "Front", variant_ids: [2, 3], mockup_ids: ["generated-1"] },
    { group_key: "back", label: "Back", variant_ids: [4], mockup_ids: [] },
  ],
  selected_mockups: {
    "old-1": { id: "old-1", src: "https://images.printify.com/old-1.jpg", type: "UPLOADED" },
    "old-2": { id: "old-2", src: "https://images.printify.com/old-2.jpg", type: "UPLOADED" },
    "generated-1": {
      id: "generated-1",
      src: "https://images.printify.com/generated-1.jpg",
      type: "GENERATED",
    },
  },
};

function payload(replace: boolean) {
  return {
    source: "mockup-studio",
    version: 1,
    createdAt: "2026-10-26T00:00:00.000Z",
    replace,
    products: [
      {
        shopId: 42,
        productId: "product-1",
        productTitle: "Cat mug",
        uploads: [
          {
            libraryId: "lib-1",
            mockupId: "new-1",
            src: "https://images.printify.com/new-1.jpg",
            filename: "new-1.jpg",
          },
          {
            libraryId: "lib-2",
            mockupId: "new-2",
            src: "https://images.printify.com/new-2.jpg",
            filename: "new-2.jpg",
          },
        ],
      },
    ],
  };
}

let calls: FetchCall[] = [];

function installFetch(layoutBody: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      calls.push({
        url: String(url),
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => layoutBody,
          text: async () => JSON.stringify(layoutBody),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }),
  );
}

function putBody(): { groups: Layout["groups"]; selected_mockups: Array<{ id: string }> } {
  const put = calls.find((call) => call.method === "PUT");
  if (!put?.body) throw new Error("the extension did not PUT the selection");
  return JSON.parse(put.body) as {
    groups: Layout["groups"];
    selected_mockups: Array<{ id: string }>;
  };
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("session", JSON.stringify({ user_id: "user-1" }));
  vi.stubGlobal("location", { hostname: "printify.com" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("the extension's replacement apply", () => {
  it("replaces the whole selection and drops the groups it emptied", async () => {
    installFetch(layout);

    const result = await applyMockups(payload(true));

    expect(result).toEqual([{ id: "product-1", ok: true }]);
    const body = putBody();
    // Only the new uploads are selected; Printify's generated mockups and any
    // earlier uploads are gone.
    expect(body.selected_mockups.map((entry) => entry.id)).toEqual(["new-1", "new-2"]);
    // Every group keeps its identity and variant partition, but none keeps an
    // old mockup id - and the groups that now hold no mockup ids are dropped
    // from the PUT entirely: today's Printify validator rejects a variant
    // group with an empty mockup_ids (HTTP 400), so Printify's own UI omits
    // empty groups, and the server keeps the omitted ones server-side (they
    // come back re-derived against the new selection).
    expect(body.groups).toEqual([
      {
        group_key: "not_linked",
        label: "not_linked",
        variant_ids: [1],
        mockup_ids: ["new-1", "new-2"],
      },
    ]);
  });

  it("never sends a variant group with an empty mockup_ids in replacement", async () => {
    installFetch(layout);

    await applyMockups(payload(true));

    const body = putBody();
    for (const group of body.groups) {
      // The validator's rule ("required when variant_ids is present") makes an
      // empty variant group a guaranteed HTTP 400.
      expect(group.variant_ids.length > 0 && group.mockup_ids.length === 0).toBe(false);
    }
  });

  it("still merges when the payload explicitly says replace:false", async () => {
    installFetch(layout);

    const result = await applyMockups(payload(false));

    expect(result).toEqual([{ id: "product-1", ok: true }]);
    const body = putBody();
    expect(body.selected_mockups.map((entry) => entry.id)).toEqual([
      "new-1",
      "new-2",
      "old-1",
      "old-2",
      "generated-1",
    ]);
    expect(body.groups[0].mockup_ids).toEqual(["new-1", "new-2", "old-1", "old-2"]);
    // The old merge kept the other groups' ids too.
    expect(body.groups[1].mockup_ids).toEqual(["generated-1"]);
  });

  it("skips the product when the existing selection cannot be read", async () => {
    installFetch({ groups: [] });

    const result = await applyMockups(payload(true));

    expect(result).toHaveLength(1);
    expect(result[0].ok).toBe(false);
    expect(result[0].error).toMatch(/could not be read/i);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
