/* ---------------------------------------------------------------------------
 * offline-check-content.mjs - checks the app-facing half of the bridge.
 *
 * Loads `payload-guard.js` + `content-app.js` the way the browser loads them
 * and gives them a fake `window`/`document`/`location`/`chrome`, then dispatches
 * the real page events from `extension/protocol.md` and asserts what the page
 * would see. No browser, no dependencies.
 *
 * Run it by hand:
 *
 *   node extension/tools/offline-check-content.mjs
 * ------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const read = (name) => readFileSync(join(ext, name), "utf8");

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}

/** A window that remembers its listeners and what was dispatched on it. */
function makeWindow() {
  const listeners = new Map();
  const dispatched = [];
  const attributes = new Map();
  const element = {
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
  };
  const win = {
    listeners,
    dispatched,
    element,
    documentElement: element,
    body: element,
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent: (event) => {
      dispatched.push({ type: event.type, detail: event.detail });
      const handlers = listeners.get(event.type) || [];
      handlers.forEach((handler) => handler(event));
      return true;
    },
  };
  return win;
}

function load(win, location, chrome) {
  const combined = ["payload-guard.js", "content-app.js"].map((name) => read(name)).join("\n;\n");
  class MutationObserver {
    observe() {}
  }
  new Function(
    "window",
    "document",
    "location",
    "chrome",
    "console",
    "CustomEvent",
    "MutationObserver",
    "Math",
    combined,
  )(win, win, location, chrome, console, CustomEvent, MutationObserver, Math);
}

const upload = (id) => ({ libraryId: `l-${id}`, mockupId: id, src: `https://cdn/${id}.png`, filename: `${id}.png` });
const APP_ORIGIN = "https://mockup-studio.adityadino678.workers.dev";

/* ------------------------------------------------------------------ runs */

console.log("on the app origin");
{
  const win = makeWindow();
  const messages = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        messages.push(message);
        callback({ ok: true, requestId: message.requestId, results: [{ id: "p1", ok: true }, { id: "p2", ok: false, error: "HTTP 500" }] });
      },
    },
  };
  load(win, { origin: APP_ORIGIN, hostname: "mockup-studio.adityadino678.workers.dev", protocol: "https:" }, chrome);

  check("marks the page", win.documentElement.getAttribute("data-mockup-studio-ext") === "1");
  check("announces itself once", win.dispatched.filter((e) => e.type === "mockup-studio:extension-ready").length === 1);
  check("listens for apply requests", (win.listeners.get("mockup-studio:apply-request") || []).length === 1);

  const payload = {
    source: "mockup-studio",
    version: 1,
    createdAt: "2026-10-25T00:00:00.000Z",
    products: [{ shopId: 7, productId: "prod-1", productTitle: "Tee", uploads: [upload("m1")] }],
  };
  win.dispatchEvent(
    new CustomEvent("mockup-studio:apply-request", { detail: { payload, requestId: "req-9" } }),
  );

  check("forwarded exactly one message", messages.length === 1, `${messages.length}`);
  check("forwarded it as MS_APPLY", messages[0].type === "MS_APPLY");
  check("forwarded the payload untouched", messages[0].payload === payload);
  check("forwarded the requestId", messages[0].requestId === "req-9");
  check("sent no credentials", JSON.stringify(messages[0]).indexOf("token") === -1);

  const results = win.dispatched.filter((e) => e.type === "mockup-studio:apply-result");
  check("relaid the result", results.length === 1);
  check("relaid the requestId", results[0].detail.requestId === "req-9");
  check("relaid ok", results[0].detail.ok === true);
  check("relaid the per-product results", Array.isArray(results[0].detail.results) && results[0].detail.results.length === 2);
  check("kept the error text of a failed product", results[0].detail.results[1].error === "HTTP 500");
}

console.log("a failing run");
{
  const win = makeWindow();
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => callback({ ok: false, error: "Printify did not open." }),
    },
  };
  load(win, { origin: APP_ORIGIN, hostname: "mockup-studio.adityadino678.workers.dev", protocol: "https:" }, chrome);
  const payload = {
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 7, productId: "prod-1", productTitle: "Tee", uploads: [upload("m1")] }],
  };
  win.dispatchEvent(new CustomEvent("mockup-studio:apply-request", { detail: { payload, requestId: "req-10" } }));

  const errors = win.dispatched.filter((e) => e.type === "mockup-studio:apply-error");
  check("dispatched apply-error", errors.length === 1, JSON.stringify(win.dispatched));
  check("with the requestId", errors[0].detail.requestId === "req-10");
  check("with the reason", /Printify did not open/.test(errors[0].detail.error || ""), errors[0].detail.error);
  check("and no apply-result", win.dispatched.filter((e) => e.type === "mockup-studio:apply-result").length === 0);
}

console.log("the extension cannot be reached");
{
  const win = makeWindow();
  const chrome = {
    runtime: {
      lastError: { message: "Could not establish connection." },
      sendMessage: (message, callback) => callback(undefined),
    },
  };
  load(win, { origin: APP_ORIGIN, hostname: "mockup-studio.adityadino678.workers.dev", protocol: "https:" }, chrome);
  const payload = {
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 7, productId: "prod-1", productTitle: "Tee", uploads: [upload("m1")] }],
  };
  win.dispatchEvent(new CustomEvent("mockup-studio:apply-request", { detail: { payload } }));

  const errors = win.dispatched.filter((e) => e.type === "mockup-studio:apply-error");
  check("reported the unreachable extension", errors.length === 1 && /Could not establish connection/.test(errors[0].detail.error || ""), JSON.stringify(errors));
  check("invented a requestId so the page can match it", typeof errors[0].detail.requestId === "string" && errors[0].detail.requestId.length > 0);
}

console.log("refusing what is not a payload");
{
  const win = makeWindow();
  const messages = [];
  const chrome = {
    runtime: { lastError: null, sendMessage: (message, callback) => { messages.push(message); callback({ ok: true, results: [] }); } },
  };
  load(win, { origin: APP_ORIGIN, hostname: "mockup-studio.adityadino678.workers.dev", protocol: "https:" }, chrome);
  const before = win.dispatched.length;

  win.dispatchEvent(new CustomEvent("mockup-studio:apply-request", { detail: { payload: { source: "other" }, requestId: "r" } }));
  const after = win.dispatched.filter((e) => e.type === "mockup-studio:apply-error");
  check("foreign payload refused", after.length === 1 && after[0].detail.requestId === "r", JSON.stringify(win.dispatched.slice(before)));
  check("nothing forwarded", messages.length === 0);

  win.dispatchEvent(new CustomEvent("mockup-studio:apply-request", { detail: { nested: { tokens: true } } }));
  check("a non-payload detail is refused too", messages.length === 0);

  win.dispatchEvent(new CustomEvent("mockup-studio:apply-request", { detail: undefined }));
  check("a detail-less event is ignored", messages.length === 0);
}

console.log("a page it was not meant for");
{
  const win = makeWindow();
  const messages = [];
  const chrome = {
    runtime: { lastError: null, sendMessage: (message) => { messages.push(message); } },
  };
  load(win, { origin: "https://example.com", hostname: "example.com", protocol: "https:" }, chrome);
  check("did not mark the page", win.documentElement.getAttribute("data-mockup-studio-ext") === null);
  check("did not announce", win.dispatched.length === 0);
  check("did not listen", (win.listeners.get("mockup-studio:apply-request") || []).length === 0);
}

console.log("localhost is an app origin");
{
  const win = makeWindow();
  let answered = 0;
  const chrome = {
    runtime: { lastError: null, sendMessage: (message, callback) => { answered++; callback({ ok: true, results: [] }); } },
  };
  load(win, { origin: "http://localhost:3000", hostname: "localhost", protocol: "http:" }, chrome);
  check("marked the page", win.documentElement.getAttribute("data-mockup-studio-ext") === "1");
  const payload = {
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 7, productId: "prod-1", productTitle: "Tee", uploads: [upload("m1")] }],
  };
  win.dispatchEvent(new CustomEvent("mockup-studio:apply-request", { detail: { payload } }));
  check("forwarded a request from localhost", answered === 1);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
