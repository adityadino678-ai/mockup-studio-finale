import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { createPrintifyClient, isSalesChannelConnected, PrintifyError } from "@/lib/server/printify";

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

/**
 * GET /api/printify/shops
 *
 * Read-only: the shops this API key can reach, and whether each one is
 * connected to a sales channel (Etsy). Settings uses it for the shop picker and
 * Listing preview uses it to check the saved shop before publishing. It has no
 * side effects, so it needs no confirmation.
 *
 * The key comes from the browser (`x-printify-key`) or, when absent, from the
 * server secret - exactly like `/api/printify/catalog`.
 */
export const prerender = false;

interface ShopRow {
  id: number;
  title: string;
  /** The raw Printify sales channel ("etsy", …); empty when there is none. */
  salesChannel: string;
  connected: boolean;
}

export const GET: APIRoute = async ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);

  if (!client.configured) {
    return json(
      {
        configured: false,
        shops: [],
        error:
          "Printify is not configured. Paste your Printify API key in Settings → API connections.",
      },
      503,
    );
  }

  try {
    const shops = await client.listShops();
    const rows: ShopRow[] = shops.map((shop) => ({
      id: shop.id,
      title: shop.title,
      salesChannel: shop.sales_channel ?? "",
      connected: isSalesChannelConnected(shop),
    }));
    // Stable sort: connected shops first, Printify's own order within each
    // group. A disconnected shop stays visible (and labelled) - hiding it would
    // make an existing selection look lost.
    rows.sort((a, b) => Number(b.connected) - Number(a.connected));
    return json({ configured: true, shops: rows });
  } catch (error) {
    if (error instanceof PrintifyError) {
      // A rejected key is a configuration problem the user can fix, not a
      // gateway fault - the same mapping the catalogue endpoint uses.
      if (error.status === 401 || error.status === 403) {
        return json(
          {
            configured: false,
            shops: [],
            error: `Printify rejected the API key (HTTP ${error.status}: ${error.message}). Update it in Settings, or set a valid PRINTIFY_API_KEY on the server.`,
            status: error.status,
          },
          503,
        );
      }
      return json(
        {
          configured: error.status !== 501,
          shops: [],
          error: error.message,
          status: error.status,
        },
        error.status === 501 ? 503 : 502,
      );
    }
    return json(
      {
        configured: true,
        shops: [],
        error: error instanceof Error ? error.message : "Unexpected error reading Printify shops",
      },
      500,
    );
  }
};
