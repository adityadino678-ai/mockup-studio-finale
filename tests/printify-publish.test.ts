import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSalesChannelConnected,
  normalizeShopId,
  normalizeShops,
} from "@/lib/server/printify";

/**
 * The publish endpoint's contract, unit-tested without a Printify key:
 *
 * 1. guards first (same-origin, JSON, confirmation, product id);
 * 2. the shop that OWNS the product is resolved by asking Printify's
 *    shop-scoped product API, never guessed as shops[0];
 * 3. a shop with no sales channel is blocked BEFORE the publish call with
 *    error 8254 and an actionable message;
 * 4. a connected shop publishes with the documented booleans body.
 *
 * The booleans body is the verified upstream contract (see AGENTS.md, "The
 * Printify product contract"): each flag says "publish this field".
 */

const KEY = "test-key";

interface ShopFixture {
  id: number;
  title: string;
  sales_channel?: string;
}

function publishRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/printify/publish", {
    method: "POST",
    headers: { "content-type": "application/json", "x-printify-key": KEY, ...headers },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A fetch stub for the three Printify routes this flow touches:
 *   GET  /shops.json
 *   GET  /shops/{shop}/products/{id}.json   (only the owning shop answers 200)
 *   POST /shops/{shop}/products/{id}/publish.json
 */
function stubPrintify(
  options: {
    shops?: ShopFixture[];
    /** productId → the shop id that owns it. */
    products?: Record<string, number>;
    publish?: { status: number; body?: unknown };
  } = {},
) {
  const shops = options.shops ?? [{ id: 1, title: "Shop", sales_channel: "etsy" }];
  const owners = options.products ?? {};
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    calls.push({ url: target, init });

    if (target.endsWith("/shops.json")) return jsonResponse(shops);

    const product = target.match(/\/shops\/(\d+)\/products\/([^/]+)\.json$/);
    if (product && !target.endsWith("/publish.json")) {
      const shopId = Number(product[1]);
      const productId = decodeURIComponent(product[2]);
      if (owners[productId] === shopId) {
        return jsonResponse({ id: productId, title: "Shop product" });
      }
      return jsonResponse({ error: "Product not found" }, 404);
    }

    if (target.endsWith("/publish.json")) {
      const publish = options.publish ?? { status: 200, body: {} };
      return jsonResponse(publish.body ?? {}, publish.status);
    }

    return jsonResponse({}, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  delete process.env.PRINTIFY_API_KEY;
  delete process.env.AI_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/printify/publish", () => {
  it("rejects cross-site calls before spending the key", async () => {
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest(
        { confirm: true, productId: "abc123" },
        { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      ),
    } as never);
    expect(response.status).toBe(403);
  });

  it("requires application/json", async () => {
    const { POST } = await import("@/pages/api/printify/publish");
    const request = new Request("http://localhost/api/printify/publish", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-printify-key": KEY },
      body: "confirm=true",
    });
    const response = await POST({ request } as never);
    expect(response.status).toBe(415);
  });

  it("answers 503 with no key configured", async () => {
    const { POST } = await import("@/pages/api/printify/publish");
    const request = new Request("http://localhost/api/printify/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, productId: "abc123" }),
    });
    const response = await POST({ request } as never);
    expect(response.status).toBe(503);
  });

  it("refuses to publish without explicit confirmation", async () => {
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ productId: "abc123" }),
    } as never);
    expect(response.status).toBe(428);
  });

  it("validates the product id before calling Printify", async () => {
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "../shops" }),
    } as never);
    expect(response.status).toBe(400);
  });

  it("resolves the shop that OWNS the product, not shops[0]", async () => {
    const calls = stubPrintify({
      shops: [
        { id: 1, title: "Custom store", sales_channel: "" },
        { id: 2, title: "Etsy store", sales_channel: "etsy" },
        { id: 3, title: "Other store", sales_channel: "shopify" },
      ],
      products: { abc123: 3 },
    });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "abc123" }),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { published: boolean; shopId: number };
    expect(body).toMatchObject({ published: true, shopId: 3 });

    const publishCall = calls.find((call) => call.url.includes("/publish.json"));
    expect(publishCall?.url).toContain("/shops/3/products/abc123/publish.json");
    // It asked each shop before deciding, and never published from shop 1.
    const productLookups = calls.filter((call) =>
      /\/products\/abc123\.json$/.test(call.url),
    );
    expect(productLookups.length).toBeGreaterThan(1);
  });

  it("prefers the selected shop's lookup before searching the rest", async () => {
    const calls = stubPrintify({
      shops: [
        { id: 1, title: "First", sales_channel: "etsy" },
        { id: 2, title: "Selected", sales_channel: "etsy" },
      ],
      products: { abc123: 2 },
    });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "abc123", shopId: 2 }),
    } as never);
    expect(response.status).toBe(200);
    const firstLookup = calls.find((call) => /\/products\/abc123\.json$/.test(call.url));
    expect(firstLookup?.url).toContain("/shops/2/");
  });

  it("blocks a disconnected shop with 409 / 8254 before any publish call", async () => {
    const calls = stubPrintify({
      shops: [{ id: 7, title: "Manual store", sales_channel: "" }],
      products: { abc123: 7 },
    });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "abc123" }),
    } as never);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      code: number;
      shopId: number;
      shopTitle: string;
      connectUrl: string;
    };
    expect(body.code).toBe(8254);
    expect(body.shopId).toBe(7);
    expect(body.shopTitle).toBe("Manual store");
    expect(body.connectUrl).toContain("printify.com");
    expect(body.error).toContain('Shop "Manual store" (#7)');
    expect(body.error).toContain("not connected to Etsy");
    expect(body.error).toContain("Connect it in Printify");
    // The preflight must not have attempted the publish.
    expect(calls.some((call) => call.url.includes("/publish.json"))).toBe(false);
  });

  it("publishes with the documented booleans body and reports success", async () => {
    const calls = stubPrintify({
      shops: [{ id: 1, title: "Shop", sales_channel: "etsy" }],
      products: { abc123: 1 },
    });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "abc123" }),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      published: boolean;
      productId: string;
      shopId: number;
    };
    expect(body).toEqual({ published: true, productId: "abc123", shopId: 1 });

    const publishCall = calls.find((call) => call.url.includes("/publish.json"));
    expect(publishCall).toBeTruthy();
    expect(publishCall!.init.method).toBe("POST");
    expect(publishCall!.url).toContain("/shops/1/products/abc123/publish.json");
    const sent = JSON.parse(String(publishCall!.init.body)) as Record<string, boolean>;
    expect(sent).toEqual({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    });
  });

  it("answers 404 when no shop owns the product", async () => {
    stubPrintify({
      shops: [{ id: 1, title: "Shop", sales_channel: "etsy" }],
      products: {},
    });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "gone123" }),
    } as never);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("gone123");
    expect(body.error).toContain("nothing to publish");
  });

  it("maps an upstream 8254 to the same actionable 409 and keeps its detail", async () => {
    stubPrintify({
      shops: [{ id: 1, title: "Etsy store", sales_channel: "etsy" }],
      products: { abc123: 1 },
      publish: {
        status: 400,
        body: {
          error: { code: 8254, message: "Shop is not connected to a sales channel." },
        },
      },
    });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "abc123" }),
    } as never);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      code: number;
      shopId: number;
      shopTitle: string;
      connectUrl: string;
      status: number;
      detail: string;
    };
    expect(body.code).toBe(8254);
    expect(body.shopId).toBe(1);
    expect(body.shopTitle).toBe("Etsy store");
    expect(body.connectUrl).toContain("printify.com");
    expect(body.error).toContain("not connected to Etsy");
    expect(body.error).toContain("Printify said");
    // The upstream status and detail survive the mapping.
    expect(body.status).toBe(400);
    expect(body.detail).toContain("8254");
  });
});

describe("shop normalization", () => {
  it("accepts only a positive integer shop id", () => {
    expect(normalizeShopId(42)).toBe(42);
    expect(normalizeShopId("42")).toBe(42);
    expect(normalizeShopId(" 42 ")).toBe(42);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "", "0", "x", null, { id: 1 }]) {
      expect(normalizeShopId(bad)).toBeUndefined();
    }
  });

  it("treats a blank sales channel as not connected", () => {
    expect(isSalesChannelConnected({ sales_channel: "etsy" })).toBe(true);
    expect(isSalesChannelConnected({ sales_channel: "  Etsy  " })).toBe(true);
    expect(isSalesChannelConnected({ sales_channel: "" })).toBe(false);
    expect(isSalesChannelConnected({ sales_channel: "   " })).toBe(false);
    expect(isSalesChannelConnected({})).toBe(false);
    expect(isSalesChannelConnected(undefined)).toBe(false);
  });

  it("trims the shop list and drops unusable ids", () => {
    expect(
      normalizeShops([
        { id: 1, title: "  Etsy store  ", sales_channel: " etsy " },
        { id: 0, title: "No id" },
        { id: 2, title: "Manual" },
      ]),
    ).toEqual([
      { id: 1, title: "Etsy store", sales_channel: "etsy" },
      { id: 2, title: "Manual", sales_channel: "" },
    ]);
  });
});
