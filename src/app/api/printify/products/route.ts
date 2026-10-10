import { NextResponse } from "next/server";
import {
  createProduct,
  isPrintifyConfigured,
  uploadAsset,
  PrintifyError,
} from "@/lib/server/printify";

export const dynamic = "force-dynamic";

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

export async function POST(request: Request) {
  if (!isPrintifyConfigured()) {
    return NextResponse.json(
      {
        error:
          "Printify is not configured. Add PRINTIFY_API_KEY to .env.local and restart the dev server before creating products.",
      },
      { status: 503 },
    );
  }

  let body: CreateProductBody;
  try {
    body = (await request.json()) as CreateProductBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "Confirmation required: creating a product on Printify has external side effects." },
      { status: 428 },
    );
  }
  if (!body.title?.trim()) {
    return NextResponse.json({ error: "Product title is required" }, { status: 400 });
  }
  if (!body.blueprintId || Number.isNaN(body.blueprintId)) {
    return NextResponse.json({ error: "A blueprint must be selected" }, { status: 400 });
  }
  if (!body.variants || Object.keys(body.variants).length === 0) {
    return NextResponse.json({ error: "At least one variant (size/color) must be selected" }, { status: 400 });
  }

  try {
    let assetId: number | undefined;
    if (body.artwork) {
      const buffer = Buffer.from(body.artwork.base64, "base64");
      if (buffer.byteLength > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: "Artwork exceeds the 25 MB upload limit" }, { status: 413 });
      }
      const blob = new Blob([new Uint8Array(buffer)], { type: "image/png" });
      const uploaded = await uploadAsset(blob, body.artwork.filename);
      assetId = uploaded.id;
    }

    const printAreas = { ...(body.printAreas ?? {}) };
    if (assetId && body.artwork?.printAreaId) {
      printAreas[body.artwork.printAreaId] = String(assetId);
    }

    const product = await createProduct({
      title: body.title.trim(),
      description: body.description ?? "",
      blueprint_id: body.blueprintId,
      print_provider_id: body.printProviderId,
      variants: body.variants,
      print_areas: Object.keys(printAreas).length > 0 ? printAreas : undefined,
      assets: assetId ? [{ id: assetId, type: "default" }] : undefined,
    });

    return NextResponse.json({ product });
  } catch (error) {
    if (error instanceof PrintifyError) {
      return NextResponse.json(
        { error: error.message, status: error.status },
        { status: error.status === 401 || error.status === 403 ? 502 : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error creating product" },
      { status: 500 },
    );
  }
}