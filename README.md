# Campaign Analyser

Compare Meta ad campaigns, ad sets and ads the way a performance marketer would, and get plain-English verdicts and fixes. Built for **lead-generation** advertisers: it ranks on cost per *qualified* lead, not just cost per lead.

- **Connect Meta** (read-only, `ads_read`), or **import** CSV/XLSX exports from Meta Ads Manager or Google Ads.
- **Daily auto-sync** (a per-account switch) of campaigns, ad sets, ads and daily results. Audience size comes from Meta's delivery estimate; budgets are worked out for the chosen date range.
- **Compare 2–5 items at any level** (campaign, ad set, ad) over any date range, in priority order:
  1. cost and budget
  2. audience and lead quality
  3. duration
  4. supporting signals
- **Funnel view** (L1 reach and impressions → L5 conversions) and an **open / loose / focused** targeting class for each item.
- **Seven charts**, each with a written takeaway, hover tooltips and a table view:
  - budget vs spend
  - share of spend vs share of results
  - cost per lead vs cost per qualified lead
  - a cost-vs-quality map
  - a timeline
  - day-by-day trends (7-day rolling)
- **Fill the gaps**: qualified leads from your CRM and corrections to audience size, budget or targeting. Your entries are kept across syncs.
- **Saved comparisons** that refresh with new data, and **share links**: read-only snapshots that expire and can be revoked.
- **Reports**: HTML (print to PDF), CSV or XLSX.
- **Statistical honesty**: two-proportion z-tests flag gaps that could be chance.

## Run it

You need **Node 22.13 or newer** and no npm packages.

```bash
npm start      # builds the page and starts the server at http://localhost:8787
npm test       # 67 tests: engine, charts, Meta mapping, and the full server against a simulated Meta API on both databases
npm run typecheck   # TypeScript check (after npm install)
```

- Without a `.env`, the server runs in **demo mode** with a simulated ad account. Paste `demo-short-token` into the token box (or use "Continue with Facebook") to try every feature without a Meta app.
- No server? Open `dist/index.html` directly. File import, analysis, charts and downloads all work offline; only the Meta connection needs the server.

## Connect a real Meta ad account
1. Create a Meta app (type **Business**) at developers.facebook.com and add the **Marketing API** product. No Facebook Login, App Review or Business Verification is needed for your own ad accounts.
2. Copy `.env.example` to `.env` and set `META_APP_ID` and `META_APP_SECRET` (App settings → Basic).
3. `npm start`, then in the Meta app go to **Marketing API → Tools**, tick **ads_read** only, click **Get Token**, and paste the token into the analyser's **Paste your access token** box.

The server checks the token belongs to your app and includes `ads_read`, swaps it for a 60-day token and stores it encrypted. Only paste tokens into the app itself; treat them like passwords.

Facebook Login is also built in (`META_LOGIN_MODE=token,oauth`), for when the app has Advanced Access and Business Verification.

## Host it on Vercel
The free Hobby plan works with a Turso database (also free):
1. Import the repository in Vercel (framework preset **Other**; `vercel.json` sets the rest).
2. Add a Turso database from the Vercel Marketplace, connected to the project.
3. Set `META_APP_ID`, `META_APP_SECRET`, `APP_SECRET_KEY` (32 random bytes, base64), `CRON_SECRET` and `BASE_URL` (`https://<project>.vercel.app`).
4. Deploy and open `/api/health`.

Hobby is for non-commercial use. Locally there are no npm dependencies; hosted, `@libsql/client` is the only one.

## How it fits together

```
Browser (dist/index.html)            Node server (server/)                    Meta
  src/core.js   analysis engine   <-- /api/accounts/:id/entities <-- SQLite <-- sync.js <-- Marketing API v25
  src/charts.ts SVG charts            /api/entities/:id/manual                     (daily, plus "Sync now")
  src/app.ts    UI                    /api/comparisons, /api/shares, /r/:token
                                      /auth/meta/token  (pasted token; or OAuth)
                                      /meta/deauthorize, /meta/data-deletion
```

| Path | What it is |
|---|---|
| `src/core.js` | The engine: parsing, column mapping, metrics, funnel, targeting, comparison, rules-based insights and recommendations. Pure functions, shared by browser and tests. |
| `src/charts.ts` | Dependency-free SVG charts (donuts, rings, mirrored gradient columns, bubble map, timeline, smoothed trend lines), shared by the app and the downloaded report. |
| `src/app.ts`, `src/page.html` | Browser UI (Overview, Charts, Details and Fixes views), styles and the in-app guide. |
| `src/types.d.ts` | Shared types for the engine, charts and UI. |
| `build.ts` | Builds `dist/`: strips TypeScript types with Node's built-in stripper, so building needs no npm packages. |
| `server/meta/client.js` | Graph API client: cursor paging, `appsecret_proof`, back-off on rate limits using Meta's usage headers, error classification. |
| `server/meta/map.js` | Meta → analyser mapping: leads from `actions` without double counting, budgets in paise (lifetime budgets pro-rated to the range), objectives, targeting notes, audience estimates. |
| `server/meta/sync.js` | Resumable, incremental sync in time-boxed steps (fits serverless limits). The first run backfills 90 days; later runs re-fetch the last 3 days, because attribution keeps settling. Ranges Meta refuses as too large are split in half. A database lease stops two syncs of the same account. |
| `server/entities.js` | Builds campaign / ad set / ad objects for a date range from daily rows, merged with your manual inputs. |
| `server/app.js` | HTTP API (node:http), sessions, CSRF, share links, usage metering, Meta deletion callbacks, scheduler. |
| `server/db.js` | One async storage interface on two backends: Node's built-in SQLite (local) and Turso/libSQL (Vercel). Schema and column migrations. |
| `api/index.js`, `vercel.json` | Vercel entry point: one function serves everything; daily cron at 00:30 UTC. |
| `mock/meta-mock.js` | A simulated Marketing API: same endpoints and shapes, made-up data, optional rate-limit errors. |
| `tests/` | Engine, charts, Meta mapping and client, and end-to-end server tests. |

## Security and privacy
- **Read-only:** the app asks Meta only for `ads_read`.
- **Tokens stay on the server.** A pasted token is checked against the app (via `appsecret_proof`) and its permissions, then swapped for a long-lived one server-side; the browser never sees it again. The long-lived token is encrypted at rest with AES-256-GCM, and every Graph call carries an `appsecret_proof`.
- **Sessions:**
  - HttpOnly, SameSite=Lax cookies
  - a CSRF token plus an origin check on every write
  - a strict Content-Security-Policy
  - `no-referrer`, so share-link tokens don't leak
- **Meta deauthorize and data-deletion callbacks** are implemented and verify `signed_request`. **Delete my data** in the app removes everything.
- **Shared snapshots** are escaped before being embedded, expire after 30 days by default, and can be revoked.
- **Never commit `data/` or `.env`.** Both are in `.gitignore`.

## Design decisions
- **TypeScript without a build toolchain.** The browser code is TypeScript using only erasable syntax, so Node's built-in type stripping turns it into JavaScript at build time; `tsc` is used only for checking. The server is still JavaScript.
- **Almost no dependencies.** Node built-ins (`node:http`, `node:sqlite`, `fetch`, `crypto`), one CDN script (SheetJS, for Excel files), and `@libsql/client` only when hosted.
- **Serverless-ready.** The same request handler runs under `node server/index.js` and as a single Vercel function. Syncs are resumable steps, not long background jobs.
- **Rules before AI.** Every verdict comes from a named, testable rule over computed metrics, so it can be explained.
- **Daily rows at ad level, added up on demand.** Any level and any date range work without re-fetching. Unique reach is the exception, because it can't be added up, so it is fetched live for the range and cached.
- **A simulated Meta API** for demo mode and tests, so the whole flow is tested without a real ad account or network access.
- **Usage counters, no billing.** Syncs, API calls, share links and saved comparisons are counted, so plan limits are possible later.

## What's next
Phase 2:
- creative fatigue and pacing alerts
- scheduled email reports
- AI-written explanations grounded in the computed numbers
- qualified leads imported by Meta Lead ID
