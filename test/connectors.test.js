// Checks each connector parses the platform's response shape correctly, using canned responses.
// Needs DATABASE_URL and TOKEN_KEY (it stores a fake Google token).
const test = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, encrypt } = require('../db');
const google = require('../connectors/google');
const meta = require('../connectors/meta');

let responses = [];
global.fetch = async (url, opts = {}) => {
  const hit = responses.find(r => String(url).includes(r.match));
  if (!hit) throw new Error(`Unexpected request ${url}`);
  hit.seen = { url: String(url), opts };
  return { ok: true, status: 200, json: async () => hit.body };
};
const respond = list => { responses = list; };

test.before(async () => {
  await migrate();
  await q(`insert into provider_tokens (provider, account_name, access_token_enc, refresh_token_enc, expires_at)
           values ('google', 'test', $1, $1, now() + interval '1 hour') on conflict (provider) do update set access_token_enc = $1, expires_at = now() + interval '1 hour'`, [encrypt('tok')]);
  process.env.META_SYSTEM_USER_TOKEN = 'meta-tok';
});
test.after(async () => { await q(`delete from provider_tokens where account_name = 'test'`); await pool.end(); });

const pick = (rows, date, metric) => rows.find(r => r.date === date && r.metric === metric)?.value;

test('GA4', async () => {
  respond([{ match: 'runReport', body: { rows: [{ dimensionValues: [{ value: '20261105' }], metricValues: ['100', '60', '250', '55', '3'].map(value => ({ value })) }] } }]);
  const rows = await google.fetchers.ga4('123', '2026-11-01', '2026-11-06');
  assert.equal(pick(rows, '2026-11-05', 'sessions'), 100);
  assert.equal(pick(rows, '2026-11-05', 'key_events'), 3);
  assert.equal(responses[0].seen.opts.headers.Authorization, 'Bearer tok');
});

test('Search Console stores weighted position', async () => {
  respond([{ match: 'searchAnalytics', body: { rows: [{ keys: ['2026-11-05'], clicks: 10, impressions: 200, position: 7.5 }] } }]);
  const rows = await google.fetchers.gsc('sc-domain:x.com', '2026-11-01', '2026-11-06');
  assert.equal(pick(rows, '2026-11-05', 'position_x_impr'), 1500);
  assert.ok(responses[0].seen.url.includes(encodeURIComponent('sc-domain:x.com')));
});

test('Google Ads converts micros and sends the manager account ID', async () => {
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '123-456-7890';
  respond([{ match: 'googleAds:search', body: { results: [{ segments: { date: '2026-11-05' }, metrics: { costMicros: '42500000', clicks: '17', impressions: '300', conversions: 2.5, conversionsValue: 900 } }] } }]);
  const rows = await google.fetchers.google_ads('555-111-2222', '2026-11-01', '2026-11-06');
  assert.equal(pick(rows, '2026-11-05', 'spend'), 42.5);
  assert.equal(pick(rows, '2026-11-05', 'conversions'), 2.5);
  assert.ok(responses[0].seen.url.includes('/customers/5551112222/'));
  assert.equal(responses[0].seen.opts.headers['login-customer-id'], '1234567890');
  assert.ok(!('developer-token' in responses[0].seen.opts.headers));
});

test('Google Ads discovery without a manager account lists directly accessible accounts', async () => {
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  respond([
    { match: 'listAccessibleCustomers', body: { resourceNames: ['customers/111'] } },
    { match: 'customers/111/googleAds:search', body: { results: [{ customer: { id: '111', descriptiveName: 'Acme', manager: false } }] } },
    { match: 'analyticsadmin', body: {} }, { match: 'webmasters', body: {} }, { match: 'mybusinessaccountmanagement', body: {} },
  ]);
  const d = await google.discover();
  assert.deepEqual(d.google_ads, [{ id: '111', label: 'Acme (111)' }]);
});

test('Business Profile sums the four impression types into views', async () => {
  const series = (dailyMetric, value) => ({ dailyMetric, timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 5 }, value }] } });
  respond([{ match: 'fetchMultiDailyMetricsTimeSeries', body: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
    series('CALL_CLICKS', '4'), series('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', '10'), series('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', '25'),
    { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 5 } }] } },
  ] }] } }]);
  const rows = await google.fetchers.gbp('999', '2026-11-01', '2026-11-06');
  assert.equal(pick(rows, '2026-11-05', 'views'), 35);
  assert.equal(pick(rows, '2026-11-05', 'calls'), 4);
  assert.equal(pick(rows, '2026-11-05', 'website_clicks'), 0);
});

test('Meta Ads counts lead actions', async () => {
  respond([{ match: '/insights', body: { data: [{ date_start: '2026-11-05', spend: '30.10', impressions: '2900', inline_link_clicks: '41',
    actions: [{ action_type: 'lead', value: '3' }, { action_type: 'link_click', value: '41' }] }] } }]);
  const rows = await meta.fetchers.meta_ads('act_2201', '2026-11-01', '2026-11-06');
  assert.equal(pick(rows, '2026-11-05', 'leads'), 3);
  assert.equal(pick(rows, '2026-11-05', 'spend'), 30.1);
  assert.ok(responses[0].seen.url.includes('/act_2201/insights'));
});

test('Facebook page shifts end_time back a day', async () => {
  respond([
    { match: 'fields=access_token', body: { access_token: 'page-tok' } },
    { match: '/insights', body: { data: [{ values: [{ end_time: '2026-11-06T08:00:00+0000', value: 77 }] }] } },
  ]);
  const rows = await meta.fetchers.facebook('104', '2026-11-01', '2026-11-03');
  assert.equal(pick(rows, '2026-11-05', 'views'), 77);
});
