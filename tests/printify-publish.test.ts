import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The publish endpoint's contract, unit-tested without a Printify key:
 * guards first (same-origin, JSON, confirmation, product id), then the exact
 * payload the upstream publish API requires — a body of BOOLEANS, one per
 * field (see AGENTS.md, "The Printify product contract": each flag says
 * "publish this field"; it is not a simple toggle).
 */

const KEY = "test-key";

function publishRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/printify/publish", {
    method: "POST",
    headers: { "content-type": "application/json", "x-printify-key": KEY, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A fetch stub that answers /shops.json (the client resolves the shop first)
 * and then records every call so the test can assert the publish request's
 * URL, method and body.
 */
function stubPrintify(response: { status: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/shops.json")) {
      return new Response(JSON.stringify([{ id: 1, title: "Shop" }]), { status: 200 });
    }
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

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

  it("publishes with the documented booleans body and reports success", async () => {
    const calls = stubPrintify({ status: 200, body: { id: "abc123" } });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "abc123" }),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { published: boolean; productId: string };
    expect(body).toEqual({ published: true, productId: "abc123" });

    const publishCall = calls.find((c) => c.url.includes("/publish.json"));
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

  it("maps an upstream 404 to 404 and surfaces Printify's message", async () => {
    stubPrintify({ status: 404, body: { error: "Product not found" } });
    const { POST } = await import("@/pages/api/printify/publish");
    const response = await POST({
      request: publishRequest({ confirm: true, productId: "gone123" }),
    } as never);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not found");
  });
});
