import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { createPrintifyClient, PrintifyError } from "@/lib/server/printify";

interface MockupBridgeBody {
  /** Explicit confirmation: each image is uploaded twice on Printify's side. */
  confirm: boolean;
  productId: string;
  /** Optional; resolved from the API key's first shop when omitted. */
  shopId?: number;
  /** The title the app believes this product has; a mismatch aborts. */
  expectedTitle?: string;
  images: Array<{ base64: string; filename: string }>;
}

const MAX_IMAGES = 10;
/** Client images are ~2 MB JPEGs; this leaves room for a retry/final JPEG. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** Base64 is ~4/3 of the decoded body; stop the parse before it can OOM. */
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

function base64Bytes(base64: string): number {
  let start = 0;
  if (base64.startsWith("data:")) {
    const comma = base64.indexOf(",");
    if (comma >= 0) start = comma + 1;
  }
  let length = 0;
  for (let i = start; i < base64.length; i++) {
    const code = base64.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    if (code === 61) break;
    length++;
  }
  return Math.floor((length * 3) / 4);
}

function cleanBase64(value: string): string {
  const raw = value.startsWith("data:")
    ? (() => {
        const comma = value.indexOf(",");
        return comma >= 0 ? value.slice(comma + 1) : value;
      })()
    : value;
  return raw.replace(/\s+/g, "");
}

function imageExtension(base64: string): "jpg" | "png" | undefined {
  if (base64.startsWith("/9j/")) return "jpg";
  if (base64.startsWith("iVBORw0KGgo")) return "png";
  return undefined;
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function safeFilename(value: unknown, index: number, extension: "jpg" | "png"): string {
  const raw = typeof value === "string" ? value : "";
  const stem = raw
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || `listing-image-${index + 1}`}.${extension}`;
}

/**
 * This route spends the operator's Printify key, so only the app itself may
 * call it. Browsers send `Sec-Fetch-Site`; a cross-site form/fetch is rejected
 * even when it uses a "simple" text/plain body that skips preflight.
 */
function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function canonicalTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (stopped) break;
      const index = next++;
      if (index >= items.length) break;
      try {
        out[index] = await fn(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  // Wait for the other worker even after one fails. Returning while an upload
  // is still in flight leaves an orphan the client can never retry safely.
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return out;
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    return json({ error: "The upload request is too large. Send fewer images at once." }, 413);
  }

  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);

  if (!client.configured) {
    return json(
      {
        error:
          "Printify is not configured. Paste your Printify API key in Settings, or set PRINTIFY_API_KEY on the server, before sending listing images.",
      },
      503,
    );
  }

  let body: MockupBridgeBody;
  try {
    body = (await request.json()) as MockupBridgeBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.confirm !== true) {
    return json(
      { error: "Confirmation required: sending listing images uploads them to Printify." },
      428,
    );
  }
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  if (!productId) return json({ error: "A Printify product id is required" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId)) {
    return json({ error: "The Printify product id is not valid" }, 400);
  }
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return json({ error: "Select at least one rendered listing image" }, 400);
  }
  if (body.images.length > MAX_IMAGES) {
    return json(
      { error: `Send at most ${MAX_IMAGES} listing images per product at a time.` },
      400,
    );
  }

  const images: Array<{ base64: string; filename: string }> = [];
  let totalBytes = 0;
  for (const [index, raw] of body.images.entries()) {
    const base64 = typeof raw?.base64 === "string" ? cleanBase64(raw.base64) : "";
    if (!base64) return json({ error: `Image ${index + 1} has no data` }, 400);
    if (!validBase64(base64)) {
      return json({ error: `Image ${index + 1} is not valid base64 data` }, 400);
    }
    const extension = imageExtension(base64);
    if (!extension) {
      return json({ error: `Image ${index + 1} must be a JPEG or PNG` }, 400);
    }
    const bytes = base64Bytes(base64);
    if (bytes > MAX_IMAGE_BYTES) {
      return json({ error: `Image ${index + 1} exceeds the 4 MB upload limit` }, 413);
    }
    totalBytes += bytes;
    images.push({ base64, filename: safeFilename(raw.filename, index, extension) });
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return json(
      {
        error: `The selected images are too large (${Math.round(totalBytes / 1024 / 1024)} MB). Render fewer images at once.`,
      },
      413,
    );
  }

  try {
    const shopId =
      typeof body.shopId === "number" && Number.isFinite(body.shopId) && body.shopId > 0
        ? body.shopId
        : await client.resolveShopId();

    // Verify the product id against the title the Studio knows. This is the
    // guard against a stale result pointing at a different product.
    const product = await client.getProduct(shopId, productId);
    const expectedTitle =
      typeof body.expectedTitle === "string" ? body.expectedTitle.trim() : "";
    if (expectedTitle) {
      if (!product.title?.trim()) {
        return json(
          {
            error:
              "Printify returned no product title, so the stale-id check could not run. Refusing to upload.",
          },
          409,
        );
      }
      if (canonicalTitle(expectedTitle) !== canonicalTitle(product.title)) {
        return json(
          {
            error: `The Printify product title does not match this listing. Expected "${expectedTitle}", found "${product.title}".`,
            expectedTitle,
            actualTitle: product.title,
          },
          409,
        );
      }
    }

    // Upload two at a time: the two calls per image are sequential (the media
    // URL must exist before the product mockup), but several images can be in
    // flight without tripping Printify's rate limit.
    const uploads = await mapPool(images, 2, async (image) => {
      const uploaded = await client.uploadImage(image.base64, image.filename);
      const fileUrl = uploaded.preview_url;
      if (!fileUrl) {
        throw new PrintifyError(
          "Printify uploaded the image but did not return a preview URL, so it cannot be made into a custom mockup.",
          502,
          uploaded,
        );
      }
      const mockup = await client.uploadProductMockup(shopId, productId, fileUrl);
      if (!mockup?.id || !mockup?.src) {
        throw new PrintifyError("Printify did not return a custom mockup id and URL.", 502, mockup);
      }
      return {
        libraryId: String(uploaded.id),
        mockupId: String(mockup.id),
        src: mockup.src,
        filename: image.filename,
      };
    });

    return json({
      shopId,
      productId,
      title: product.title,
      uploads,
    });
  } catch (error) {
    if (error instanceof PrintifyError) {
      const detail =
        error.detail === undefined
          ? undefined
          : (typeof error.detail === "string"
              ? error.detail
              : JSON.stringify(error.detail)
            ).slice(0, 400);
      if (error.status === 401 || error.status === 403) {
        return json(
          {
            error:
              "Printify rejected the API key while sending listing images. Paste a current key in Settings.",
            configured: false,
            detail,
          },
          503,
        );
      }
      const status =
        error.status === 429
          ? 429
          : error.status === 400 || error.status === 422 || error.status === 413
            ? 400
            : error.status === 404
              ? 404
              : 502;
      return json({ error: error.message, detail, status: error.status }, status);
    }
    return json(
      {
        error:
          error instanceof Error ? error.message : "Unexpected error sending listing images",
      },
      500,
    );
  }
};
