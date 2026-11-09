import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import { requireAuth } from "@/lib/auth/middleware";
import { z } from "zod";

export const prerender = false;

const syncDesignSchema = z.object({
  designs: z.array(
    z.object({
      id: z.string(),
      user_id: z.string().optional(),
      name: z.string(),
      original_asset_id: z.string().optional(),
      processed_asset_id: z.string().optional(),
      white_ink_asset_id: z.string().optional(),
      black_ink_asset_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
      updated_at: z.string().optional(),
    }),
  ),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAuth(request, locals);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => ({}));
  const parsed = syncDesignSchema.safeParse(body);

  if (!parsed.success) {
    return json(
      { error: "bad_request", message: "Invalid designs payload" },
      400,
    );
  }

  const { designs } = parsed.data;

  const { admin } = authClients(locals);
  if (!admin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }
  const { error } = await admin.from("designs").upsert(
    designs.map((d) => ({
      ...d,
      user_id: auth.userId,
      updated_at: d.updated_at ?? new Date().toISOString(),
    })),
    { onConflict: "id" },
  );

  if (error) {
    return json(
      { error: "sync_failed", message: error.message },
      500,
    );
  }

  return json({ ok: true, synced: designs.length });
};

export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await requireAuth(request, locals);
  if (auth instanceof Response) return auth;

  const { admin } = authClients(locals);
  if (!admin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }
  const { data, error } = await admin
    .from("designs")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (error) {
    return json({ error: "sync_failed", message: error.message }, 500);
  }

  return json({ designs: data ?? [] });
};
