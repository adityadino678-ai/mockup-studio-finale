# The Mockup Studio ↔ extension protocol

Everything the extension and the app say to each other, exactly. Implemented in
`extension/content-app.js` (the app-facing half) and `extension/background.js`
(the Printify and Etsy half). Plain DOM events on the app page; nothing else.

The extension has two jobs: **apply the mockup selection to a Printify product**
(section 2) and **read the public Etsy search page when the app has no Etsy API
key** (section 6).

The extension is **optional**. The app keeps the clipboard + bookmarklet path as
the fallback, so the one-click button only appears when the extension is loaded.

---

## 1. Presence: is the extension installed?

The content script runs on the app origins at `document_idle` and immediately:

1. sets the attributes

   ```html
   <html data-mockup-studio-ext="1"
         data-mockup-studio-ext-protocol="2"
         data-mockup-studio-ext-etsy="1"
         data-mockup-studio-ext-version="1.2.0">
   ```

   (and the marker on `<body>`; a `MutationObserver` re-marks it if the app
   rebuilds the DOM), and
2. dispatches on `window`

   ```js
   new CustomEvent("mockup-studio:extension-ready", {
     detail: {
       version: 2,
       protocol: 2,
       etsy: true,
       extensionVersion: "1.2.0",
       marker: "data-mockup-studio-ext",
     },
   });
   ```

Safe detection:

```js
const root = document.documentElement;
const present = root.getAttribute("data-mockup-studio-ext") === "1";
const protocol = Number(root.getAttribute("data-mockup-studio-ext-protocol") || "0");
const etsy = root.getAttribute("data-mockup-studio-ext-etsy") === "1";
const ready = present && protocol >= 2; // this app's protocol
window.addEventListener("mockup-studio:extension-ready", () => setReady(true));
```

Use whichever fits the component's lifecycle. The attributes are the simple
answer on first render; the event covers an extension loaded (or reloaded) after
the page was already open — which is exactly the "reload the page" case in the
README.

**Protocol 2 is required.** An older build only sets the marker, so it is
reported as "reload the extension" instead of being used: it would merge the
mockups instead of replacing them and cannot answer Etsy research. If the
marker is absent, the extension is not loaded in this browser: keep the
bookmarklet steps.

## 2. Asking for an apply

The app (page script) dispatches on `window`:

```js
new CustomEvent("mockup-studio:apply-request", {
  detail: { payload, requestId },
});
```

- `payload` — a `PrintifyBridgePayload` from
  `src/lib/printify/mockup-bridge.ts`, i.e. exactly what `bridgePayloadJson`
  serialises:

  ```ts
  { source: "mockup-studio", version: 1, createdAt: string, replace: boolean,
    products: [ { shopId: number, productId: string, productTitle: string,
                  uploads: [ { libraryId, mockupId, src, filename } ] } ] }
  ```

  **Never add credentials to it.** No API key, no token, no session. It is ids,
  URLs, file names and titles.

  `replace: true` (what the app sends) makes the uploads the product's WHOLE
  mockup selection: every group keeps its `group_key`, `label` and
  `variant_ids`, every group's `mockup_ids` is cleared, and only the new
  uploads are placed in `not_linked`. That is what removes Printify's
  generated/default mockups. Groups that end up with no mockup ids are then
  **dropped from the PUT** — Printify's own UI does the same, and its validator
  rejects a variant group sent with an empty `mockup_ids` (HTTP 400). The
  omitted groups are not lost: Printify keeps them server-side and re-derives
  their ids against the new selection, so a replaced variant group comes back
  empty instead of keeping its old generated mockups (verified live against a
  real product, Nov 2026). Uploaded entries are sent as
  `{id, src, type: "UPLOADED", ownership: "MPL"}` with the REAL mockup-library
  id and https URL from the upload step — image-file ids or missing `src` are
  rejected or silently dropped. `replace: false` opts back into the old
  dedupe/prepend merge; an older payload with no flag is treated as `true`.
- `requestId` — any string the app makes up (e.g. `crypto.randomUUID()`), echoed
  back so the app can match a late answer to the right dialog. Optional: the
  extension invents one if it is missing, but always send one.

The content script validates the payload against the bridge contract
(`source`, `version`, product/upload shape; mockup ids matching
`/^[A-Za-z0-9_-]{1,64}$/`, image URLs starting `https://`, at most 25 products)
and **forwards nothing that is not a valid payload**. Anything else is refused
with `mockup-studio:apply-error`.

## 3. The answer

On success:

```js
new CustomEvent("mockup-studio:apply-result", {
  detail: { ok: true, requestId, results },
});
```

On failure — the Printify tab could not be opened, the payload was refused, the
extension's background worker could not be reached, or the browser blocked the
injection:

```js
new CustomEvent("mockup-studio:apply-error", {
  detail: { requestId, error },
});
```

`error` is a short sentence written for a seller, not a stack trace
("Sign in to Printify in this tab first.", "Printify kept rate-limiting (429).
Try again in a minute.").

### `results` — one entry per product, in payload order

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | The product id the entry is about (`"?"` for a failure before any product was reached, e.g. no Printify session). |
| `ok` | `boolean` | `true` when that product's mockups were selected. |
| `error` | `string?` | Present only when `ok` is `false`. The reason. |

`ok: true` on the outer `detail` does **not** mean every product succeeded — it
means the extension managed to run the apply. Read the per-product entries:

```js
function summarise(results) {
  const done = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return { done, total: results.length, failed };
}
// failed entries: [{ id: "6ad3…", ok: false, error: "HTTP 500 — …" }]
```

A product fails (and the rest still run) when: its existing selection could not
be read (the background tab cannot ask, so it **skips rather than blindly
replacing**), Printify returned 401/403 (the session was rejected), Printify
returned another error status, or the 429 backoff ran out.

## 4. Inside the extension

`content-app.js` → `chrome.runtime.sendMessage({ type: "MS_APPLY", payload, requestId })`
→ `background.js`:

1. validates the payload with the shared `payload-guard.js`;
2. opens `https://printify.com/app/products/<firstProductId>` with
   `active: false` (a background tab) and remembers the tab id;
3. polls `chrome.tabs.get` until `status === "complete"` (20 s cap), then waits
   1.5 s for Printify's SPA to mount so `localStorage.session` and the
   `XSRF-TOKEN` cookie exist;
4. refuses anything that is not `printify.com`;
5. `chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED",
   func: applyMockups, args: [payload] })` — the isolated world shares the page's
   origin, cookies and `localStorage`, so `credentials: "include"` sends the
   user's own session and nothing else;
6. closes the tab with `chrome.tabs.remove(tabId)` and answers through
   `sendResponse`.

`MS_ETSY_RESEARCH` takes a different branch: it opens
`https://www.etsy.com/search?q=<query>` in a background tab, injects
`scrapeEtsySearch` from `etsy-research.js`, returns the cards and closes the
tab. See section 6.

No `chrome.storage` is used or requested; the payload lives in a module-level
variable for the length of that one run.

## 5. Reference page-side integration

Drop-in caller for the Send dialog, in place of / alongside the bookmarklet step:

```js
const requestId = crypto.randomUUID();

function onResult(event) {
  if (event.detail.requestId !== requestId) return;
  const { results, ok } = event.detail;
  const failed = results.filter((r) => !r.ok);
  setStatus(
    ok
      ? `Applied ${results.length - failed.length} of ${results.length} product(s).`
      : "The extension could not apply the images.",
  );
  setFailures(failed.map((r) => `${r.id}: ${r.error}`));
}

function onError(event) {
  if (event.detail.requestId !== requestId) return;
  setStatus(event.detail.error); // a sentence for the user
}

window.addEventListener("mockup-studio:apply-result", onResult);
window.addEventListener("mockup-studio:apply-error", onError);
window.addEventListener("mockup-studio:extension-ready", () => setExtReady(true));

function applyWithExtension() {
  setExtReady(document.documentElement.getAttribute("data-mockup-studio-ext") === "1");
  if (!extReady) {
    // no extension: keep the bookmarklet steps
    return;
  }
  window.dispatchEvent(
    new CustomEvent("mockup-studio:apply-request", { detail: { payload, requestId } }),
  );
}
```

Remember to remove the three listeners when the dialog closes.

## 6. Etsy research fallback

The app prefers `POST /api/etsy/research` (an Etsy keystring in Settings). When
that is missing or rejected, it asks the extension to read the public Etsy
search page in the user's own browser.

The app dispatches on `window`:

```js
new CustomEvent("mockup-studio:etsy-research-request", {
  detail: { query: "personalized cat mug", requestId },
});
```

- `query` — 2–120 characters. Nothing else is accepted.
- `requestId` — any string, echoed back so the app can match a late answer.

The content script forwards `{ type: "MS_ETSY_RESEARCH", query, requestId }`.
The service worker opens `https://www.etsy.com/search?q=<query>` in a background
tab, waits for it to load, injects `etsy-research.js`'s `scrapeEtsySearch`, and
closes the tab. It uses the user's own Etsy session.

On success:

```js
new CustomEvent("mockup-studio:etsy-research-result", {
  detail: {
    ok: true,
    requestId,
    cards: [
      {
        title: "Personalized Cat Mug",
        priceText: "$24.99",
        url: "https://www.etsy.com/listing/123/cat-mug",
      },
    ],
  },
});
```

On failure — a verification page, no Etsy session, a closed tab, or an invalid
query:

```js
new CustomEvent("mockup-studio:etsy-research-error", {
  detail: { requestId, error },
});
```

`cards` is capped at 48. `priceText` is the label exactly as Etsy showed it; the
app parses it. `url` is empty when Etsy did not expose a listing URL.

**What browser mode cannot see: tags.** Etsy's search cards expose the title and
price, not the listing tags. The app therefore reports `topTags: []` and says so
in the disclaimer. It never invents tags from the title.

**This is a fallback, not a scraping service.** It only runs when the API cannot
answer, it runs in the user's browser, and it sends no query or result to Mockup
Studio's server.

## 7. What the extension will never do

- It will not ask for, read or send the app's Printify API key. It does not know
  it exists.
- It will not read the Printify session out of the page. It leaves the
  `localStorage.session` read and the `XSRF-TOKEN` cookie to the injected code,
  which runs on `printify.com` and only ever talks to `printify.com`.
- It will not forward data from the page that is not a valid payload.
- It will not send an Etsy query or its results to Mockup Studio's server, or to
  any other server. The Etsy page is read in the user's own browser.
- It will not read Etsy listing tags. Search cards do not expose them.
- It will not run anywhere except `printify.com`, `etsy.com` and the app origins
  listed in the manifest.
