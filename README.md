# SCG Client Portal

Secure per-client marketing dashboards for Summit Creative Group clients. Each client signs in and sees live results from their website, Google Search, Business Profile, social and ads in one place, with reporting periods, comparisons, data freshness and a log of the work Summit did.

**Stack:** Node/Express, Postgres (Neon), vanilla JS + Chart.js. Hosted on Render, same as the other SCG apps.

## How it works

- **Summit connects once per platform.** One Summit Google login covers GA4, Search Console, Google Ads (through the manager account) and Business Profile for every client it can access. One Meta login (or System User token) covers Facebook Pages, Instagram and ad accounts.
- **Admins map accounts to clients.** On a client's page, pick their GA4 property, Search Console site, Ads account, etc. from the dropdown. The first sync pulls ~13 months of history so "same period last year" works.
- **Syncing.** Data refreshes automatically when anyone opens a dashboard and it's more than 6 hours old (`STALE_HOURS`), plus "Sync now" in admin. For a fixed schedule, add a Render Cron Job running `node sync.js` (paid) or set `SYNC_EVERY_HOURS` on the web service.
- **Freshness.** Reports always run through *yesterday*, because platforms finalize each day overnight. Every account shows its last sync time and the latest day of data.

## Security

- Client logins are pinned to their own client on the server. A client can't request another client's data even by editing the URL (covered by tests).
- Passwords hashed with bcrypt; temporary passwords must be changed on first sign-in; 10 failed sign-ins locks that IP out for 15 minutes.
- Sessions stored in Postgres, httpOnly + secure cookies, 12-hour rolling expiry. Removing a login or resetting a password signs that person out immediately.
- CSRF protection on every write, strict Content Security Policy, OAuth state checks.
- Google/Meta tokens are encrypted at rest (AES-256-GCM with `TOKEN_KEY`).

## Environment variables

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `SESSION_SECRET` | Long random string |
| `TOKEN_KEY` | 64 hex chars: `openssl rand -hex 32`. Don't lose it, tokens can't be decrypted without it |
| `APP_URL` | e.g. `https://scg-client-portal.onrender.com` (no trailing slash) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Creates the first admin on first start (must change password on sign-in) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | From the manager account's API Center |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Summit's manager (MCC) account ID |
| `META_APP_ID`, `META_APP_SECRET` | Meta developer app |
| `META_SYSTEM_USER_TOKEN` | Optional, recommended: never-expiring token from Business Manager |
| `GOOGLE_ADS_API_VERSION`, `META_API_VERSION` | Optional, default `v21` / `v24.0` |
| `STALE_HOURS`, `SYNC_EVERY_HOURS` | Optional sync tuning |

## Platform setup (one time)

These approvals take anywhere from a day to a few weeks, so start them first.

**Google Cloud** (console.cloud.google.com, signed in as Summit's agency Google account)
1. Create a project, e.g. "SCG Client Portal".
2. Enable: Google Analytics Data API, Google Analytics Admin API, Google Search Console API, Google Ads API, My Business Account Management API, My Business Business Information API, Business Profile Performance API.
3. OAuth consent screen: External, add the scopes the app asks for, then **Publish to production**. Leaving it in "Testing" makes the login expire every 7 days. Since only Summit staff sign in through it, Google's unverified-app warning is fine to click through.
4. Credentials → OAuth client ID → Web application. Authorized redirect URI: `{APP_URL}/oauth/google/callback`.

**Google Ads:** In the Summit manager account, Tools → API Center, request a developer token and apply for **Basic access** (test access only reads test accounts).

**Business Profile:** Request API access using Google's Business Profile API access form. Until it's approved the quota is 0 and those calls fail.

**Meta** (developers.facebook.com)
1. Create a Business-type app connected to Summit's Business Manager, add Facebook Login for Business.
2. Valid OAuth redirect URI: `{APP_URL}/oauth/meta/callback`.
3. Request `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights`, `ads_read`, `business_management`. Reading client-owned assets needs **Advanced Access**, which means App Review and Business Verification.
4. Recommended: Business Settings → System Users → create an admin system user, assign it the client pages/IG/ad accounts, generate a token with the scopes above, and set it as `META_SYSTEM_USER_TOKEN`.

## Running locally

```bash
npm install
export DATABASE_URL=postgres://... SESSION_SECRET=dev TOKEN_KEY=$(openssl rand -hex 32) DEMO_MODE=1
npm run seed-demo     # two fictional demo clients with 2 years of data
npm start             # http://localhost:3000, admin@scg.demo / demo-password-1
npm test              # needs the server running with the demo seed on BASE_URL (default :3100)
```

`DEMO_MODE=1` stops the app from trying to sync the demo clients' fake accounts. Don't set it in production.

## Metric notes

- **Leads** = GA4 key events + Business Profile calls + Meta lead form submissions. Google Ads conversions are shown in the Ads section only, since they usually overlap with GA4 key events.
- **Average position** is impression-weighted, so it's correct over any date range.
- **Total followers** is the count at the end of the period. History builds from the day the account is connected, since the platforms don't expose past follower counts.
- Instagram history backfills 90 days; everything else ~13 months.
- If a comparison period starts before the client's data does, the dashboard says so and hides the highlights instead of showing inflated percentages.
