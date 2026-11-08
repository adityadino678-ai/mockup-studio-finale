import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteUrl, normaliseSiteUrl } from "@/lib/site";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normaliseSiteUrl", () => {
  it("accepts an https origin", () => {
    expect(normaliseSiteUrl("https://listbulkly.com")).toBe("https://listbulkly.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseSiteUrl("  https://listbulkly.com  ")).toBe("https://listbulkly.com");
  });

  it("strips a trailing slash", () => {
    expect(normaliseSiteUrl("https://listbulkly.com/")).toBe("https://listbulkly.com");
  });

  it("drops a path, query and hash and keeps only the origin", () => {
    expect(normaliseSiteUrl("https://listbulkly.com/shop?utm=1#top")).toBe(
      "https://listbulkly.com",
    );
  });

  it("rejects http", () => {
    expect(normaliseSiteUrl("http://listbulkly.com")).toBeNull();
  });

  it("rejects a workers.dev subdomain", () => {
    expect(normaliseSiteUrl("https://mockup-studio.adityadino678.workers.dev")).toBeNull();
  });

  it("rejects a workers.dev host regardless of case", () => {
    expect(normaliseSiteUrl("https://MOCKUP-STUDIO.Adityadino678.WORKERS.DEV")).toBeNull();
  });

  it("rejects the bare workers.dev host", () => {
    expect(normaliseSiteUrl("https://workers.dev")).toBeNull();
  });

  it("accepts a deceptive host that merely contains workers.dev", () => {
    // The check is on the HOSTNAME SUFFIX, not a substring: this host is
    // `x.workers.dev.evil.com`, which is not Cloudflare's workers.dev.
    expect(normaliseSiteUrl("https://x.workers.dev.evil.com")).toBe(
      "https://x.workers.dev.evil.com",
    );
  });

  it("rejects empty and missing values", () => {
    expect(normaliseSiteUrl("")).toBeNull();
    expect(normaliseSiteUrl("   ")).toBeNull();
    expect(normaliseSiteUrl(undefined)).toBeNull();
    expect(normaliseSiteUrl(null)).toBeNull();
  });

  it("rejects garbage and relative values", () => {
    expect(normaliseSiteUrl("not a url")).toBeNull();
    expect(normaliseSiteUrl("listbulkly.com")).toBeNull();
    expect(normaliseSiteUrl("//listbulkly.com")).toBeNull();
    expect(normaliseSiteUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseSiteUrl("https://")).toBeNull();
  });
});

describe("absoluteUrl", () => {
  it("joins the configured origin and a path", () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://listbulkly.com");
    expect(absoluteUrl("/listing-preview")).toBe("https://listbulkly.com/listing-preview");
  });

  it("always prefixes a path with one slash and collapses duplicates", () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://listbulkly.com/");
    expect(absoluteUrl("mockups")).toBe("https://listbulkly.com/mockups");
    expect(absoluteUrl("//mockups//area")).toBe("https://listbulkly.com/mockups/area");
  });

  it("returns null when no site URL is configured", () => {
    expect(absoluteUrl("/mockups")).toBeNull();
  });

  it("returns null when the configured URL is not usable", () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://mockup-studio.adityadino678.workers.dev");
    expect(absoluteUrl("/mockups")).toBeNull();
  });
});
