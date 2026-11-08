# Mockup Studio

A premium, local-first workspace for print-on-demand sellers: upload designs, place them on a real Printify print area, map that area onto mockup photos, render mockups, create ink variants, remove backgrounds, and export organized ZIP archives — all stored in your browser, no account required.

`/` is the public ListBulkly landing page; the workspace starts at **Printify Studio** and continues through **Mockups**, **Listing images**, **Listing details**, **Listing preview**, **Export Center**, **Activity**, **Onboarding**, **Settings** and the bookmarklet install page. There is no separate agent page: the agent is an in-page panel on Printify Studio and Listing details. `/styleguide` is internal (`noindex`). The public **Privacy**, **Terms**, **Refunds**, **Cookies** and **Contact** pages are honest launch drafts: legal identity, jurisdiction and price are still PLACEHOLDER, and the contact address (`listbulkly@gmail.com`) is real. `/404` + `/500` are real error pages rather than redirects. There is no `/login` page: the landing document's small window is the only sign-up/log-in surface (Name/Email/Password), reached from the Start free and Log in buttons or from `/?auth=in` / `/?auth=up` elsewhere, and **`/auth/confirm`** finishes an email-confirmation link. Sign-out lives in Settings.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

Or from the folder one level up, without touching the terminal commands yourself:

| File | What it does |
|---|---|
| `../start.cmd` | Checks Node, installs deps on first run, opens the browser and starts the dev server |
| `../setup.cmd` | Installs dependencies only |

Optional integrations can be connected two ways:

1. **In the app (recommended):** open **Settings → API connections**. Paste your
   Printify key, then pick an AI **provider** (NVIDIA NIM,
   OpenRouter, Groq, Cerebras, Together, Google Gemini, Mistral, DeepSeek,
   Fireworks, xAI, OpenAI, Anthropic, a local Ollama server, or any custom
   OpenAI-compatible endpoint). The **Load models** button fetches that
   provider's live model list and tags free models `free`; choose one and press
   **Test connection**. You can keep a key per provider and switch the active
   model from the agent panel without losing the others. Keys are stored only
   in your browser's IndexedDB and attached to the relevant requests — never
   saved on the server.
2. **Optionally, on your own server** (`.env.local` / `wrangler secret put`) —
   only for a self-hosted or preview deployment. The public Worker deliberately
   ships without these, because every visitor pastes their own:

```bash
PRINTIFY_API_KEY=...      # optional server fallback for Printify calls
AI_API_KEY=...            # optional server fallback for agent chat + listing copy
AI_BASE_URL=...           # default: https://api.openai.com/v1
AI_MODEL=...              # default: gpt-4o-mini
```

A browser-saved key takes precedence over a server key when both are present.

**Everything in the core workflow works without any API key.**

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run deploy` | Build and publish to Cloudflare Workers |
| `npm run lint` | ESLint (typescript-eslint + eslint-plugin-astro) |
| `npm run typecheck` | `astro check` — strict TS across `.ts`, `.tsx` and `.astro` |
| `npm run test` | Unit/integration tests (666 tests in 40 files) |
| `npm run test:e2e` | End-to-end acceptance tests (49 tests, needs `npx playwright install chromium` once) |
| `npm run astro` | Any Astro CLI command (`astro add`, `astro info`, …) |

## Deploying to Cloudflare

The production build targets **Cloudflare Workers** via `@astrojs/cloudflare`.

```powershell
npx wrangler login     # one time
npm run deploy         # build + wrangler deploy
```

The app is published to `https://mockup-studio.adityadino678.workers.dev`.

**How it is shaped:** `output: "static"`, because no page depends on request
state — every view reads its data from the visitor's own IndexedDB. So all 21
pages prerender to static HTML and are served directly from Cloudflare's CDN,
and `dist/_routes.json` excludes them from the Worker. Only the twenty-two `/api/**`
endpoints run on demand, each opting in with `export const prerender = false`.
`/` is the static ListBulkly landing page; `/printify-studio` is the workspace.

**Secrets:** the deployed Worker has **no** Printify or AI key, on purpose — this
is a bring-your-own-key app. A visitor pastes their Printify token (and any AI
key) in **Settings → API connections**; it lives in that browser's IndexedDB and
travels on the request as `x-printify-key`, never through the server's storage.
Without a key, the panels say "not configured" instead of borrowing someone
else's, and the core workflow is unaffected.

Only for a self-hosted or preview deployment would you add server-side fallbacks:

```powershell
npx wrangler secret put PRINTIFY_API_KEY   # optional, not used on the public Worker
npx wrangler secret put AI_API_KEY         # optional
```

Secrets are read through `getSecret()` from `astro:env/server`, which is
adapter-provided, so the same code works locally, on Workers, and would survive
a switch to another adapter. Locally, copy `.dev.vars.example` to `.dev.vars`.

**Accounts (optional).** Supabase Auth is server-proxied: the browser calls
`/api/auth/signup`, `/api/auth/signin` and `/api/auth/me`, and never receives a
Supabase key. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to configure it;
`/api/auth/status` then reports the live sign-up mode. With
`SUPABASE_SERVICE_ROLE` set, sign-up creates an already-confirmed account and
sends no mail. With only the anon key, Supabase sends its own confirmation mail
and the account stays unusable until the link is opened at `/auth/confirm`.
The project's built-in sender is rate-limited until a sending domain exists, so
the API says `email rate limit exceeded` rather than claiming success. A
signed-in client can push to `/api/sync/*`; the local tools never require it.



## The workflow

1. **Printify Studio** (`/printify-studio`, the home page) — the workspace. Upload designs; search, rename, tag, duplicate and download them from each card's "…" menu; make white/black ink variants; remove backgrounds in place (the card menu) or in bulk for the ticked designs. Choose the product and its colours, place the artwork (drag, centre snap, 15° rotation), and create one Printify product per ticked design from the Design panel tab. The session survives a reload.
2. **Mockups** — upload product photos, then in **Print areas** give a photo its real print area: a frame on the garment with the area's aspect, the visible window (crop) for a folded shirt, a garment reference for inches, print-area templates and the print-file export. **Save render** composes the design onto the photo and stores it for the Export Center. The mockup follows the Studio's placement, so what the buyer sees and what Printify prints cannot disagree.
3. **Background removal** — two engines, both local and unlimited: *flood-key* (a solid backdrop) and *border-model* (a gradient or vignette). No model download, no key, no upload; a busy photographic background has to be cut out before upload.
4. **Export Center** — real ZIP (fflate) with `MockupStudio_Export/<Design>/original.png`, ink variants, `mockups/`, `listing/`, and a `manifest.json`. The archive is re-read and verified before success is reported; missing assets are listed, not hidden.
5. **Activity** — a log of what actually happened (uploads, saves, renders, exports, errors).
6. **Settings** — workspace storage and API connections (bring your own Printify / AI key).
7. **Agent (in-page panel)** — a floating launcher on **Printify Studio** and **Listing details** opens a streaming chat over the page; it never navigates to a route of its own. Markdown + syntax highlighting, collapsible reasoning blocks, a provider/model picker with favorites and a reasoning-effort pill, and an approximate token/context meter. The agent can really run fourteen tools — explain a workflow, summarize or list the local library, browse the live Printify catalog, draft listing copy, research Etsy, propose a batch job, make a single mockup, save a placement (optionally as a template), make an ink variant, remove a background, save an image you attached in chat as a design or mockup, save listing details, and create a Printify product — shown as expandable activity cards. Every local write runs immediately because the user's own words are the approval; only `create_printify_product` waits for a click, because it uploads artwork and spends the operator's key. When a model answers in prose without calling a tool, a keyword intent router still runs the obvious tool. Conversations persist in this browser's IndexedDB; replies stream over SSE from `/api/ai/chat`; without an AI provider the composer is disabled and points at Settings.

## Architecture notes

- **Astro 5 (`output: "static"` via `@astrojs/cloudflare`) + React 19 islands + TypeScript strict + Tailwind v4.** Every page is a thin `.astro` route that renders one React island; the shell and the view live in a single React tree (`src/routes/*.tsx`) because islands cannot nest and the views need Radix context from `TooltipProvider`.
- **API routes** are Astro endpoints (`src/pages/api/**/*.ts`) exporting `GET`/`POST` as `APIRoute` and returning a plain `Response`. Secrets are read server-side through `src/lib/server/env.ts`.
- **One compositing engine** (`src/lib/canvas/compose.ts`): **Save render**, the agent's `create_mockup_render` and the batch engine all call the same `computeGeometry`/`drawPlacement` math, so a single render, a batch render and an export are the same pixels — exports are full-resolution composites, never screenshots.
- **Transforms are mockup-relative** (fractions of mockup dimensions), so placements survive canvas resize; a print area's frame is stored the same way and travels as a template.
- **Storage**: Dexie (IndexedDB) with metadata and blobs in separate tables; a future server-side migration only needs to swap the repository layer. Schema is versioned (v2 added render-provenance indexes; v3 added the agent-chat `conversations` / `messages` tables).
- **Secrets never ship in the bundle.** Integration keys are either pasted by the
  user in Settings (kept in that browser's IndexedDB, sent only as per-request
  headers to the app's own API routes) or set server-side as secrets. Printify and
  AI calls always go through server endpoints (`src/pages/api/**`), so keys are
  never called from the client directly and never appear in client chunks.
- **Client routing** is a thin `<a>` shim (`src/lib/client/nav.tsx`): `Link` renders a plain anchor and `navigate()` calls `location.assign`, so every navigation is a real document load. A History-API version changed the URL while leaving the old view on screen, so every link looked dead and was replaced.
- **Background removal** is two local engines: flood-key (one flat border colour) then border-model (a background estimated from the border and followed along each row and column). Both are pure and unit-tested; there is no AI model, no worker and no hosted service.
- **Batch rendering** is sequential on the main thread with event-loop yields — item statuses are the source of truth, and the UI stays responsive.

## Verified during development

- Uploads persist across reloads (manual browser QA + E2E).
- A saved render is verified at pixel level: the design's own colour is present just inside the print area and absent just outside it (the clip), at full mockup resolution.
- Background removal verified at pixel level (corner alpha 0, artwork alpha 255, original untouched) for the local engine chain.
- Ink variants verified at pixel level (white = 255,255,255; black = 0,0,0; original intact).
- Export ZIP inspected on disk: exact folder structure, correct per-design files, accurate manifest (counts, provenance, missing-asset notes), archive re-verified programmatically.
- A print area survives a refresh; its crop cuts the design at the fold; its frame can be turned and its chrome hidden without losing the design.
- 666 unit/integration tests in 40 files + 49 E2E acceptance tests, lint clean, `astro check` clean, production build passing and the built Worker verified on every route.

## Known limitations (honest)

- **Not proven live yet.** The Send/Publish path has not been exercised against
  the live Worker with a real key and a real printify.com session, so treat it as
  verified-by-contract, not verified-by-use; Send also stops at an unpublished
  draft and Publish is always a separate click. There is no server-side Printify
  key and none is planned: each visitor pastes their own in Settings. Pricing and
  legal text are PLACEHOLDER. The companion
  extension is a beta unpacked prototype. There is no custom domain yet, so
  production mail (Resend; Supabase verification/reset mail until then),
  reliable account-confirmation mail and Razorpay live mode remain launch
  blockers. Sign-up is instant on the deployed Worker (it carries
  `SUPABASE_SERVICE_ROLE`, so `/api/auth/status` reports
  `signupMode: "instant"`); a local dev run with only the anon key falls back to
  Supabase's confirmation mail, whose built-in sender answers
  `email rate limit exceeded` until a sending domain exists.
- **Account deletion cascades to the profile.** `public.profiles.id` references
  `auth.users` `ON DELETE CASCADE` (`supabase/migrations/004_profile_cascade.sql`);
  without it a user delete failed with a foreign-key error, including Supabase's
  own dashboard action.

- **Keep the project out of OneDrive if you can.** OneDrive turns build caches into cloud placeholders and can hold Astro's `.astro/data-store.json` open, which kills `astro dev` with an `EPERM` rename. The repo works from a synced folder, but if a dev-server crash points at `mutable-data-store.js`, delete `.astro/data-store.json.tmp` and restart (see AGENTS.md).

- **Printify / AI** are wired to the live provider APIs and can be connected from
  **Settings → API connections** (bring your own key). The AI section is a
  provider picker: choose a provider, paste its key, **Load models** to fetch the
  live list (free models tagged from the provider's own pricing where available),
  then **Test connection**. Free tags are best-effort — OpenRouter's real pricing
  is authoritative, other providers use id conventions or their advertised free
  tier. Neither was **verified against a real account** in this environment; Etsy
  listing *submission* is deliberately not implemented as a live call yet (the
  agent drafts copy for you to paste) because Etsy's v3 OAuth flow needs app
  registration; the workspace is ready for it.
- **Background removal handles a solid or faded backdrop only.** Two local engines
  cover flat artwork and a gradient/vignette; a busy photographic background has to
  be cut out before upload. There is no AI model and no hosted service, so there is
  nothing to configure and no usage limit.
- **The Agent chat is complete through milestone M4, and the agent can now do the whole manual workflow.** Replies stream from `/api/ai/chat` over SSE, and the twelve tools run against real local data (tool-activity cards, a Create/Cancel confirm step before any of the seven writing actions, and model-written thread titles): batch-render, single mockup render, save placement/template, ink variant, background removal, save a chat image, and create a Printify product, plus read-only explain/summarize/list/browse/draft. A keyword intent router keeps weak models acting, and voice, steering, and the workspace rail are in place. Printify product creation sends every required field (`print_provider_id`, integer-cent prices, string artwork ids) and resolves the blueprint/provider/variants from a product type without inventing ids. The streaming and tool-calling paths have not been exercised against a real provider account in this environment (they need a pasted key), so they are covered by unit tests over synthetic SSE rather than a live call; voice relies on browser Web Speech support and is hidden where that is absent.
- Perspective/warp editing is **not** offered — Konva cannot do true perspective transforms, and fake controls are worse than none. A print area's frame supports move, uniform scale and rotation only.
- Batch rendering is single-threaded by design (reliability over throughput). The agent's batch tool runs the loop to completion; there is no batch-job list screen any more, so the results are seen in the Export Center.
- Data lives in the browser profile that created it (IndexedDB is per-profile).

## Security

- API keys are never bundled into client code. A visitor may paste their own keys
  in Settings (stored in their browser's IndexedDB); those are only ever sent as
  headers to the app's own `/api/**` routes, which proxy to the provider. Server
  keys live in `.env.local` / Wrangler secrets (git-ignored); no key material is
  present in client bundles (covered by an E2E test).
- The `/api/integrations/test` endpoint makes a read-only probe and persists nothing. `/api/integrations/models` proxies a provider's public model list (read-only, nothing persisted).
- File uploads validated (type, size, emptiness); filenames sanitized against traversal (`sanitizeFilename`).
- No network calls leave the machine in the core workflow. Background removal is local code, so it downloads nothing at all; only the Agent and the Printify endpoints reach a provider, and only when you have configured a key.
