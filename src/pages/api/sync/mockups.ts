import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { supabaseAdmin } from "@/lib/auth/supabase-auth";
import { requireAuth } from "@/lib/auth/middleware";
import { z } from "zod";

export const prerender = false;

const syncMockupSchema = z.object({
  mockups: z.array(
    z.object({
      id: z.string(),
      user_id: z.string().optional(),
      name: z.string(),
      category: z.string().optional(),
      asset_id: z.string(),
      print_area: z.any().optional(),
      updated_at: z.string().optional(),
    }),
  ),
});

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => ({}));
  const parsed = syncMockupSchema.safeParse(body);

  if (!parsed.success) {
    return json(
      { error: "bad_request", message: "Invalid mockups payload" },
      400,
    );
  }

  const { mockups } = parsed.data;

  if (!supabaseAdmin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }
  const { error } = await supabaseAdmin.from("mockups").upsert(
    mockups.map((m) => ({
      ...m,
      user_id: auth.userId,
      updated_at: m.updated_at ?? new Date().toISOString(),
    })),
    { onConflict: "id" },
  );

  if (error) {
    return json(
      { error: "sync_failed", message: error.message },
      500,
    );
  }

  return json({ ok: true, synced: mockups.length });
};

export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  if (!supabaseAdmin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }
  const { data, error } = await supabaseAdmin
    .from("mockups")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (error) {
    return json({ error: "sync_failed", message: error.message }, 500);
  }

  return json({ mockups: data ?? [] });
};
