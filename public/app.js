const app = document.getElementById('app');
let me = null;
let charts = [];
let pollTimer = null;

// ---------- helpers

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { 'x-scg': '1', ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { me = null; renderLogin(); throw new Error('signed out'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

function hashParts() {
  const [route, qs] = location.hash.slice(1).split('?');
  return { route: route || '/', params: new URLSearchParams(qs || '') };
}
const go = (route, params) => { location.hash = params && [...params].length ? `${route}?${params}` : route; };

const fmt = {
  int: n => Math.round(n).toLocaleString('en-US'),
  dec: n => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  pct: n => `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`,
  usd: n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 }),
  x: n => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}x`,
};
const show = (n, f) => (n == null ? '—' : fmt[f](n));

const utc = s => new Date(s + 'T12:00:00Z');
function fmtDate(s, opts = {}) {
  return utc(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts });
}
function fmtRange(start, end) {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  if (start === end) return fmtDate(start, { year: 'numeric' });
  return `${fmtDate(start, sameYear ? {} : { year: 'numeric' })} – ${fmtDate(end, { year: 'numeric' })}`;
}
function fmtTime(iso, tz) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
}
function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

const LOGO = `<span class="logo"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M4 52 25 18l9 15 7-9 19 28Z" fill="#fff"/><path d="M25 18l-5 8 5-2 4 4Z" fill="#38bdf8"/></svg></span>`;

// ---------- shell

function shell(content, active) {
  charts.forEach(c => c.destroy());
  charts = [];
  const isAdmin = me.user.role === 'admin';
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/">${LOGO}<span>SCG Client Portal<small>Summit Creative Group</small></span></a>
      <span class="spacer"></span>
      <nav>
        <a href="#/" class="${active === 'dash' ? 'active' : ''}">Dashboard</a>
        ${isAdmin ? `<a href="#/admin" class="${active === 'admin' ? 'active' : ''}">Clients</a>
                     <a href="#/admin/connections" class="${active === 'conn' ? 'active' : ''}">Connections</a>` : ''}
        <a href="#/account" class="${active === 'account' ? 'active' : ''}">Account</a>
      </nav>
      <div class="who">${esc(me.user.name || me.user.email)}<br>${esc(isAdmin ? 'Summit team' : me.client?.name)}</div>
      <button class="btn sm" id="signout">Sign out</button>
    </header>
    <main>${content}</main>`;
  document.getElementById('signout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; renderLogin(); };
}

// ---------- auth views

function renderLogin(error = '') {
  clearInterval(pollTimer);
  app.innerHTML = `
    <div class="login">
      <form class="card" id="login">
        <div class="brand">${LOGO}<span>SCG Client Portal<small>Summit Creative Group</small></span></div>
        <p class="muted small" style="margin:0;text-align:center">Sign in to see how your marketing is performing.</p>
        <label class="field">Email<input name="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" id="err">${esc(error)}</div>
        <button class="btn primary" style="justify-content:center">Sign in</button>
        <p class="muted small" style="margin:0;text-align:center">Forgot your password? Contact your Summit account manager and we'll reset it.</p>
      </form>
    </div>`;
  document.getElementById('login').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      await start();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

function passwordForm(first) {
  return `
    <form class="card stack" id="pw" style="max-width:440px">
      <div><h2>${first ? 'Set your password' : 'Change password'}</h2>
        ${first ? '<p class="muted small">You signed in with a temporary password. Choose your own to continue.</p>' : ''}</div>
      <label class="field">${first ? 'Temporary password' : 'Current password'}<input name="current" type="password" autocomplete="current-password" required></label>
      <label class="field">New password (10+ characters)<input name="next" type="password" minlength="10" autocomplete="new-password" required></label>
      <label class="field">Confirm new password<input name="confirm" type="password" minlength="10" autocomplete="new-password" required></label>
      <div class="error" id="err"></div>
      <button class="btn primary">Save password</button>
    </form>`;
}

function bindPasswordForm(onDone) {
  document.getElementById('pw').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = document.getElementById('err');
    if (f.get('next') !== f.get('confirm')) { err.textContent = "Passwords don't match"; return; }
    try {
      await api('/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      onDone();
    } catch (x) { err.textContent = x.message; }
  };
}

function renderFirstPassword() {
  app.innerHTML = `<div class="login">${passwordForm(true)}</div>`;
  bindPasswordForm(start);
}

function renderAccount() {
  shell(`<h1 style="margin-bottom:20px">Account</h1>
    <p class="muted">Signed in as <b>${esc(me.user.email)}</b></p>${passwordForm(false)}`, 'account');
  bindPasswordForm(() => { toast('Password updated'); renderAccount(); });
}

// ---------- dashboard

const RANGES = [['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['last90', 'Last 90 days'], ['this_month', 'Month to date'],
  ['last_month', 'Last month'], ['qtd', 'Quarter to date'], ['ytd', 'Year to date'], ['last12m', 'Last 12 months'], ['custom', 'Custom range']];
const COMPARES = [['previous', 'Previous period'], ['year', 'Same period last year'], ['none', 'No comparison']];

async function renderDashboard(params) {
  clearInterval(pollTimer);
  const isAdmin = me.user.role === 'admin';
  let clients = [];
  if (isAdmin) {
    clients = await api('/admin/clients');
    if (!clients.length) { shell(`<div class="card empty"><h2>No clients yet</h2><p>Add your first client to start building dashboards.</p><a class="btn primary" href="#/admin">Add a client</a></div>`, 'dash'); return; }
    if (!params.get('client')) { params.set('client', clients[0].id); history.replaceState(null, '', `#/?${params}`); }
  }
  const qs = new URLSearchParams(params);
  const range = qs.get('range') || 'last30';
  const compare = qs.get('compare') || 'previous';
  let data;
  try { data = await api(`/dashboard?${qs}`); }
  catch (e) { shell(`<div class="card empty">${esc(e.message)}</div>`, 'dash'); return; }

  const tz = data.client.timezone;
  const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const errors = data.sources.filter(s => s.status === 'error');

  shell(`
    <div class="dash-head">
      <div>
        <div class="eyebrow">Marketing performance</div>
        <h1>${esc(data.client.name)}</h1>
      </div>
      <div class="controls">
        ${isAdmin ? `<label class="field">Client${sel('f-client', clients.map(c => [String(c.id), c.name]), String(data.client.id))}</label>` : ''}
        <label class="field">Reporting period${sel('f-range', RANGES, range)}</label>
        <span class="row" id="custom" ${range === 'custom' ? '' : 'hidden'}>
          <label class="field">From<input type="date" id="f-start" value="${data.period.start}"></label>
          <label class="field">To<input type="date" id="f-end" value="${data.period.end}"></label>
          <button class="btn" id="f-apply">Apply</button>
        </span>
        <label class="field">Compare to${sel('f-compare', COMPARES, compare)}</label>
        <button class="btn" id="print" title="Save this report as a PDF">Download PDF</button>
      </div>
    </div>

    <div class="freshness">
      <span>Showing <b>${fmtRange(data.period.start, data.period.end)}</b> (${esc(data.period.label.toLowerCase())})</span>
      ${data.compare ? `<span>Compared with <b>${fmtRange(data.compare.start, data.compare.end)}</b></span>` : ''}
      <span>${data.lastUpdated ? `Data updated <b title="${esc(fmtTime(data.lastUpdated, tz))}">${ago(data.lastUpdated)}</b> · ${esc(fmtTime(data.lastUpdated, tz))}` : 'Not synced yet'}</span>
      ${data.compareGap ? `<span class="chip warn" title="Changes may look bigger than they are">Tracking began ${fmtDate(data.compareGap, { year: 'numeric' })}, so the comparison period is incomplete</span>` : ''}
      ${data.refreshing ? `<span class="chip info pulse"><span class="dot"></span>Refreshing</span>` : ''}
      ${isAdmin && errors.length ? `<a class="chip bad" href="#/admin/client/${data.client.id}"><span class="dot"></span>${errors.length} source${errors.length > 1 ? 's' : ''} failing</a>` : ''}
    </div>

    ${!data.sources.length ? `<div class="card empty"><h2>Your dashboard is being set up</h2><p>We're connecting your accounts. Your results will show up here soon.</p></div>` : `
    <div class="stack">
      ${highlightsCard(data)}
      ${data.sections.map(s => sectionCard(s, data)).join('')}
      ${data.sections.length ? '' : `<div class="card empty">No data for this period yet. Try a longer reporting period.</div>`}
      <div class="grid2">
        ${workCard(data)}
        ${sourcesCard(data)}
      </div>
      <p class="muted small" style="margin:0">Numbers come straight from each platform. Reports run through yesterday, since platforms finish counting each day overnight. Times are shown in ${esc(tz.replace(/_/g, ' '))} time.</p>
    </div>`}`, 'dash');

  const set = (k, v) => { const p = new URLSearchParams(params); v == null ? p.delete(k) : p.set(k, v); return p; };
  document.getElementById('f-range').onchange = e => {
    if (e.target.value === 'custom') { document.getElementById('custom').hidden = false; return; }
    const p = set('range', e.target.value); p.delete('start'); p.delete('end'); go('/', p);
  };
  document.getElementById('f-apply').onclick = () => {
    const p = set('range', 'custom');
    p.set('start', document.getElementById('f-start').value);
    p.set('end', document.getElementById('f-end').value);
    go('/', p);
  };
  document.getElementById('f-compare').onchange = e => go('/', set('compare', e.target.value));
  if (isAdmin) document.getElementById('f-client').onchange = e => go('/', set('client', e.target.value));
  document.getElementById('print').onclick = () => window.print();
  document.querySelectorAll('[data-table]').forEach(b => b.onclick = () => {
    const t = document.getElementById(b.dataset.table);
    t.hidden = !t.hidden;
    b.textContent = t.hidden ? 'Show data table' : 'Hide data table';
  });

  data.sections.forEach(s => s.chart && drawChart(s, data));

  // Keep the page current: quick polls while a refresh runs, otherwise every 10 minutes
  pollTimer = setInterval(() => { if (!document.hidden) renderDashboard(params); }, data.refreshing ? 20000 : 600000);
}

function delta(k) {
  if (k.prev == null || k.value == null) return '';
  let txt, change;
  if (k.fmt === 'pct') { change = k.value - k.prev; txt = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)} pts`; }
  else if (k.fmt === 'dec') { change = k.value - k.prev; txt = `${change >= 0 ? '+' : ''}${change.toFixed(1)}`; }
  else {
    if (!k.prev) return `<span class="delta flat">New</span>`;
    change = (k.value - k.prev) / Math.abs(k.prev);
    txt = `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`;
  }
  const flat = Math.abs(k.fmt === 'pct' ? change * 100 : k.fmt === 'dec' ? change : change * 100) < 1;
  const up = change > 0;
  const cls = flat || k.better === 'neutral' ? 'flat' : (k.better === 'down' ? !up : up) ? 'good' : 'bad';
  return `<span class="delta ${cls}" title="Change vs comparison period">${flat ? '' : up ? '▲' : '▼'} ${txt}</span>`;
}

function highlightsCard(data) {
  if (!data.compare || data.compareGap) return '';
  const items = data.highlights;
  const line = h => {
    const pct = Math.round(Math.abs(h.pct) * 100);
    const dir = h.pct > 0 ? 'up' : 'down';
    return `<li class="${h.good ? 'good' : 'bad'}"><span class="icon">${h.good ? '✓' : '!'}</span>
      <span><b>${esc(h.label)}</b> ${h.good ? '' : 'was '}${dir} ${pct}% (${show(h.value, h.fmt)} vs ${show(h.prev, h.fmt)}) <span class="muted">· ${esc(h.section)}</span></span></li>`;
  };
  return `<section class="card highlights">
    <h2>Highlights</h2>
    <p class="muted small" style="margin:2px 0 0">Biggest changes compared with ${esc(data.compare.label.toLowerCase())}.</p>
    ${items.length ? `<ul>${items.map(line).join('')}</ul>` : `<p class="muted">Results held steady — no metric moved more than 5%.</p>`}
  </section>`;
}

function sectionCard(s, data) {
  const id = `chart-${s.key}`;
  const c = s.chart;
  const unitLabel = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[c?.unit];
  return `<section class="card">
    <div class="section-head">
      <div><h2>${esc(s.title)}</h2><p>${esc(s.blurb)}</p></div>
    </div>
    <div class="kpis">
      ${s.kpis.map((k, i) => `<div class="kpi ${i === 0 ? 'lead' : ''}">
        <div class="label">${esc(k.label)}${k.snapshot ? ' <span class="muted small">(as of period end)</span>' : ''}</div>
        <div class="value">${show(k.value, k.fmt)}</div>
        ${delta(k)}${k.prev != null ? `<span class="vs">vs ${show(k.prev, k.fmt)}</span>` : ''}
      </div>`).join('')}
    </div>
    ${c ? `
      <div class="legend">
        <b style="color:var(--ink);font-weight:600">${unitLabel} ${esc(c.label.toLowerCase())}</b>
        <span><span class="sw"></span>${fmtRange(data.period.start, data.period.end)}</span>
        ${data.compare ? `<span><span class="sw prev"></span>${fmtRange(data.compare.start, data.compare.end)}</span>` : ''}
        ${data.notes.length ? `<span><span class="sw note"></span>Summit activity</span>` : ''}
      </div>
      <div class="chart-wrap" style="margin-top:10px"><canvas id="${id}" role="img" aria-label="${esc(unitLabel + ' ' + c.label)} chart"></canvas></div>
      <div class="chart-foot"><span></span><button class="linkbtn no-print" data-table="${id}-t">Show data table</button></div>
      <div class="tablewrap" id="${id}-t" hidden>
        <table><thead><tr><th>${esc(c.unit === 'day' ? 'Date' : c.unit === 'week' ? 'Week of' : 'Month')}</th><th class="num">${esc(c.label)}</th>${data.compare ? '<th class="num">Comparison</th>' : ''}</tr></thead>
        <tbody>${c.points.map(p => `<tr><td>${bucketLabel(p, c.unit, true)}</td><td class="num">${show(p.value, c.fmt)}</td>${data.compare ? `<td class="num">${show(p.prev, c.fmt)}</td>` : ''}</tr>`).join('')}</tbody></table>
      </div>` : ''}
  </section>`;
}

function bucketLabel(p, unit, long) {
  if (unit === 'month') return utc(p.start).toLocaleDateString('en-US', { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
  return fmtDate(p.start, long ? { year: 'numeric', weekday: unit === 'day' ? 'short' : undefined } : {});
}

function workCard(data) {
  return `<section class="card">
    <h2>Work we did</h2>
    <p class="muted small" style="margin:2px 0 0">What Summit worked on during this period. These show as markers on the charts.</p>
    ${data.notes.length ? `<ul class="timeline">${data.notes.map(n => `<li><span class="when">${fmtDate(n.date)}</span>
      <div><b>${esc(n.title)}</b>${n.body ? `<p>${esc(n.body)}</p>` : ''}</div></li>`).join('')}</ul>`
      : `<p class="muted">Nothing logged for this period.</p>`}
  </section>`;
}

function sourcesCard(data) {
  const tz = data.client.timezone;
  const chip = s => s.status === 'ok' ? '<span class="chip ok"><span class="dot"></span>Up to date</span>'
    : s.status === 'syncing' ? '<span class="chip info pulse"><span class="dot"></span>Updating</span>'
    : s.status === 'error' ? '<span class="chip bad"><span class="dot"></span>Needs attention</span>'
    : '<span class="chip warn"><span class="dot"></span>Connecting</span>';
  return `<section class="card">
    <h2>Connected accounts</h2>
    <p class="muted small" style="margin:2px 0 0">Where these numbers come from and how current they are.</p>
    <div class="tablewrap"><table style="margin-top:10px">
      <thead><tr><th>Account</th><th>Status</th><th>Last updated</th></tr></thead>
      <tbody>${data.sources.map(s => `<tr>
        <td><b>${esc(s.name)}</b><br><span class="muted small">${esc(s.label)}</span></td>
        <td>${chip(s)}${s.error ? `<div class="error small" style="margin-top:4px">${esc(s.error)}</div>` : ''}</td>
        <td class="small">${s.lastSyncedAt ? esc(fmtTime(s.lastSyncedAt, tz)) : '—'}
          ${s.dataThrough ? `<br><span class="muted">Data through ${fmtDate(s.dataThrough)}</span>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

// Draws a thin amber tick at each bucket that has Summit work logged
const notePlugin = {
  id: 'notes',
  afterDatasetsDraw(chart, _, opts) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const i of opts.indexes || []) {
      const px = x.getPixelForValue(i);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
    }
    ctx.restore();
  },
};

function drawChart(section, data) {
  const canvas = document.getElementById(`chart-${section.key}`);
  if (!canvas || !window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const color = v => css.getPropertyValue(v).trim();
  const c = section.chart;
  const notesAt = c.points.map(p => data.notes.filter(n => n.date >= p.start && n.date <= p.end));
  const fmtVal = v => show(v, c.fmt);

  const datasets = [{
    label: fmtRange(data.period.start, data.period.end), data: c.points.map(p => p.value),
    borderColor: color('--accent'), backgroundColor: 'rgba(56,189,248,.08)', fill: true,
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: color('--card'), cubicInterpolationMode: 'monotone',
  }];
  if (data.compare) datasets.push({
    label: fmtRange(data.compare.start, data.compare.end), data: c.points.map(p => p.prev),
    borderColor: color('--faint'), borderDash: [5, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, cubicInterpolationMode: 'monotone', fill: false,
  });

  charts.push(new Chart(canvas, {
    type: 'line',
    data: { labels: c.points.map(p => bucketLabel(p, c.unit)), datasets },
    plugins: [notePlugin],
    options: {
      maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        notes: { color: color('--warn'), indexes: notesAt.flatMap((n, i) => (n.length ? [i] : [])) },
        tooltip: {
          backgroundColor: color('--surface'), borderColor: color('--line'), borderWidth: 1,
          titleColor: color('--ink'), bodyColor: color('--muted'), footerColor: color('--warn'), padding: 10,
          titleFont: { family: color('--body'), weight: '600' }, bodyFont: { family: color('--body') },
          callbacks: {
            title: items => {
              const p = c.points[items[0].dataIndex];
              return c.unit === 'day' ? fmtDate(p.start, { weekday: 'short', year: 'numeric' }) : c.unit === 'week' ? `Week of ${fmtDate(p.start, { year: 'numeric' })}` : bucketLabel(p, 'month', true);
            },
            label: item => ` ${item.datasetIndex ? 'Comparison' : 'This period'}: ${fmtVal(item.raw)}`,
            footer: items => notesAt[items[0].dataIndex].map(n => `◆ ${n.title}`),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: color('--line') },
          ticks: { color: color('--muted'), maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { family: color('--body'), size: 11 } } },
        y: { beginAtZero: true, grid: { color: color('--grid') }, border: { display: false },
          ticks: { color: color('--muted'), maxTicksLimit: 5, font: { family: color('--body'), size: 11 },
            callback: v => c.fmt === 'usd' ? fmt.usd(v) : c.fmt === 'pct' ? fmt.pct(v) : Number(v).toLocaleString('en-US', { notation: 'compact' }) } },
      },
    },
  }));
}

// ---------- admin: clients

async function renderAdminClients() {
  const clients = await api('/admin/clients');
  shell(`
    <div class="dash-head"><div><div class="eyebrow">Admin</div><h1>Clients</h1></div></div>
    <div class="stack">
      <section class="card">
        ${clients.length ? `<div class="tablewrap"><table>
          <thead><tr><th>Client</th><th class="num">Accounts</th><th class="num">Logins</th><th>Status</th><th>Last sync</th><th></th></tr></thead>
          <tbody>${clients.map(c => `<tr>
            <td><a href="#/admin/client/${c.id}"><b>${esc(c.name)}</b></a></td>
            <td class="num">${c.sources}</td><td class="num">${c.users}</td>
            <td>${c.errors ? `<span class="chip bad"><span class="dot"></span>${c.errors} failing</span>` : c.sources ? '<span class="chip ok"><span class="dot"></span>OK</span>' : '<span class="chip warn"><span class="dot"></span>No accounts</span>'}</td>
            <td class="small">${c.last_synced_at ? ago(c.last_synced_at) : '—'}</td>
            <td class="num"><a class="btn sm" href="#/?client=${c.id}">Dashboard</a></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No clients yet.</p>'}
      </section>
      <form class="card row" id="add-client">
        <label class="field" style="flex:1 1 240px">New client name<input name="name" required placeholder="Business name"></label>
        <label class="field">Time zone<select name="timezone">${['America/Boise', 'America/Denver', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Phoenix']
          .map(t => `<option>${t}</option>`).join('')}</select></label>
        <button class="btn primary">Add client</button>
      </form>
    </div>`, 'admin');
  document.getElementById('add-client').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { const c = await api('/admin/clients', { method: 'POST', body: Object.fromEntries(f) }); go(`/admin/client/${c.id}`); }
    catch (x) { toast(x.message); }
  };
}

const PLATFORM_NAMES = { ga4: 'Google Analytics 4', gsc: 'Search Console', gbp: 'Business Profile', google_ads: 'Google Ads',
  facebook: 'Facebook Page', instagram: 'Instagram', meta_ads: 'Meta Ads' };
let discovered = null;

async function renderAdminClient(id) {
  clearInterval(pollTimer);
  const d = await api(`/admin/clients/${id}`);
  const c = d.client;
  const syncing = d.sources.some(s => s.status === 'syncing');
  shell(`
    <div class="dash-head">
      <div><div class="eyebrow"><a href="#/admin">Clients</a> / Client</div><h1>${esc(c.name)}</h1></div>
      <div class="controls">
        <a class="btn" href="#/?client=${c.id}">View dashboard</a>
        <button class="btn" id="sync" ${syncing ? 'disabled' : ''}>${syncing ? 'Syncing…' : 'Sync now'}</button>
      </div>
    </div>
    <div class="stack">
      <section class="card">
        <h2>Connected accounts</h2>
        <p class="muted small" style="margin:2px 0 12px">Map this client's accounts. The first sync pulls about 13 months of history.</p>
        ${d.sources.length ? `<div class="tablewrap"><table>
          <thead><tr><th>Platform</th><th>Account</th><th>Status</th><th>Last sync</th><th></th></tr></thead>
          <tbody>${d.sources.map(s => `<tr>
            <td>${esc(PLATFORM_NAMES[s.platform] || s.platform)}</td>
            <td>${esc(s.label)}<br><span class="muted small mono">${esc(s.external_id)}</span></td>
            <td>${s.status === 'error' ? `<span class="chip bad">Error</span><div class="error small" style="margin-top:4px">${esc(s.last_error)}</div>` : `<span class="chip ${s.status === 'ok' ? 'ok' : 'info'}">${{ ok: 'Up to date', syncing: 'Syncing', pending: 'Waiting' }[s.status] || esc(s.status)}</span>`}</td>
            <td class="small">${s.last_synced_at ? ago(s.last_synced_at) : '—'}${s.data_through ? `<br><span class="muted">through ${fmtDate(s.data_through.slice(0, 10))}</span>` : ''}</td>
            <td class="num"><button class="btn sm danger" data-del-source="${s.id}">Remove</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No accounts mapped yet.</p>'}
        <form class="row" id="add-source" style="margin-top:14px">
          <label class="field">Platform<select name="platform">${Object.entries(PLATFORM_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field" style="flex:1 1 280px">Account <span id="disc-status" class="muted">(loading accounts…)</span>
            <input name="external_id" list="disc-list" required placeholder="Pick from the list or paste an ID"></label>
          <datalist id="disc-list"></datalist>
          <button class="btn primary">Add account</button>
        </form>
      </section>

      <div class="admin-grid">
        <section class="card">
          <h2>Client logins</h2>
          <p class="muted small" style="margin:2px 0 12px">People at ${esc(c.name)} who can see this dashboard. They only ever see this client.</p>
          ${d.users.length ? `<table><tbody>${d.users.map(u => `<tr>
            <td><b>${esc(u.name || u.email)}</b><br><span class="muted small">${esc(u.email)} · ${u.last_login_at ? `last in ${ago(u.last_login_at)}` : 'never signed in'}</span></td>
            <td class="num" style="white-space:nowrap"><button class="btn sm" data-reset="${u.id}" data-name="${esc(u.name)}" data-email="${esc(u.email)}">Reset password</button>
              <button class="btn sm danger" data-del-user="${u.id}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No logins yet.</p>'}
          <form class="row" id="add-user" style="margin-top:14px">
            <label class="field" style="flex:1">Name<input name="name" placeholder="Jane Smith"></label>
            <label class="field" style="flex:1">Email<input name="email" type="email" required></label>
            <button class="btn primary">Create login</button>
          </form>
          <div id="invite"></div>
        </section>

        <section class="card">
          <h2>Work log</h2>
          <p class="muted small" style="margin:2px 0 12px">Shows on the client's dashboard and as markers on their charts.</p>
          <form class="stack" id="add-note" style="gap:10px">
            <div class="row">
              <label class="field">Date<input type="date" name="date" required value="${new Date().toLocaleDateString('en-CA', { timeZone: c.timezone })}"></label>
              <label class="field" style="flex:1">What we did<input name="title" required maxlength="200" placeholder="Launched spring Google Ads campaign"></label>
            </div>
            <label class="field">Details (optional)<textarea name="body" rows="2" maxlength="2000"></textarea></label>
            <div><button class="btn primary">Add to work log</button></div>
          </form>
          <ul class="timeline">${d.notes.map(n => `<li><span class="when">${fmtDate(n.date, { year: 'numeric' })}</span>
            <div><b>${esc(n.title)}</b> <button class="linkbtn" data-del-note="${n.id}">remove</button>${n.body ? `<p>${esc(n.body)}</p>` : ''}</div></li>`).join('')}</ul>
        </section>
      </div>

      <form class="card row" id="edit-client">
        <label class="field" style="flex:1 1 240px">Client name<input name="name" value="${esc(c.name)}" required></label>
        <label class="field">Time zone<input name="timezone" value="${esc(c.timezone)}" required></label>
        <button class="btn">Save</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn danger" type="button" id="del-client">Delete client</button>
      </form>
    </div>`, 'admin');

  const reload = () => renderAdminClient(id);
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); reload(); } catch (x) { toast(x.message); } };

  document.getElementById('sync').onclick = () => act(() => api(`/admin/clients/${id}/sync`, { method: 'POST' }), 'Sync started');
  document.querySelectorAll('[data-del-source]').forEach(b => b.onclick = () =>
    confirm('Remove this account and its stored history?') && act(() => api(`/admin/sources/${b.dataset.delSource}`, { method: 'DELETE' })));
  document.querySelectorAll('[data-del-user]').forEach(b => b.onclick = () =>
    confirm('Remove this login? They will be signed out immediately.') && act(() => api(`/admin/users/${b.dataset.delUser}`, { method: 'DELETE' })));
  document.querySelectorAll('[data-del-note]').forEach(b => b.onclick = () => act(() => api(`/admin/notes/${b.dataset.delNote}`, { method: 'DELETE' })));
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
    if (!confirm('Reset this password? They will be signed out and need the new temporary password.')) return;
    try { const r = await api(`/admin/users/${b.dataset.reset}/reset`, { method: 'POST' }); showInvite(b.dataset.name, b.dataset.email, r.tempPassword); }
    catch (x) { toast(x.message); }
  });

  document.getElementById('add-user').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/admin/users', { method: 'POST', body: { ...f, role: 'client', client_id: Number(id) } });
      await reload();
      showInvite(f.name, r.email, r.tempPassword);
    } catch (x) { toast(x.message); }
  };
  document.getElementById('add-note').onsubmit = e => {
    e.preventDefault();
    act(() => api('/admin/notes', { method: 'POST', body: { ...Object.fromEntries(new FormData(e.target)), client_id: Number(id) } }), 'Added to work log');
  };
  document.getElementById('edit-client').onsubmit = e => {
    e.preventDefault();
    act(() => api(`/admin/clients/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }), 'Saved');
  };
  document.getElementById('del-client').onclick = async () => {
    if (prompt(`This deletes ${c.name}, their logins and all stored data. Type the client name to confirm.`) !== c.name) return;
    try { await api(`/admin/clients/${id}`, { method: 'DELETE' }); go('/admin'); } catch (x) { toast(x.message); }
  };

  // Account picker: fill the list with what Summit's Google/Meta logins can see
  const form = document.getElementById('add-source');
  const status = document.getElementById('disc-status');
  const fill = () => {
    const p = form.platform.value;
    const list = discovered?.[p] || [];
    document.getElementById('disc-list').innerHTML = list.map(a => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
    const err = discovered?.errors?.[p] || (p.match(/facebook|instagram|meta_ads/) && discovered?.errors?.meta);
    status.textContent = !discovered ? '(loading accounts…)' : err ? `(couldn't list accounts: ${err})` : `(${list.length} available)`;
  };
  form.platform.onchange = fill;
  form.onsubmit = e => {
    e.preventDefault();
    const p = form.platform.value, ext = form.external_id.value.trim();
    const label = (discovered?.[p] || []).find(a => a.id === ext)?.label || ext;
    act(() => api('/admin/sources', { method: 'POST', body: { client_id: Number(id), platform: p, external_id: ext, label } }), 'Account added — syncing history now');
  };
  if (!discovered) api('/admin/discover').then(r => { discovered = r; fill(); }).catch(() => { discovered = { errors: {} }; fill(); });
  else fill();

  if (syncing) pollTimer = setInterval(() => { if (location.hash === `#/admin/client/${id}`) reload(); }, 8000);
}

function showInvite(name, email, password) {
  const url = location.origin;
  const msg = `Hi ${name || 'there'},\n\nYour Summit Creative Group reporting dashboard is ready. You can see live results from your website, search, social and ads in one place.\n\nSign in: ${url}\nEmail: ${email}\nTemporary password: ${password}\n\nYou'll choose your own password the first time you sign in.\n\nSummit Creative Group`;
  document.getElementById('invite').innerHTML = `<div class="notice" style="margin-top:14px">
    Temporary password for <b>${esc(email)}</b>: <span class="secret">${esc(password)}</span><br>
    <span class="small muted">This is shown once. Send it to them, they'll set their own on first sign-in.</span><br>
    <button class="btn sm" id="copy-invite" style="margin-top:8px">Copy invite message</button></div>`;
  document.getElementById('copy-invite').onclick = () => navigator.clipboard.writeText(msg).then(() => toast('Invite copied'));
}

// ---------- admin: connections + team

async function renderConnections(params) {
  const [conn, admins] = await Promise.all([api('/admin/connections'), api('/admin/users')]);
  const err = params.get('error');
  const ok = params.get('connected');
  const check = (good, text) => `<li>${good ? '<span class="chip ok">Set</span>' : '<span class="chip warn">Missing</span>'} ${text}</li>`;
  const metaExp = conn.meta.expiresAt && new Date(conn.meta.expiresAt);
  const metaDays = metaExp && Math.round((metaExp - Date.now()) / 864e5);
  shell(`
    <div class="dash-head"><div><div class="eyebrow">Admin</div><h1>Connections</h1></div></div>
    ${ok ? `<div class="notice" style="margin-bottom:20px">${ok === 'google' ? 'Google' : 'Meta'} connected. Map client accounts from each client's page.</div>` : ''}
    ${err ? `<div class="notice warn" style="margin-bottom:20px">Connection failed: ${esc(err)}</div>` : ''}
    <div class="stack">
      <div class="grid2">
        <section class="card stack" style="gap:12px">
          <div class="section-head"><h2>Google</h2>${conn.google.connected ? '<span class="chip ok"><span class="dot"></span>Connected</span>' : '<span class="chip warn"><span class="dot"></span>Not connected</span>'}</div>
          <p class="muted small" style="margin:0">One Summit Google login covers Analytics 4, Search Console, Google Ads and Business Profile for every client it has access to.</p>
          ${conn.google.account ? `<p style="margin:0">Signed in as <b>${esc(conn.google.account)}</b></p>` : ''}
          <ul class="small" style="list-style:none;padding:0;margin:0;display:grid;gap:6px">
            ${check(conn.google.configured, 'OAuth client ID and secret')}
            ${check(conn.google.adsReady, 'Google Ads developer token and manager account ID')}
          </ul>
          <div><a class="btn ${conn.google.connected ? '' : 'primary'}" href="/oauth/google/start" ${conn.google.configured ? '' : 'aria-disabled="true" style="pointer-events:none;opacity:.5"'}>${conn.google.connected ? 'Reconnect Google' : 'Connect Google'}</a></div>
        </section>
        <section class="card stack" style="gap:12px">
          <div class="section-head"><h2>Meta</h2>${conn.meta.connected ? (metaDays != null && metaDays < 10 ? `<span class="chip warn"><span class="dot"></span>Expires in ${metaDays} days</span>` : '<span class="chip ok"><span class="dot"></span>Connected</span>') : '<span class="chip warn"><span class="dot"></span>Not connected</span>'}</div>
          <p class="muted small" style="margin:0">Facebook Pages, Instagram business accounts and Meta ad accounts.</p>
          ${conn.meta.account ? `<p style="margin:0">Signed in as <b>${esc(conn.meta.account)}</b>${metaExp ? ` · login good until ${metaExp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</p>` : ''}
          <ul class="small" style="list-style:none;padding:0;margin:0;display:grid;gap:6px">${check(conn.meta.configured, 'Meta app ID and secret')}</ul>
          <p class="muted small" style="margin:0">Tip: a System User token from Business Manager never expires. Set it as META_SYSTEM_USER_TOKEN and you can skip reconnecting.</p>
          <div><a class="btn ${conn.meta.connected ? '' : 'primary'}" href="/oauth/meta/start" ${conn.meta.configured ? '' : 'aria-disabled="true" style="pointer-events:none;opacity:.5"'}>${conn.meta.connected ? 'Reconnect Meta' : 'Connect Meta'}</a></div>
        </section>
      </div>
      <section class="card">
        <h2>Summit team</h2>
        <p class="muted small" style="margin:2px 0 12px">Admins can see every client and manage the portal.</p>
        <table><tbody>${admins.map(u => `<tr><td><b>${esc(u.name || u.email)}</b><br><span class="muted small">${esc(u.email)}</span></td>
          <td class="small muted">${u.last_login_at ? `last in ${ago(u.last_login_at)}` : 'never signed in'}</td>
          <td class="num">${u.id === me.user.id ? '<span class="muted small">you</span>' : `<button class="btn sm danger" data-del-user="${u.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table>
        <form class="row" id="add-admin" style="margin-top:14px">
          <label class="field" style="flex:1">Name<input name="name"></label>
          <label class="field" style="flex:1">Email<input name="email" type="email" required></label>
          <button class="btn primary">Add admin</button>
        </form>
        <div id="invite"></div>
      </section>
    </div>`, 'conn');

  document.getElementById('add-admin').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { const r = await api('/admin/users', { method: 'POST', body: { ...f, role: 'admin' } }); await renderConnections(new URLSearchParams()); showInvite(f.name, r.email, r.tempPassword); }
    catch (x) { toast(x.message); }
  };
  document.querySelectorAll('[data-del-user]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this admin?')) return;
    try { await api(`/admin/users/${b.dataset.delUser}`, { method: 'DELETE' }); renderConnections(new URLSearchParams()); } catch (x) { toast(x.message); }
  });
}

// ---------- router

async function route() {
  if (!me) return;
  if (me.user.must_change_password) return renderFirstPassword();
  const { route, params } = hashParts();
  const isAdmin = me.user.role === 'admin';
  try {
    if (route === '/account') return renderAccount();
    if (isAdmin && route === '/admin') return await renderAdminClients();
    if (isAdmin && route === '/admin/connections') return await renderConnections(params);
    const m = route.match(/^\/admin\/client\/(\d+)$/);
    if (isAdmin && m) return await renderAdminClient(m[1]);
    return await renderDashboard(params);
  } catch (e) {
    if (e.message !== 'signed out') toast(e.message);
  }
}

async function start() {
  try { me = await api('/me'); } catch { return; }
  route();
}

window.addEventListener('hashchange', route);
start();
