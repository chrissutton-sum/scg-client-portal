// Meta: Facebook Pages, Instagram business accounts and ad accounts.
// Uses a System User token from Business Manager if set (never expires),
// otherwise the long-lived user token from the OAuth flow (~60 days).
const { q, encrypt, decrypt } = require('../db');
const { addDays } = require('../report');

const VERSION = process.env.META_API_VERSION || 'v24.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic',
  'instagram_manage_insights', 'ads_read', 'business_management'];
const redirectUri = () => `${process.env.APP_URL}/oauth/meta/callback`;

function authUrl(state) {
  const p = new URLSearchParams({ client_id: process.env.META_APP_ID, redirect_uri: redirectUri(), state, scope: SCOPES.join(',') });
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${p}`;
}

async function get(path, params = {}, token) {
  const url = `${path.startsWith('http') ? path : GRAPH + path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ ...params, ...(token && { access_token: token }) })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || res.statusText);
  return data;
}

async function getAll(path, params, token) {
  const out = [];
  let d = await get(path, params, token);
  out.push(...(d.data || []));
  while (d.paging?.next) { d = await get(d.paging.next); out.push(...(d.data || [])); }
  return out;
}

async function handleCallback(code) {
  const app = { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET };
  const short = await get('/oauth/access_token', { ...app, redirect_uri: redirectUri(), code });
  const long = await get('/oauth/access_token', { ...app, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token });
  const me = await get('/me', { fields: 'name' }, long.access_token);
  await q(`insert into provider_tokens (provider, account_name, access_token_enc, expires_at, updated_at)
           values ('meta', $1, $2, now() + make_interval(secs => $3), now())
           on conflict (provider) do update set account_name = $1, access_token_enc = $2,
             expires_at = now() + make_interval(secs => $3), updated_at = now()`,
    [me.name, encrypt(long.access_token), long.expires_in || 60 * 86400]);
}

async function userToken() {
  if (process.env.META_SYSTEM_USER_TOKEN) return process.env.META_SYSTEM_USER_TOKEN;
  const { rows: [row] } = await q(`select * from provider_tokens where provider = 'meta'`);
  if (!row) throw new Error('Meta is not connected. Connect it under Admin → Connections.');
  if (row.expires_at < new Date()) throw new Error('Meta login expired. Reconnect it under Admin → Connections.');
  return decrypt(row.access_token_enc);
}

const pageTokens = new Map();
async function pageToken(pageId) {
  if (!pageTokens.has(pageId)) pageTokens.set(pageId, (await get(`/${pageId}`, { fields: 'access_token' }, await userToken())).access_token);
  return pageTokens.get(pageId);
}

async function discover() {
  const out = { facebook: [], instagram: [], meta_ads: [], errors: {} };
  try {
    const token = await userToken();
    const pages = await getAll('/me/accounts', { fields: 'id,name,instagram_business_account{id,username}', limit: 100 }, token);
    out.facebook = pages.map(p => ({ id: p.id, label: p.name }));
    out.instagram = pages.filter(p => p.instagram_business_account)
      .map(p => ({ id: p.instagram_business_account.id, label: `@${p.instagram_business_account.username} (${p.name})` }));
    const ads = await getAll('/me/adaccounts', { fields: 'account_id,name', limit: 100 }, token);
    out.meta_ads = ads.map(a => ({ id: a.account_id, label: `${a.name} (${a.account_id})` }));
  } catch (e) { out.errors.meta = e.message; }
  return out;
}

const unix = d => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000);
const ymd = iso => iso.slice(0, 10);

// Split a date range into windows the API will accept
function windows(start, end, maxDays) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, maxDays)) {
    const e = addDays(s, maxDays - 1);
    out.push([s, e < end ? e : end]);
  }
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);

async function fetchFacebook(pageId, start, end) {
  const token = await pageToken(pageId);
  const rows = [];
  const metrics = { page_media_view: 'views', page_post_engagements: 'engagements', page_daily_follows_unique: 'new_followers' };
  // Pull each metric on its own so one deprecated metric doesn't sink the rest
  for (const [apiName, metric] of Object.entries(metrics)) {
    for (const [s, e] of windows(start, end, 90)) {
      const d = await get(`/${pageId}/insights`, { metric: apiName, period: 'day', since: unix(s), until: unix(addDays(e, 1)) }, token)
        .catch(err => { if (/valid insights metric/i.test(err.message)) return { data: [] }; throw err; });
      // Facebook stamps each day with the following midnight
      for (const series of d.data || []) for (const val of series.values || [])
        rows.push({ date: addDays(ymd(val.end_time), -1), metric, value: Number(val.value) || 0 });
    }
  }
  if (end >= addDays(today(), -2)) {
    const page = await get(`/${pageId}`, { fields: 'followers_count' }, token);
    rows.push({ date: end, metric: 'followers', value: page.followers_count || 0 });
  }
  return rows;
}

async function fetchInstagram(igId, start, end) {
  const token = await userToken();
  const rows = [];
  // views and total_interactions only come as totals, so ask one day at a time.
  // Instagram keeps limited history, so backfill caps at 90 days.
  const floor = addDays(end, -89);
  for (let d = start < floor ? floor : start; d <= end; d = addDays(d, 1)) {
    const r = await get(`/${igId}/insights`, {
      metric: 'views,total_interactions,follows_and_unfollows', metric_type: 'total_value', period: 'day',
      since: unix(d), until: unix(addDays(d, 1)),
    }, token).catch(() => ({ data: [] }));
    for (const m of r.data || []) {
      if (m.name === 'views') rows.push({ date: d, metric: 'views', value: m.total_value?.value || 0 });
      if (m.name === 'total_interactions') rows.push({ date: d, metric: 'engagements', value: m.total_value?.value || 0 });
      if (m.name === 'follows_and_unfollows') {
        const follows = (m.total_value?.breakdowns?.[0]?.results || []).find(x => x.dimension_values?.includes('FOLLOWER'));
        rows.push({ date: d, metric: 'new_followers', value: follows?.value || 0 });
      }
    }
  }
  if (end >= addDays(today(), -2)) {
    const acct = await get(`/${igId}`, { fields: 'followers_count' }, token);
    rows.push({ date: end, metric: 'followers', value: acct.followers_count || 0 });
  }
  return rows;
}

async function fetchMetaAds(accountId, start, end) {
  const token = await userToken();
  const rows = [];
  for (const [s, e] of windows(start, end, 90)) {
    const data = await getAll(`/act_${accountId.replace(/^act_/, '')}/insights`, {
      level: 'account', time_increment: 1, limit: 500,
      fields: 'spend,impressions,inline_link_clicks,actions',
      time_range: JSON.stringify({ since: s, until: e }),
    }, token);
    for (const r of data) {
      const date = r.date_start;
      const leads = (r.actions || []).filter(a => a.action_type === 'lead').reduce((n, a) => n + Number(a.value), 0);
      rows.push(
        { date, metric: 'spend', value: Number(r.spend || 0) },
        { date, metric: 'impressions', value: Number(r.impressions || 0) },
        { date, metric: 'link_clicks', value: Number(r.inline_link_clicks || 0) },
        { date, metric: 'leads', value: leads },
      );
    }
  }
  return rows;
}

async function status() {
  if (process.env.META_SYSTEM_USER_TOKEN) return { connected: true, account: 'System User token', expiresAt: null };
  const { rows: [row] } = await q(`select account_name, expires_at from provider_tokens where provider = 'meta'`);
  return row ? { connected: true, account: row.account_name, expiresAt: row.expires_at } : { connected: false };
}

module.exports = {
  authUrl, handleCallback, discover, status,
  fetchers: { facebook: fetchFacebook, instagram: fetchInstagram, meta_ads: fetchMetaAds },
};
