// Pulls fresh numbers from each connected platform into metrics_daily.
// Run on a schedule with `node sync.js` (Render cron job), or per client from the admin panel.
const { q, pool, migrate } = require('./db');
const { addDays } = require('./report');
const google = require('./connectors/google');
const meta = require('./connectors/meta');

const fetchers = { ...google.fetchers, ...meta.fetchers };
const BACKFILL_DAYS = 400; // enough for "same period last year" comparisons
const REFRESH_DAYS = 5;    // platforms revise the last few days (GA4, Ads conversions, Search Console lag)

const localToday = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function syncSource(sourceId) {
  // Claim the source so two syncs never run on it at once (stale claims expire after 30 min)
  const { rows: [src] } = await q(`
    update sources s set status = 'syncing', sync_started_at = now()
    from clients c where s.id = $1 and c.id = s.client_id
      and (s.status <> 'syncing' or s.sync_started_at < now() - interval '30 minutes')
    returning s.*, c.timezone`, [sourceId]);
  if (!src) return { skipped: true };

  const end = addDays(localToday(src.timezone), -1); // today is still in progress, so stop at yesterday
  const start = src.last_synced_at ? addDays(end, -REFRESH_DAYS) : addDays(end, -BACKFILL_DAYS);
  try {
    const fetch = fetchers[src.platform];
    if (!fetch) throw new Error(`No connector for ${src.platform}`);
    const rows = await fetch(src.external_id, start, end);
    await saveRows(src, rows);
    await q(`update sources set status = 'ok', last_error = null, last_synced_at = now(),
               data_through = (select max(date) from metrics_daily where source_id = $1) where id = $1`, [src.id]);
    return { ok: true, rows: rows.length };
  } catch (e) {
    await q(`update sources set status = 'error', last_error = $2 where id = $1`, [src.id, e.message.slice(0, 500)]);
    return { ok: false, error: e.message };
  }
}

async function saveRows(src, rows) {
  // Collapse duplicates (same date+metric) before the upsert
  const merged = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.metric}`;
    merged.set(k, r.metric === 'followers' ? r.value : (merged.get(k) || 0) + r.value);
  }
  const keys = [...merged.keys()];
  for (let i = 0; i < keys.length; i += 5000) {
    const chunk = keys.slice(i, i + 5000);
    await q(`insert into metrics_daily (client_id, source_id, date, metric, value)
             select $1, $2, d::date, m, v from unnest($3::text[], $4::text[], $5::float8[]) as t(d, m, v)
             on conflict (source_id, date, metric) do update set value = excluded.value`,
      [src.client_id, src.id, chunk.map(k => k.split('|')[0]), chunk.map(k => k.split('|')[1]), chunk.map(k => merged.get(k))]);
  }
}

async function syncClient(clientId) {
  const { rows } = await q(`select id from sources where client_id = $1 order by id`, [clientId]);
  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await syncSource(r.id)) });
  return results;
}

async function syncAll() {
  const { rows } = await q(`select id, platform, external_id from sources order by client_id, id`);
  for (const r of rows) {
    const res = await syncSource(r.id);
    console.log(`[sync] ${r.platform} ${r.external_id}:`, res.ok ? `${res.rows} rows` : res.skipped ? 'skipped (already running)' : `ERROR ${res.error}`);
  }
}

module.exports = { syncSource, syncClient, syncAll };

if (require.main === module) {
  migrate().then(syncAll).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
