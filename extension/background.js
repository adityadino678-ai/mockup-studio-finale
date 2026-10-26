/* ---------------------------------------------------------------------------
 * background.js - the MV3 service worker for Mockup Studio Printify Bridge.
 *
 * What it does, start to finish:
 *
 *   1. The app's page dispatches `mockup-studio:apply-request`; the content
 *      script forwards it here as `{ type: "MS_APPLY", payload, requestId }`.
 *   2. The payload is validated against the bridge contract. It is ids, URLs,
 *      filenames and titles only - never a Printify API key, never a token.
 *   3. A printify.com tab is opened in the BACKGROUND and waited for.
 *   4. `printify-apply.js`'s `applyMockups` is injected into that tab's
 *      isolated world. Same origin, same cookies, same localStorage session the
 *      user already has - so the BFF calls are the user's own session.
 *   5. The results come back through `sendResponse`, and the background tab is
 *      closed again.
 *
 * It also answers `MS_ETSY_RESEARCH`: open `etsy.com/search?q=...` in a
 * background tab, inject `scrapeEtsySearch`, return the public listing cards,
 * and close the tab. That path only runs when the app's Etsy API key is
 * missing or rejected, and it reads titles/prices/URLs only - search cards do
 * not expose listing tags.
 *
 * It keeps nothing: the payload is held in a module-level variable for the
 * length of ONE apply and dropped in the `finally`. No `chrome.storage` is used
 * or requested, and no payload, session or token is ever logged - the logging
 * in this file is fixed strings only.
 *
 * Known prototype limitation: a service worker can be stopped by the browser
 * after ~30 idle seconds, and an injected script keeps running in the page even
 * if the worker is stopped - which would lose the results. One apply opens one
 * tab, works two products at a time and finishes in seconds for a normal batch,
 * so this is acceptable for a prototype; store.md/README.md say so out loud.
 * ------------------------------------------------------------------------- */

"use strict";

/* Three files, all required at runtime and all plain JS:
   - payload-guard.js    the payload contract, shared with the content script;
   - printify-apply.js   the function injected into the printify.com tab;
   - etsy-research.js    the function injected into the etsy.com tab. */
["payload-guard.js", "printify-apply.js", "etsy-research.js"].forEach((file) => {
  try {
    importScripts(file);
  } catch (e) {
    /* Reported honestly when a request is made rather than ignored. */
  }
});

var MS_APPLY = "MS_APPLY";
var MS_ETSY_RESEARCH = "MS_ETSY_RESEARCH";
var PRINTIFY_HOST = "printify.com";
var ETSY_SEARCH_BASE = "https://www.etsy.com/search?q=";

/* How long to wait for the printify.com tab to load, how often to look, and how
   long to let the SPA mount before injecting: the session lives in
   localStorage once the app has booted. */
var LOAD_TIMEOUT_MS = 20000;
var LOAD_POLL_MS = 250;
var SETTLE_MS = 1500;
var ETSY_LOAD_TIMEOUT_MS = 25000;
var ETSY_SETTLE_MS = 1500;
/* Etsy's grid can render after `status === "complete"`. Poll, scroll, and give
   the cards several chances before reporting "no cards". */
var ETSY_POLL_ATTEMPTS = 6;
var ETSY_POLL_MS = 1200;

/* The payload for the apply that is running right now, in memory only. */
var pendingPayload = null;
var applyInFlight = false;
var etsyInFlight = false;

/* ------------------------------------------------------------------ helpers */

function log() {
  var parts = ["[Mockup Studio Printify Bridge]"];
  for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
  try {
    console.log.apply(console, parts);
  } catch (e) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  if (!error) return "Unknown error.";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function hostnameOf(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

function productUrl(productId) {
  return "https://" + PRINTIFY_HOST + "/app/products/" + productId;
}

function etsySearchUrl(query) {
  return ETSY_SEARCH_BASE + encodeURIComponent(query);
}

function isEtsyHost(host) {
  return host === "etsy.com" || /\.etsy\.com$/i.test(host);
}

/* ---------------------------------------------------------- the background tab */

async function openBackgroundTab(url) {
  var tab;
  try {
    /* Background by default: the user keeps working in the app while the
       images are applied. */
    tab = await chrome.tabs.create({ url: url, active: false });
  } catch (e) {
    /* A browser that refuses a background create still has to open the tab. */
    tab = await chrome.tabs.create({ url: url });
  }
  /* `active` is the documented knob; also ask for inactive once more in case a
     browser ignored the first one. If it is still foregrounded, the user stays
     where they are anyway - switching focus is not something the API allows. */
  try {
    await chrome.tabs.update(tab.id, { active: false });
  } catch (e) {}
  return tab;
}

async function readTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    /* The tab was closed, or the window went away. */
    return null;
  }
}

async function waitForTabLoad(tabId, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || LOAD_TIMEOUT_MS);
  for (;;) {
    var tab = await readTab(tabId);
    if (!tab) return null;
    if (tab.status === "complete") return tab;
    if (Date.now() >= deadline) return tab; /* try anyway; the caller says why it failed */
    await sleep(LOAD_POLL_MS);
  }
}

function closeTab(tabId) {
  if (tabId === null || tabId === undefined) return;
  try {
    chrome.tabs.remove(tabId, function () {
      /* The tab is already gone - nothing to do. */
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

/**
 * Scrolls the Etsy tab once, which is what makes lazy-loaded cards mount.
 *
 * The injected function is self-contained for the same reason as
 * `scrapeEtsySearch`: `executeScript({ func })` serialises only its source.
 */
async function nudgeEtsyScroll(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      func: function () {
        var step = Math.max(500, Math.floor((window.innerHeight || 800) * 0.9));
        window.scrollBy(0, step);
        return { y: window.scrollY, height: document.documentElement.scrollHeight };
      },
    });
  } catch (e) {
    /* A closed tab or a restricted page: the next poll will report it. */
  }
}

/* ------------------------------------------------------------------- injecting */

async function runInTab(tabId, payload) {
  if (typeof applyMockups !== "function") {
    throw new Error("The Printify apply code did not load.");
  }
  var injected = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: "ISOLATED",
    func: applyMockups,
    args: [payload],
  });
  var frame = injected && injected[0];
  if (!frame) return null;
  /* A rejected script surfaces as a thrown executeScript error above. */
  if (frame.result === undefined) return null;
  return frame.result;
}

function normaliseResults(results) {
  if (!Array.isArray(results)) return null;
  var out = [];
  for (var i = 0; i < results.length; i++) {
    var entry = results[i];
    if (!entry || typeof entry !== "object") {
      out.push({ id: "?", ok: false, error: "No result came back." });
      continue;
    }
    out.push({
      id: typeof entry.id === "string" ? entry.id : "?",
      ok: entry.ok === true,
      error: typeof entry.error === "string" && entry.error ? entry.error : undefined,
    });
  }
  return out;
}

/* -------------------------------------------------------------------- the run */

async function handleApply(payload, requestId) {
  if (applyInFlight) {
    return {
      ok: false,
      requestId: requestId,
      error: "Another apply is already running. Wait for it to finish.",
    };
  }
  if (typeof msDescribeInvalidPayload !== "function" || typeof applyMockups !== "function") {
    return {
      ok: false,
      requestId: requestId,
      error:
        "The extension files did not load. Remove it in chrome://extensions and load the extension folder again.",
    };
  }
  var invalid = msDescribeInvalidPayload(payload);
  if (invalid) {
    return { ok: false, requestId: requestId, error: invalid };
  }

  applyInFlight = true;
  pendingPayload = payload;
  var tabId = null;
  try {
    var first = payload.products[0];
    var tab = await openBackgroundTab(productUrl(first.productId));
    tabId = tab.id;
    log("Opened the Printify tab for one product.");

    var loaded = await waitForTabLoad(tabId);
    if (!loaded) {
      return {
        ok: false,
        requestId: requestId,
        error: "The Printify tab closed before the images could be applied.",
      };
    }
    var host = hostnameOf(loaded.url);
    if (host !== PRINTIFY_HOST) {
      return {
        ok: false,
        requestId: requestId,
        error:
          "Printify did not stay on printify.com (it went to " +
          (host || "another page") +
          "). Sign in to Printify, then try again.",
      };
    }
    /* The SPA has to boot before localStorage.session and the XSRF cookie are
       readable - otherwise the apply would report a missing session. */
    await sleep(SETTLE_MS);

    /* `pendingPayload` is the one copy this worker holds; inject that. */
    var results = await runInTab(tabId, pendingPayload);
    var shaped = normaliseResults(results);
    if (!shaped) {
      return {
        ok: false,
        requestId: requestId,
        error: "Printify did not answer in a way this extension understands.",
      };
    }
    var applied = shaped.filter(function (r) { return r.ok; }).length;
    log("Apply finished: " + applied + " of " + shaped.length + " product(s).");
    return { ok: true, requestId: requestId, results: shaped };
  } catch (error) {
    log("Apply failed.");
    return { ok: false, requestId: requestId, error: describeError(error) };
  } finally {
    applyInFlight = false;
    pendingPayload = null; /* memory only, and not for one minute longer */
    closeTab(tabId);
  }
}

/* -------------------------------------------------------------- etsy research */

/**
 * An honest message when the page yielded no cards.
 *
 * "No results" is a different situation from "the page never rendered", and
 * the user can act on them differently. The diagnostics are deliberately
 * short: a page title, a URL and the first page-text fragment, never a dump.
 */
function etsyNoCardsMessage(page, attempts) {
  var diag = (page && page.diagnostics) || {};
  var checks = Math.min(attempts + 1, ETSY_POLL_ATTEMPTS);
  var title =
    page && page.pageTitle ? ' ("' + String(page.pageTitle).slice(0, 120) + '")' : "";
  var url = page && page.url ? " URL: " + String(page.url).slice(0, 180) + "." : "";
  var body = diag.bodyText
    ? ' Page text starts: "' + String(diag.bodyText).slice(0, 220) + '"'
    : "";

  if (diag.noResults) {
    return (
      "Etsy returned no results for this search. Try a broader or differently worded query." +
      url +
      body
    );
  }
  if (!diag.listingAnchorCount) {
    return (
      "The Etsy search page loaded" +
      title +
      " but no listing links appeared after " +
      checks +
      " check(s). Etsy may still be rendering, may be showing a verification wall, or may have changed its markup. Open etsy.com in a normal tab, finish any check, then try again." +
      url +
      body
    );
  }
  return (
    "Etsy showed " +
    diag.listingAnchorCount +
    " listing link(s) but no complete listing card could be read after " +
    checks +
    " check(s). Open etsy.com once and try again." +
    url +
    body
  );
}

function normaliseEtsyCards(listings) {
  if (!Array.isArray(listings)) return [];
  var out = [];
  for (var i = 0; i < listings.length && out.length < 48; i++) {
    var entry = listings[i];
    if (!entry || typeof entry !== "object") continue;
    var title =
      typeof entry.title === "string" ? entry.title.replace(/\s+/g, " ").trim() : "";
    if (title.length < 3) continue;
    var url =
      typeof entry.url === "string" &&
      /^https:\/\/([a-z0-9-]+\.)*etsy\.com\/listing\//i.test(entry.url)
        ? entry.url
        : "";
    out.push({
      title: title.slice(0, 300),
      priceText: typeof entry.priceText === "string" ? entry.priceText.slice(0, 40) : "",
      url: url,
    });
  }
  return out;
}

async function handleEtsyResearch(query, requestId) {
  if (etsyInFlight) {
    return {
      ok: false,
      requestId: requestId,
      error: "Another Etsy research request is already running. Wait for it to finish.",
    };
  }
  if (typeof scrapeEtsySearch !== "function") {
    return {
      ok: false,
      requestId: requestId,
      error:
        "The Etsy research code did not load. Remove the extension in chrome://extensions and load the folder again.",
    };
  }

  var clean = typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "";
  if (clean.length < 2 || clean.length > 120) {
    return {
      ok: false,
      requestId: requestId,
      error: "The Etsy query must be 2-120 characters.",
    };
  }

  etsyInFlight = true;
  var tabId = null;
  try {
    var tab = await openBackgroundTab(etsySearchUrl(clean));
    tabId = tab.id;
    log("Opened the Etsy search tab.");

    var loaded = await waitForTabLoad(tabId, ETSY_LOAD_TIMEOUT_MS);
    if (!loaded) {
      return {
        ok: false,
        requestId: requestId,
        error: "The Etsy tab closed before the search page could be read.",
      };
    }
    var host = hostnameOf(loaded.url);
    if (!isEtsyHost(host)) {
      return {
        ok: false,
        requestId: requestId,
        error:
          "Etsy did not stay on etsy.com (it went to " +
          (host || "another page") +
          "). Open etsy.com in this browser, then try again.",
      };
    }
    /* Etsy's search page is server-rendered, but the grid can still mount
       after `complete`. Poll, scroll to trigger lazy cards, and only report
       "no cards" after several honest attempts. */
    await sleep(ETSY_SETTLE_MS);

    var page = null;
    var attempts = 0;
    for (; attempts < ETSY_POLL_ATTEMPTS; attempts++) {
      var injected = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "ISOLATED",
        func: scrapeEtsySearch,
      });
      var frame = injected && injected[0];
      page = frame && frame.result;
      if (!page || page.ok !== true) break;
      if (page.blocked) break;
      if (Array.isArray(page.listings) && page.listings.length > 0) break;
      if (page.diagnostics && page.diagnostics.noResults) break;
      if (attempts < ETSY_POLL_ATTEMPTS - 1) {
        await nudgeEtsyScroll(tabId);
        await sleep(ETSY_POLL_MS);
      }
    }

    if (!page || page.ok !== true) {
      return {
        ok: false,
        requestId: requestId,
        error: "Etsy did not answer in a way this extension understands.",
      };
    }
    if (page.blocked) {
      return { ok: false, requestId: requestId, error: page.blocked, blocked: page.blocked };
    }

    var cards = normaliseEtsyCards(page.listings);
    if (!cards.length) {
      var why = etsyNoCardsMessage(page, attempts);
      log("Etsy research found no cards.");
      return { ok: false, requestId: requestId, error: why };
    }
    log("Etsy research finished: " + cards.length + " card(s).");
    return { ok: true, requestId: requestId, cards: cards };
  } catch (error) {
    log("Etsy research failed.");
    return { ok: false, requestId: requestId, error: describeError(error) };
  } finally {
    etsyInFlight = false;
    closeTab(tabId);
  }
}

/* ------------------------------------------------------------------ messages */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || (message.type !== MS_APPLY && message.type !== MS_ETSY_RESEARCH)) {
    return undefined; /* not ours */
  }
  var requestId = typeof message.requestId === "string" ? message.requestId : null;
  var work =
    message.type === MS_APPLY
      ? handleApply(message.payload, requestId)
      : handleEtsyResearch(message.query, requestId);

  work
    .then(function (response) {
      try {
        sendResponse(response);
      } catch (e) {}
    })
    .catch(function (error) {
      try {
        sendResponse({ ok: false, requestId: requestId, error: describeError(error) });
      } catch (e) {}
    });
  return true; /* the response is async */
});

chrome.runtime.onInstalled.addListener(function () {
  log("Installed. Open Mockup Studio and use Send to Printify.");
});
