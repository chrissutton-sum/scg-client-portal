// Runs against a server with the demo seed loaded: node --test (BASE_URL defaults to localhost:3100)
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const PW = 'demo-password-1';
const addYears = (s, n) => `${Number(s.slice(0, 4)) + n}${s.slice(4)}`;

async function login(email, password = PW) {
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-scg': '1' }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, call: (path, opts = {}) => call(path, { ...opts, cookie }) };
}

async function call(path, { method = 'GET', body, cookie, csrf = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(cookie && { cookie }), ...(csrf && { 'x-scg': '1' }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('signed-out requests are rejected', async () => {
  assert.equal((await call('/api/dashboard')).status, 401);
  assert.equal((await call('/api/admin/clients')).status, 401);
});

test('wrong password is rejected with a generic message', async () => {
  const r = await login('owner@ridgeline.demo', 'nope');
  assert.equal(r.status, 401);
  const r2 = await login('nobody@x.demo', 'nope');
  assert.equal(r2.status, 401);
});

test('client users only ever see their own client', async () => {
  const admin = await login('admin@scg.demo');
  const clients = (await admin.call('/api/admin/clients')).body;
  const ridge = clients.find(c => c.name.startsWith('Ridgeline'));
  const saw = clients.find(c => c.name.startsWith('Sawtooth'));

  const owner = await login('owner@ridgeline.demo');
  const own = await owner.call('/api/dashboard');
  assert.equal(own.status, 200);
  assert.equal(own.body.client.id, ridge.id);

  // Asking for another client's data is ignored, not honored
  const sneaky = await owner.call(`/api/dashboard?client=${saw.id}`);
  assert.equal(sneaky.body.client.id, ridge.id);
  assert.ok(!sneaky.body.sources.some(s => s.label.includes('Sawtooth')));

  for (const path of ['/api/admin/clients', `/api/admin/clients/${saw.id}`, '/api/admin/discover', '/api/admin/connections']) {
    assert.equal((await owner.call(path)).status, 403, path);
  }
  assert.equal((await owner.call(`/api/admin/clients/${saw.id}`, { method: 'DELETE' })).status, 403);
  // Clients don't see internal error details
  assert.ok(own.body.sources.every(s => !('error' in s)));
});

test('state-changing calls need the CSRF header', async () => {
  const admin = await login('admin@scg.demo');
  const r = await admin.call('/api/admin/clients', { method: 'POST', body: { name: 'x' }, csrf: false });
  assert.equal(r.status, 403);
});

test('dashboard returns sections, comparisons and freshness', async () => {
  const owner = await login('owner@sawtooth.demo');
  const d = (await owner.call('/api/dashboard?range=last30&compare=previous')).body;
  assert.deepEqual(d.sections.map(s => s.key), ['leads', 'website', 'search', 'gbp', 'social', 'meta_ads']);
  assert.ok(d.lastUpdated && d.compare && d.period.end < new Date().toISOString().slice(0, 10));
  const leads = d.sections[0].kpis[0];
  assert.ok(leads.value > 0 && leads.prev > 0);
  assert.equal(d.sections[0].chart.points.length, 30);

  const year = (await owner.call('/api/dashboard?range=last12m&compare=year')).body;
  assert.equal(year.sections[0].chart.unit, 'week');
  assert.equal(year.compare.start.slice(0, 4), String(Number(year.period.start.slice(0, 4)) - 1));
  assert.equal(year.compareGap, null);
  assert.ok(year.highlights.length > 0);
  const last = year.sections[0].chart.points.at(-1);
  assert.equal(last.end, year.period.end);
  assert.equal(last.start, new Date(Date.parse(last.end) - 6 * 864e5).toISOString().slice(0, 10));

  // Comparing against a time before tracking started is flagged and highlights are withheld
  const early = (await owner.call('/api/dashboard?range=last12m&compare=year&client=0')).body;
  const longAgo = (await owner.call(`/api/dashboard?range=custom&start=${addYears(early.period.start, -1)}&end=${addYears(early.period.end, -1)}&compare=year`)).body;
  assert.ok(longAgo.compareGap);
  assert.equal(longAgo.highlights.length, 0);

  const none = (await owner.call('/api/dashboard?range=custom&start=2026-09-01&end=2026-09-30&compare=none')).body;
  assert.equal(none.period.start, '2026-09-01');
  assert.equal(none.compare, null);
  assert.ok(none.sections[0].kpis.every(k => k.prev == null));
});

test('removing a login signs that person out immediately', async () => {
  const admin = await login('admin@scg.demo');
  const ridge = (await admin.call('/api/admin/clients')).body.find(c => c.name.startsWith('Ridgeline'));
  const made = (await admin.call('/api/admin/users', { method: 'POST', body: { email: `temp${Date.now()}@ridgeline.demo`, role: 'client', client_id: ridge.id } })).body;
  const temp = await login(made.email, made.tempPassword);
  // Must change the temporary password before seeing data
  assert.equal((await temp.call('/api/dashboard')).status, 403);
  assert.equal((await temp.call('/api/password', { method: 'POST', body: { current: made.tempPassword, next: 'a-new-password-123' } })).status, 200);
  assert.equal((await temp.call('/api/dashboard')).status, 200);
  await admin.call(`/api/admin/users/${made.id}`, { method: 'DELETE' });
  assert.equal((await temp.call('/api/dashboard')).status, 401);
});

// Keep last: it locks this IP out of signing in for 15 minutes
test('repeated wrong passwords get locked out', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await login('owner@ridgeline.demo', `wrong${i}`)).status);
  assert.ok(statuses.includes(429));
});
