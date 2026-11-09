import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Content guards for the public landing page.
 *
 * `/` is the owner-supplied standalone document in `src/landing/exact.html`.
 * These checks are static so they keep working without a browser. The
 * behavioural checks (dialog, calculator, live slogan tee, 390px overflow)
 * live in `e2e/landing.spec.ts`.
 */

const root = path.resolve(import.meta.dirname, "..");
const landing = readFileSync(path.join(root, "src/landing/exact.html"), "utf8");
const index = readFileSync(path.join(root, "src/pages/index.astro"), "utf8");

describe("landing page content rules", () => {
  it("serves the supplied document verbatim without the old React landing", () => {
    expect(landing).toContain("<!doctype html>");
    expect(landing).toContain("</html>");
    expect(landing).toContain("<title>ListBulkly – From sketch to shelf, in bulk</title>");
    expect(index).toContain('import landing from "../landing/exact.html?raw"');
    expect(index).toContain("<Fragment set:html={landing} />");
    expect(index).not.toContain("import SketchLayout");
    expect(index).not.toContain("LandingPage");
    expect(index).not.toContain('http-equiv="refresh"');
    expect(index).not.toContain("location.replace");
  });

  it("contains the hero, six sections, calculator, auth dialog, pricing and FAQ", () => {
    for (const id of ["#top", "#cost", "#s1", "#s2", "#s3", "#s4", "#s5", "#s6", "#trust", "#pricing", "#faq", "#auth"]) {
      expect(landing).toContain(`id="${id.slice(1)}"`);
    }
    for (const heading of ["Create", "Clean", "Mockup", "Describe", "Check", "Send"]) {
      expect(landing).toContain(`<h2>${heading}</h2>`);
    }
    expect(landing).toContain('id="sl"');
    expect(landing).toContain('id="t1"');
    expect(landing).toContain('id="t2"');
    expect(landing).toContain('id="t3"');
    expect(landing).toContain('id="r1"');
    expect(landing).toContain('id="r2"');
    expect(landing).toContain('data-auth="up"');
    expect(landing).toContain('data-auth="in"');
  });

  it("labels unfinished pricing as PLACEHOLDER and keeps the visible close-out note", () => {
    expect(landing).toContain("PLACEHOLDER");
    expect(landing).toContain("Prices and limits are placeholders");
  });

  it("states the no-auto-publish rule and Printify-only relationship", () => {
    expect(landing).not.toMatch(/one-click publish/i);
    expect(landing).toContain("Nothing goes live by itself");
    expect(landing).toContain("Send stops at an unpublished draft");
    expect(landing).toContain("Publishing is a separate click");
    expect(landing).toContain("ListBulkly is independent and not affiliated with or endorsed by Printify or Etsy");
  });

  it("makes no invented social proof", () => {
    expect(landing).not.toMatch(/\b\d[\d,.]*\s*(sellers|creators|customers|users)\b/i);
    expect(landing).not.toMatch(/trusted by|loved by|rated \d|★/i);
  });

  it("points the footer legal links at the real pages", () => {
    expect(landing).not.toMatch(/etsy\.com/i);
    expect(landing).not.toMatch(/instagram|tiktok|facebook|twitter\/x/i);
    const footerLinks = [...landing.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)]
      .filter((m) => ["Privacy", "Terms", "Refunds", "Cookies", "Contact"].includes(m[2]))
      .map((m) => [m[2], m[1]]);
    expect(footerLinks).toEqual([
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["Refunds", "/refunds"],
      ["Cookies", "/cookies"],
      ["Contact", "/contact"],
    ]);
  });

  it("wires the auth dialog to the real API and keeps no demo-only claim", () => {
    expect(landing).toContain("/api/auth/");
    expect(landing).toContain("signup");
    expect(landing).toContain("signin");
    expect(landing).not.toContain("Demo only: connect your auth provider");
    expect(landing).not.toContain("supabase.auth.signUp / signInWithPassword");
  });

  it("collects a name at sign-up and sends it as fullName", () => {
    expect(landing).toContain('id="nm"');
    expect(landing).toContain("fullName:nm");
    expect(landing).toContain("URLSearchParams(location.search)");
  });
});
