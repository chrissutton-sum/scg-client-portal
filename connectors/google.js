// Google: one OAuth grant (Summit's agency Google account) covers GA4, Search Console,
// Google Ads and Business Profile for every client that account can access.
const { q, encrypt, decrypt } = require('../db');

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/business.manage',
];
const ADS_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v21';
const redirectUri = () => `${process.env.APP_URL}/oauth/google/callback`;

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${data.error_description || data.error}`);
  return data;
}

async function handleCallback(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const email = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url')).email : null;
  await q(`insert into provider_tokens (provider, account_name, refresh_token_enc, access_token_enc, expires_at, updated_at)
           values ('google', $1, $2, $3, now() + make_interval(secs => $4), now())
           on conflict (provider) do update set account_name = $1, refresh_token_enc = coalesce($2, provider_tokens.refresh_token_enc),
             access_token_enc = $3, expires_at = now() + make_interval(secs => $4), updated_at = now()`,
    [email, encrypt(t.refresh_token), encrypt(t.access_token), t.expires_in - 60]);
}

async function accessToken() {
  const { rows: [row] } = await q(`select * from provider_tokens where provider = 'google'`);
  if (!row) throw new Error('Google is not connected. Connect it under Admin → Connections.');
  if (row.expires_at > new Date()) return decrypt(row.access_token_enc);
  const t = await tokenRequest({ refresh_token: decrypt(row.refresh_token_enc), grant_type: 'refresh_token' });
  await q(`update provider_tokens set access_token_enc = $1, expires_at = now() + make_interval(secs => $2) where provider = 'google'`,
    [encrypt(t.access_token), t.expires_in - 60]);
  return t.access_token;
}

async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Array.isArray(data) ? data[0]?.error : data.error;
    throw new Error(`${res.status} ${err?.message || res.statusText}`);
  }
  return data;
}

const adsHeaders = () => ({
  'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID && { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '') }),
});

async function adsSearch(customerId, query) {
  const rows = [];
  let pageToken;
  do {
    const data = await api(`https://googleads.googleapis.com/${ADS_VERSION}/customers/${customerId}/googleAds:search`,
      { method: 'POST', headers: adsHeaders(), body: { query, ...(pageToken && { pageToken }) } });
    rows.push(...(data.results || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return rows;
}

// ---- Discovery: what the connected Google account can see, for mapping to clients

async function discover() {
  const out = { ga4: [], gsc: [], google_ads: [], gbp: [], errors: {} };
  const tryIt = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = e.message; } };

  await tryIt('ga4', async () => {
    const d = await api('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
    return (d.accountSummaries || []).flatMap(a => (a.propertySummaries || []).map(p =>
      ({ id: p.property.replace('properties/', ''), label: `${p.displayName} (${a.displayName})` })));
  });
  await tryIt('gsc', async () => {
    const d = await api('https://www.googleapis.com/webmasters/v3/sites');
    return (d.siteEntry || []).filter(s => s.permissionLevel !== 'siteUnverifiedUser').map(s => ({ id: s.siteUrl, label: s.siteUrl }));
  });
  await tryIt('google_ads', async () => {
    const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
    if (!mcc) throw new Error('Set GOOGLE_ADS_LOGIN_CUSTOMER_ID (your manager account ID)');
    const rows = await adsSearch(mcc, `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager
      FROM customer_client WHERE customer_client.level <= 1`);
    return rows.filter(r => !r.customerClient.manager)
      .map(r => ({ id: String(r.customerClient.id), label: `${r.customerClient.descriptiveName || 'Unnamed'} (${r.customerClient.id})` }));
  });
  await tryIt('gbp', async () => {
    const accts = await api('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    const list = [];
    for (const a of accts.accounts || []) {
      let pageToken;
      do {
        const d = await api(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const l of d.locations || []) {
          const city = l.storefrontAddress?.locality;
          list.push({ id: l.name.replace('locations/', ''), label: city ? `${l.title} — ${city}` : l.title });
        }
        pageToken = d.nextPageToken;
      } while (pageToken);
    }
    return list;
  });
  return out;
}

// ---- Fetchers: each returns [{ date: 'YYYY-MM-DD', metric, value }]

async function fetchGa4(propertyId, start, end) {
  const d = await api(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    body: {
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [{ name: 'date' }],
      metrics: ['sessions', 'newUsers', 'screenPageViews', 'engagedSessions', 'keyEvents'].map(name => ({ name })),
      limit: 100000,
    },
  });
  const names = ['sessions', 'new_users', 'page_views', 'engaged_sessions', 'key_events'];
  return (d.rows || []).flatMap(r => {
    const raw = r.dimensionValues[0].value;
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return names.map((metric, i) => ({ date, metric, value: Number(r.metricValues[i].value) }));
  });
}

async function fetchGsc(siteUrl, start, end) {
  const d = await api(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: 'POST', body: { startDate: start, endDate: end, dimensions: ['date'], rowLimit: 25000 },
  });
  return (d.rows || []).flatMap(r => [
    { date: r.keys[0], metric: 'clicks', value: r.clicks },
    { date: r.keys[0], metric: 'impressions', value: r.impressions },
    // Stored weighted so average position stays correct across any date range
    { date: r.keys[0], metric: 'position_x_impr', value: r.position * r.impressions },
  ]);
}

async function fetchGoogleAds(customerId, start, end) {
  const rows = await adsSearch(customerId.replace(/-/g, ''), `SELECT segments.date, metrics.cost_micros, metrics.clicks,
      metrics.impressions, metrics.conversions, metrics.conversions_value
    FROM customer WHERE segments.date BETWEEN '${start}' AND '${end}'`);
  return rows.flatMap(r => {
    const m = r.metrics, date = r.segments.date;
    return [
      { date, metric: 'spend', value: Number(m.costMicros || 0) / 1e6 },
      { date, metric: 'clicks', value: Number(m.clicks || 0) },
      { date, metric: 'impressions', value: Number(m.impressions || 0) },
      { date, metric: 'conversions', value: Number(m.conversions || 0) },
      { date, metric: 'conv_value', value: Number(m.conversionsValue || 0) },
    ];
  });
}

const GBP_METRICS = {
  CALL_CLICKS: 'calls', BUSINESS_DIRECTION_REQUESTS: 'directions', WEBSITE_CLICKS: 'website_clicks',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'views', BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'views',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'views', BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'views',
};

async function fetchGbp(locationId, start, end) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const p = new URLSearchParams({
    'dailyRange.startDate.year': sy, 'dailyRange.startDate.month': sm, 'dailyRange.startDate.day': sd,
    'dailyRange.endDate.year': ey, 'dailyRange.endDate.month': em, 'dailyRange.endDate.day': ed,
  });
  for (const m of Object.keys(GBP_METRICS)) p.append('dailyMetrics', m);
  const d = await api(`https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${p}`);

  const totals = {}; // views is the sum of four impression metrics
  for (const series of d.multiDailyMetricTimeSeries || []) {
    for (const s of series.dailyMetricTimeSeries || []) {
      const metric = GBP_METRICS[s.dailyMetric];
      for (const dv of s.timeSeries?.datedValues || []) {
        const date = `${dv.date.year}-${String(dv.date.month).padStart(2, '0')}-${String(dv.date.day).padStart(2, '0')}`;
        const key = `${date}|${metric}`;
        totals[key] = (totals[key] || 0) + Number(dv.value || 0);
      }
    }
  }
  return Object.entries(totals).map(([k, value]) => { const [date, metric] = k.split('|'); return { date, metric, value }; });
}

module.exports = {
  authUrl, handleCallback, discover,
  fetchers: { ga4: fetchGa4, gsc: fetchGsc, google_ads: fetchGoogleAds, gbp: fetchGbp },
};
