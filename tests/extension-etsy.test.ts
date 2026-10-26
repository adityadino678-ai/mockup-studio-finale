import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The extension's Etsy scraper runs in a real page, so it is tested against a
// real jsdom document. The card-climbing rule is the part that matters: it
// must stop at the grid, or one listing would be given a neighbour's price.
// ---------------------------------------------------------------------------

const extensionDir = join(process.cwd(), "extension");
const read = (name: string) => readFileSync(join(extensionDir, name), "utf8");

interface ScrapedCard {
  title: string;
  priceText: string;
  url: string;
}

interface ScrapeResult {
  ok: boolean;
  pageTitle: string;
  url: string;
  blocked: string;
  listings: ScrapedCard[];
  diagnostics: {
    anchorCount: number;
    listingAnchorCount: number;
    cardCount: number;
    bodyLength: number;
    bodyText: string;
    noResults: boolean;
    hasResultsRoot: boolean;
    readyState: string;
  };
}

function loadScraper() {
  const source = read("etsy-research.js");
  const factory = new Function(
    "document",
    "location",
    `${source}\nreturn { scrapeEtsySearch: scrapeEtsySearch, msEtsyPriceText: msEtsyPriceText };`,
  ) as (
    doc: Document,
    loc: { href: string },
  ) => {
    scrapeEtsySearch: () => ScrapeResult;
    msEtsyPriceText: (text: string) => string;
  };
  return factory(document, { href: "https://www.etsy.com/search?q=cat+mug" });
}

beforeEach(() => {
  document.title = "";
  document.body.innerHTML = "";
});

describe("scrapeEtsySearch", () => {
  it("reads titles, prices and URLs, and never borrows a neighbour's price", () => {
    document.body.innerHTML = `
      <div id="grid">
        <div class="card">
          <a href="https://www.etsy.com/listing/1/cat-mug?ref=search">
            <h2>Personalized Cat Mug</h2>
            <span>$24.99</span>
          </a>
        </div>
        <div class="card">
          <a href="https://www.etsy.com/listing/1/cat-mug?ref=again"><h2>Duplicate</h2></a>
        </div>
        <div class="card">
          <a href="https://www.etsy.com/listing/2/cat-shirt"><h2>Cat Mom Shirt</h2></a>
          <span>US$32.50</span>
        </div>
        <div class="card">
          <a href="https://www.etsy.com/listing/3/no-price"><h2>No price listing</h2></a>
        </div>
      </div>
    `;

    const result = loadScraper().scrapeEtsySearch();

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe("");
    expect(result.listings.map((listing) => listing.url)).toEqual([
      "https://www.etsy.com/listing/1/cat-mug",
      "https://www.etsy.com/listing/2/cat-shirt",
      "https://www.etsy.com/listing/3/no-price",
    ]);
    expect(result.listings[0]).toMatchObject({
      title: "Personalized Cat Mug",
      priceText: "$24.99",
    });
    expect(result.listings[1]).toMatchObject({
      title: "Cat Mom Shirt",
      priceText: "US$32.50",
    });
    // The fourth card has no price of its own; the grid's prices are not used.
    expect(result.listings[2].priceText).toBe("");
  });

  it("reports a verification page instead of pretending it found listings", () => {
    document.title = "Just a moment...";
    document.body.innerHTML = "<p>Enable JavaScript and cookies to continue</p>";

    const result = loadScraper().scrapeEtsySearch();

    expect(result.ok).toBe(true);
    expect(result.blocked).toMatch(/verification page/i);
    expect(result.listings).toEqual([]);
  });

  it("caps the cards at 48", () => {
    const cards = Array.from(
      { length: 60 },
      (_, index) =>
        `<div class="card"><a href="https://www.etsy.com/listing/${index}/x"><h2>Listing ${index}</h2><span>$${index + 1}.00</span></a></div>`,
    ).join("");
    document.body.innerHTML = `<div id="grid">${cards}</div>`;

    const result = loadScraper().scrapeEtsySearch();

    expect(result.listings).toHaveLength(48);
  });

  it("ignores links that are not Etsy listing URLs", () => {
    document.body.innerHTML = `
      <a href="https://evil.example/listing/1/x"><h2>Evil</h2><span>$1.00</span></a>
      <a href="https://www.etsy.com/listing/2/ok"><h2>Real</h2><span>$2.00</span></a>
    `;

    const result = loadScraper().scrapeEtsySearch();

    expect(result.listings.map((listing) => listing.title)).toEqual(["Real"]);
  });

  it("reports Etsy's own no-results page instead of a generic failure", () => {
    document.body.innerHTML = `
      <main data-search-results>
        <h1>No results found</h1>
        <p>Try a different search or check your spelling.</p>
      </main>
    `;

    const result = loadScraper().scrapeEtsySearch();

    expect(result.listings).toEqual([]);
    expect(result.diagnostics.noResults).toBe(true);
    expect(result.diagnostics.hasResultsRoot).toBe(true);
    expect(result.diagnostics.anchorCount).toBe(0);
  });

  it("explains an empty page with counts and a page-text sample", () => {
    document.body.innerHTML = "<main><p>Loading results…</p></main>";

    const result = loadScraper().scrapeEtsySearch();

    expect(result.listings).toEqual([]);
    expect(result.diagnostics.noResults).toBe(false);
    expect(result.diagnostics.hasResultsRoot).toBe(false);
    expect(result.diagnostics.anchorCount).toBe(0);
    expect(result.diagnostics.listingAnchorCount).toBe(0);
    expect(result.diagnostics.bodyText).toContain("Loading results");
    expect(result.diagnostics.bodyLength).toBeGreaterThan(0);
  });
});

describe("extension files", () => {
  it("compile as classic scripts", () => {
    for (const file of [
      "background.js",
      "content-app.js",
      "etsy-research.js",
      "payload-guard.js",
      "printify-apply.js",
    ]) {
      expect(() => new Function(read(file)), file).not.toThrow();
    }
  });

  it("asks for Etsy host permission", () => {
    const manifest = JSON.parse(read("manifest.json")) as {
      host_permissions: string[];
      version: string;
    };
    expect(manifest.host_permissions).toContain("https://*.etsy.com/*");
    expect(manifest.host_permissions).toContain("https://etsy.com/*");
    expect(manifest.version).toBe("1.2.0");
  });

  it("announces protocol 2 and the Etsy capability", () => {
    const content = read("content-app.js");
    expect(content).toContain("data-mockup-studio-ext-protocol");
    expect(content).toContain("data-mockup-studio-ext-etsy");
    expect(content).toContain("var PROTOCOL = 2");
    expect(content).toContain("protocol: PROTOCOL");
    expect(content).toContain("etsy: true");
  });

  it("polls and scrolls the Etsy tab before reporting no cards", () => {
    const background = read("background.js");
    expect(background).toContain("ETSY_POLL_ATTEMPTS");
    expect(background).toContain("nudgeEtsyScroll");
    expect(background).toContain("etsyNoCardsMessage");
    expect(background).toContain("diagnostics.noResults");
  });

  it("wires the Etsy message and page events", () => {
    expect(read("background.js")).toContain("MS_ETSY_RESEARCH");
    expect(read("background.js")).toContain("handleEtsyResearch");
    expect(read("content-app.js")).toContain("mockup-studio:etsy-research-request");
    expect(read("content-app.js")).toContain("mockup-studio:etsy-research-result");
    expect(read("content-app.js")).toContain("mockup-studio:etsy-research-error");
  });
});
