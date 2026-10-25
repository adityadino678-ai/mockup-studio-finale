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

/* Two files, both required at runtime and both plain JS:
   - payload-guard.js   the payload contract, shared with the content script;
   - printify-apply.js  the function injected into the printify.com tab. */
["payload-guard.js", "printify-apply.js"].forEach((file) => {
  try {
    importScripts(file);
  } catch (e) {
    /* Reported honestly when an apply is requested rather than ignored. */
  }
});

var MS_APPLY = "MS_APPLY";
var PRINTIFY_HOST = "printify.com";

/* How long to wait for the printify.com tab to load, how often to look, and how
   long to let the SPA mount before injecting: the session lives in
   localStorage once the app has booted. */
var LOAD_TIMEOUT_MS = 20000;
var LOAD_POLL_MS = 250;
var SETTLE_MS = 1500;

/* The payload for the apply that is running right now, in memory only. */
var pendingPayload = null;
var applyInFlight = false;

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

/* ------------------------------------------------------------ the printify tab */

async function openPrintifyTab(url) {
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

async function waitForTabLoad(tabId) {
  var deadline = Date.now() + LOAD_TIMEOUT_MS;
  for (;;) {
    var tab = await readTab(tabId);
    if (!tab) return null;
    if (tab.status === "complete") return tab;
    if (Date.now() >= deadline) return tab; /* try anyway; the apply says why it failed */
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
    var tab = await openPrintifyTab(productUrl(first.productId));
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

/* ------------------------------------------------------------------ messages */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== MS_APPLY) return undefined; /* not ours */
  var requestId = typeof message.requestId === "string" ? message.requestId : null;
  handleApply(message.payload, requestId)
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
