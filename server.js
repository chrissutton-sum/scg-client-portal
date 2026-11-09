const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const { pool, q, migrate } = require('./db');
const { buildReport, addDays, daysBetween } = require('./report');
const { syncClient, syncAll } = require('./sync');
const google = require('./connectors/google');
const meta = require('./connectors/meta');

const PROD = process.env.NODE_ENV === 'production';
const STALE_HOURS = Number(process.env.STALE_HOURS || 6);
const PLATFORMS = {
  ga4: 'Google Analytics 4', gsc: 'Search Console', google_ads: 'Google Ads', gbp: 'Business Profile',
  facebook: 'Facebook Page', instagram: 'Instagram', meta_ads: 'Meta Ads',
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  name: 'scg.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 12 * 3600e3 },
}));

// CSRF: every state-changing API call must carry a custom header, which a
// cross-site form or script can't add without a CORS preflight we never allow.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('x-scg') !== '1') return res.status(403).json({ error: 'Bad request' });
  next();
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Auth

async function loadUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in' });
  // Re-read every request so removed users and role changes take effect immediately
  const { rows: [user] } = await q(`select id, email, name, role, client_id, must_change_password from users where id = $1`, [req.session.userId]);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Please sign in' }); }
  req.user = user;
  const allowed = ['/me', '/password', '/logout'];
  if (user.must_change_password && !allowed.includes(req.path)) return res.status(403).json({ error: 'Please set a new password first' });
  next();
}

const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Not allowed' }));

// The one place that decides which client's data a request may see.
// Client users are pinned to their own client no matter what they ask for.
function clientScope(req) {
  if (req.user.role === 'client') return req.user.client_id;
  const id = Number(req.query.client || req.body?.client_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

app.post('/api/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows: [user] } = await q(`select * from users where email = $1`, [email]);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect' });
  req.session.regenerate(async err => {
    if (err) return res.status(500).json({ error: 'Could not sign in' });
    req.session.userId = user.id;
    await q(`update users set last_login_at = now() where id = $1`, [user.id]);
    // Make sure the session is written before the browser's next request can arrive
    req.session.save(err2 => (err2 ? res.status(500).json({ error: 'Could not sign in' }) : res.json({ ok: true })));
  });
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('scg.sid'); res.json({ ok: true }); }));

app.use('/api', wrap(loadUser));

app.get('/api/me', wrap(async (req, res) => {
  let client = null;
  if (req.user.client_id) client = (await q(`select id, name from clients where id = $1`, [req.user.client_id])).rows[0];
  res.json({ user: req.user, client });
}));

app.post('/api/password', wrap(async (req, res) => {
  const { current, next } = req.body;
  if (typeof next !== 'string' || next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters' });
  const { rows: [u] } = await q(`select password_hash from users where id = $1`, [req.user.id]);
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) return res.status(400).json({ error: 'Current password is incorrect' });
  await q(`update users set password_hash = $1, must_change_password = false where id = $2`, [await bcrypt.hash(next, 12), req.user.id]);
  res.json({ ok: true });
}));

// ---------- Dashboard

const localToday = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s));
const shiftYear = s => { const y = Number(s.slice(0, 4)) - 1; const md = s.slice(5) === '02-29' ? '02-28' : s.slice(5); return `${y}-${md}`; };

function resolvePeriod(range, startQ, endQ, tz) {
  const yesterday = addDays(localToday(tz), -1);
  const y = yesterday.slice(0, 4), m = yesterday.slice(5, 7);
  const monthStart = `${y}-${m}-01`;
  const quarterStart = `${y}-${String(Math.floor((Number(m) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  const presets = {
    last7: [addDays(yesterday, -6), yesterday, 'Last 7 days'],
    last30: [addDays(yesterday, -29), yesterday, 'Last 30 days'],
    last90: [addDays(yesterday, -89), yesterday, 'Last 90 days'],
    this_month: [monthStart, yesterday, 'Month to date'],
    last_month: [(() => { const d = addDays(monthStart, -1); return d.slice(0, 8) + '01'; })(), addDays(monthStart, -1), 'Last month'],
    qtd: [quarterStart, yesterday, 'Quarter to date'],
    ytd: [`${y}-01-01`, yesterday, 'Year to date'],
    last12m: [addDays(yesterday, -364), yesterday, 'Last 12 months'],
  };
  if (range === 'custom' && isDate(startQ) && isDate(endQ) && startQ <= endQ) {
    const end = endQ > yesterday ? yesterday : endQ;
    const start = startQ > end ? end : startQ;
    if (daysBetween(start, end) <= 800) return { key: 'custom', start, end, label: 'Custom range' };
  }
  const key = presets[range] ? range : 'last30';
  const [start, end, label] = presets[key];
  return { key, start: start > end ? end : start, end, label };
}

function resolveCompare(period, mode) {
  if (mode === 'none') return null;
  if (mode === 'year') return { mode, start: shiftYear(period.start), end: shiftYear(period.end), label: 'Same period last year' };
  const len = daysBetween(period.start, period.end) + 1;
  return { mode: 'previous', start: addDays(period.start, -len), end: addDays(period.start, -1), label: 'Previous period' };
}

app.get('/api/dashboard', wrap(async (req, res) => {
  const clientId = clientScope(req);
  if (!clientId) return res.status(400).json({ error: 'Choose a client' });
  const { rows: [client] } = await q(`select id, name, timezone from clients where id = $1`, [clientId]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { rows: sources } = await q(`select id, platform, label, status, last_error, last_synced_at, data_through
                                     from sources where client_id = $1 order by platform, label`, [clientId]);

  // Refresh in the background when the data is getting old, so a viewer never waits on it
  const stale = sources.some(s => !['syncing', 'demo'].includes(s.status) && (!s.last_synced_at || Date.now() - s.last_synced_at > STALE_HOURS * 3600e3));
  if (stale && !process.env.DEMO_MODE) syncClient(clientId).catch(e => console.error('[sync]', e.message));

  const period = resolvePeriod(req.query.range, req.query.start, req.query.end, client.timezone);
  const compare = resolveCompare(period, req.query.compare);
  const report = await buildReport(client, sources, period, compare);

  const { rows: notes } = await q(`select id, to_char(date, 'YYYY-MM-DD') as date, title, body from notes
    where client_id = $1 and date between $2 and $3 order by date desc, id desc`, [clientId, period.start, period.end]);

  const synced = sources.map(s => s.last_synced_at).filter(Boolean);
  res.json({
    client: { id: client.id, name: client.name, timezone: client.timezone },
    period, compare, notes,
    generatedAt: new Date(),
    lastUpdated: synced.length ? new Date(Math.min(...synced.map(Number))) : null,
    refreshing: stale || sources.some(s => s.status === 'syncing'),
    sources: sources.map(s => ({
      platform: s.platform, name: PLATFORMS[s.platform] || s.platform, label: s.label,
      status: s.status, lastSyncedAt: s.last_synced_at,
      dataThrough: s.data_through && s.data_through.toISOString().slice(0, 10),
      ...(req.user.role === 'admin' && { error: s.last_error }),
    })),
    ...report,
  });
}));

// ---------- Admin

const admin = express.Router();
admin.use(requireAdmin);
const tempPassword = () => crypto.randomBytes(9).toString('base64url');
const validTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

admin.get('/clients', wrap(async (req, res) => {
  const { rows } = await q(`
    select c.id, c.name, c.timezone,
      (select count(*)::int from sources s where s.client_id = c.id) as sources,
      (select count(*)::int from sources s where s.client_id = c.id and s.status = 'error') as errors,
      (select count(*)::int from users u where u.client_id = c.id) as users,
      (select min(last_synced_at) from sources s where s.client_id = c.id) as last_synced_at
    from clients c order by c.name`);
  res.json(rows);
}));

admin.post('/clients', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const tz = req.body.timezone || 'America/Boise';
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!validTz(tz)) return res.status(400).json({ error: 'Unknown time zone' });
  const { rows: [c] } = await q(`insert into clients (name, timezone) values ($1, $2) returning *`, [name, tz]);
  res.json(c);
}));

admin.patch('/clients/:id', wrap(async (req, res) => {
  const { name, timezone } = req.body;
  if (timezone && !validTz(timezone)) return res.status(400).json({ error: 'Unknown time zone' });
  await q(`update clients set name = coalesce(nullif($2, ''), name), timezone = coalesce($3, timezone) where id = $1`,
    [req.params.id, name?.trim(), timezone]);
  res.json({ ok: true });
}));

admin.delete('/clients/:id', wrap(async (req, res) => {
  await q(`delete from clients where id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

admin.get('/clients/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const { rows: [client] } = await q(`select * from clients where id = $1`, [id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const [users, sources, notes] = await Promise.all([
    q(`select id, email, name, must_change_password, last_login_at from users where client_id = $1 order by email`, [id]),
    q(`select * from sources where client_id = $1 order by platform, label`, [id]),
    q(`select id, to_char(date, 'YYYY-MM-DD') as date, title, body from notes where client_id = $1 order by date desc limit 50`, [id]),
  ]);
  res.json({ client, users: users.rows, sources: sources.rows, notes: notes.rows });
}));

admin.post('/clients/:id/sync', wrap(async (req, res) => {
  syncClient(Number(req.params.id)).catch(e => console.error('[sync]', e.message));
  res.status(202).json({ ok: true });
}));

admin.get('/users', wrap(async (req, res) => {
  const { rows } = await q(`select id, email, name, last_login_at from users where role = 'admin' order by email`);
  res.json(rows);
}));

admin.post('/users', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'client';
  const clientId = role === 'client' ? Number(req.body.client_id) : null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (role === 'client' && !clientId) return res.status(400).json({ error: 'Pick a client' });
  const password = tempPassword();
  try {
    const { rows: [u] } = await q(`insert into users (email, name, password_hash, role, client_id) values ($1, $2, $3, $4, $5) returning id, email`,
      [email, String(req.body.name || '').trim(), await bcrypt.hash(password, 12), role, clientId]);
    res.json({ ...u, tempPassword: password });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That email already has an account' });
    throw e;
  }
}));

admin.post('/users/:id/reset', wrap(async (req, res) => {
  const password = tempPassword();
  await q(`update users set password_hash = $1, must_change_password = true where id = $2`, [await bcrypt.hash(password, 12), req.params.id]);
  // Sign them out everywhere
  await q(`delete from session where (sess -> 'userId')::text = $1`, [String(req.params.id)]);
  res.json({ tempPassword: password });
}));

admin.delete('/users/:id', wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
  await q(`delete from users where id = $1`, [req.params.id]);
  await q(`delete from session where (sess -> 'userId')::text = $1`, [String(req.params.id)]);
  res.json({ ok: true });
}));

admin.post('/sources', wrap(async (req, res) => {
  const { client_id, platform, external_id, label } = req.body;
  if (!PLATFORMS[platform]) return res.status(400).json({ error: 'Unknown platform' });
  if (!client_id || !String(external_id || '').trim()) return res.status(400).json({ error: 'Pick an account' });
  try {
    const { rows: [s] } = await q(`insert into sources (client_id, platform, external_id, label) values ($1, $2, $3, $4) returning *`,
      [client_id, platform, String(external_id).trim(), String(label || external_id).trim()]);
    syncClient(Number(client_id)).catch(e => console.error('[sync]', e.message));
    res.json(s);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That account is already connected to this client' });
    throw e;
  }
}));

admin.delete('/sources/:id', wrap(async (req, res) => {
  await q(`delete from sources where id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

admin.post('/notes', wrap(async (req, res) => {
  const { client_id, date, title, body } = req.body;
  if (!client_id || !isDate(date) || !String(title || '').trim()) return res.status(400).json({ error: 'Date and title are required' });
  const { rows: [n] } = await q(`insert into notes (client_id, date, title, body, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [client_id, date, String(title).trim().slice(0, 200), String(body || '').trim().slice(0, 2000), req.user.id]);
  res.json(n);
}));

admin.delete('/notes/:id', wrap(async (req, res) => {
  await q(`delete from notes where id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

admin.get('/connections', wrap(async (req, res) => {
  const { rows: [g] } = await q(`select account_name, updated_at from provider_tokens where provider = 'google'`);
  const env = k => Boolean(process.env[k]);
  res.json({
    google: { connected: !!g, account: g?.account_name, configured: env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'),
      adsReady: env('GOOGLE_ADS_LOGIN_CUSTOMER_ID') },
    meta: { ...(await meta.status()), configured: env('META_APP_ID') && env('META_APP_SECRET') },
  });
}));

admin.get('/discover', wrap(async (req, res) => {
  const [g, m] = await Promise.all([google.discover(), meta.discover()]);
  res.json({ ...g, ...m, errors: { ...g.errors, ...m.errors } });
}));

app.use('/api/admin', admin);

// ---------- OAuth (admin only, browser redirects)

async function adminFromSession(req) {
  if (!req.session.userId) return null;
  const { rows: [u] } = await q(`select role from users where id = $1`, [req.session.userId]);
  return u?.role === 'admin';
}

for (const [name, provider] of Object.entries({ google, meta })) {
  app.get(`/oauth/${name}/start`, wrap(async (req, res) => {
    if (!(await adminFromSession(req))) return res.redirect('/');
    req.session.oauthState = crypto.randomBytes(16).toString('hex');
    res.redirect(provider.authUrl(req.session.oauthState));
  }));
  app.get(`/oauth/${name}/callback`, wrap(async (req, res) => {
    const expected = req.session.oauthState;
    delete req.session.oauthState;
    if (!(await adminFromSession(req)) || !expected || req.query.state !== expected) return res.redirect('/#/admin/connections?error=state');
    if (req.query.error || !req.query.code) return res.redirect(`/#/admin/connections?error=${encodeURIComponent(req.query.error || 'denied')}`);
    try {
      await provider.handleCallback(String(req.query.code));
      res.redirect(`/#/admin/connections?connected=${name}`);
    } catch (e) {
      console.error(`[oauth ${name}]`, e.message);
      res.redirect(`/#/admin/connections?error=${encodeURIComponent(e.message.slice(0, 200))}`);
    }
  }));
}

// ---------- Static app

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: PROD ? '1h' : 0 }));
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.js')));
app.get(/^\/(?!api|oauth).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

async function bootstrapAdmin() {
  const { rows: [{ n }] } = await q(`select count(*)::int as n from users where role = 'admin'`);
  if (n || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  await q(`insert into users (email, name, password_hash, role, must_change_password) values ($1, 'Admin', $2, 'admin', true)`,
    [process.env.ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)]);
  console.log(`Created first admin ${process.env.ADMIN_EMAIL}`);
}

if (require.main === module) {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  migrate().then(bootstrapAdmin).then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`SCG Client Portal on :${port}`));
    // Demo clients for previewing before real accounts connect. Reseeded each start so dates stay current.
    if (process.env.SEED_DEMO) require('./seed-demo').seedDemo().catch(e => console.error('[demo]', e.message));
    if (process.env.SYNC_EVERY_HOURS && !process.env.DEMO_MODE) {
      setInterval(() => syncAll().catch(e => console.error('[sync]', e.message)), Number(process.env.SYNC_EVERY_HOURS) * 3600e3);
    }
  });
}

module.exports = { app, resolvePeriod, resolveCompare };
