import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { createPrintifyClient, PrintifyError } from "@/lib/server/printify";

interface PublishProductBody {
  /**
   * Explicit user confirmation is required: publishing makes a product live
   * on the connected shop, which is exactly the kind of external side effect
   * this app never takes without a click.
   */
  confirm: boolean;
  /** The Printify product to publish. Must be a product THIS app created. */
  productId: string;
}

/**
 * Product ids are Printify's own: a bounded alphanumeric string. Validating
 * here keeps a tampered body from probing arbitrary URL shapes upstream.
 */
function validProductId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{6,64}$/.test(value);
}

/**
 * This route makes a product LIVE on the operator's shop, so only the app
 * itself may call it. Browsers send `Sec-Fetch-Site`; a cross-site request is
 * rejected even when it uses a "simple" body that skips preflight. Same guard
 * as the mockup upload endpoint.
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

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);
  if (!client.configured) {
    return json(
      {
        error:
          "Printify is not configured. Paste your Printify API key in Settings, or set PRINTIFY_API_KEY on the server, before publishing.",
      },
      503,
    );
  }

  let body: PublishProductBody;
  try {
    body = (await request.json()) as PublishProductBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.confirm !== true) {
    return json(
      { error: "Confirmation required: publishing makes the product live on your shop." },
      428,
    );
  }
  if (!validProductId(body.productId)) {
    return json({ error: "A valid Printify product id is required" }, 400);
  }

  try {
    const shopId = await client.resolveShopId();
    await client.publishProduct(shopId, body.productId);
    // The publish endpoint answers with the product record; the client only
    // needs the id it already has. Reporting success without echoing upstream
    // data keeps the response shape stable across Printify changes.
    return json({ published: true, productId: body.productId }, 200);
  } catch (error) {
    if (error instanceof PrintifyError) {
      const detail =
        error.detail === undefined
          ? undefined
          : (typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail)).slice(0, 400);
      // Pass the upstream status through where it is meaningful, so a
      // validation failure is not reported to the browser as a gateway error.
      const status =
        error.status === 429
          ? 429
          : error.status === 404
            ? 404
            : error.status === 400 || error.status === 422
              ? 400
              : 502;
      return json({ error: error.message, detail, status: error.status }, status);
    }
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error publishing product" },
      500,
    );
  }
};
