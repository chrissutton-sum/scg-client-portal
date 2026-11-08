const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|\/tmp|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false },
});

const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    create table if not exists clients (
      id serial primary key,
      name text not null,
      timezone text not null default 'America/Boise',
      created_at timestamptz not null default now()
    );
    create table if not exists users (
      id serial primary key,
      email text not null unique,
      name text not null default '',
      password_hash text not null,
      role text not null check (role in ('admin','client')),
      client_id int references clients(id) on delete cascade,
      must_change_password boolean not null default true,
      last_login_at timestamptz,
      created_at timestamptz not null default now(),
      check (role = 'admin' or client_id is not null)
    );
    -- Summit's agency-level OAuth grants (one per provider)
    create table if not exists provider_tokens (
      provider text primary key,
      account_name text,
      refresh_token_enc text,
      access_token_enc text,
      expires_at timestamptz,
      updated_at timestamptz not null default now()
    );
    -- A client's connected account on one platform
    create table if not exists sources (
      id serial primary key,
      client_id int not null references clients(id) on delete cascade,
      platform text not null,
      external_id text not null,
      label text not null default '',
      status text not null default 'pending',
      last_error text,
      last_synced_at timestamptz,
      sync_started_at timestamptz,
      data_through date,
      created_at timestamptz not null default now(),
      unique (client_id, platform, external_id)
    );
    create table if not exists metrics_daily (
      client_id int not null references clients(id) on delete cascade,
      source_id int not null references sources(id) on delete cascade,
      date date not null,
      metric text not null,
      value double precision not null,
      primary key (source_id, date, metric)
    );
    create index if not exists metrics_client_date on metrics_daily (client_id, date);
    -- Summit's work log, shown to clients
    create table if not exists notes (
      id serial primary key,
      client_id int not null references clients(id) on delete cascade,
      date date not null,
      title text not null,
      body text not null default '',
      created_by int references users(id) on delete set null,
      created_at timestamptz not null default now()
    );
    create index if not exists notes_client_date on notes (client_id, date);
  `);
}

// AES-256-GCM for OAuth tokens. TOKEN_KEY is 32 bytes, hex or base64.
function key() {
  const raw = process.env.TOKEN_KEY || '';
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes (64 hex chars)');
  return k;
}

function encrypt(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { pool, q, migrate, encrypt, decrypt };
