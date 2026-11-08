import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : request.headers.get("x-access-token") ?? "";

  if (!token) {
    return json({ error: "unauthorized", message: "Missing auth token" }, 401);
  }

  const { client, admin } = authClients(locals);
  const supabase = client ?? admin;

  if (!supabase) {
    return json({ error: "not_configured", message: "Supabase Auth is not configured." }, 503);
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  return json({
    user: {
      id: data.user.id,
      email: data.user.email ?? "",
    },
  });
};
