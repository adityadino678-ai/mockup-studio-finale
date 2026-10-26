/* ---------------------------------------------------------------------------
 * offline-check-sw.mjs - runs the service worker end to end, in Node.
 *
 * No browser, no dependencies. It concatenates `payload-guard.js`,
 * `printify-apply.js` and `background.js` the way the browser loads them
 * (one classic script scope, `importScripts` already satisfied), gives them a
 * stubbed `chrome` API - tabs.create/get/update/remove, scripting.executeScript
 * that really calls the injected function, runtime.onMessage - and then sends
 * real `MS_APPLY` messages and asserts what happened.
 *
 * Run it by hand:
 *
 *   node extension/tools/offline-check-sw.mjs
 *
 * If this passes, the message -> validate -> background tab -> inject -> result
 * -> close-tab chain works, and nothing touches chrome.storage.
 * ------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const read = (name) => readFileSync(join(ext, name), "utf8");

/* --------------------------------------------------------------- the stub */

function makeChrome() {
  const state = {
    tabs: new Map(),
    nextId: 1,
    created: [],
    updated: [],
    removed: [],
    executed: [],
    storageTouched: [],
  };
  const chrome = {
    tabs: {
      create: async (options) => {
        const tab = { id: state.nextId++, url: options.url, status: "loading", active: options.active !== false };
        state.tabs.set(tab.id, tab);
        state.created.push({ id: tab.id, url: options.url, active: options.active });
        /* The browser resolves the URL a moment later. */
        setTimeout(() => {
          const live = state.tabs.get(tab.id);
          if (live) {
            live.status = "complete";
            /* Etsy search URLs stay as they are; a product URL resolves to
               Printify's SPA route. */
            if (String(live.url).indexOf("https://www.etsy.com/") !== 0) {
              live.url = "https://printify.com/app/products/" + String(live.url).split("/").pop();
            }
          }
        }, 5);
        return Object.assign({}, tab);
      },
      get: async (tabId) => {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error("No tab with id " + tabId);
        return Object.assign({}, tab);
      },
      update: async (tabId, options) => {
        state.updated.push(Object.assign({ id: tabId }, options));
        const tab = state.tabs.get(tabId);
        if (tab && options.active === false) tab.active = false;
        return tab ? Object.assign({}, tab) : undefined;
      },
      remove: (tabId, callback) => {
        state.removed.push(tabId);
        state.tabs.delete(tabId);
        if (typeof callback === "function") callback();
      },
    },
    scripting: {
      executeScript: async (options) => {
        state.executed.push({
          world: options.world,
          tabId: options.target.tabId,
          argCount: Array.isArray(options.args) ? options.args.length : 0,
        });
        const result = await options.func.apply(null, options.args || []);
        return [{ result }];
      },
    },
    /* If the worker ever reaches for chrome.storage, that is a bug: record it. */
    storage: new Proxy(
      {},
      {
        get(_target, prop) {
          state.storageTouched.push(String(prop));
          return () => {};
        },
      },
    ),
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { state.listener = fn; } },
      onInstalled: { addListener: (fn) => { state.onInstalled = fn; } },
    },
  };
  return { chrome, state };
}

/** Loads the three files as one classic script and returns its message listener. */
function makeWorker() {
  const { chrome, state } = makeChrome();
  const combined = ["payload-guard.js", "printify-apply.js", "etsy-research.js", "background.js"]
    .map((name) => read(name))
    .join("\n;\n");
  /* `new Function` gives one function scope for the three files; `importScripts`
     is a no-op because their code is already in that scope. */
  new Function("importScripts", "chrome", "console", "setTimeout", combined)(
    () => {},
    chrome,
    console,
    setTimeout,
  );
  if (!state.listener) throw new Error("background.js never registered a message listener");
  return { chrome, state };
}

/** Sends one message and resolves with the response. */
function send(state, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response from background.js")), 20000);
    state.listener(message, { tab: { id: 99, url: "https://mockup-studio.adityadino678.workers.dev/listing-images" } }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/* --------------------------------------------------- the browser globals */

const session = { user_id: "user-1", access_token: "token-1" };
globalThis.location = { hostname: "printify.com" };
globalThis.localStorage = { getItem: (key) => (key === "session" ? JSON.stringify(session) : null) };
globalThis.sessionStorage = { getItem: () => null };
globalThis.document = { cookie: "XSRF-TOKEN=csrf-1" };

let fetched = [];
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const entry = { url: String(url), method, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined };
  fetched.push(entry);
  if (method === "GET") {
    return { ok: true, status: 200, json: async () => ({ groups: [], selected_mockups: {} }), text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
};

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}

const upload = (id) => ({ libraryId: `l-${id}`, mockupId: id, src: `https://cdn/${id}.png`, filename: `${id}.png` });
const payloadOf = (products) => ({ source: "mockup-studio", version: 1, createdAt: "2026-10-25T00:00:00.000Z", products });

/* ------------------------------------------------------------------ runs */

console.log("a real apply message");
{
  const { state } = makeWorker();
  fetched = [];
  const response = await send(state, {
    type: "MS_APPLY",
    payload: payloadOf([
      { shopId: 7, productId: "prod-1", productTitle: "Tee", uploads: [upload("m1"), upload("m2")] },
      { shopId: 7, productId: "prod-2", productTitle: "Mug", uploads: [upload("m3")] },
    ]),
    requestId: "req-1",
  });

  check("answered through sendResponse", Boolean(response) && typeof response === "object", JSON.stringify(response));
  check("answered ok", response.ok === true, JSON.stringify(response));
  check("carried the requestId", response.requestId === "req-1");
  check("returned one result per product", Array.isArray(response.results) && response.results.length === 2, JSON.stringify(response.results));
  check("both products applied", response.results.every((r) => r.ok === true), JSON.stringify(response.results));
  check("no error string on success", response.error === undefined);

  check("opened a printify.com tab", state.created.length === 1 && /^https:\/\/printify\.com\/app\/products\/prod-1$/.test(state.created[0].url), JSON.stringify(state.created));
  check("opened it in the background", state.created[0].active === false, JSON.stringify(state.created[0]));
  check("asked for inactive again", state.updated.some((u) => u.active === false));
  check("closed the tab afterwards", state.removed.length === 1 && state.tabs.size === 0, JSON.stringify(state.removed));
  check("did not touch chrome.storage", state.storageTouched.length === 0, state.storageTouched.join(","));

  check("injected once, in the isolated world", state.executed.length === 1 && state.executed[0].world === "ISOLATED");
  check("injected with the payload as an argument", state.executed[0].argCount === 1);
  check("injected into the printify tab", state.executed[0].tabId === 1);
  check("read the layout for each product", fetched.filter((f) => f.method === "GET").length === 2, `${fetched.length} calls`);
  check("put the merged selection", fetched.filter((f) => f.method === "PUT").length === 2);
  check("sent the XSRF header", fetched[0].headers["X-XSRF-TOKEN"] === "csrf-1");
}

console.log("an Etsy research request");
{
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const heading = (text) => ({ textContent: text });
  function anchor(href, title, price) {
    const h = heading(title);
    const a = {
      href,
      textContent: title + " " + price,
      getAttribute: () => null,
      querySelector: (selector) => (String(selector).indexOf("h2") >= 0 ? h : null),
      parentElement: null,
    };
    const card = {
      textContent: title + " " + price,
      querySelector: (selector) => (String(selector).indexOf("h2") >= 0 ? h : null),
      querySelectorAll: () => [a],
      parentElement: null,
    };
    a.parentElement = card;
    return a;
  }
  const anchors = [
    anchor("https://www.etsy.com/listing/1/cat-mug?ref=search", "Personalized Cat Mug", "$24.99"),
    anchor("https://www.etsy.com/listing/2/cat-shirt", "Cat Mom Shirt", "US$32.50"),
    anchor("https://www.etsy.com/listing/1/cat-mug?ref=again", "Duplicate", "$24.99"),
  ];
  globalThis.document = {
    cookie: "XSRF-TOKEN=csrf-1",
    title: "cat mug | Etsy",
    body: { innerText: "Results for cat mug" },
    querySelectorAll: () => anchors,
  };
  globalThis.location = {
    hostname: "www.etsy.com",
    href: "https://www.etsy.com/search?q=cat+mug",
  };

  const { state } = makeWorker();
  fetched = [];
  const response = await send(state, {
    type: "MS_ETSY_RESEARCH",
    query: "cat mug",
    requestId: "etsy-1",
  });

  check("answered ok", response.ok === true, JSON.stringify(response));
  check("carried the requestId", response.requestId === "etsy-1");
  check(
    "returned the cards",
    Array.isArray(response.cards) && response.cards.length === 2,
    JSON.stringify(response.cards),
  );
  check(
    "de-duplicated the same listing",
    response.cards.filter((c) => c.url.indexOf("/listing/1/") >= 0).length === 1,
    JSON.stringify(response.cards),
  );
  check("kept the title", response.cards[0].title === "Personalized Cat Mug", JSON.stringify(response.cards[0]));
  check("kept the price text", response.cards[0].priceText === "$24.99", JSON.stringify(response.cards[0]));
  check(
    "opened the Etsy search page",
    state.created.length === 1 && state.created[0].url === "https://www.etsy.com/search?q=cat%20mug",
    JSON.stringify(state.created),
  );
  check("opened it in the background", state.created[0].active === false);
  check("closed the tab afterwards", state.removed.length === 1 && state.tabs.size === 0);
  check("injected the scraper once", state.executed.length === 1 && state.executed[0].world === "ISOLATED");
  check("did not touch chrome.storage", state.storageTouched.length === 0);

  globalThis.document = originalDocument;
  globalThis.location = originalLocation;
}

console.log("an Etsy verification page");
{
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  globalThis.document = {
    cookie: "",
    title: "Just a moment...",
    body: { innerText: "Enable JavaScript and cookies to continue" },
    querySelectorAll: () => [],
  };
  globalThis.location = {
    hostname: "www.etsy.com",
    href: "https://www.etsy.com/search?q=cat",
  };

  const { state } = makeWorker();
  const response = await send(state, {
    type: "MS_ETSY_RESEARCH",
    query: "cat",
    requestId: "etsy-2",
  });
  check("refused the verification page", response.ok === false, JSON.stringify(response));
  check("said what to do", /verification page/i.test(response.error || ""), response.error);
  check("closed the tab", state.removed.length === 1);

  globalThis.document = originalDocument;
  globalThis.location = originalLocation;
}

console.log("an Etsy query that is too short");
{
  const { state } = makeWorker();
  const response = await send(state, {
    type: "MS_ETSY_RESEARCH",
    query: "x",
    requestId: "etsy-3",
  });
  check("refused", response.ok === false && /2-120/.test(response.error || ""), JSON.stringify(response));
  check("opened no tab", state.created.length === 0);
}

console.log("a foreign payload");
{
  const { state } = makeWorker();
  const response = await send(state, {
    type: "MS_APPLY",
    payload: { source: "not-mockup-studio", version: 1, products: [] },
    requestId: "req-2",
  });
  check("refused", response.ok === false, JSON.stringify(response));
  check("opened no tab", state.created.length === 0);
  check("injected nothing", state.executed.length === 0);
  check("closed nothing", state.removed.length === 0);
}

console.log("a payload with no products");
{
  const { state } = makeWorker();
  const response = await send(state, { type: "MS_APPLY", payload: payloadOf([]), requestId: "req-3" });
  check("refused", response.ok === false && /no products/i.test(response.error || ""), JSON.stringify(response));
  check("opened no tab", state.created.length === 0);
}

console.log("a payload with a malformed product");
{
  const { state } = makeWorker();
  const response = await send(state, {
    type: "MS_APPLY",
    payload: payloadOf([{ shopId: 0, productId: "p", productTitle: "t", uploads: [] }]),
    requestId: "req-4",
  });
  check("refused", response.ok === false, JSON.stringify(response));
  check("opened no tab", state.created.length === 0);
}

console.log("messages that are not ours");
{
  const { state } = makeWorker();
  let ignored = 0;
  /* The listener returns `true` only for the messages it means to answer. */
  const before = state.listener({ type: "SOMETHING_ELSE" }, {}, () => { ignored++ });
  check("returns nothing for a foreign message", before === undefined, String(before));
  check("and never answers it", ignored === 0);
}

console.log("an install");
{
  const { state } = makeWorker();
  check("registers an install listener", typeof state.onInstalled === "function");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
