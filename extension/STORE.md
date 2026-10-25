# Publishing "Mockup Studio Printify Bridge" — checklist

This is a **local prototype**: it is not published, and it does not have to be,
because it is loaded by hand from `extension/` (see `README.md`). This file is
what it would take to put it in the two stores, written before the fact so
nothing is discovered during review.

Both stores review a submission, and MV3 means one package works for both. The
only things that must be *replaced* first are the placeholder icons.

---

## 0. Do these before submitting

- [ ] **Replace the placeholder icons** (`extension/icons/icon16.png`, `…32`,
      `…48`, `…128`). They are generated stand-ins (a green square with a mockup
      frame) with no real artwork. Regenerate placeholders with
      `node extension/tools/generate-icons.mjs`; commission/export the real ones
      from the Mockup Studio logo.
- [ ] **Run the offline checks** (`node extension/tools/offline-check.mjs`,
      `offline-check-sw.mjs`, `offline-check-content.mjs`) and at least one real
      run against a throwaway Printify product in a signed-in browser.
- [ ] **Bump `version`** in `manifest.json` for every submission (both stores
      require a strictly newer version).
- [ ] Decide about `minimum_chrome_version` (currently `102`): the APIs used
      (`scripting.executeScript` with `world`, MV3 background) need 102+.
- [ ] Decide about an `options_page`: not included on purpose — there is nothing
      to configure. Chrome asks "Why do you not need an options page?" and
      "nothing to configure" is the answer.

## 1. Chrome Web Store

- [ ] **Developer account** at <https://chrome.google.com/webstore/devconsole/>.
      Requires a Google account with **2-step verification**.
- [ ] **One-time US$5 registration fee.** (Edge and Firefox do not charge one.)
- [ ] Verify the domain if you want to claim ownership of
      `mockup-studio.adityadino678.workers.dev`.
- [ ] Package the folder as a **ZIP of the contents of `extension/`** (the ZIP
      root must contain `manifest.json`, not an extra folder level).
- [ ] Store listing fields:
  - Name: `Mockup Studio Printify Bridge`
  - Summary (max 132 chars), Description (max 16,000 chars) — reuse the plain
    English from `README.md`'s first two sections.
  - Category: **Productivity** (Shopping is defensible too).
  - Language, **Support URL**, and a **Privacy policy URL** — see §4.
  - Screenshots: **1280×800 or 640×400**, at least 1, up to 5, PNG/JPEG, no
    alpha. Suggested: (1) the Listing images Send dialog, (2) the one-click
    button and its result, (3) the extensions page with it loaded.
  - Small promo tile 440×280 (optional).
- [ ] **Permissions justification** — copy/paste into the store listing's
  permission notes, one line each (see §3).
- [ ] **Data usage disclosures** (the "Privacy practices" tab). The honest
  answer for this extension is: it handles **no** personally identifying
  information, no health/financial/personal communications data, no
  authentication data; the only thing it transmits is the mockup selection the
  user asked it to apply, to printify.com, in the user's own session.
- [ ] Single purpose statement: "Apply the mockup images Mockup Studio prepared
      to the user's Printify products, using the user's own Printify session."
- [ ] Publish: **Unlisted** first (works for a prototype, no public review
      wait), then **Public** once real users need it.

Typical review time is a few days for a first submission.

## 2. Microsoft Edge Add-ons

- [ ] **Developer account** at <https://partner.microsoft.com/dashboard/microsoftedge/>
      (a Microsoft account; no fee).
- [ ] Same ZIP from §1. Edge accepts the MV3 package unmodified.
- [ ] Store listing fields mirror Chrome's, plus:
  - Category, screenshots (**1280×800 or 640×400**, at least 1).
  - **Privacy policy URL** — same requirement as Chrome.
  - Notes for the reviewer: same permission justifications.
- [ ] "Availability" — choose Public or Unlisted. Unlisted is fine for the
      prototype.
- [ ] Expect a similar review window.

## 3. Permission justifications (paste-ready)

> **`tabs`** — the extension has to see whether the Printify tab it opened has
> finished loading, and to close it again after the images are applied.
>
> **`activeTab`** — the one-click button lives in the Mockup Studio page; this
> lets the extension act on the tab the user is on when they press it.
>
> **`scripting`** — the mockup-selection step is not a public Printify API, so it
> has to run inside the user's own printify.com tab. This is what injects that
> code into the tab the extension itself opened.
>
> **Host permission `https://printify.com/*` and `https://*.printify.com/*`** —
> the injected code must make same-origin requests to Printify's own endpoints
> with the user's Printify session cookies. Printify is the only third-party site
> the extension touches, and it is the site the user asked it to work on.
>
> **Host permissions on `mockup-studio.adityadino678.workers.dev`,
> `http://localhost/*` and `http://127.0.0.1/*`** — these are where Mockup Studio
> itself runs (the deployed site and the local dev server). The content script
> runs there only to mark the page and pass the user's own request to the
> extension. `localhost`/`127.0.0.1` are needed because the app is local-first
> and developers run it locally.
>
> **No `storage` permission is requested.** Nothing the extension sees is saved —
> the image list is held in memory for the length of one run and then dropped.
>
> **No remote code.** The extension bundles its own plain JavaScript and runs no
> remotely hosted code, and it never uses `eval`.

## 4. Privacy policy

Chrome requires a working privacy policy URL for any submission. It needs to say,
in plain words:

- The extension runs in the user's browser and acts on the user's own Printify
  session; it never sees, stores or transmits a Printify password or the app's
  Printify API key.
- The image list (product ids, mockup ids, image URLs, file names, titles) is
  sent only to `printify.com`, only because the user pressed the button, and is
  not kept after that run.
- No analytics, no advertising, no tracking, no third parties, no server of the
  extension's own.

Host it next to the app's existing site (e.g. the same workers.dev deployment)
and reference it in the store listing.

## 5. Notes a reviewer will care about

- **It is not a Printify partner integration.** It automates a click the user
  could make by hand, in the user's own logged-in session, using Printify's own
  web endpoints — the same thing the shipped "Printify Automation" extensions do.
  There is no scraping of user data and no bulk export.
- **No credentials, ever.** The extension cannot read the app's API key: it is
  held in Mockup Studio's browser-local storage and sent only to Mockup Studio's
  server, never to the extension.
- **Single purpose:** apply mockups to a Printify product.
- **No obfuscation, no minification** in the shipped files (the repo versions
  are already readable; keep them that way — reviewers can and do read them).

## 6. After publishing

- Update `extension/README.md`'s install section to link the store listing
  instead of "load unpacked".
- Keep `version` increasing per submission.
- Re-run the offline checks after any change; `printify-apply.js` must stay a
  faithful port of `src/lib/printify/bookmarklet.ts` so the two paths cannot
  drift apart (the bookmarklet is the reference the unit tests cover).
