// Demo data so the dashboards can be reviewed before the Google/Meta APIs are approved.
// Usage: node seed-demo.js   (run with DEMO_MODE=1 on the server so it won't try to sync fake accounts)
const bcrypt = require('bcryptjs');
const { q, pool, migrate } = require('./db');
const { addDays } = require('./report');

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const noise = (amt = 0.15) => 1 + (rand() - 0.5) * 2 * amt;

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Boise' }).format(new Date());
const END = addDays(today, -1);
const DAYS = 800;
const STARTED = 150; // Summit took over this many days ago

// 0 before Summit started, easing up to 1 over ~4 months
const ramp = daysAgo => { const t = Math.max(0, (STARTED - daysAgo) / 120); return Math.min(1, t * (2 - t)); };

const CLIENTS = [
  {
    name: 'Ridgeline Diesel & Auto', login: 'owner@ridgeline.demo', person: 'Dana Ridgeline',
    weekday: [0.55, 1.1, 1.1, 1.05, 1.05, 1.0, 0.7], // Sun..Sat
    sources: {
      ga4: ['412233901', 'ridgelinediesel.com'],
      gsc: ['sc-domain:ridgelinediesel.com', 'ridgelinediesel.com'],
      gbp: ['8823411009', 'Ridgeline Diesel & Auto — Caldwell'],
      google_ads: ['5512238841', 'Ridgeline Diesel (551-223-8841)'],
      facebook: ['104422771', 'Ridgeline Diesel & Auto'],
    },
    gen: (r, w) => ({
      ga4: (() => { const s = 95 * (1 + 0.55 * r) * w * noise(); return { sessions: s, new_users: s * 0.66, page_views: s * 2.4, engaged_sessions: s * (0.5 + 0.1 * r), key_events: s * 0.024 * (1 + 0.5 * r) }; })(),
      gsc: (() => { const i = 2600 * (1 + 0.7 * r) * w * noise(); return { impressions: i, clicks: i * (0.028 + 0.012 * r), position_x_impr: i * (16 - 6 * r) }; })(),
      gbp: { views: 210 * (1 + 0.6 * r) * w * noise(), calls: 4.5 * (1 + 0.8 * r) * w * noise(0.4), directions: 3 * (1 + 0.5 * r) * w * noise(0.4), website_clicks: 6 * (1 + 0.6 * r) * w * noise(0.3) },
      google_ads: r > 0.02 ? (() => { const sp = 42 * noise(0.1); const c = sp / (2.6 - 0.6 * r) * w; const conv = c * (0.05 + 0.04 * r) * noise(0.4); return { spend: sp, clicks: c, impressions: c * 15, conversions: conv, conv_value: conv * 420 }; })() : null,
      facebook: { views: 340 * (1 + 0.9 * r) * noise(0.35), engagements: 18 * (1 + 1.2 * r) * noise(0.4), new_followers: 1.2 * (1 + 1.5 * r) * noise(0.6) },
    }),
    followers: { facebook: 1450 },
    notes: [
      [140, 'Took over Google Business Profile', 'Rebuilt the listing: services, photos, hours and a weekly post schedule.'],
      [118, 'Launched new website', 'Faster site with a quote request form on every page.'],
      [92, 'Started Google Ads: "diesel repair near me"', 'Search campaign targeting Caldwell, Nampa and Boise.'],
      [55, 'SEO: 6 new service pages', 'Fleet service, DPF cleaning, mobile repair, and more.'],
      [21, 'Review request campaign', 'Texted the last 90 days of customers asking for Google reviews.'],
    ],
  },
  {
    name: 'Sawtooth Coffee Co.', login: 'owner@sawtooth.demo', person: 'Sam Sawtooth',
    weekday: [1.25, 0.85, 0.9, 0.9, 0.95, 1.1, 1.35],
    sources: {
      ga4: ['398811245', 'sawtoothcoffee.com'],
      gsc: ['https://sawtoothcoffee.com/', 'sawtoothcoffee.com'],
      gbp: ['5521190034', 'Sawtooth Coffee Co. — Boise'],
      facebook: ['200188433', 'Sawtooth Coffee Co.'],
      instagram: ['17841400991', '@sawtoothcoffee'],
      meta_ads: ['2201983344', 'Sawtooth Coffee Ads'],
    },
    gen: (r, w) => ({
      ga4: (() => { const s = 160 * (1 + 0.4 * r) * w * noise(); return { sessions: s, new_users: s * 0.71, page_views: s * 3.1, engaged_sessions: s * (0.56 + 0.06 * r), key_events: s * 0.011 * (1 + 0.6 * r) }; })(),
      gsc: (() => { const i = 3900 * (1 + 0.45 * r) * w * noise(); return { impressions: i, clicks: i * (0.035 + 0.008 * r), position_x_impr: i * (11 - 3 * r) }; })(),
      gbp: { views: 520 * (1 + 0.4 * r) * w * noise(), calls: 2.5 * (1 + 0.3 * r) * w * noise(0.5), directions: 22 * (1 + 0.45 * r) * w * noise(0.3), website_clicks: 11 * (1 + 0.4 * r) * w * noise(0.3) },
      facebook: { views: 520 * (1 + 0.5 * r) * noise(0.4), engagements: 35 * (1 + 0.7 * r) * noise(0.4), new_followers: 2 * (1 + 0.8 * r) * noise(0.6) },
      instagram: { views: 1300 * (1 + 1.3 * r) * w * noise(0.4), engagements: 85 * (1 + 1.4 * r) * noise(0.4), new_followers: 4 * (1 + 2 * r) * noise(0.6) },
      meta_ads: r > 0.15 ? (() => { const sp = 28 * noise(0.1); const imp = sp * 95; const lc = imp * 0.012; return { spend: sp, impressions: imp, link_clicks: lc, leads: lc * (0.05 + 0.05 * r) * noise(0.5) }; })() : null,
    }),
    followers: { facebook: 3100, instagram: 5400 },
    notes: [
      [146, 'Content plan kickoff', 'Monthly photo shoot plus 4 Reels a week on Instagram.'],
      [104, 'Meta Ads: catering lead form', 'Lead form campaign for office and event catering.'],
      [70, 'Holiday blend launch campaign', 'Organic posts, email, and a 2-week Meta boost.'],
      [33, 'Google Business Profile refresh', 'New menu photos, products and Q&A.'],
      [8, 'New website menu pages', 'Seasonal drinks and catering pages with order buttons.'],
    ],
  },
];

// withLogins: create the demo logins with a known password. Local testing only, never on the live site.
async function seedDemo({ withLogins = false } = {}) {
  await q(`delete from clients where name = any($1)`, [CLIENTS.flatMap(c => [c.name, `${c.name} (Demo)`])]);

  const hash = withLogins && await bcrypt.hash('demo-password-1', 12);
  if (withLogins) await q(`insert into users (email, name, password_hash, role, must_change_password) values ('admin@scg.demo', 'Summit Admin', $1, 'admin', false)
           on conflict (email) do nothing`, [hash]);

  for (const c of CLIENTS) {
    const { rows: [client] } = await q(`insert into clients (name) values ($1) returning id`, [`${c.name}${withLogins ? '' : ' (Demo)'}`]);
    if (withLogins) {
      await q(`delete from users where email = $1`, [c.login]);
      await q(`insert into users (email, name, password_hash, role, client_id, must_change_password, last_login_at)
               values ($1, $2, $3, 'client', $4, false, now() - interval '2 days')`, [c.login, c.person, hash, client.id]);
    }

    const ids = {};
    for (const [platform, [ext, label]] of Object.entries(c.sources)) {
      const { rows: [s] } = await q(`insert into sources (client_id, platform, external_id, label, status, last_synced_at, data_through)
        values ($1, $2, $3, $4, 'demo', now() - interval '47 minutes', $5) returning id`, [client.id, platform, ext, label, END]);
      ids[platform] = s.id;
    }

    const rows = { s: [], d: [], m: [], v: [] };
    const followers = { ...c.followers };
    for (let ago = DAYS - 1; ago >= 0; ago--) {
      const date = addDays(END, -ago);
      const w = c.weekday[new Date(date + 'T12:00:00Z').getUTCDay()];
      const day = c.gen(ramp(ago), w);
      for (const [platform, metrics] of Object.entries(day)) {
        if (!metrics || !ids[platform]) continue;
        for (const [metric, value] of Object.entries(metrics)) {
          const val = ['spend', 'conv_value', 'position_x_impr'].includes(metric) ? Math.round(value * 100) / 100 : Math.max(0, Math.round(value));
          rows.s.push(ids[platform]); rows.d.push(date); rows.m.push(metric); rows.v.push(val);
          if (metric === 'new_followers' && followers[platform] != null) followers[platform] += val;
        }
        if (followers[platform] != null) {
          rows.s.push(ids[platform]); rows.d.push(date); rows.m.push('followers'); rows.v.push(followers[platform]);
        }
      }
    }
    await q(`insert into metrics_daily (client_id, source_id, date, metric, value)
             select $1, s, d::date, m, v from unnest($2::int[], $3::text[], $4::text[], $5::float8[]) as t(s, d, m, v)`,
      [client.id, rows.s, rows.d, rows.m, rows.v]);

    for (const [ago, title, body] of c.notes) {
      await q(`insert into notes (client_id, date, title, body) values ($1, $2, $3, $4)`, [client.id, addDays(END, -ago), title, body]);
    }
    console.log(`Seeded ${c.name}: ${rows.s.length} data points${withLogins ? `, login ${c.login}` : ''}`);
  }
  if (withLogins) console.log('Admin login: admin@scg.demo / demo-password-1 (client logins use the same password)');
}

module.exports = { seedDemo };

if (require.main === module) {
  migrate().then(() => seedDemo({ withLogins: true }))
    .catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
