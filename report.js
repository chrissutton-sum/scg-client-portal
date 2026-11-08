const { q } = require('./db');

// Platform metrics that are point-in-time counts (take the latest value, don't sum)
const SNAPSHOT = new Set(['followers']);

const div = (a, b) => (b ? a / b : null);
const v = key => m => m[key] ?? null;

// Each section only shows up when the client has one of its platforms connected.
// calc() gets a map of "platform.metric" -> value for a period or a chart bucket.
const SECTIONS = [
  {
    key: 'leads', title: 'Leads', platforms: ['ga4', 'gbp', 'meta_ads'],
    blurb: 'Website conversions, Google Business Profile calls and Meta lead forms combined.',
    kpis: [
      { key: 'total', label: 'Total leads', fmt: 'int', chart: true,
        calc: m => sumOf(m, ['ga4.key_events', 'gbp.calls', 'meta_ads.leads']) },
      { key: 'web', label: 'Website conversions', fmt: 'int', calc: v('ga4.key_events') },
      { key: 'calls', label: 'Calls from Google', fmt: 'int', calc: v('gbp.calls') },
      { key: 'forms', label: 'Meta lead forms', fmt: 'int', calc: v('meta_ads.leads') },
    ],
  },
  {
    key: 'website', title: 'Website', platforms: ['ga4'],
    blurb: 'Traffic and engagement on your website (Google Analytics 4).',
    kpis: [
      { key: 'visits', label: 'Visits', fmt: 'int', chart: true, calc: v('ga4.sessions') },
      { key: 'new', label: 'New visitors', fmt: 'int', calc: v('ga4.new_users') },
      { key: 'views', label: 'Page views', fmt: 'int', calc: v('ga4.page_views') },
      { key: 'engagement', label: 'Engagement rate', fmt: 'pct', calc: m => div(m['ga4.engaged_sessions'], m['ga4.sessions']) },
    ],
  },
  {
    key: 'search', title: 'Google Search', platforms: ['gsc'],
    blurb: 'How often you show up and get clicked in Google search results (Search Console).',
    kpis: [
      { key: 'clicks', label: 'Search clicks', fmt: 'int', chart: true, calc: v('gsc.clicks') },
      { key: 'impressions', label: 'Times shown in search', fmt: 'int', calc: v('gsc.impressions') },
      { key: 'ctr', label: 'Click-through rate', fmt: 'pct', calc: m => div(m['gsc.clicks'], m['gsc.impressions']) },
      { key: 'position', label: 'Average position', fmt: 'dec', better: 'down',
        calc: m => div(m['gsc.position_x_impr'], m['gsc.impressions']) },
    ],
  },
  {
    key: 'gbp', title: 'Google Business Profile', platforms: ['gbp'],
    blurb: 'Activity on your Google Maps and Search listing.',
    kpis: [
      { key: 'views', label: 'Profile views', fmt: 'int', chart: true, calc: v('gbp.views') },
      { key: 'calls', label: 'Calls', fmt: 'int', calc: v('gbp.calls') },
      { key: 'directions', label: 'Direction requests', fmt: 'int', calc: v('gbp.directions') },
      { key: 'site', label: 'Website clicks', fmt: 'int', calc: v('gbp.website_clicks') },
    ],
  },
  {
    key: 'social', title: 'Social media', platforms: ['facebook', 'instagram'],
    blurb: 'Organic Facebook and Instagram results.',
    kpis: [
      { key: 'reach', label: 'Views', fmt: 'int', chart: true, calc: m => sumOf(m, ['facebook.views', 'instagram.views']) },
      { key: 'engagement', label: 'Engagements', fmt: 'int', calc: m => sumOf(m, ['facebook.engagements', 'instagram.engagements']) },
      { key: 'newfollowers', label: 'New followers', fmt: 'int', calc: m => sumOf(m, ['facebook.new_followers', 'instagram.new_followers']) },
      { key: 'followers', label: 'Total followers', fmt: 'int', snapshot: true, calc: m => sumOf(m, ['facebook.followers', 'instagram.followers']) },
    ],
  },
  {
    key: 'google_ads', title: 'Google Ads', platforms: ['google_ads'],
    blurb: 'Paid search and display campaigns.',
    kpis: [
      { key: 'conversions', label: 'Conversions', fmt: 'int', chart: true, calc: v('google_ads.conversions') },
      { key: 'spend', label: 'Spend', fmt: 'usd', neutral: true, calc: v('google_ads.spend') },
      { key: 'clicks', label: 'Clicks', fmt: 'int', calc: v('google_ads.clicks') },
      { key: 'cpa', label: 'Cost per conversion', fmt: 'usd', better: 'down', calc: m => div(m['google_ads.spend'], m['google_ads.conversions']) },
      { key: 'cpc', label: 'Cost per click', fmt: 'usd', better: 'down', calc: m => div(m['google_ads.spend'], m['google_ads.clicks']) },
      { key: 'roas', label: 'Return on ad spend', fmt: 'x', calc: m => div(m['google_ads.conv_value'], m['google_ads.spend']) },
    ],
  },
  {
    key: 'meta_ads', title: 'Meta Ads', platforms: ['meta_ads'],
    blurb: 'Facebook and Instagram ad campaigns.',
    kpis: [
      { key: 'results', label: 'Leads', fmt: 'int', chart: true, calc: v('meta_ads.leads') },
      { key: 'spend', label: 'Spend', fmt: 'usd', neutral: true, calc: v('meta_ads.spend') },
      { key: 'impressions', label: 'Ad impressions', fmt: 'int', calc: v('meta_ads.impressions') },
      { key: 'clicks', label: 'Link clicks', fmt: 'int', calc: v('meta_ads.link_clicks') },
      { key: 'cpl', label: 'Cost per lead', fmt: 'usd', better: 'down', calc: m => div(m['meta_ads.spend'], m['meta_ads.leads']) },
    ],
  },
];

function sumOf(m, keys) {
  let total = null;
  for (const k of keys) if (m[k] != null) total = (total || 0) + m[k];
  return total;
}

// Totals for a date range: sums, except snapshot metrics take each source's latest value
async function totals(clientId, start, end) {
  const { rows } = await q(`
    select s.platform, m.metric, sum(m.value)::float as value
    from metrics_daily m join sources s on s.id = m.source_id
    where m.client_id = $1 and m.date between $2 and $3 and not (m.metric = any($4))
    group by 1, 2
    union all
    select platform, metric, sum(value)::float from (
      select distinct on (m.source_id, m.metric) s.platform, m.metric, m.value
      from metrics_daily m join sources s on s.id = m.source_id
      where m.client_id = $1 and m.date between $2 and $3 and m.metric = any($4)
      order by m.source_id, m.metric, m.date desc
    ) latest group by 1, 2`, [clientId, start, end, [...SNAPSHOT]]);
  const out = {};
  for (const r of rows) out[`${r.platform}.${r.metric}`] = r.value;
  return out;
}

async function daily(clientId, start, end) {
  const { rows } = await q(`
    select to_char(m.date, 'YYYY-MM-DD') as date, s.platform, m.metric, sum(m.value)::float as value
    from metrics_daily m join sources s on s.id = m.source_id
    where m.client_id = $1 and m.date between $2 and $3
    group by 1, 2, 3`, [clientId, start, end]);
  const byDate = {};
  for (const r of rows) (byDate[r.date] ||= {})[`${r.platform}.${r.metric}`] = r.value;
  return byDate;
}

// Date helpers on plain YYYY-MM-DD strings (UTC math avoids DST surprises)
const toD = s => new Date(s + 'T00:00:00Z');
const fromD = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => fromD(new Date(toD(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((toD(b) - toD(a)) / 864e5);

// Buckets: daily up to ~3 months, weekly up to ~1 year, monthly beyond
function buckets(start, end) {
  const span = daysBetween(start, end) + 1;
  const unit = span <= 93 ? 'day' : span <= 380 ? 'week' : 'month';
  const out = [];
  if (unit === 'week') {
    // Count weeks back from the end so the newest bucket is always a full week;
    // a leftover stub at the start gets folded into the first week
    for (let e = end; e >= start; e = addDays(e, -7)) {
      const s = addDays(e, -6);
      out.unshift({ start: s < start ? start : s, end: e });
    }
    if (out.length > 1 && daysBetween(out[0].start, out[0].end) < 6) out.splice(0, 2, { start: out[0].start, end: out[1].end });
    return { unit, list: out };
  }
  let cur = start;
  while (cur <= end) {
    let next;
    if (unit === 'day') next = addDays(cur, 1);
    else if (unit === 'week') next = addDays(cur, 7);
    else { const d = toD(cur); next = fromD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))); }
    const last = addDays(next, -1) < end ? addDays(next, -1) : end;
    out.push({ start: cur, end: last });
    cur = next;
  }
  return { unit, list: out };
}

function rollup(byDate, b) {
  const m = {};
  const latest = {};
  for (let d = b.start; d <= b.end; d = addDays(d, 1)) {
    for (const [k, val] of Object.entries(byDate[d] || {})) {
      if (SNAPSHOT.has(k.split('.')[1])) latest[k] = val;
      else m[k] = (m[k] || 0) + val;
    }
  }
  return Object.assign(m, latest);
}

const round = n => (n == null || !isFinite(n) ? null : Math.round(n * 10000) / 10000);

async function buildReport(client, sources, period, compare) {
  const platforms = new Set(sources.map(s => s.platform));
  const cur = await totals(client.id, period.start, period.end);
  const prev = compare ? await totals(client.id, compare.start, compare.end) : null;
  const curDaily = await daily(client.id, period.start, period.end);
  const prevDaily = compare ? await daily(client.id, compare.start, compare.end) : null;
  const curB = buckets(period.start, period.end);
  const prevB = compare ? buckets(compare.start, compare.end) : null;

  const sections = [];
  for (const sec of SECTIONS) {
    if (!sec.platforms.some(p => platforms.has(p))) continue;
    const kpis = sec.kpis.map(k => ({
      key: k.key, label: k.label, fmt: k.fmt,
      better: k.neutral ? 'neutral' : (k.better || 'up'),
      snapshot: !!k.snapshot,
      value: round(k.calc(cur)),
      prev: prev ? round(k.calc(prev)) : null,
    })).filter(k => k.value != null || k.prev != null);
    if (!kpis.length) continue;

    const chartKpi = sec.kpis.find(k => k.chart);
    const chart = chartKpi && {
      label: chartKpi.label, fmt: chartKpi.fmt, unit: curB.unit,
      points: curB.list.map((b, i) => ({
        start: b.start, end: b.end,
        value: round(chartKpi.calc(rollup(curDaily, b))),
        prev: prevB && prevB.list[i] ? round(chartKpi.calc(rollup(prevDaily, prevB.list[i]))) : null,
      })),
    };
    sections.push({ key: sec.key, title: sec.title, blurb: sec.blurb, kpis, chart });
  }

  // If tracking started partway through the comparison period, % changes would be inflated
  let compareGap = null;
  if (compare) {
    const { rows: [r] } = await q(`select to_char(min(date), 'YYYY-MM-DD') as first from metrics_daily where client_id = $1`, [client.id]);
    if (r.first && r.first > compare.start) compareGap = r.first;
  }

  return { sections, compareGap, highlights: compareGap ? [] : highlights(sections) };
}

// Plain-English call-outs: the biggest wins, plus one honest "worth watching"
function highlights(sections) {
  const changes = [];
  for (const s of sections) for (const k of s.kpis) {
    if (k.better === 'neutral' || k.value == null || !k.prev) continue;
    const pct = (k.value - k.prev) / Math.abs(k.prev);
    if (!isFinite(pct) || Math.abs(pct) < 0.05) continue;
    const good = k.better === 'down' ? pct < 0 : pct > 0;
    changes.push({ section: s.title, label: k.label, fmt: k.fmt, value: k.value, prev: k.prev, pct, good,
      weight: Math.abs(pct) * (k.fmt === 'int' && k.value < 20 ? 0.5 : 1) });
  }
  changes.sort((a, b) => b.weight - a.weight);
  // The same number can appear in two sections (e.g. calls under Leads and Business Profile)
  const seen = new Set();
  const unique = changes.filter(c => { const k = `${c.value}|${c.prev}`; return !seen.has(k) && seen.add(k); });
  const wins = unique.filter(c => c.good).slice(0, 3);
  const watch = unique.filter(c => !c.good).slice(0, 1);
  return [...wins, ...watch];
}

module.exports = { buildReport, SECTIONS, addDays, daysBetween };
