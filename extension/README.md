# Mockup Studio Printify Bridge

A tiny browser extension for Chrome and Edge that finishes the "Send to Printify"
step for you, and reads public Etsy search results when Mockup Studio has no
Etsy API key.

Mockup Studio can upload your listing images to Printify and can build the list
of which images should become a product's mockups — but choosing a product's
mockups is something Printify only lets you do inside your own signed-in
Printify web page. Until now that last step was a **bookmarklet** you had to
click on the Printify tab. This extension does the same thing with **one click**
from inside Mockup Studio.

It also gives the in-app agent an Etsy research fallback. The app prefers Etsy's
public API (a keystring in **Settings → API connections**). When that key is
missing or rejected, the extension opens the public Etsy search page in a
background tab, reads the listing cards that page displayed, and returns the
titles and prices. It cannot read listing tags, because Etsy's search cards do
not expose them.

It is a prototype, local-only companion: it is **not published in any store**,
so it has to be loaded by hand once (see below). Browsers deliberately forbid
installing an extension silently, so every person who wants the one-click button
has to do this once on their own machine.

---

## What you install

- A **background worker** that opens a Printify tab, quietly, applies the images,
  then closes that tab again. You normally never see it. It does the same for an
  Etsy search tab when the app asks it to research a query.
- A small **content script** that only runs on the Mockup Studio pages
  (`mockup-studio.adityadino678.workers.dev`, `localhost`, `127.0.0.1`). It puts
  a marker on the page and listens for the app's events, so the app knows the
  extension is there and can offer the one-click button and the Etsy fallback.

Nothing else runs anywhere. No other website is touched.

## How to install it (once)

### Chrome

1. Open **Mockup Studio** in Chrome and stay signed in.
2. Make sure you are signed in to **printify.com** in the same browser
   (`https://printify.com/app/products` should show your products).
3. In Chrome's address bar type `chrome://extensions` and press Enter.
4. Turn on **Developer mode** (switch at the top right).
5. Click **Load unpacked**.
6. Choose this folder:
   `mockup-studio-finale\extension`
   (the folder that contains `manifest.json`, not the whole project).
7. Done. The extension appears in the list as
   **Mockup Studio Printify Bridge** and stays there.

### Edge

1. Open Edge and be signed in to printify.com in it.
2. Type `edge://extensions` and press Enter.
3. Turn on **Developer mode** (bottom left).
4. Click **Load unpacked** and pick
   `mockup-studio-finale\extension`.
5. Done.

**Chrome and Edge are separate browsers.** If you use both, load it in both.

## How to use it

Once the app is wired to it (see the status note below), the flow is:

1. In Mockup Studio go to **Listing images**.
2. Tick the listings you want, press **Send to Printify**, and let it upload the
   images (it does the uploading exactly as before).
3. In the "Apply the images in Printify" dialog, press
   **Apply with the extension (one click)** — it sits beside the old bookmarklet
   steps, which still work as a fallback.
4. A Printify tab opens in the background, the images are selected on the
   product, and that tab closes by itself.
5. The dialog shows which products worked and which did not. You can then open
   the product in Printify and check.

> **Status: local prototype.** The app now detects the extension and offers the
> one-click apply in the Send dialog. The extension is still loaded by hand
> (below), not published in a store. `protocol.md` is the exact event contract,
> including the Etsy research events.

### What the extension does on the product

It keeps whatever mockups the product already has selected and puts your new
images in front, so the **first image becomes the main image**, exactly like the
bookmarklet. It reads the current selection first: if it cannot read it, it
skips that product and tells you, instead of replacing the selection blindly.

### Etsy research fallback

You do not press a separate button for this. When the agent needs Etsy research
and the app has no working Etsy keystring, it asks the extension for it:

1. The extension opens `etsy.com/search?q=<your query>` in a **background tab**.
2. It reads the listing cards that page displayed: title, price label and URL.
3. It closes the tab and hands the cards to the app.
4. The app reports the observed titles, recurring title words and median price.

If Etsy shows a "Just a moment" verification page, the extension says so instead
of returning an empty result. Open <https://www.etsy.com> in a normal tab, finish
the check, and try again.

**Tags are not available this way.** Etsy's search cards do not expose listing
tags, so browser mode reports none. Add an Etsy keystring in Settings if you need
tag data.

## How it stays private

- It runs **in your browser, in your own Printify tab, with your own login**.
  It never asks for your password and never logs into Printify for you.
- It uses the session that is already in your browser. Your Printify login is
  never copied anywhere.
- **The app's Printify API key is never involved.** The extension does not know
  it, cannot read it, and is not sent it. Mockup Studio's server never sees your
  Printify web session either.
- The list of images (product ids, mockup ids, image URLs, file names and
  titles) is held in memory only for the length of one run, then thrown away. It
  is **not** saved to disk, to `chrome.storage`, to a file, or to any server.
- An Etsy query is held in memory only for the length of that one research run.
  The cards it reads are returned to the app page; they are **not** sent to
  Mockup Studio's server, and they are not saved by the extension.
- The extension asks your browser for three permissions only — `tabs`,
  `scripting`, `activeTab` — and permission to run on `printify.com`, `etsy.com`,
  the Mockup Studio website and `localhost`/`127.0.0.1` (for the local dev
  server). Nothing else.
- It contains no analytics, no ads, no remote code and no `eval`.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Sign in to Printify in this tab first" | You are not signed in to printify.com **in this browser**. Open <https://printify.com/app/products>, sign in, and press the button again. |
| "Printify kept rate-limiting (429)" | Printify slowed down. Wait a minute and press the button again. |
| "Printify did not open on printify.com" | Printify redirected somewhere else (a login wall, a temporary outage). Open printify.com by hand, sign in, then try again. |
| "The extension is not installed correctly" | Remove the extension in `chrome://extensions` and load the folder again. |
| "Etsy showed a verification page" | Open <https://www.etsy.com> in a normal tab, finish the check it asks for, then ask the agent again. |
| Etsy research returns no tags | Expected in browser mode: Etsy's search cards do not expose tags. Add an Etsy keystring in Settings for tag data. |
| No one-click button in the dialog | The extension is not loaded in this browser. Load it, then reload the Mockup Studio page. |
| Nothing happens and the Printify tab closed | The browser stopped the extension's background worker mid-run (a known Chrome limitation on long runs). Check the product in Printify first — the images may already be applied — then press the button again. |

The old bookmarklet still works, so you are never stuck: install it from
**/printify-bookmarklet**, copy the payload, and click it on the Printify tab.

## Turning it off

`chrome://extensions` (or `edge://extensions`) → find **Mockup Studio Printify
Bridge** → toggle it off, or **Remove**. Removing it changes nothing in Mockup
Studio; the dialog goes back to the bookmarklet steps automatically.

## Limitations of this prototype

- **It is not store-published.** It has to be loaded by hand, in every browser,
  by every person. `STORE.md` lists what publishing would take.
- **Etsy can serve a verification page.** The extension reports that instead of
  pretending it found nothing; finish the check on etsy.com and retry.
- **Etsy browser mode cannot read tags.** Search cards expose titles and prices
  only. Use an Etsy keystring if you need tag data.
- **Background tabs can be closed.** If you have "continue where you left off"
  or an aggressive memory saver, the Printify tab may be closed before it
  finishes. Re-run it.
- **A browser can stop the extension's background worker** after ~30 idle
  seconds. A normal batch finishes in seconds, so this is rare; if it happens,
  the results are lost and you re-run.
- **Placeholder icons.** `extension/icons/*` are generated stand-ins; replace
  them with a real icon before any store submission.
- No options page, no settings. There is nothing to configure.

## Files in this folder

| File | What it is |
|---|---|
| `manifest.json` | The extension's manifest (MV3): permissions, host permissions, the content script and the background worker. |
| `background.js` | The service worker: takes the payload, opens the Printify tab in the background, injects the apply code, returns the results, closes the tab. It also handles the Etsy research message. |
| `printify-apply.js` | The Printify mockup-selection logic, ported from Mockup Studio's bookmarklet with its pop-up questions removed. |
| `etsy-research.js` | The Etsy search-card scraper injected into the background Etsy tab. Titles, price labels and URLs only — no tags. |
| `payload-guard.js` | What a Mockup Studio payload is — shared by the background worker and the content script. |
| `content-app.js` | Runs on the Mockup Studio pages only: marks the page, listens for the apply and Etsy research events, forwards them, relays the answers. |
| `icons/` | Placeholder PNG icons. |
| `tools/generate-icons.mjs` | Regenerates those placeholder icons (plain Node, no dependencies). |
| `tools/offline-check.mjs` | Checks the ported Printify logic against stubbed browser globals. |
| `tools/offline-check-sw.mjs` | Checks the whole background-worker chain with a stubbed `chrome` API. |
| `tools/offline-check-content.mjs` | Checks the app-facing event protocol. |
| `protocol.md` | The exact events the app can integrate with. |
| `STORE.md` | What publishing to the Chrome Web Store and Edge Add-ons would take. |

### Running the checks (only if you are the developer)

```
node extension/tools/generate-icons.mjs
node extension/tools/offline-check.mjs
node extension/tools/offline-check-sw.mjs
node extension/tools/offline-check-content.mjs
```

They need nothing installed but Node, no browser and no Printify account.
