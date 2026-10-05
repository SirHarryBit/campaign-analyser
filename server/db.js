// Storage with one async interface and two backends:
//  - local:  Node's built-in SQLite (node:sqlite, Node 22.13+), a file in data/
//  - hosted: Turso / libSQL over the network (@libsql/client), needed on Vercel,
//            where functions have no lasting disk.
// Both speak SQLite SQL, so the schema and queries are shared.
'use strict';

const TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- Meta user id (app-scoped)
  name TEXT,
  token_enc TEXT,                    -- encrypted long-lived user token
  token_expires_at INTEGER,          -- ms since epoch
  token_status TEXT DEFAULT 'ok',    -- ok | reconnect
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_accounts (
  id TEXT NOT NULL,                  -- act_123
  user_id TEXT NOT NULL,
  name TEXT, currency TEXT, timezone TEXT, account_status INTEGER,
  selected INTEGER DEFAULT 0,
  auto_sync INTEGER DEFAULT 1,       -- daily automatic sync on/off
  sync_state TEXT DEFAULT 'never',   -- never | running | partial | ok | error | waiting | reconnect
  sync_error TEXT,
  sync_progress TEXT,
  sync_started_at INTEGER,           -- lease, so two servers never sync the same account at once
  sync_cursor TEXT,                  -- next day to fetch while a sync is part-way through
  last_synced_at INTEGER,
  synced_until TEXT,                 -- last date with daily data (YYYY-MM-DD)
  next_attempt_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS entities (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  level TEXT NOT NULL,               -- campaign | adset | ad
  campaign_id TEXT, adset_id TEXT,
  name TEXT, objective TEXT, status TEXT,
  daily_budget TEXT, lifetime_budget TEXT,
  start_time TEXT, end_time TEXT,
  targeting_notes TEXT,
  universe INTEGER, universe_at INTEGER,
  thumbnail_url TEXT,
  updated_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS entities_by_account ON entities(user_id, account_id, level);
CREATE TABLE IF NOT EXISTS daily (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  ad_id TEXT NOT NULL, adset_id TEXT, campaign_id TEXT,
  date TEXT NOT NULL,
  spend REAL, impressions INTEGER, reach INTEGER, clicks INTEGER,
  lpv INTEGER, leads INTEGER, conversions INTEGER, conversion_value REAL, views INTEGER,
  PRIMARY KEY (user_id, ad_id, date)
);
CREATE INDEX IF NOT EXISTS daily_by_account ON daily(user_id, account_id, date);
CREATE TABLE IF NOT EXISTS totals_cache (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL, level TEXT NOT NULL, since TEXT NOT NULL, until TEXT NOT NULL,
  fetched_at INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id, level, since, until)
);
CREATE TABLE IF NOT EXISTS manual_inputs (
  user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity_id)
);
CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  views INTEGER DEFAULT 0, last_viewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_by_user ON usage_events(user_id, at);
CREATE TABLE IF NOT EXISTS deletion_requests (
  code TEXT PRIMARY KEY, at INTEGER NOT NULL
);
`;

// Columns added after the first release; older local databases get them on start-up.
const MIGRATIONS = [
  ['ad_accounts', 'auto_sync', 'INTEGER DEFAULT 1'],
  ['ad_accounts', 'sync_started_at', 'INTEGER'],
  ['ad_accounts', 'sync_cursor', 'TEXT'],
];

// Every table that holds a user's data (used to delete a user completely).
const USER_TABLES = ['sessions', 'ad_accounts', 'entities', 'daily', 'totals_cache', 'manual_inputs', 'comparisons', 'shares', 'usage_events'];

const statements = (sql) => sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
const clean = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

/** Local file database on node:sqlite. */
function sqliteDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  const cache = new Map();
  const stmt = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
    return cache.get(sql);
  };
  return {
    kind: 'sqlite',
    async exec(sql) { db.exec(sql); },
    async get(sql, args) { return stmt(sql).get(...clean(args)); },
    async all(sql, args) { return stmt(sql).all(...clean(args)); },
    async run(sql, args) { const r = stmt(sql).run(...clean(args)); return { changes: Number(r.changes) }; },
    async batch(list) {
      db.exec('BEGIN');
      try { for (const [sql, ...args] of list) stmt(sql).run(...clean(args)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  };
}

/** Turso / libSQL. `client` can be injected (tests); otherwise one is created from url + token. */
function libsqlDriver({ url, authToken, client }) {
  const c = client || require('@libsql/client').createClient({ url, authToken, intMode: 'number' });
  const toObj = (rs, row) => Object.fromEntries(rs.columns.map((col, i) => [col, row[i]]));
  const exec = (sql, args) => c.execute({ sql, args: clean(args) });
  return {
    kind: 'libsql',
    async exec(sql) { await c.batch(statements(sql), 'write'); },
    async get(sql, args) { const rs = await exec(sql, args); return rs.rows.length ? toObj(rs, rs.rows[0]) : undefined; },
    async all(sql, args) { const rs = await exec(sql, args); return rs.rows.map((r) => toObj(rs, r)); },
    async run(sql, args) { const rs = await exec(sql, args); return { changes: Number(rs.rowsAffected) }; },
    async batch(list) {
      // One round trip, all-or-nothing. Large syncs are split to keep each request small.
      for (let i = 0; i < list.length; i += 200) {
        await c.batch(list.slice(i, i + 200).map(([sql, ...args]) => ({ sql, args: clean(args) })), 'write');
      }
    },
    close() { c.close?.(); },
  };
}

/**
 * Open the database and make sure the schema is current.
 * @param {{ file?: string, url?: string, authToken?: string, client?: object }} o
 */
async function openDb(o) {
  const d = o.url || o.client ? libsqlDriver(o) : sqliteDriver(o.file);
  await d.exec(TABLES);
  for (const [table, col, type] of MIGRATIONS) {
    const cols = await d.all(`PRAGMA table_info(${table})`, []);
    if (!cols.some((c) => c.name === col)) await d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
  }
  return {
    kind: d.kind,
    get: (sql, ...args) => d.get(sql, args),
    all: (sql, ...args) => d.all(sql, args),
    run: (sql, ...args) => d.run(sql, args),
    /** Several writes, applied together. Each item: [sql, ...args]. */
    batch: (list) => (list.length ? d.batch(list) : Promise.resolve()),
    close: () => d.close(),
  };
}

module.exports = { openDb, USER_TABLES };
