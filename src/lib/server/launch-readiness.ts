/**
 * Launch-readiness report.
 *
 * A read-only summary of what the deployment still needs before it can be
 * called launched. It is deliberately strict and deliberately honest:
 *
 * - it NEVER sends mail, charges anyone or calls a network service;
 * - it never returns a secret value, prefix, suffix or length - only booleans
 *   and fixed human sentences;
 * - pricing stays PLACEHOLDER, there is no custom domain, the companion
 *   extension stays a beta prototype, and Supabase Auth keeps sending its own
 *   mail until a verified sending domain exists.
 *
 * Because the extension is always a beta prototype, the top-level `ready` is
 * never true today: it is true only when every item is ready.
 */

export interface ReadinessItem {
  id: "site-url" | "auth" | "email" | "billing" | "extension";
  label: string;
  ready: boolean;
  detail: string;
}

export interface LaunchReadinessInput {
  siteUrl?: string | null;
  supabaseUrl?: string | null;
  supabaseAnonKey?: string | null;
  supabaseServiceRole?: string | null;
  resendApiKey?: string | null;
  resendFrom?: string | null;
  razorpayKeyId?: string | null;
  razorpayKeySecret?: string | null;
}

export interface LaunchReadiness {
  ready: boolean;
  items: ReadinessItem[];
}

/** A value counts as configured only when it has a non-space character. */
function present(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The site URL rule is the canonical one: a `*.workers.dev` address is a
 * temporary host, so canonical links stay unset until a real domain exists.
 * Anything that is not an absolute http(s) URL is equally unusable.
 */
function siteUrlState(value: string | null | undefined): {
  ready: boolean;
  detail: string;
} {
  if (!present(value)) {
    return {
      ready: false,
      detail:
        "PUBLIC_SITE_URL is not set, so canonical links are omitted. There is no custom domain yet.",
    };
  }
  let host = "";
  try {
    const url = new URL(value as string);
    if (url.protocol !== "https:") throw new Error("protocol");
    host = url.hostname.toLowerCase();
  } catch {
    return {
      ready: false,
      detail:
        "PUBLIC_SITE_URL is not an https URL. Canonical links stay unset: there is no custom domain yet.",
    };
  }
  if (host === "workers.dev" || host.endsWith(".workers.dev")) {
    return {
      ready: false,
      detail:
        "PUBLIC_SITE_URL points at a workers.dev address. Canonical links stay unset: there is no custom domain yet.",
    };
  }
  return {
    ready: true,
    detail: "PUBLIC_SITE_URL is a real public origin, so canonical links can be emitted.",
  };
}

export function computeLaunchReadiness(input: LaunchReadinessInput): LaunchReadiness {
  const site = siteUrlState(input.siteUrl);

  const authReady = present(input.supabaseUrl) && present(input.supabaseAnonKey);
  const serviceRoleNote = present(input.supabaseServiceRole)
    ? "The service-role key is optional and is set."
    : "The service-role key is optional and is not set.";
  const missingAuth = [
    present(input.supabaseUrl) ? null : "SUPABASE_URL",
    present(input.supabaseAnonKey) ? null : "SUPABASE_ANON_KEY",
  ].filter((name): name is string => name !== null);
  const auth: ReadinessItem = {
    id: "auth",
    label: "Auth",
    ready: authReady,
    detail: authReady
      ? `Supabase URL and anon key are set, so sign-in can use Supabase Auth. ${serviceRoleNote}`
      : `Supabase Auth needs ${missingAuth.join(" and ")}. ${serviceRoleNote}`,
  };

  const emailReady = present(input.resendApiKey) && present(input.resendFrom);
  const emailDetail = emailReady
    ? "Resend key and from address are set. Supabase Auth sends its own mail until a verified domain exists."
    : "Email is not ready: RESEND_API_KEY and RESEND_FROM are both required. Supabase Auth sends its own mail until a verified domain exists.";
  const email: ReadinessItem = {
    id: "email",
    label: "Email",
    ready: emailReady,
    detail: `${emailDetail} This report never sends mail.`,
  };

  const billingReady = present(input.razorpayKeyId) && present(input.razorpayKeySecret);
  const billing: ReadinessItem = {
    id: "billing",
    label: "Billing",
    ready: billingReady,
    detail: billingReady
      ? "Both Razorpay keys are set, but live mode stays off and pricing is PLACEHOLDER until real launch data exists."
      : "Billing needs both Razorpay keys. Live mode stays off and pricing is PLACEHOLDER until real launch data exists.",
  };

  const items: ReadinessItem[] = [
    {
      id: "site-url",
      label: "Site URL",
      ready: site.ready,
      detail: site.detail,
    },
    auth,
    email,
    billing,
    {
      id: "extension",
      label: "Extension",
      ready: false,
      detail:
        "Beta prototype: unpacked install, protocol 2 required, store listing not published.",
    },
  ];

  return { ready: items.every((item) => item.ready), items };
}
