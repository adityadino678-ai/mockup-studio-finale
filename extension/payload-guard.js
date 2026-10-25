/* ---------------------------------------------------------------------------
 * payload-guard.js - what a Mockup Studio payload is, in one place.
 *
 * Loaded twice, unchanged:
 *   - by the service worker (`importScripts` in background.js), so the
 *     extension only ever accepts a real Mockup Studio bridge payload; and
 *   - as a content script on the app origins (manifest.json), so the page's
 *     request is checked before it is forwarded anywhere.
 *
 * The shape mirrors `src/lib/printify/mockup-bridge.ts`:
 *
 *   { source: "mockup-studio", version: 1, createdAt: string,
 *     products: [ { shopId: number, productId: string, productTitle: string,
 *                   uploads: [ { libraryId, mockupId, src, filename } ] } ] }
 *
 * It carries ids, URLs, filenames and titles. It NEVER carries a Printify API
 * key, an access token or any other credential, and this guard is the only
 * thing the extension accepts.
 *
 * Plain JS, no dependencies. `var`/function declarations on purpose: both the
 * service worker and the isolated world evaluate these as classic scripts and
 * share one global scope.
 * ------------------------------------------------------------------------- */

"use strict";

/* Printify's own ids are 24-char hex, but the app tolerates the wider
   `[A-Za-z0-9_-]{1,64}` the bookmarklet uses, so a payload the app produced is
   never rejected by a stricter rule here. */
var MS_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function msIsUpload(u) {
  if (!u || typeof u !== "object") return false;
  if (typeof u.mockupId !== "string" || !MS_ID_PATTERN.test(u.mockupId)) return false;
  /* `https://` only: a tampered payload cannot smuggle in `javascript:` or a
     `data:` URL, and Printify only serves uploaded mockup images over https. */
  if (typeof u.src !== "string" || u.src.indexOf("https://") !== 0) return false;
  if (typeof u.libraryId !== "string" || typeof u.filename !== "string") return false;
  return true;
}

function msIsProduct(p) {
  if (!p || typeof p !== "object") return false;
  if (typeof p.shopId !== "number" || !isFinite(p.shopId) || p.shopId <= 0) return false;
  if (typeof p.productId !== "string" || !MS_ID_PATTERN.test(p.productId)) return false;
  if (typeof p.productTitle !== "string") return false;
  if (!Array.isArray(p.uploads) || p.uploads.length === 0) return false;
  for (var i = 0; i < p.uploads.length; i++) {
    if (!msIsUpload(p.uploads[i])) return false;
  }
  return true;
}

/**
 * Returns null when `payload` is a Mockup Studio bridge payload, or a short
 * human-readable reason why it is not. Never throws.
 */
function msDescribeInvalidPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "That is not a Mockup Studio payload.";
  }
  if (payload.source !== "mockup-studio") {
    return "That is not a Mockup Studio payload.";
  }
  if (payload.version !== 1) {
    return "Unsupported payload version " + String(payload.version) + ".";
  }
  if (!Array.isArray(payload.products) || payload.products.length === 0) {
    return "The payload has no products.";
  }
  if (payload.products.length > 25) {
    return "The payload has too many products for one run.";
  }
  for (var i = 0; i < payload.products.length; i++) {
    if (!msIsProduct(payload.products[i])) {
      return "Product " + (i + 1) + " in the payload is not complete.";
    }
  }
  return null;
}

/** A result entry as the injected Printify apply returns it. */
function msIsResultEntry(entry) {
  return Boolean(entry) && typeof entry === "object" && typeof entry.ok === "boolean";
}
