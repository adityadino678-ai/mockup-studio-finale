# DEPLOYMENT.md — Mockup Studio

How this app is built, deployed, and verified. For architecture reasoning see
[AGENTS.md](./AGENTS.md).

## Live

**https://mockup-studio.adityadino678.workers.dev**

Public. No login, no account. Every visitor gets their own empty workspace,
stored in their own browser.

## Cloudflare accounts

| | |
|---|---|
| Account | `Adityadino678@gmail.com's Account` |
| Account ID | `d9d43da4a430000a58df02d35e8d519c` |
| workers.dev subdomain | `adityadino678` |
| Worker | `mockup-studio` |
| Worker URL | `mockup-studio.adityadino678.workers.dev` |

The Worker shares an account with an older project (`shy-morning-46e6`) and three
Pages projects (`voiceshift`, `voiceshift2`, `voiceshift3`). Do not disturb them.

## Prerequisites

- Node.js 22+ (tested on v24.14.0)
- `npm install`
- `npx playwright install chromium` once, for the e2e suite

## Local development

```powershell
npm run dev        # http://localhost:3000
```

Or double-click `..\start.cmd` from the parent folder, which checks Node,
installs dependencies on first run, opens the browser and starts the server.

## Build shape

`output: "static"` on `@astrojs/cloudflare@12.6.13`.

```
npm run build
  └─ astro build          12 pages -> static HTML in dist/
  └─ postbuild.mjs        writes dist/.assetsignore containing "_worker.js"
```

Because no page depends on request state (all data is in the visitor's
IndexedDB), every page is prerendered and served from Cloudflare's CDN. Only the
five `/api/**` endpoints render on demand; each sets
`export const prerender = false`. The generated `dist/_routes.json` excludes the
pages and `/_astro/*` from the Worker.

`dist/.assetsignore` is mandatory. Without it wrangler aborts the deploy because
it would otherwise upload the server-side Worker directory as a public asset.
`scripts/postbuild.mjs` recreates it after every build, since `dist/` is
regenerated and git-ignored.

## Deploying

```powershell
npm run deploy      # npm run build && wrangler deploy
```

Auth is a wrangler OAuth token already stored on this machine at
`%APPDATA%\xdg.config\.wrangler\config\default.toml`. Verify with
`npx wrangler whoami`.

Expected tail of a successful deploy:

```
Uploaded mockup-studio (23.61 sec)
Deployed mockup-studio triggers (2.47 sec)
  https://mockup-studio.adityadino678.workers.dev
```

A `523` error in the first minute after a first deploy is normal — Cloudflare
propagates the subdomain; it resolves itself.

To deploy a preview: `npx wrangler versions upload`

## Automatic deploys — NOT YET CONNECTED

Workers Builds has not been linked to the repository. To enable, one dashboard
step:

1. Cloudflare → **Workers & Pages** → `mockup-studio`
2. **Settings** → **Builds** → **Connect repository**
3. Authorise GitHub, choose `adityadino678-ai/mockup-studio-finale`
4. Build command: `npm run build`
5. Deploy command: `npx wrangler deploy`

There are no secrets to configure, so CI needs no secret management. Every push
to `main` will then rebuild and redeploy.

## Verification

```powershell
npm run lint
npm run typecheck
npm run test          # 27 unit
npm run test:e2e      # 15 acceptance, local dev server
```

Against production:

```powershell
$env:BASE_URL = "https://mockup-studio.adityadino678.workers.dev"
npx playwright test
```

Smoke test by hand:

```powershell
Invoke-WebRequest https://mockup-studio.adityadino678.workers.dev -UseBasicParsing
(Invoke-WebRequest https://mockup-studio.adityadino678.workers.dev/api/integrations/status -UseBasicParsing).Content
```

Every route should return 200, and the status endpoint should report
`configured: false` for `printify`, `etsy` and `ai`.

## Integrations and secrets

No API keys are deployed. That is deliberate: the core workflow — upload, edit,
batch, background removal, ink variants, templates, ZIP export — needs no keys,
and with none present every integration endpoint returns 503 before doing any
work, so the public attack surface is effectively nil.

To enable in production:

```powershell
npx wrangler secret put PRINTIFY_API_KEY
npx wrangler secret put AI_API_KEY
```

Supported names: `PRINTIFY_API_KEY`, `ETSY_API_KEY`, `ETSY_ACCESS_TOKEN`,
`ETSY_SHOP_ID`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `OPENAI_API_KEY`.

Locally, copy `.dev.vars.example` to `.dev.vars`.

**Before enabling Printify:** the product-creation endpoint accepts a 25 MB
base64 artwork payload, which exceeds the Workers 128 MB memory limit. Lower
`MAX_UPLOAD_BYTES` in `src/pages/api/printify/products.ts` and stream or resize
the artwork first.

## Backups

A source ZIP of the committed tree lives at
`..\mockup-studio-finale-source.zip`. Regenerate with:

```powershell
git archive --format=zip --output="..\mockup-studio-finale-source.zip" HEAD
```

Note this is a *source* backup only. It does not contain a visitor's library,
which lives in that browser's IndexedDB and can only be exported from inside the
app via the Export Center.
