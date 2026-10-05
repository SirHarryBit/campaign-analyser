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
npm test       # 53 tests: engine, charts, Meta mapping, and the full server against a simulated Meta API on both databases
```

- Without a `.env`, the server runs in **demo mode**: "Continue with Facebook" connects to a simulated ad account, so you can try every feature without a Meta app.
- To use a real ad account, follow [SETUP-META.md](SETUP-META.md).
- No server? Open `dist/index.html` directly. File import, analysis, charts and downloads all work offline; only the Meta connection needs the server.
- **Host it on Vercel** (free Hobby plan) with a Turso database: [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md). Locally there are no npm dependencies; hosted, `@libsql/client` is the only one.

## How it fits together

```
Browser (dist/index.html)            Node server (server/)                    Meta
  src/core.js   analysis engine   <-- /api/accounts/:id/entities <-- SQLite <-- sync.js <-- Marketing API v25
  src/charts.js SVG charts            /api/entities/:id/manual                     (daily, plus "Sync now")
  src/app.js    UI                    /api/comparisons, /api/shares, /r/:token
                                      /auth/meta/*  (OAuth code flow)
                                      /meta/deauthorize, /meta/data-deletion
```

| Path | What it is |
|---|---|
| `src/core.js` | The engine: parsing, column mapping, metrics, funnel, targeting, comparison, rules-based insights and recommendations. Pure functions, shared by browser and tests. |
| `src/charts.js` | Dependency-free SVG charts, shared by the app and the downloaded report. |
| `src/app.js`, `src/page.html` | Browser UI, styles and the in-app guide. |
| `server/meta/client.js` | Graph API client: cursor paging, `appsecret_proof`, back-off on rate limits using Meta's usage headers, error classification. |
| `server/meta/map.js` | Meta → analyser mapping: leads from `actions` without double counting, budgets in paise (lifetime budgets pro-rated to the range), objectives, targeting notes, audience estimates. |
| `server/meta/sync.js` | Resumable, incremental sync in time-boxed steps (fits serverless limits). The first run backfills 90 days; later runs re-fetch the last 3 days, because attribution keeps settling. Ranges Meta refuses as too large are split in half. A database lease stops two syncs of the same account. |
| `server/entities.js` | Builds campaign / ad set / ad objects for a date range from daily rows, merged with your manual inputs. |
| `server/app.js` | HTTP API (node:http), sessions, CSRF, share links, usage metering, Meta deletion callbacks, scheduler. |
| `server/db.js` | One async storage interface on two backends: Node's built-in SQLite (local) and Turso/libSQL (Vercel). Schema and column migrations. |
| `api/index.js`, `vercel.json` | Vercel entry point: one function serves everything; daily cron at 00:30 UTC. |
| `mock/meta-mock.js` | A simulated Marketing API: same endpoints and shapes, made-up data, optional rate-limit errors. |
| `tests/` | Engine, charts, Meta mapping and client, and end-to-end server tests. |
| `GUIDE.md`, `SETUP-META.md`, `ROADMAP.md` | Usage guide, Meta setup, product roadmap. |

## Security and privacy
- **Read-only:** the app asks Meta only for `ads_read`.
- **Tokens stay on the server.** The OAuth code exchange happens server-side. The long-lived token is encrypted at rest with AES-256-GCM, and every Graph call carries an `appsecret_proof`.
- **Sessions:**
  - HttpOnly, SameSite=Lax cookies
  - a CSRF token plus an origin check on every write
  - a strict Content-Security-Policy
  - `no-referrer`, so share-link tokens don't leak
- **Meta deauthorize and data-deletion callbacks** are implemented and verify `signed_request`. **Delete my data** in the app removes everything.
- **Shared snapshots** are escaped before being embedded, expire after 30 days by default, and can be revoked.
- **Never commit `data/` or `.env`.** Both are in `.gitignore`.

## Design decisions
- **Almost no dependencies.** Plain JavaScript, Node built-ins (`node:http`, `node:sqlite`, `fetch`, `crypto`), one CDN script (SheetJS, for Excel files), and `@libsql/client` only when hosted.
- **Serverless-ready.** The same request handler runs under `node server/index.js` and as a single Vercel function. Syncs are resumable steps, not long background jobs.
- **Rules before AI.** Every verdict comes from a named, testable rule over computed metrics, so it can be explained.
- **Daily rows at ad level, added up on demand.** Any level and any date range work without re-fetching. Unique reach is the exception, because it can't be added up, so it is fetched live for the range and cached.
- **A simulated Meta API** for demo mode and tests, so the whole flow is tested without a real ad account or network access.
- **Usage counters, no billing.** Syncs, API calls, share links and saved comparisons are counted, so plan limits are possible later.

## What's next
See [ROADMAP.md](ROADMAP.md). Phase 2 is:
- creative fatigue and pacing alerts
- scheduled email reports
- AI-written explanations grounded in the computed numbers
- qualified leads imported by Meta Lead ID
