import { describe, expect, it } from "vitest";
import { computeLaunchReadiness } from "@/lib/server/launch-readiness";

/**
 * The launch-readiness reporter is the only place that says whether email,
 * auth, billing and the site URL are configured. These tests pin its honesty
 * rules: it reports presence, never a secret, and it never claims a launch
 * state that does not exist (PLACEHOLDER pricing, no custom domain, beta
 * extension).
 */

const SECRETS = {
  siteUrl: "https://listbulkly.com",
  supabaseUrl: "https://project-ref.supabase.co",
  supabaseAnonKey: "sb-anon-secret-value-123456",
  supabaseServiceRole: "sb-service-role-secret-value-7890",
  resendApiKey: "re_live_secret_value_abcdef",
  resendFrom: "hello@listbulkly.com",
  razorpayKeyId: "rzp_live_key_id_xyz",
  razorpayKeySecret: "rzp_live_key_secret_xyz",
};

describe("computeLaunchReadiness", () => {
  it("reports nothing ready when every input is missing", () => {
    const report = computeLaunchReadiness({});

    expect(report.ready).toBe(false);
    expect(report.items).toHaveLength(5);
    expect(report.items.every((item) => item.ready === false)).toBe(true);
    expect(report.items.map((item) => item.id)).toEqual([
      "site-url",
      "auth",
      "email",
      "billing",
      "extension",
    ]);

    const byId = Object.fromEntries(report.items.map((item) => [item.id, item.detail]));
    expect(byId["site-url"]).toContain("no custom domain yet");
    expect(byId.auth).toContain("SUPABASE_URL");
    expect(byId.email).toContain("until a verified domain exists");
    expect(byId.billing).toContain("PLACEHOLDER");
    expect(byId.extension).toBe(
      "Beta prototype: unpacked install, protocol 2 required, store listing not published.",
    );
  });

  it("marks the configurable items ready when fully configured", () => {
    const report = computeLaunchReadiness(SECRETS);
    const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));

    expect(byId["site-url"].ready).toBe(true);
    expect(byId.auth.ready).toBe(true);
    expect(byId.email.ready).toBe(true);
    expect(byId.billing.ready).toBe(true);

    // The extension is always a beta prototype, so the deployment is not
    // launch-ready even with every credential present. Top-level `ready` is
    // true only when EVERY item is ready.
    expect(byId.extension.ready).toBe(false);
    expect(report.ready).toBe(false);
  });

  it("keeps workers.dev site URLs blocked with the canonical reason", () => {
    const report = computeLaunchReadiness({
      ...SECRETS,
      siteUrl: "https://mockup-studio.adityadino678.workers.dev",
    });
    const site = report.items.find((item) => item.id === "site-url");

    expect(site?.ready).toBe(false);
    expect(site?.detail).toContain("workers.dev");
    expect(site?.detail).toContain("no custom domain yet");
  });

  it("treats the service-role key as optional for auth", () => {
    const report = computeLaunchReadiness({
      supabaseUrl: SECRETS.supabaseUrl,
      supabaseAnonKey: SECRETS.supabaseAnonKey,
      supabaseServiceRole: null,
    });
    const auth = report.items.find((item) => item.id === "auth");

    expect(auth?.ready).toBe(true);
    expect(auth?.detail).toContain("service-role key is optional");
    expect(auth?.detail).toContain("not set");
  });

  it("never includes a provided secret in any detail", () => {
    const report = computeLaunchReadiness(SECRETS);
    const serialized = JSON.stringify(report.items);

    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });
});
