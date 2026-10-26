/* ---------------------------------------------------------------------------
 * etsy-research.js - reads the public Etsy search page in the user's browser.
 *
 * The app prefers the Etsy API (a keystring in Settings). When no key is
 * configured, or Etsy rejects it, the service worker opens
 * `https://www.etsy.com/search?q=...` in a BACKGROUND tab and injects
 * `scrapeEtsySearch` into that tab's isolated world. It uses the user's own
 * Etsy session, so it sees the same public page a person would.
 *
 * What it can read: listing titles, the price label and the listing URL.
 * What it cannot read: tags. Etsy's search cards do not expose them, so the
 * caller reports an empty `topTags` instead of inventing tags.
 *
 * IMPORTANT: `scrapeEtsySearch` is injected with
 * `chrome.scripting.executeScript({ func })`, which serialises ONLY that
 * function's source. It must therefore be completely self-contained: no outer
 * helper, no module constant, no closure. `msEtsyPriceText` below exists for
 * the unit tests and is intentionally duplicated inside the injected function.
 *
 * The page can still be rendering when this runs. The service worker calls the
 * function repeatedly, scrolls between attempts, and uses the returned
 * `diagnostics` to tell "Etsy found nothing" apart from "the page never
 * rendered listing cards".
 * ------------------------------------------------------------------------- */

"use strict";

var ETSY_SEARCH_MAX_CARDS = 48;

/** The first price-looking fragment in a card's text, or "". */
function msEtsyPriceText(text) {
  if (!text) return "";
  var match = String(text).match(
    /(?:US\s*\$|CA\s*\$|AU\s*\$|USD\s*|EUR\s*|GBP\s*|[$€£])\s*\d[\d.,\s]*/i,
  );
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

/**
 * Injected into the Etsy search tab.
 *
 * Returns `{ ok, pageTitle, url, blocked, listings, diagnostics }`. `blocked`
 * is a short sentence when Etsy served a verification/CAPTCHA page instead of
 * results; `listings` is capped at 48 and de-duplicated by URL. `diagnostics`
 * is for the background worker's error message, not for the app's UI.
 */
function scrapeEtsySearch() {
  var MAX_CARDS = 48;

  /* Self-contained on purpose (see the file header): the injected function
     cannot see `msEtsyPriceText` or `ETSY_SEARCH_MAX_CARDS`. */
  function priceTextOf(text) {
    if (!text) return "";
    var match = String(text).match(
      /(?:US\s*\$|CA\s*\$|AU\s*\$|USD\s*|EUR\s*|GBP\s*|[$€£])\s*\d[\d.,\s]*/i,
    );
    return match ? match[0].replace(/\s+/g, " ").trim() : "";
  }

  var result = {
    ok: true,
    pageTitle: document.title || "",
    url: location.href,
    blocked: "",
    listings: [],
    diagnostics: {
      anchorCount: 0,
      listingAnchorCount: 0,
      cardCount: 0,
      bodyLength: 0,
      bodyText: "",
      noResults: false,
      hasResultsRoot: false,
      readyState: "",
    },
  };

  var bodyText = "";
  try {
    bodyText =
      (document.body && (document.body.innerText || document.body.textContent)) || "";
  } catch (e) {}

  result.diagnostics.bodyLength = bodyText.length;
  result.diagnostics.bodyText = bodyText.replace(/\s+/g, " ").trim().slice(0, 500);
  try {
    result.diagnostics.readyState = document.readyState || "";
  } catch (e) {}

  if (
    /just a moment|checking your browser|enable javascript and cookies to continue|verify you are human|challenge-platform|cf-challenge|unusual traffic|captcha|are you a robot|access denied/i.test(
      result.pageTitle + " " + bodyText.slice(0, 4000),
    )
  ) {
    result.blocked =
      "Etsy showed a verification page instead of search results. Open etsy.com in a normal tab, finish the check, then try again.";
    return result;
  }

  try {
    result.diagnostics.hasResultsRoot = Boolean(
      document.querySelector(
        '[data-search-results], [data-component="search-results"], #search-results, [data-results-container], [data-listing-card], .search-listings-group',
      ),
    );
  } catch (e) {}

  result.diagnostics.noResults = /no results|we couldn't find|didn't match|try a different search|no listings|0 results/i.test(
    bodyText.slice(0, 6000),
  );

  /* The number of DISTINCT listings inside a node. A card can have two links
     to the same listing (image + title); the grid has several listings. */
  function listingLinkCount(node) {
    var links = node.querySelectorAll('a[href*="/listing/"]');
    var seenHref = {};
    var count = 0;
    for (var n = 0; n < links.length; n++) {
      var href = links[n].href || links[n].getAttribute("href") || "";
      var key = href.split("?")[0];
      if (key && !seenHref[key]) {
        seenHref[key] = true;
        count++;
      }
    }
    return count;
  }

  var anchors = document.querySelectorAll('a[href*="/listing/"]');
  result.diagnostics.anchorCount = anchors.length;
  var seen = {};

  for (var i = 0; i < anchors.length && result.listings.length < MAX_CARDS; i++) {
    var anchor = anchors[i];
    var href = anchor.href || anchor.getAttribute("href") || "";
    if (!/^https:\/\/([a-z0-9-]+\.)*etsy\.com\/listing\//i.test(href)) continue;
    result.diagnostics.listingAnchorCount++;

    var url = href.split("?")[0].split("#")[0];
    if (seen[url]) continue;

    /* The card is the smallest ancestor that carries a price. Climbing stops
       at the grid, which is the first ancestor with more than one listing
       link - otherwise one card's price could be read for every card. */
    var card = anchor;
    var priceText = priceTextOf(anchor.textContent || "");
    for (var depth = 0; depth < 6 && !priceText && card.parentElement; depth++) {
      card = card.parentElement;
      /* Stop at the grid BEFORE reading its text: the grid contains every
         card's price, so accepting one there would give this listing a
         neighbour's price. */
      if (listingLinkCount(card) > 1) break;
      priceText = priceTextOf(card.textContent || "");
    }

    var title = "";
    var heading = card.querySelector("h2, h3, [data-listing-card-title]");
    if (heading && heading.textContent) title = heading.textContent;
    if (!title) title = anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "";
    if (!title) {
      var image = anchor.querySelector("img[alt]");
      if (image) title = image.getAttribute("alt") || "";
    }
    if (!title) title = anchor.textContent || "";

    title = String(title).replace(/\s+/g, " ").trim();
    if (priceText && title.indexOf(priceText) >= 0) {
      title = title.replace(priceText, "").replace(/\s+/g, " ").trim();
    }
    if (title.length < 3) continue;

    seen[url] = true;
    result.listings.push({
      title: title.slice(0, 300),
      priceText: priceText,
      url: url,
    });
  }

  result.diagnostics.cardCount = result.listings.length;
  return result;
}
