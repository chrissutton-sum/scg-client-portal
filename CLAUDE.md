# SCG Client Portal

Secure marketing dashboards for Summit Creative Group's clients. Each client signs in and sees live results from the platforms Summit manages for them (GA4, Search Console, Google Business Profile, Google Ads, Facebook, Instagram, Meta Ads), with reporting periods, comparisons over time, data freshness and a log of the work Summit did. The point of the product is showing the value of Summit's work, so numbers must be right and honestly labeled.

- Live: https://scg-client-portal.onrender.com (Render free plan)
- Database: Neon Postgres
- **This repo is public.** Never commit secrets, tokens, real client names or real client data. Demo data only.

## Stack

Node 20+, Express 5, `pg`, `express-session` with `connect-pg-simple`, `helmet`, `express-rate-limit`, `bcryptjs`. Vanilla JS frontend with Chart.js served from `node_modules` at `/vendor/chart.umd.js`. No build step, no framework.

## Run and test

```
npm install
export DATABASE_URL=postgres://... SESSION_SECRET=dev TOKEN_KEY=$(openssl rand -hex 32) DEMO_MODE=1
npm run seed-demo        # two fictional clients with 2 years of data
PORT=3100 npm start      # admin@scg.demo / demo-password-1
npm test                 # in a second terminal
```

`npm test` talks to a running server with the demo seed loaded, at `BASE_URL` (default `http://localhost:3100`), so start the server on 3100 or set `BASE_URL`. The connector tests also need `DATABASE_URL` and `TOKEN_KEY` and write a fake token, so use a throwaway database, never the real Neon one. `DEMO_MODE=1` stops syncs against the fake demo accounts; never set it in production. `npm run sync` runs a full sync by hand.

**Run the tests after any change to login, sessions, the dashboard endpoint or admin routes.** They cover client isolation.

## Layout

| Path | What it is |
|---|---|
| `server.js` | Express app (~400 lines): security middleware, login, `/api/dashboard`, the `/api/admin` router (clients, users, sources, notes, connections, account discovery), OAuth callbacks |
| `db.js` | Pool, schema and migrations. Tables: `clients`, `users`, `provider_tokens`, `sources`, `metrics_daily`, `notes` |
| `report.js` | Dashboard definitions. `SECTIONS` declares each section, its platforms and its KPIs as `calc()` functions over `platform.metric` values |
| `sync.js` | Pulls platform data into `metrics_daily`; also runnable as `node sync.js` |
| `connectors/google.js` | GA4, Search Console, Google Ads, Business Profile |
| `connectors/meta.js` | Facebook Pages, Instagram, Meta Ads |
| `seed-demo.js` | Demo clients and data |
| `public/app.js`, `public/styles.css`, `public/index.html` | Client dashboard and admin UI |
| `public/native.js` | Glue that only runs inside the mobile shell |
| `test/` | `portal.test.js` (access control, reporting), `connectors.test.js` |
| `mobile/` | Capacitor 8 Android shell |

## Security rules (do not weaken)

- A client login is pinned to its own client **on the server**. Never take a client ID from the request for a non-admin user. Every new endpoint needs the same check, plus a test.
- Every non-GET `/api` request must carry the `x-scg: 1` header (CSRF check). The frontend's fetch helper adds it; keep using that helper.
- Sessions live in Postgres, httpOnly + secure cookies, 12-hour rolling expiry. Removing a login or resetting a password must sign that person out immediately.
- Google and Meta tokens are encrypted at rest with AES-256-GCM using `TOKEN_KEY`. Never log tokens or return them from the API.
- Sign-in is rate limited (10 failures locks the IP for 15 minutes) and temporary passwords must be changed on first sign-in.
- There is a strict Content Security Policy: scripts must be same-origin, so no inline scripts and no script CDNs. Vendor through `node_modules` like Chart.js.

## How the data works

- Summit connects each platform once (one Google login, one Meta login or System User token). Admins then map each client's accounts as rows in `sources`.
- `sync.js` claims a source, fetches a date range and upserts into `metrics_daily`. First sync backfills 400 days so "same period last year" works; later syncs refresh the last 5 days because platforms revise recent numbers. Instagram only backfills 90 days.
- Reports run through **yesterday** in the client's timezone. Today is never shown.
- Data refreshes when a dashboard is opened and is older than `STALE_HOURS` (default 6), on "Sync now", or on `SYNC_EVERY_HOURS`.
- To add a metric: fetch it in the connector, then add a KPI to the right entry in `SECTIONS`. Point-in-time counts like followers go in `SNAPSHOT` so they take the latest value instead of being summed.
- Metric definitions are in the README's "Metric notes" (Leads = GA4 key events + Business Profile calls + Meta lead forms; average position is impression-weighted). Keep the README in step if a definition changes.
- If a comparison period starts before the client's data does, the dashboard says so and hides highlights. Don't show inflated percentages.

## Environment

`DATABASE_URL`, `SESSION_SECRET`, `TOKEN_KEY` (losing it makes stored tokens undecryptable), `APP_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `META_APP_ID`, `META_APP_SECRET`. Optional: `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `META_SYSTEM_USER_TOKEN`, `GOOGLE_ADS_API_VERSION`, `META_API_VERSION`, `STALE_HOURS`, `SYNC_EVERY_HOURS`. `render.yaml` still lists `GOOGLE_ADS_DEVELOPER_TOKEN`, which the code no longer reads. New env vars are added in the Render dashboard, tell Chris which ones.

Platform approvals (Google Ads API access, Business Profile API, Meta App Review) are slow and outside the code. A connector failing with a quota or permission error may be a pending approval, not a bug. The README's "Platform setup" section has the details.

## Mobile

`mobile/` is a Capacitor shell that loads the live site, so web changes reach the app as soon as Render deploys. A push to `main` touching `mobile/**` runs `.github/workflows/android.yml`, which builds a signed APK and **commits it back to `main`** in `public/downloads/` with `version.json`. Don't edit those by hand, and pull before pushing. There is no iOS build for this app yet.

## Deploy

Render redeploys automatically on every push to `main`, so **a push to `main` is a production release** that clients see. Health check is `/healthz`.

## Conventions

- Match the existing style and naming. Pragmatic and simple: no wrapper classes, no new dependencies or build tooling without asking. Comments only where the logic isn't obvious.
- Colors come from the shared SCG palette (same as SCG CRM), defined as CSS variables in `public/styles.css`: `--bg #000b19`, `--surface #001630`, `--card #0a2649`, `--sunk #000f22`, `--line #1c3e68`, `--ink #e8ebf0`, `--muted #9ca8b8`, `--blue #0b74b8`, `--accent #00e0f5`, plus `--good`, `--warn`, `--bad`. The same file has a light print stylesheet (`@media print`) for printed reports, so use the variables and check the print view after layout changes.
- This is client-facing. Wording should be plain enough for a business owner who isn't a marketer.
- Explain changes to Chris in plain language, and write any setup steps click by click like the README does.

## Sister apps

SCG CRM (`summit-crm`), SCG Lead Finder (`scg-lead-finder`), SCG Connect (`summit-connect`), SCG Business Audit (`summit-audit`).
