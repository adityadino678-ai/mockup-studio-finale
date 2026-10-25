/* ---------------------------------------------------------------------------
 * offline-check.mjs - a hand-runnable check of the ported Printify logic.
 *
 * NOT part of any build, no dependencies, and it needs no browser: it loads
 * `../printify-apply.js` exactly the way `chrome.scripting.executeScript`
 * loads it (the function is taken by source), gives it stubbed browser globals
 * (location, localStorage, sessionStorage, document.cookie, fetch) and asserts
 * the ported bookmarklet behaviour: the merge order, the `not_linked` group,
 * the 429 backoff, the 401 Bearer retry, and the no-UI decisions.
 *
 * Run it by hand:
 *
 *   node extension/tools/offline-check.mjs
 *
 * If this passes, the port still behaves like the bookmarklet it replaced.
 * ------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "printify-apply.js"), "utf8");

/* The same load path as the service worker: the file is a classic script, so
   grab its top-level function by evaluating it and returning it. */
const applyMockups = new Function(`${source}\nreturn applyMockups;`)();

/* ------------------------------------------------------------------ stubs */

const session = { user_id: "user-123", access_token: "token-abc" };
const cookieJar = "XSRF-TOKEN=csrf-token%20123";

function makeEnvironment({ hostname = "printify.com", fetchImpl } = {}) {
  globalThis.location = { hostname };
  globalThis.localStorage = { getItem: (key) => (key === "session" ? JSON.stringify(session) : null) };
  globalThis.sessionStorage = { getItem: () => null };
  globalThis.document = { cookie: cookieJar };
  globalThis.fetch = fetchImpl;
}

/** Records every request and answers from a queue / callback. */
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const entry = {
      url: String(url),
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(entry);
    return handler(entry, calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}

/* --------------------------------------------------------------- assertions */

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => "" };
}

/* -------------------------------------------------------------------- tests */

async function testHostGuard() {
  console.log("hostname guard");
  const fetchImpl = makeFetch(() => jsonResponse({}));
  makeEnvironment({ hostname: "www.printify.com", fetchImpl });
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "abc", productTitle: "T", uploads: [upload("m1")] }],
  });
  check("returns a structured result instead of fetching", results.length === 1 && results[0].ok === false);
  check("names the host it refused", /www\.printify\.com/.test(results[0].error || ""));
  check("made no request", fetchImpl.calls.length === 0);
}

async function testMissingSession() {
  console.log("missing session");
  makeEnvironment({ fetchImpl: makeFetch(() => jsonResponse({})) });
  const saved = session.user_id;
  session.user_id = undefined;
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "abc", productTitle: "T", uploads: [upload("m1")] }],
  });
  session.user_id = saved;
  check("reports the missing session", results.length === 1 && /session/i.test(results[0].error || ""));
}

const upload = (mockupId, src = `https://cdn.printify.com/${mockupId}.png`) => ({
  libraryId: `lib-${mockupId}`,
  mockupId,
  src,
  filename: `${mockupId}.png`,
});

async function testMerge() {
  console.log("merge: new images first, existing kept, not_linked first");
  /* Printify answers `selected_mockups` as an object keyed by mockup id and a
     group list; this is the shape the bookmarklet normalises. */
  const layout = {
    groups: [
      { group_key: "other", label: "Other", variant_ids: [11, 12], mockup_ids: ["old-1"] },
      {
        group_key: "not_linked",
        label: "not_linked",
        variant_ids: [],
        mockup_ids: ["old-1", "old-2", "kept-by-me"],
      },
      { group_key: "", label: "", variant_ids: [], mockup_ids: ["ignored"] },
    ],
    selected_mockups: {
      "old-1": { src: "https://cdn/old1.png", type: "PROVIDED", ownership: "MPL" },
      "old-2": { src: "https://cdn/old2.png", type: "PROVIDED" },
    },
  };
  const fetchImpl = makeFetch((entry, n) => {
    if (n === 0) return jsonResponse(layout);
    return jsonResponse({ success: true });
  });
  makeEnvironment({ fetchImpl });
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [
      {
        shopId: 5,
        productId: "prod-1",
        productTitle: "Tee",
        /* The same mockup twice, plus one brand new one. */
        uploads: [upload("m-new", "https://cdn/new.png"), upload("m-new"), upload("old-1")],
      },
    ],
  });

  check("product reported ok", results.length === 1 && results[0].ok === true, JSON.stringify(results));
  const layoutCall = fetchImpl.calls[0];
  const putCall = fetchImpl.calls[1];
  check("reads the layout first", layoutCall.method === "GET" && layoutCall.url.endsWith("/mockup-library-layout"));
  check("puts to selected-mockups", putCall.method === "PUT" && putCall.url.endsWith("/selected-mockups"));
  check("sends the XSRF cookie as X-XSRF-TOKEN", putCall.headers["X-XSRF-TOKEN"] === "csrf-token 123");
  check(
    "url carries the user, shop and product",
    layoutCall.url === "/api/v1/users/user-123/shops/5/products/prod-1/mockup-library-layout",
  );

  const selected = putCall.body.selected_mockups;
  check("selected_mockups is an array", Array.isArray(selected));
  check(
    "the new image is first and is UPLOADED/MPL",
    selected[0] && selected[0].id === "m-new" && selected[0].type === "UPLOADED" && selected[0].ownership === "MPL",
    JSON.stringify(selected),
  );
  check("the new image appears once", selected.filter((e) => e.id === "m-new").length === 1);
  check("the upload's src is used", selected[0].src === "https://cdn/new.png");
  check("existing entries are kept after the new ones", selected.slice(1).map((e) => e.id).join(",") === "old-1,old-2");
  check("ownership only when it was a string", "ownership" in selected[2] === false);

  const groups = putCall.body.groups;
  check("not_linked is the first group", groups[0].group_key === "not_linked");
  check("not_linked carries new ids first then the old ones", groups[0].mockup_ids.join(",") === "m-new,old-1,old-2,kept-by-me");
  check("the other group survives", groups.some((g) => g.group_key === "other"));
  check("the empty group_key is dropped", !groups.some((g) => g.group_key === ""));
  check("the other group's label and variants survive", groups[1].label === "Other" && groups[1].variant_ids.join(",") === "11,12");
}

async function testUnreadableLayoutIsSkipped() {
  console.log("unreadable layout is skipped, never replaced");
  const fetchImpl = makeFetch((entry, n) => (n === 0 ? jsonResponse({}, 500) : jsonResponse({ ok: true })));
  makeEnvironment({ fetchImpl });
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "prod-2", productTitle: "Mug", uploads: [upload("m1")] }],
  });
  check("reported not ok", results[0].ok === false);
  check("says it was skipped", /Skipped/i.test(results[0].error || ""), results[0].error);
  check("nothing was written", fetchImpl.calls.length === 1, `${fetchImpl.calls.length} calls`);
}

async function testRateLimitBackoff() {
  console.log("429 backs off and retries the PUT");
  const fetchImpl = makeFetch((entry, n) => {
    if (n === 0) return jsonResponse({ groups: [], selected_mockups: {} });
    if (n <= 2) return jsonResponse({ error: "slow down" }, 429);
    return jsonResponse({ ok: true });
  });
  makeEnvironment({ fetchImpl });
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "prod-3", productTitle: "Hoodie", uploads: [upload("m1")] }],
  });
  check("succeeded after the rate limit", results[0].ok === true, JSON.stringify(results));
  check("retried up to four times", fetchImpl.calls.length === 4, `${fetchImpl.calls.length} calls`);
}

async function testBearerFallback() {
  console.log("401 falls back to the session token once");
  const fetchImpl = makeFetch((entry, n) => {
    if (n === 0) return jsonResponse({ groups: [], selected_mockups: {} });
    if (n === 1) return jsonResponse({}, 401);
    return jsonResponse({ ok: true });
  });
  makeEnvironment({ fetchImpl });
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "prod-4", productTitle: "Poster", uploads: [upload("m1")] }],
  });
  check("succeeded on the retry", results[0].ok === true, JSON.stringify(results));
  check("the second PUT carried only the bearer retry", fetchImpl.calls[2].headers.Authorization === "Bearer token-abc");
  check("the first PUT had no Authorization header", fetchImpl.calls[1].headers.Authorization === undefined);
}

async function testRejectedSession() {
  console.log("403 reports the rejected session");
  const fetchImpl = makeFetch((entry, n) => {
    if (n === 0) return jsonResponse({ groups: [], selected_mockups: {} });
    return jsonResponse({}, 403);
  });
  makeEnvironment({ fetchImpl });
  const results = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "prod-5", productTitle: "Sticker", uploads: [upload("m1")] }],
  });
  check("reported not ok", results[0].ok === false);
  check("says to sign in again", /Sign in again/.test(results[0].error || ""), results[0].error);
}

async function testTwoAtATime() {
  console.log("runs two products at a time");
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = makeFetch(async (entry) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    /* Answer by what was asked, not by call order: the order the two workers
       interleave is not deterministic. */
    if (entry.method === "GET") return jsonResponse({ groups: [], selected_mockups: {} });
    return jsonResponse({ ok: true });
  });
  makeEnvironment({ fetchImpl });
  const products = [1, 2, 3, 4, 5].map((i) => ({
    shopId: 5,
    productId: `prod-${i}`,
    productTitle: `T${i}`,
    uploads: [upload(`m${i}`)],
  }));
  const results = await applyMockups({ source: "mockup-studio", version: 1, products });
  check("every product has a result", results.length === 5 && results.every((r) => r && typeof r.ok === "boolean"));
  check("all five applied", results.every((r) => r.ok === true));
  check("never more than two in flight", maxInFlight <= 2, `max ${maxInFlight}`);
}

async function testBadPayload() {
  console.log("invalid payloads are refused");
  const fetchImpl = makeFetch(() => jsonResponse({}));
  makeEnvironment({ fetchImpl });
  const wrongSource = await applyMockups({ source: "nope", version: 1, products: [] });
  const empty = await applyMockups({ source: "mockup-studio", version: 1, products: [] });
  const badImage = await applyMockups({
    source: "mockup-studio",
    version: 1,
    products: [{ shopId: 5, productId: "p", productTitle: "t", uploads: [{ libraryId: "l", mockupId: "m", src: "javascript:x", filename: "f" }] }],
  });
  check("foreign source refused", wrongSource[0].ok === false && /not a Mockup Studio payload/.test(wrongSource[0].error));
  check("no products refused", empty[0].ok === false);
  check("non-https src refused", badImage[0].ok === false && /Invalid image/.test(badImage[0].error));
  check("and never fetched", fetchImpl.calls.length === 0);
}

async function testNoUiCalls() {
  console.log("no UI calls in the injected code");
  /* The comments explain why the bookmarklet's prompts were removed, so look at
     the code the browser actually runs: comments stripped. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const forbidden = ["window.prompt", "window.confirm", "window.alert", "navigator.clipboard", "eval("];
  const used = forbidden.filter((needle) => code.includes(needle));
  check("none of prompt/confirm/alert/clipboard/eval", used.length === 0, used.join(", "));
}

const tests = [
  testHostGuard,
  testMissingSession,
  testMerge,
  testUnreadableLayoutIsSkipped,
  testRateLimitBackoff,
  testBearerFallback,
  testRejectedSession,
  testTwoAtATime,
  testBadPayload,
  testNoUiCalls,
];

for (const test of tests) {
  await test();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
