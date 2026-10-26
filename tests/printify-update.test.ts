import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The product-update contract, unit-tested without a Printify key.
 *
 * Listing preview's Send reuses the create endpoint for a listing that already
 * has a product. The rules that matter:
 *
 * 1. it is a PARTIAL update: title/description/tags, never `print_areas`, so
 *    an update cannot move the printed artwork;
 * 2. a price update sends EVERY variant, preserving each `is_enabled` flag -
 *    Printify rewrites the variant set when one is missing;
 * 3. the shop that OWNS the product is resolved first, never assumed from the
 *    saved shop selection;
 * 4. nothing happens without `confirm: true`.
 */

const KEY = "test-key";

interface ShopFixture {
  id: number;
  title: string;
  sales_channel?: string;
}

function updateRequest(body: unknown): Request {
  return new Request("http://localhost/api/printify/products", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-printify-key": KEY },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubPrintify(
  options: {
    shops?: ShopFixture[];
    /** productId → the shop id that owns it. */
    products?: Record<string, number>;
    variants?: Array<{ id: number; is_enabled?: boolean }>;
  } = {},
) {
  const shops = options.shops ?? [{ id: 1, title: "Shop", sales_channel: "etsy" }];
  const owners = options.products ?? {};
  const variants = options.variants ?? [];
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    const method = (init.method ?? "GET").toUpperCase();

    if (target.endsWith("/shops.json")) return jsonResponse(shops);

    const product = target.match(/\/shops\/(\d+)\/products\/([^/]+)\.json$/);
    if (product) {
      const shopId = Number(product[1]);
      const productId = decodeURIComponent(product[2]);
      if (owners[productId] !== shopId) {
        return jsonResponse({ error: "Product not found" }, 404);
      }
      if (method === "PUT") {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        return jsonResponse({
          id: productId,
          title: body.title ?? "Existing product",
          variants,
        });
      }
      return jsonResponse({ id: productId, title: "Existing product", variants });
    }

    return jsonResponse({}, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function putBody(calls: Array<{ url: string; init: RequestInit }>): Record<string, unknown> {
  const put = calls.find((call) => (call.init.method ?? "GET").toUpperCase() === "PUT");
  expect(put, "a PUT call was made").toBeDefined();
  return JSON.parse(String(put?.init.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  delete process.env.PRINTIFY_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PUT /api/printify/products", () => {
  it("answers 503 with no key configured", async () => {
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: new Request("http://localhost/api/printify/products", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, productId: "abc123", title: "New" }),
      }),
    } as never);
    expect(response.status).toBe(503);
  });

  it("refuses to update without explicit confirmation", async () => {
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({ productId: "abc123", title: "New" }),
    } as never);
    expect(response.status).toBe(428);
  });

  it("validates the product id before calling Printify", async () => {
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({ confirm: true, productId: "../shops", title: "New" }),
    } as never);
    expect(response.status).toBe(400);
  });

  it("requires at least one field to update", async () => {
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({ confirm: true, productId: "abc123" }),
    } as never);
    expect(response.status).toBe(400);
  });

  it("updates copy only, without sending print areas", async () => {
    const calls = stubPrintify({ products: { abc123: 1 } });
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({
        confirm: true,
        productId: "abc123",
        title: "  A better title  ",
        description: "A better description",
        tags: ["cat", "Cat", "dog"],
      }),
    } as never);
    expect(response.status).toBe(200);
    expect(putBody(calls)).toEqual({
      title: "A better title",
      description: "A better description",
      tags: ["cat", "dog"],
    });
    expect(putBody(calls)).not.toHaveProperty("print_areas");
  });

  it("sends every variant with the new price and preserves is_enabled", async () => {
    const calls = stubPrintify({
      products: { abc123: 1 },
      variants: [
        { id: 11, is_enabled: true },
        { id: 12, is_enabled: false },
      ],
    });
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({ confirm: true, productId: "abc123", price: 2499 }),
    } as never);
    expect(response.status).toBe(200);
    expect(putBody(calls)).toEqual({
      variants: [
        { id: 11, price: 2499, is_enabled: true },
        { id: 12, price: 2499, is_enabled: false },
      ],
    });
    expect(putBody(calls)).not.toHaveProperty("print_areas");
  });

  it("uses the shop that OWNS the product, not the preferred shop", async () => {
    const calls = stubPrintify({
      shops: [
        { id: 1, title: "Saved shop", sales_channel: "etsy" },
        { id: 2, title: "Real owner", sales_channel: "etsy" },
      ],
      products: { abc123: 2 },
    });
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({
        confirm: true,
        shopId: 1,
        productId: "abc123",
        title: "New title",
      }),
    } as never);
    expect(response.status).toBe(200);
    const put = calls.find((call) => (call.init.method ?? "GET").toUpperCase() === "PUT");
    expect(put?.url).toContain("/shops/2/products/abc123.json");
  });

  it("reports a product that is not in any shop", async () => {
    stubPrintify({ products: {} });
    const { PUT } = await import("@/pages/api/printify/products");
    const response = await PUT({
      request: updateRequest({ confirm: true, productId: "missing", title: "New" }),
    } as never);
    expect(response.status).toBe(404);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toMatch(/could not find product/i);
  });
});
