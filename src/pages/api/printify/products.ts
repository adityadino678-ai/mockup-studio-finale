import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { createPrintifyClient, PrintifyError } from "@/lib/server/printify";

interface CreateProductBody {
  /** Explicit user confirmation is required before anything is created remotely. */
  confirm: boolean;
  title: string;
  description?: string;
  blueprintId: number;
  printProviderId?: number;
  variants: Record<string, number[]>;
  printAreas?: Record<string, string>;
  /** Base64 artwork to upload and attach to the print area. */
  artwork?: { base64: string; filename: string; printAreaId: string };
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Decodes base64 without `Buffer`, which does not exist in the Workers
 * runtime. `atob` is available in Workers and in every browser. Used only to
 * enforce the upload size limit before handing the base64 to Printify.
 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);

  if (!client.configured) {
    return json(
      {
        error:
          "Printify is not configured. Paste your Printify API key in Settings, or set PRINTIFY_API_KEY on the server, before creating products.",
      },
      503,
    );
  }

  let body: CreateProductBody;
  try {
    body = (await request.json()) as CreateProductBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.confirm !== true) {
    return json(
      { error: "Confirmation required: creating a product on Printify has external side effects." },
      428,
    );
  }
  if (!body.title?.trim()) {
    return json({ error: "Product title is required" }, 400);
  }
  if (!body.blueprintId || Number.isNaN(body.blueprintId)) {
    return json({ error: "A blueprint must be selected" }, 400);
  }
  if (!body.variants || Object.keys(body.variants).length === 0) {
    return json({ error: "At least one variant (size/color) must be selected" }, 400);
  }

  try {
    let assetId: number | undefined;
    if (body.artwork) {
      const bytes = base64ToBytes(body.artwork.base64);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return json({ error: "Artwork exceeds the 25 MB upload limit" }, 413);
      }
      const uploaded = await client.uploadImage(body.artwork.base64, body.artwork.filename);
      assetId = uploaded.id;
    }

    const printAreas = { ...(body.printAreas ?? {}) };
    if (assetId && body.artwork?.printAreaId) {
      printAreas[body.artwork.printAreaId] = String(assetId);
    }

    const product = await client.createProduct({
      title: body.title.trim(),
      description: body.description ?? "",
      blueprintId: body.blueprintId,
      printProviderId: body.printProviderId,
      variants: body.variants,
      printAreas: Object.keys(printAreas).length > 0 ? printAreas : undefined,
      assets: assetId ? [{ id: assetId, type: "default" }] : undefined,
    });

    return json({ product });
  } catch (error) {
    if (error instanceof PrintifyError) {
      return json({ error: error.message, status: error.status }, 502);
    }
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error creating product" },
      500,
    );
  }
};
