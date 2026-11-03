# SEO and pages audit

Source of truth for every claim: `src/pages/`, `src/layouts/AppLayout.astro`,
`src/components/layout/sidebar.tsx`, `src/pages/api/auth/`, and `AGENTS.md`
in this repo. Nothing here is implemented; this is a gaps-only report.

## 1. Summary

- No `robots.txt`, no `sitemap.xml`, and no `404.astro` exist anywhere in `src/pages/`.
- Every page shares one `<title>Mockup Studio</title>` and one meta description from `AppLayout.astro`; there are no unique per-page titles or descriptions.
- No canonical URLs, no Open Graph tags, no Twitter cards, and no `robots` meta are set on any page.
- No legal pages (Privacy, Terms, Refund, Cookies, Contact, About, FAQ, Shipping) exist, and `sidebar.tsx` links to none of them.
- No `noindex` is set anywhere, so all prerendered pages including app-only work surfaces are currently unblocked from indexing.

## 2. Pages inventory

| Route | Type | Indexable today? | Unique title? | Unique description? |
|---|---|---|---|---|
| / | marketing / landing | Yes (unblocked) | No | No |
| /printify-studio | app | Yes (unblocked) | No | No |
| /mockups | app | Yes (unblocked) | No | No |
| /listing-images | app | Yes (unblocked) | No | No |
| /listing-details | app | Yes (unblocked) | No | No |
| /listing-preview | app | Yes (unblocked) | No | No |
| /autopilot | app | Yes (unblocked) | No | No |
| /export | app / utility | Yes (unblocked) | No | No |
| /agent | app / utility | Yes (unblocked) | No | No |
| /activity | app / utility | Yes (unblocked) | No | No |
| /settings | app / utility | Yes (unblocked) | No | No |
| /onboarding | app | Yes (unblocked) | No | No |
| /printify-bookmarklet | utility | Yes (unblocked) | No | No |
| /auth/signin | utility | Yes (unblocked) | No | No |
| /auth/signup | utility | Yes (unblocked) | No | No |

Notes: all 13 top-level pages plus two auth pages prerender to static HTML per
`AGENTS.md`. None pass a unique title or description to `AppLayout`, so all
inherit `<title>Mockup Studio</title>` and the single meta description. API
endpoints under `src/pages/api/` are not pages and are excluded.

## 3. Missing pages

| Page | Why needed | Priority | Suggested route |
|---|---|---|---|
| Privacy Policy | Required because user data is stored in the visitor's IndexedDB; explains data stays in-browser | must | /privacy |
| Terms of Service | Sets user-facing terms for the workspace | must | /terms |
| Refund / Returns | POD sellers need a returns stance for generated mockups/listings | should | /refund-policy |
| Cookies | Cookie/consent disclosure (app sets no cookies unless optional Supabase sign-in is used) | should | /cookies |
| Contact | Operator identity and support channel | should | /contact |
| About | Who runs the workspace; required for trust and structured data | nice | /about |
| FAQ | Reduces support load; target for FAQPage structured data | nice | /faq |
| Shipping policy | Relevant for POD/Etsy sellers using the app | nice | /shipping-policy |
| 404 | Missing route handling; Cloudflare appends trailing slashes to directory-like routes | must | /404.astro |
| 500 / error page | Server error fallback for the Worker | should | 500 or error handling |

None of the above exist in `src/pages/`. `robots.txt.ts` and `sitemap.xml.ts`
are also not found in code.

## 4. Security & completeness gaps

- Legal links not reachable from the UI: `src/components/layout/sidebar.tsx`
  links only to app surfaces (`/printify-studio`, `/mockups`,
  `/listing-images`, `/listing-details`, `/listing-preview`, `/autopilot`,
  `/agent`, `/export`, `/activity`, `/settings`). No legal page link exists
  anywhere in the sidebar (the only privacy/terms/contact/faq/cookies/refund
  match in the file is a comment, line 40).
- Operator identity/contact placeholders: no About or Contact page exists, so
  there is no disclosed operator name, address, or support email in the UI.
- Cookie/consent text vs actual cookie use: no cookie banner, cookie policy,
  or consent UI was found in code. The app sets no cookies unless the optional
  Supabase sign-in (`/auth/signin`, `/auth/signup`, plus `api/auth/me`,
  `api/auth/callback`) is used; all other user data lives in IndexedDB only.
- Data-processing statement: no page states that user data stays in the
  visitor's browser, even though `AGENTS.md` confirms this is the core design.
- External-link hygiene: `AppLayout.astro` preconnects to
  `fonts.googleapis.com` and `fonts.gstatic.com`; external links to
  printify.com/etsy.com/github were not checked for `rel="noopener"` in code
  (not found).
- CSP notes: `index.astro` comments that the landing page "lives behind the
  shared CSP (nonce'd inline scripts + Google Fonts from fonts.gstatic.com)",
  but no CSP header declaration was found in the pages read; unverified.

## 5. SEO gaps

- Per-page titles/descriptions: every page inherits AppLayout's single
  `<title>Mockup Studio</title>` and one meta description; no page sets its
  own. Duplicate titles across all 15 routes.
- Canonical URLs: none set on any page; no self-referencing canonical.
- Open Graph / Twitter cards: no `og:title`, `og:description`, `og:image`,
  `og:url`, or `twitter:*` tags found anywhere.
- Sitemap contents vs actual routes: `src/pages/sitemap.xml.ts` does not
  exist, so there is no sitemap listing `/`, `/printify-studio`, `/mockups`,
  `/listing-images`, `/listing-details`, `/listing-preview`, `/autopilot`,
  `/export`, `/agent`, `/activity`, `/settings`, `/onboarding`,
  `/printify-bookmarklet`, `/auth/signin`, `/auth/signup`.
- robots.txt rules: `src/pages/robots.txt.ts` does not exist; no crawling
  rules are published.
- Missing H1s: not verified per page; flagged as a gap to check because
  `AppLayout` provides no heading and pages were not checked for an `<h1>`.
- Missing structured data: no JSON-LD found. Concrete examples to add:
  `Organization` (name: Mockup Studio, url: https://mockup-studio.adityadino678.workers.dev),
  `SoftwareApplication` (applicationCategory: Business, operatingSystem: Web,
  offere... local-first POD workspace), and `FAQPage` on an /faq page once it
  exists.

## 6. Indexing recommendation

App pages (user work surfaces, user data in IndexedDB, no public content):
`/printify-studio`, `/mockups`, `/listing-images`, `/listing-details`,
`/listing-preview`, `/autopilot`, `/export`, `/activity`, `/settings`,
`/printify-bookmarklet`, `/onboarding`, `/auth/signin`, `/auth/signup`.

Exact `robots` meta value for the app group:
`<meta name="robots" content="noindex, nofollow">`

Landing / marketing / legal pages (indexable):
`/`, plus any legal pages added (`/privacy`, `/terms`, `/refund-policy`,
`/cookies`, `/contact`, `/about`, `/faq`, `/shipping-policy`).

Exact `robots` meta value for the indexable group:
`<meta name="robots" content="index, follow">`

Also add `robots.txt` disallowing the app routes and a `sitemap.xml`
listing only indexable routes.

## 7. Prioritised action list

| Action | Effort | Impact | Owner note |
|---|---|---|---|
| Add robots.txt disallowing app routes | S | High | Blocks crawler access to app surfaces |
| Add sitemap.xml listing indexable routes only | S | High | Helps discovery of landing/legal pages |
| Add noindex, nofollow meta to all app pages | S | High | Per-page via AppLayout or page frontmatter |
| Create /privacy and /terms pages | M | High | Legal requirement for browser-local data |
| Create /contact and /about pages | M | High | Operator identity disclosure |
| Add unique title + description per page | S | Medium | Fix duplicate titles across all routes |
| Add canonical URLs per page | S | Medium | Self-referencing canonical on each route |
| Add Open Graph + Twitter card tags | M | Medium | Social sharing of the landing page |
| Link legal pages from sidebar/footer | S | Medium | Make legal pages reachable from UI |
| Add data-processing statement (data stays in browser) | S | Medium | On landing and privacy pages |
| Create /404.astro | S | Medium | Missing route fallback |
| Add cookie / consent notice | M | Low | Reflects that no cookies are set unless Supabase sign-in used |
| Add SoftwareApplication + Organization JSON-LD | M | Low | Structured data for the workspace |
| Add FAQ page with FAQPage JSON-LD | M | Low | Depends on /faq existing first |
| Add 500 / error page handling | S | Low | Worker error fallback |
