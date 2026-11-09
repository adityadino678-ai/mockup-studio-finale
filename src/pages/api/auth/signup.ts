import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import { sameOriginRequest } from "@/lib/server/same-origin";
import { z } from "zod";

export const prerender = false;

const bodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(72),
  fullName: z.string().trim().max(120).optional(),
});

/**
 * The token shape `/api/auth/signin` returns, so both entry points hand the
 * browser the same thing and the landing dialog can sign in rather than
 * guess what happened.
 */
function sessionFields(session: {
  access_token: string;
  refresh_token: string;
  expires_at?: number | null;
}) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
  };
}

/**
 * Create an account.
 *
 * Two honest paths, chosen by what is configured:
 *
 * - **Service role present.** The account is created confirmed (admin API, no
 *   mail), then signed in with the same password so the response carries a real
 *   session. `profiles` is filled by the `on_auth_user_created` trigger, which
 *   stores the email.
 * - **Anon key only.** `auth.signUp` is used, so Supabase sends its own
 *   confirmation mail and the account is unusable until the link is opened.
 *   The response says `needsEmailConfirmation: true`; it never claims a session
 *   it does not have. If the project has "Confirm email" turned off, signUp
 *   issues a session immediately and the response carries it instead.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "forbidden", message: "Cross-site requests are not allowed." }, 403);
  }

  const { client, admin } = authClients(locals);
  if (!client && !admin) {
    return json(
      {
        error: "not_configured",
        message: "Account sign-up is not configured on this deployment.",
      },
      503,
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return json(
      {
        error: "bad_request",
        message: "Enter a valid email and a password of at least 8 characters.",
      },
      400,
    );
  }

  const { email, password, fullName } = parsed.data;
  const signin = client ?? admin!;

  if (admin) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName ?? "" },
    });

    if (error || !data.user) {
      return json(
        { error: "auth_failed", message: error?.message ?? "Could not create the account." },
        400,
      );
    }

    // The admin create call does not return a session, and no mail was sent in
    // this mode, so "check your email" would be a lie. Mint a real session with
    // the password the visitor just chose. If even that fails the account still
    // exists and is confirmed, so report it created and let them log in.
    const signedIn = await signin.auth.signInWithPassword({ email, password });
    const session = signedIn.error ? null : signedIn.data.session;

    return json({
      ok: true,
      user: { id: data.user.id, email: data.user.email ?? email },
      needsEmailConfirmation: false,
      mode: "instant",
      ...(session ? sessionFields(session) : {}),
    });
  }

  const { data, error } = await client!.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName ?? "" },
      emailRedirectTo: new URL("/auth/confirm", request.url).toString(),
    },
  });

  if (error) {
    // Supabase's built-in sender is rate-limited until a custom SMTP/domain
    // exists. That is a configuration fact, not a user error, so say so and
    // name the one switch that removes the dependency.
    const rateLimited = /rate limit/i.test(error.message);
    return json(
      {
        error: "auth_failed",
        message: rateLimited
          ? "Supabase's email sender is rate-limited on this project. Add SUPABASE_SERVICE_ROLE to create accounts instantly, or try again later."
          : error.message,
      },
      400,
    );
  }

  return json({
    ok: true,
    user: { id: data.user?.id ?? "", email: data.user?.email ?? email },
    needsEmailConfirmation: !data.session,
    // A project with "Confirm email" turned off issues a session straight from
    // signUp. That is the same instant outcome as the service-role path, so
    // report it the same way instead of claiming mail was sent.
    mode: data.session ? "instant" : "email-confirmation",
    ...(data.session ? sessionFields(data.session) : {}),
  });
};
