import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { requireAuth } from "@/lib/auth/middleware";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  return json({
    user: {
      id: auth.userId,
      email: auth.email,
    },
  });
};
