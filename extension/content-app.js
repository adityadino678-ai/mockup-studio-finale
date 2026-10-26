/* ---------------------------------------------------------------------------
 * content-app.js - runs on the Mockup Studio app origins only
 * (manifest.json content_scripts matches: the workers.dev deployment,
 * localhost and 127.0.0.1). It is the app's side of the bridge.
 *
 * It marks the page so the app can see the extension is installed, listens for
 * the page's `mockup-studio:apply-request` event, validates the payload, and
 * hands it to the service worker - which does the Printify work in a background
 * printify.com tab. The result (or the failure) is dispatched straight back to
 * the page.
 *
 * It also forwards `mockup-studio:etsy-research-request` as `MS_ETSY_RESEARCH`,
 * so the app can fall back to the public Etsy search page when no Etsy API key
 * is configured. That path carries a query string only.
 *
 * It reads nothing else from the page: no tokens, no crypto, no storage. The
 * page hands over a payload that was already built from ids, URLs, filenames
 * and titles, and this file only checks that it really is that payload.
 * ------------------------------------------------------------------------- */

"use strict";

(function () {
  var MARKER_ATTR = "data-mockup-studio-ext";
  var MARKER_PROTOCOL_ATTR = "data-mockup-studio-ext-protocol";
  var MARKER_ETSY_ATTR = "data-mockup-studio-ext-etsy";
  var MARKER_VERSION_ATTR = "data-mockup-studio-ext-version";
  /* Protocol 2 = replacement apply (the payload's `replace` flag) and Etsy
     research. The app refuses an older build instead of letting it merge
     mockups or wait for an Etsy answer that will never arrive. */
  var PROTOCOL = 2;
  var EVENT_READY = "mockup-studio:extension-ready";
  var EVENT_REQUEST = "mockup-studio:apply-request";
  var EVENT_RESULT = "mockup-studio:apply-result";
  var EVENT_ERROR = "mockup-studio:apply-error";
  var EVENT_ETSY_REQUEST = "mockup-studio:etsy-research-request";
  var EVENT_ETSY_RESULT = "mockup-studio:etsy-research-result";
  var EVENT_ETSY_ERROR = "mockup-studio:etsy-research-error";
  var MS_APPLY = "MS_APPLY";
  var MS_ETSY_RESEARCH = "MS_ETSY_RESEARCH";

  function originAllowed() {
    if (location.origin === "https://mockup-studio.adityadino678.workers.dev") return true;
    if (location.protocol !== "http:") return false;
    var host = location.hostname;
    return host === "localhost" || host === "127.0.0.1";
  }

  /* Origin check first: if this file ever ended up on a page it was not meant
     for, it does nothing at all. The manifest matches already do this. */
  if (!originAllowed()) return;

  function log() {
    var parts = ["[Mockup Studio Printify Bridge]"];
    for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
    try {
      console.log.apply(console, parts);
    } catch (e) {}
  }

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version || "";
    } catch (e) {
      return "";
    }
  }

  function markPresence() {
    try {
      if (document.documentElement) {
        document.documentElement.setAttribute(MARKER_ATTR, "1");
        document.documentElement.setAttribute(MARKER_PROTOCOL_ATTR, String(PROTOCOL));
        document.documentElement.setAttribute(MARKER_ETSY_ATTR, "1");
        document.documentElement.setAttribute(MARKER_VERSION_ATTR, extensionVersion());
      }
      if (document.body) document.body.setAttribute(MARKER_ATTR, "1");
    } catch (e) {}
  }

  function announce() {
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_READY, {
          detail: {
            version: PROTOCOL,
            protocol: PROTOCOL,
            etsy: true,
            extensionVersion: extensionVersion(),
            marker: MARKER_ATTR,
          },
        }),
      );
    } catch (e) {}
  }

  function emitError(requestId, error) {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_ERROR, { detail: { requestId: requestId, error: error } }));
    } catch (e) {}
  }

  function emitResult(requestId, results) {
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_RESULT, { detail: { ok: true, requestId: requestId, results: results } }),
      );
    } catch (e) {}
  }

  function emitEtsyResult(requestId, cards) {
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_ETSY_RESULT, { detail: { ok: true, requestId: requestId, cards: cards } }),
      );
    } catch (e) {}
  }

  function emitEtsyError(requestId, error) {
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_ETSY_ERROR, { detail: { requestId: requestId, error: error } }),
      );
    } catch (e) {}
  }

  function requestIdOf(detail) {
    if (detail && typeof detail.requestId === "string" && detail.requestId) return detail.requestId;
    if (detail && (typeof detail.requestId === "number" || typeof detail.requestId === "string")) {
      return String(detail.requestId);
    }
    return "ms-" + Math.random().toString(36).slice(2, 10);
  }

  function onApplyRequest(event) {
    var detail = event && event.detail;
    if (!detail || typeof detail !== "object") return; /* nothing to forward */

    var payload = detail.payload;
    var requestId = requestIdOf(detail);

    /* Only the Mockup Studio payload contract is forwarded - never arbitrary
       data from the page. */
    var invalid =
      typeof msDescribeInvalidPayload === "function" ? msDescribeInvalidPayload(payload) : "The extension is not installed correctly. Load the extension folder again.";
    if (invalid) {
      log("Refused a request: " + invalid);
      emitError(requestId, "Mockup Studio Bridge: " + invalid);
      return;
    }

    var message = { type: MS_APPLY, payload: payload, requestId: requestId };
    try {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          var why = chrome.runtime.lastError.message || "the extension could not be reached";
          emitError(requestId, "Mockup Studio Bridge: " + why);
          return;
        }
        if (!response || typeof response !== "object") {
          emitError(requestId, "Mockup Studio Bridge: no answer from the extension.");
          return;
        }
        if (response.ok !== true || !Array.isArray(response.results)) {
          emitError(
            requestId,
            typeof response.error === "string" && response.error
              ? "Mockup Studio Bridge: " + response.error
              : "Mockup Studio Bridge could not apply the images.",
          );
          return;
        }
        emitResult(requestId, response.results);
      });
    } catch (error) {
      var message_ = "Mockup Studio Bridge: " + (error && error.message ? error.message : "could not reach the extension");
      emitError(requestId, message_);
    }
  }

  function onEtsyResearchRequest(event) {
    var detail = event && event.detail;
    if (!detail || typeof detail !== "object") return; /* nothing to forward */

    var query =
      typeof detail.query === "string" ? detail.query.replace(/\s+/g, " ").trim() : "";
    var requestId = requestIdOf(detail);

    /* A query is the only thing this path accepts. It is length-checked so the
       extension never opens a tab for an empty or absurdly long string. */
    if (query.length < 2 || query.length > 120) {
      emitEtsyError(
        requestId,
        "Mockup Studio Bridge: the Etsy query must be 2-120 characters.",
      );
      return;
    }

    try {
      chrome.runtime.sendMessage(
        { type: MS_ETSY_RESEARCH, query: query, requestId: requestId },
        function (response) {
          if (chrome.runtime.lastError) {
            var why = chrome.runtime.lastError.message || "the extension could not be reached";
            emitEtsyError(requestId, "Mockup Studio Bridge: " + why);
            return;
          }
          if (!response || typeof response !== "object") {
            emitEtsyError(requestId, "Mockup Studio Bridge: no answer from the extension.");
            return;
          }
          if (response.ok !== true || !Array.isArray(response.cards)) {
            emitEtsyError(
              requestId,
              typeof response.error === "string" && response.error
                ? "Mockup Studio Bridge: " + response.error
                : "Mockup Studio Bridge could not read Etsy.",
            );
            return;
          }
          emitEtsyResult(requestId, response.cards);
        },
      );
    } catch (error) {
      emitEtsyError(
        requestId,
        "Mockup Studio Bridge: " +
          (error && error.message ? error.message : "could not reach the extension"),
      );
    }
  }

  /* Presence, announced now and kept marked if the app rebuilds the DOM. */
  markPresence();
  announce();

  window.addEventListener(EVENT_REQUEST, onApplyRequest);
  window.addEventListener(EVENT_ETSY_REQUEST, onEtsyResearchRequest);

  try {
    var observer = new MutationObserver(function () {
      if (!document.documentElement.getAttribute(MARKER_ATTR)) {
        markPresence();
        announce();
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [MARKER_ATTR] });
  } catch (e) {}

  log("Ready on " + location.origin + ".");
})();
