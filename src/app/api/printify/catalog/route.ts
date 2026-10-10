import { NextResponse } from "next/server";
import {
  isPrintifyConfigured,
  listBlueprints,
  getBlueprint,
  listProviders,
  PrintifyError,
  type PrintifyBlueprintDetail,
} from "@/lib/server/printify";

export const dynamic = "force-dynamic";

function fail(error: unknown) {
  if (error instanceof PrintifyError) {
    return NextResponse.json({ error: error.message, status: error.status }, { status: error.status === 501 ? 503 : 502 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unexpected Printify error" },
    { status: 500 },
  );
}

/**
 * GET /api/printify/catalog?category=...            → blueprint list
 * GET /api/printify/catalog?id=123                 → blueprint detail (variants + print areas)
 * GET /api/printify/catalog?id=123&providers=1     → print providers for a blueprint
 */
export async function GET(request: Request) {
  if (!isPrintifyConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        error:
          "Printify is not configured. Add PRINTIFY_API_KEY to .env.local and restart the dev server to enable the live catalog.",
      },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const category = url.searchParams.get("category") ?? undefined;
  const wantsProviders = url.searchParams.get("providers") === "1";

  try {
    if (!id) {
      return NextResponse.json({ configured: true, blueprints: await listBlueprints(category) });
    }
    if (wantsProviders) {
      return NextResponse.json({ configured: true, ...(await listProviders(Number(id))) });
    }
    const detail: PrintifyBlueprintDetail = await getBlueprint(Number(id));
    return NextResponse.json({ configured: true, blueprint: detail });
  } catch (error) {
    return fail(error);
  }
}