// The HTTP app: Meta sign-in, the JSON API the browser calls, share links,
// Meta's deletion callbacks and the daily sync (a timer locally, a cron job on Vercel).
// Built on node:http request/response objects with no framework, so the same
// `handle(req, res)` runs under `node server/index.js` and as a Vercel function.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, USER_TABLES } = require('./db.js');
const S = require('./security.js');
const { GraphClient, MetaError } = require('./meta/client.js');
const { syncStep, todayIn, addDays } = require('./meta/sync.js');
const { buildCampaigns, cleanManual, LEVELS } = require('./entities.js');
const { cleanSnapshot } = require('./snapshot.js');

const SESSION_DAYS = 30;
const JSON_LIMIT = 2 * 1024 * 1024;
const DAY = 86400000;
const LEASE_MS = 310000; // a sync step that hasn't finished in this long has died (Vercel stops functions at 300 s)
const HARD_STOP_MS = 40000; // after the step budget, in-flight Meta calls get this long before the step ends itself

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

async function createApp(config, { sleep, log = console } = {}) {
  const db = await openDb(config.db);
  const secure = config.baseUrl.startsWith('https://');
  // Browsers share cookies across ports on localhost; the __Host- prefix locks them down on HTTPS.
  const SID = secure ? '__Host-ca_sid' : 'ca_sid';
  const OAUTH = secure ? '__Host-ca_oauth' : 'ca_oauth';

  const meta = config.meta;
  const client = (token) => new GraphClient({ token, appSecret: meta.appSecret, version: meta.version, baseUrl: meta.graphUrl, sleep });
  const track = (userId, kind, qty = 1) => db.run('INSERT INTO usage_events (user_id, kind, qty, at) VALUES (?, ?, ?, ?)', userId, kind, qty, Date.now());

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const parseRaw = (raw, type) => {
    if (!raw) return {};
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    return JSON.parse(raw);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    // Some hosts read the body before the app gets the request.
    if (req.readableEnded) {
      const b = req.body;
      if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return resolve(b);
      try { return resolve(parseRaw(Buffer.isBuffer(b) ? b.toString('utf8') : String(b || ''), type)); } catch { return reject(new HttpError(400, 'Invalid request body')); }
    }
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > JSON_LIMIT) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parseRaw(Buffer.concat(parts).toString('utf8'), type)); } catch { reject(new HttpError(400, 'Invalid request body')); } });
    req.on('error', reject);
  });

  async function sessionFrom(req) {
    const sid = S.parseCookies(req.headers.cookie)[SID];
    if (!sid) return null;
    const s = await db.get('SELECT s.*, u.name, u.token_status, u.token_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', sid);
    if (!s || s.expires_at < Date.now()) return null;
    return s;
  }
  async function requireUser(req, { write = false } = {}) {
    const s = await sessionFrom(req);
    if (!s) throw new HttpError(401, 'Sign in with Meta first.');
    if (write) {
      // Same-origin check plus a CSRF token for anything that changes data.
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin && origin !== config.baseUrl && origin !== `http://${host}` && origin !== `https://${host}`) throw new HttpError(403, 'Cross-site request blocked.');
      if (!S.safeEqual(req.headers['x-csrf-token'] || '', s.csrf)) throw new HttpError(403, 'Missing or wrong security token. Reload the page.');
    }
    return s;
  }
  async function userToken(userId) {
    const u = await db.get('SELECT token_enc, token_status FROM users WHERE id = ?', userId);
    if (!u || !u.token_enc || u.token_status !== 'ok') throw new HttpError(409, 'Your Meta connection has expired. Reconnect to keep syncing.', { reconnect: true });
    return S.decrypt(u.token_enc, config.key);
  }
  async function account(userId, accountId) {
    const a = await db.get('SELECT * FROM ad_accounts WHERE user_id = ? AND id = ?', userId, accountId);
    if (!a) throw new HttpError(404, 'Ad account not found.');
    return a;
  }
  const publicAccount = (a) => ({
    id: a.id, name: a.name, currency: a.currency, timezone: a.timezone, selected: !!a.selected,
    autoSync: a.auto_sync === null || a.auto_sync === undefined ? true : !!a.auto_sync,
    // A step that died (host time limit, crash) leaves 'running' behind; report it as resumable.
    ...(a.sync_state === 'running' && a.sync_started_at && a.sync_started_at < Date.now() - LEASE_MS
      ? { syncState: 'partial', syncError: null, syncProgress: 'Interrupted; continuing' }
      : { syncState: a.sync_state, syncError: a.sync_error, syncProgress: a.sync_progress }),
    lastSyncedAt: a.last_synced_at, syncedUntil: a.synced_until, nextAttemptAt: a.next_attempt_at,
  });
  async function upsertAccounts(userId, accts) {
    await db.batch(accts.map((a) => [`INSERT INTO ad_accounts (id, user_id, name, currency, timezone, account_status) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, currency = excluded.currency, timezone = excluded.timezone, account_status = excluded.account_status`,
    a.id, userId, a.name, a.currency, a.timezone_name, a.account_status ?? null]));
  }

  // ---------- sync orchestration ----------
  /**
   * Run one time-boxed step of a sync. A database lease stops two servers (or a
   * cron run and a button press) syncing the same account at the same time.
   * Returns the account afterwards; syncState 'partial' means "call again".
   */
  async function runSyncStep(userId, accountId, budgetMs = config.syncStepMs) {
    const now = Date.now();
    const got = await db.run(`UPDATE ad_accounts SET sync_state = 'running', sync_error = NULL, sync_progress = 'Starting', sync_started_at = ?
      WHERE user_id = ? AND id = ? AND (sync_state != 'running' OR sync_started_at IS NULL OR sync_started_at < ?)`, now, userId, accountId, now - LEASE_MS);
    if (!got.changes) return account(userId, accountId); // already running elsewhere
    try {
      const c = client(await userToken(userId));
      c.deadline = now + Math.min(budgetMs + HARD_STOP_MS, config.hosted ? 285000 : Infinity);
      const r = await syncStep({
        db, userId, accountId, client: c, backfillDays: meta.backfillDays, deadline: now + budgetMs,
        progress: (msg) => db.run('UPDATE ad_accounts SET sync_progress = ? WHERE user_id = ? AND id = ?', msg, userId, accountId),
      });
      await track(userId, 'meta_api_calls', r.apiCalls);
      if (r.done) {
        await db.run(`UPDATE ad_accounts SET sync_state = 'ok', sync_error = ?, sync_progress = NULL, next_attempt_at = NULL WHERE user_id = ? AND id = ?`, r.note || null, userId, accountId);
        await track(userId, 'sync');
        log.info?.(`sync ok ${accountId}: ${r.rows} daily rows, ${r.apiCalls} calls`);
      } else {
        await db.run(`UPDATE ad_accounts SET sync_state = 'partial', sync_progress = ? WHERE user_id = ? AND id = ?`, r.cursor ? `Continuing from ${r.cursor}` : 'Continuing', userId, accountId);
      }
    } catch (e) {
      const kind = e instanceof MetaError ? e.kind : e.extra?.reconnect ? 'auth' : 'other';
      if (kind === 'auth') {
        await db.run(`UPDATE users SET token_status = 'reconnect' WHERE id = ?`, userId);
        await db.run(`UPDATE ad_accounts SET sync_state = 'reconnect', sync_error = ?, sync_progress = NULL WHERE user_id = ? AND id = ?`, 'Meta connection expired or was removed. Reconnect to continue.', userId, accountId);
      } else if (kind === 'rate_limit') {
        await db.run(`UPDATE ad_accounts SET sync_state = 'waiting', sync_error = ?, sync_progress = NULL, next_attempt_at = ? WHERE user_id = ? AND id = ?`,
          'Meta asked us to slow down. The sync carries on later.', Date.now() + (e.retryAfterMs || 15 * 60000), userId, accountId);
      } else {
        const msg = kind === 'permission' ? 'Meta refused access to this ad account. Check that your Facebook profile still has access to it.' : `Sync failed: ${e.message}`;
        await db.run(`UPDATE ad_accounts SET sync_state = 'error', sync_error = ?, sync_progress = NULL WHERE user_id = ? AND id = ?`, msg, userId, accountId);
      }
      log.warn?.(`sync failed ${accountId}: ${e.message}${e.fbtraceId ? ' (fbtrace ' + e.fbtraceId + ')' : ''}`);
    }
    return account(userId, accountId);
  }

  /** Accurate unique reach for a range comes from Meta directly (it can't be added up from days). */
  async function reachFor(userId, accountId, level, since, until) {
    const cached = await db.get('SELECT * FROM totals_cache WHERE user_id = ? AND account_id = ? AND level = ? AND since = ? AND until = ?', userId, accountId, level, since, until);
    if (cached && Date.now() - cached.fetched_at < 6 * 3600000) return JSON.parse(cached.json);
    try {
      const rows = await client(await userToken(userId)).all(`${accountId}/insights`, { level, time_range: { since, until }, fields: `${level}_id,reach,frequency,impressions`, limit: 500 });
      const out = {};
      for (const r of rows) out[r[`${level}_id`]] = { reach: Number(r.reach) || undefined, frequency: Number(r.frequency) || undefined };
      await db.run(`INSERT INTO totals_cache (user_id, account_id, level, since, until, fetched_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, account_id, level, since, until) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json`, userId, accountId, level, since, until, Date.now(), JSON.stringify(out));
      return out;
    } catch (e) {
      // Offline or rate-limited: show everything else; reach stays blank.
      return cached ? JSON.parse(cached.json) : {};
    }
  }

  async function deleteUser(userId) {
    await db.batch([...USER_TABLES.map((t) => [`DELETE FROM ${t} WHERE user_id = ?`, userId]), ['DELETE FROM users WHERE id = ?', userId]]);
  }

  // ---------- the page ----------
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let pageCache = null;
  /** The page with a fresh nonce on every <script>, and the matching Content-Security-Policy. */
  function appPage(extraScript = '') {
    const nonce = crypto.randomBytes(16).toString('base64');
    if (!pageCache) pageCache = fs.readFileSync(path.join(config.distDir, 'index.html'), 'utf8');
    let html = pageCache;
    if (extraScript) html = html.replace('<body>', () => `<body>\n<script>${extraScript}</script>`);
    html = html.replace(/<script(?=[\s>])/g, () => `<script nonce="${nonce}"`);
    return { html, headers: { ...SECURITY_HEADERS, 'content-security-policy': csp(nonce) } };
  }
  function csp(nonce) {
    return [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' ${XLSX_URL}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data: https://*.fbcdn.net https://*.facebook.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
  }
  const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  };
  const plainPage = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;max-width:36rem;margin:15vh auto;padding:0 16px">${body}</body>`;

  /**
   * Finish signing in with a Meta user token (from Facebook Login or pasted in):
   * store it encrypted, remember the ad accounts it can see, start a session.
   * Returns the session id.
   */
  async function signInWithToken(token, expiresAt) {
    const me = await client(token).get('me', { fields: 'id,name' });
    const now = Date.now();
    await db.run(`INSERT INTO users (id, name, token_enc, token_expires_at, token_status, created_at, last_login_at) VALUES (?, ?, ?, ?, 'ok', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_enc = excluded.token_enc, token_expires_at = excluded.token_expires_at, token_status = 'ok', last_login_at = excluded.last_login_at`,
    me.id, me.name, S.encrypt(token, config.key), expiresAt ?? null, now, now);
    await upsertAccounts(me.id, await client(token).all('me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status', limit: 100 }));
    await db.run(`UPDATE ad_accounts SET sync_state = CASE WHEN sync_state = 'reconnect' THEN 'ok' ELSE sync_state END WHERE user_id = ?`, me.id);
    const sid = S.randomId(32);
    await db.run('INSERT INTO sessions (id, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sid, me.id, S.randomId(24), now, now + SESSION_DAYS * DAY);
    await track(me.id, 'login');
    return sid;
  }

  /** Swap a short-lived token for a 60-day one. Falls back to the original if Meta refuses. */
  async function longLived(token) {
    const g = new GraphClient({ token: '', version: meta.version, baseUrl: meta.graphUrl, sleep });
    try {
      const r = await g.getNoAuth('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: meta.appId, client_secret: meta.appSecret, fb_exchange_token: token });
      if (r.access_token) return { token: r.access_token, expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : null };
    } catch (e) { /* keep the original */ }
    return { token, expiresAt: null };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/health$/, () => ({ ok: true, mode: config.demo ? 'demo' : 'live', apiVersion: meta.version, hosted: !!config.hosted, loginModes: config.loginModes }));

  // Sign in with Meta (OAuth code flow; the token never reaches the browser).
  route('GET', /^\/auth\/meta\/start$/, (req, res) => {
    if (!config.loginModes.includes('oauth')) throw new HttpError(404, 'Facebook Login is switched off. Paste an access token instead.');
    const state = S.randomId(16);
    const u = new URL(`${meta.dialogUrl}/${meta.version}/dialog/oauth`);
    u.searchParams.set('client_id', meta.appId);
    u.searchParams.set('redirect_uri', `${config.baseUrl}/auth/meta/callback`);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    if (meta.configId) { u.searchParams.set('config_id', meta.configId); u.searchParams.set('override_default_response_type', 'true'); }
    else u.searchParams.set('scope', 'ads_read');
    res.writeHead(302, {
      location: u.toString(),
      'set-cookie': S.cookie(OAUTH, S.sign({ state, at: Date.now() }, config.key), { maxAge: 600, secure }),
      'cache-control': 'no-store',
    });
    res.end();
  });

  route('GET', /^\/auth\/meta\/callback$/, async (req, res, { url }) => {
    const fail = () => { res.writeHead(302, { location: '/#connect-error', 'set-cookie': S.cookie(OAUTH, '', { maxAge: 0, secure }) }); res.end(); };
    const saved = S.unsign(S.parseCookies(req.headers.cookie)[OAUTH], config.key);
    if (url.searchParams.get('error')) return fail();
    if (!saved || saved.state !== url.searchParams.get('state') || Date.now() - saved.at > 600000) return fail();
    try {
      const g = new GraphClient({ token: '', version: meta.version, baseUrl: meta.graphUrl, sleep });
      const short = await g.getNoAuth('oauth/access_token', { client_id: meta.appId, client_secret: meta.appSecret, redirect_uri: `${config.baseUrl}/auth/meta/callback`, code: url.searchParams.get('code') });
      const lt = await longLived(short.access_token);
      const sid = await signInWithToken(lt.token, lt.expiresAt || Date.now() + Number(short.expires_in || 3600) * 1000);
      res.writeHead(302, {
        location: '/#connected',
        'set-cookie': [S.cookie(SID, sid, { maxAge: SESSION_DAYS * 86400, secure }), S.cookie(OAUTH, '', { maxAge: 0, secure })],
        'cache-control': 'no-store',
      });
      res.end();
    } catch (e) {
      log.warn?.('oauth failed: ' + e.message);
      fail();
    }
  });

  // Sign in by pasting a token from the Meta app's Marketing API → Tools page.
  // Needs no Facebook Login product, App Review or Business Verification.
  route('POST', /^\/auth\/meta\/token$/, async (req, res) => {
    if (!config.loginModes.includes('token')) throw new HttpError(404, 'Not found');
    // Login CSRF guard: same-origin JSON only (a cross-site form can't send this content type).
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && origin !== config.baseUrl && origin !== `http://${host}` && origin !== `https://${host}`) throw new HttpError(403, 'Cross-site request blocked.');
    if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
    const b = await readBody(req);
    const pasted = String(b.token || '').trim();
    if (!/^[A-Za-z0-9|_\-.]{10,1000}$/.test(pasted)) throw new HttpError(400, 'That doesn\'t look like an access token. Copy the whole token from Marketing API → Tools.');
    let perms;
    try {
      // appsecret_proof is added to this call, so a token from any other app is refused by Meta.
      perms = await client(pasted).all('me/permissions', {});
    } catch (e) {
      if (e instanceof MetaError && e.kind === 'auth') throw new HttpError(400, 'Meta rejected this token. It may have expired or belong to a different app. Generate a new one.');
      if (e instanceof MetaError && e.code === 100) throw new HttpError(400, 'This token belongs to a different Meta app. Generate it from this app\'s Marketing API → Tools page.');
      throw e;
    }
    const granted = new Set(perms.filter((p) => p.status === 'granted').map((p) => p.permission));
    if (!granted.has('ads_read') && !granted.has('ads_management')) throw new HttpError(400, 'This token doesn\'t include ads_read. Tick ads_read before clicking Get Token.');
    const lt = await longLived(pasted);
    const sid = await signInWithToken(lt.token, lt.expiresAt);
    send(res, 200, { ok: true }, { 'set-cookie': S.cookie(SID, sid, { maxAge: SESSION_DAYS * 86400, secure }) });
  });

  route('POST', /^\/auth\/logout$/, async (req, res) => {
    const s = await requireUser(req, { write: true });
    await db.run('DELETE FROM sessions WHERE id = ?', s.id);
    send(res, 200, { ok: true }, { 'set-cookie': S.cookie(SID, '', { maxAge: 0, secure }) });
  });

  route('GET', /^\/api\/me$/, async (req) => {
    const s = await requireUser(req);
    const daysLeft = s.token_expires_at ? Math.floor((s.token_expires_at - Date.now()) / DAY) : null;
    return { id: s.user_id, name: s.name, csrf: s.csrf, demo: config.demo, connection: { status: s.token_status, expiresAt: s.token_expires_at, daysLeft } };
  });

  route('DELETE', /^\/api\/me$/, async (req, res) => {
    const s = await requireUser(req, { write: true });
    await deleteUser(s.user_id);
    send(res, 200, { ok: true, deleted: true }, { 'set-cookie': S.cookie(SID, '', { maxAge: 0, secure }) });
  });

  route('POST', /^\/api\/accounts\/refresh$/, async (req) => {
    const s = await requireUser(req, { write: true });
    await upsertAccounts(s.user_id, await client(await userToken(s.user_id)).all('me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status', limit: 100 }));
    return { accounts: (await db.all('SELECT * FROM ad_accounts WHERE user_id = ? ORDER BY selected DESC, name', s.user_id)).map(publicAccount) };
  });

  route('GET', /^\/api\/accounts$/, async (req) => {
    const s = await requireUser(req);
    return { accounts: (await db.all('SELECT * FROM ad_accounts WHERE user_id = ? ORDER BY selected DESC, name', s.user_id)).map(publicAccount) };
  });

  // One sync step. The browser calls again while syncState is 'partial'.
  route('POST', /^\/api\/accounts\/(act_\d+)\/sync$/, async (req, res, { m }) => {
    const s = await requireUser(req, { write: true });
    await account(s.user_id, m[1]);
    await readBody(req);
    await db.run('UPDATE ad_accounts SET selected = 1 WHERE user_id = ? AND id = ?', s.user_id, m[1]);
    return { account: publicAccount(await runSyncStep(s.user_id, m[1])) };
  });

  // Per-account settings: daily auto-sync on or off.
  route('PUT', /^\/api\/accounts\/(act_\d+)\/settings$/, async (req, res, { m }) => {
    const s = await requireUser(req, { write: true });
    await account(s.user_id, m[1]);
    const b = await readBody(req);
    if (typeof b.autoSync !== 'boolean') throw new HttpError(400, 'autoSync must be true or false.');
    await db.run('UPDATE ad_accounts SET auto_sync = ? WHERE user_id = ? AND id = ?', b.autoSync ? 1 : 0, s.user_id, m[1]);
    return { account: publicAccount(await account(s.user_id, m[1])) };
  });

  route('GET', /^\/api\/accounts\/(act_\d+)$/, async (req, res, { m }) => {
    const s = await requireUser(req);
    return { account: publicAccount(await account(s.user_id, m[1])) };
  });

  // Campaigns / ad sets / ads for a date range, ready for the analysis engine.
  route('GET', /^\/api\/accounts\/(act_\d+)\/entities$/, async (req, res, { m, url }) => {
    const s = await requireUser(req);
    const a = await account(s.user_id, m[1]);
    const level = url.searchParams.get('level') || 'campaign';
    if (!LEVELS.includes(level)) throw new HttpError(400, 'level must be campaign, adset or ad');
    const today = todayIn(a.timezone);
    const since = url.searchParams.get('since') || addDays(today, -29);
    const until = url.searchParams.get('until') || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) throw new HttpError(400, 'Invalid date range');
    // Meta keeps 37 months of insights; anything longer only creates cache rows and API calls.
    if ((Date.parse(until) - Date.parse(since)) / DAY > 1125 || until > addDays(today, 1)) throw new HttpError(400, 'Pick a range within the last 37 months.');
    const reach = a.last_synced_at ? await reachFor(s.user_id, a.id, level, since, until) : {};
    const built = await buildCampaigns({ db, userId: s.user_id, accountId: a.id, level, since, until, reach });
    return { account: publicAccount(a), level, since, until, ...built };
  });

  route('PUT', /^\/api\/entities\/(\d+)\/manual$/, async (req, res, { m }) => {
    const s = await requireUser(req, { write: true });
    const exists = await db.get('SELECT id FROM entities WHERE user_id = ? AND id = ?', s.user_id, m[1]);
    if (!exists) throw new HttpError(404, 'Campaign not found.');
    const prev = await db.get('SELECT json FROM manual_inputs WHERE user_id = ? AND entity_id = ?', s.user_id, m[1]);
    const merged = { ...(prev ? JSON.parse(prev.json) : {}), ...cleanManual(await readBody(req)) };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    await db.run(`INSERT INTO manual_inputs (user_id, entity_id, json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, entity_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`, s.user_id, m[1], JSON.stringify(merged), Date.now());
    return { manual: merged };
  });

  // Saved comparisons.
  route('GET', /^\/api\/comparisons$/, async (req) => {
    const s = await requireUser(req);
    return { comparisons: (await db.all('SELECT * FROM comparisons WHERE user_id = ? ORDER BY updated_at DESC', s.user_id)).map((c) => ({ id: c.id, name: c.name, ...JSON.parse(c.json), updatedAt: c.updated_at })) };
  });
  route('POST', /^\/api\/comparisons$/, async (req) => {
    const s = await requireUser(req, { write: true });
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Give the comparison a name.');
    if (!Array.isArray(b.entityIds) || b.entityIds.length < 2 || b.entityIds.length > 5) throw new HttpError(400, 'Pick 2 to 5 items.');
    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!/^act_\d+$/.test(String(b.accountId)) || !b.entityIds.every((x) => /^\d{1,30}$/.test(String(x)))) throw new HttpError(400, 'Invalid comparison.');
    const data = { accountId: String(b.accountId), level: LEVELS.includes(b.level) ? b.level : 'campaign', preset: ['last7', 'last14', 'last30', 'last90', 'this_month', 'last_month', 'custom'].includes(b.preset) ? b.preset : 'custom', since: isDate(b.since) ? b.since : null, until: isDate(b.until) ? b.until : null, entityIds: b.entityIds.map(String) };
    const id = S.randomId(9);
    await db.run('INSERT INTO comparisons (id, user_id, name, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, s.user_id, name, JSON.stringify(data), Date.now(), Date.now());
    await track(s.user_id, 'comparison_saved');
    return { comparison: { id, name, ...data } };
  });
  route('DELETE', /^\/api\/comparisons\/([\w-]+)$/, async (req, res, { m }) => {
    const s = await requireUser(req, { write: true });
    await db.run('DELETE FROM comparisons WHERE id = ? AND user_id = ?', m[1], s.user_id);
    return { ok: true };
  });

  // Share links: a frozen snapshot anyone with the link can view, until it expires or is revoked.
  route('POST', /^\/api\/shares$/, async (req) => {
    const s = await requireUser(req, { write: true });
    const b = await readBody(req);
    const clean = cleanSnapshot(b);
    if (clean.campaigns.length < 2) throw new HttpError(400, 'A shared report needs 2 to 5 items.');
    const days = Math.min(90, Math.max(1, Number(b.days) || config.shareDays));
    const token = S.randomId(24);
    const snapshot = { ...clean, createdAt: Date.now() };
    await db.run('INSERT INTO shares (token, user_id, title, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', token, s.user_id, snapshot.title, JSON.stringify(snapshot), Date.now(), Date.now() + days * DAY);
    await track(s.user_id, 'share_created');
    return { share: { token, url: `${config.baseUrl}/r/${token}`, expiresAt: Date.now() + days * DAY, title: snapshot.title } };
  });
  route('GET', /^\/api\/shares$/, async (req) => {
    const s = await requireUser(req);
    return { shares: (await db.all('SELECT token, title, created_at, expires_at, revoked_at, views, last_viewed_at FROM shares WHERE user_id = ? ORDER BY created_at DESC', s.user_id))
      .map((x) => ({ token: x.token, url: `${config.baseUrl}/r/${x.token}`, title: x.title, createdAt: x.created_at, expiresAt: x.expires_at, revoked: !!x.revoked_at, views: x.views, lastViewedAt: x.last_viewed_at, active: !x.revoked_at && x.expires_at > Date.now() })) };
  });
  route('DELETE', /^\/api\/shares\/([\w-]+)$/, async (req, res, { m }) => {
    const s = await requireUser(req, { write: true });
    await db.run('UPDATE shares SET revoked_at = ? WHERE token = ? AND user_id = ? AND revoked_at IS NULL', Date.now(), m[1], s.user_id);
    return { ok: true };
  });
  route('GET', /^\/r\/([\w-]+)$/, async (req, res, { m }) => {
    const sh = await db.get('SELECT * FROM shares WHERE token = ?', m[1]);
    const gone = !sh || sh.revoked_at || sh.expires_at < Date.now();
    if (gone) return send(res, 410, plainPage('Link expired', '<h1>This report link has expired</h1><p>Ask the person who shared it for a new link.</p>'), SECURITY_HEADERS);
    await db.run('UPDATE shares SET views = views + 1, last_viewed_at = ? WHERE token = ?', Date.now(), sh.token);
    const data = JSON.stringify({ ...JSON.parse(sh.snapshot), expiresAt: sh.expires_at }).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16));
    const page = appPage(`window.__SHARE__ = ${data};`);
    send(res, 200, page.html, { ...page.headers, 'x-robots-tag': 'noindex' });
  });

  // Usage counters (the hook for plan limits later; nothing is limited today).
  route('GET', /^\/api\/usage$/, async (req) => {
    const s = await requireUser(req);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const counts = Object.fromEntries((await db.all('SELECT kind, SUM(qty) AS n FROM usage_events WHERE user_id = ? AND at >= ? GROUP BY kind', s.user_id, monthStart.getTime())).map((r) => [r.kind, r.n]));
    return {
      month: monthStart.toISOString().slice(0, 7),
      thisMonth: counts,
      totals: {
        adAccountsSynced: (await db.get('SELECT COUNT(*) AS n FROM ad_accounts WHERE user_id = ? AND selected = 1', s.user_id)).n,
        autoSyncOn: (await db.get('SELECT COUNT(*) AS n FROM ad_accounts WHERE user_id = ? AND selected = 1 AND auto_sync = 1', s.user_id)).n,
        savedComparisons: (await db.get('SELECT COUNT(*) AS n FROM comparisons WHERE user_id = ?', s.user_id)).n,
        activeShareLinks: (await db.get('SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', s.user_id, Date.now())).n,
      },
    };
  });

  // Daily sync, called by Vercel Cron (or any scheduler) with the CRON_SECRET.
  route('GET', /^\/api\/cron\/sync$/, async (req) => {
    const auth = req.headers.authorization || '';
    if (!config.cronSecret || !S.safeEqual(auth, `Bearer ${config.cronSecret}`)) throw new HttpError(401, 'Not allowed.');
    return tick({ budgetMs: config.syncStepMs });
  });

  // Meta callbacks (set these URLs in the Meta app settings). Off in demo mode.
  route('POST', /^\/meta\/deauthorize$/, async (req) => {
    if (config.demo) throw new HttpError(404, 'Not found');
    const b = await readBody(req);
    const p = S.parseSignedRequest(b.signed_request, meta.appSecret);
    if (!p || !p.user_id) throw new HttpError(400, 'Invalid signed_request');
    const uid = String(p.user_id);
    await db.batch([
      [`UPDATE users SET token_enc = NULL, token_status = 'reconnect' WHERE id = ?`, uid],
      ['DELETE FROM sessions WHERE user_id = ?', uid],
      ['UPDATE shares SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', Date.now(), uid],
    ]);
    return { ok: true };
  });
  route('POST', /^\/meta\/data-deletion$/, async (req) => {
    if (config.demo && !config.allowDemoCallbacks) throw new HttpError(404, 'Not found');
    const b = await readBody(req);
    const p = S.parseSignedRequest(b.signed_request, meta.appSecret);
    if (!p || !p.user_id) throw new HttpError(400, 'Invalid signed_request');
    await deleteUser(String(p.user_id));
    const code = S.randomId(9);
    await db.run('INSERT INTO deletion_requests (code, at) VALUES (?, ?)', code, Date.now());
    return { url: `${config.baseUrl}/meta/deletion-status?code=${code}`, confirmation_code: code };
  });
  route('GET', /^\/meta\/deletion-status$/, async (req, res, { url }) => {
    const r = await db.get('SELECT at FROM deletion_requests WHERE code = ?', url.searchParams.get('code') || '');
    send(res, r ? 200 : 404, plainPage('Data deletion', r ? `<h1>Your data has been deleted</h1><p>All ad data and settings linked to your Facebook account were deleted on ${new Date(r.at).toUTCString()}.</p>` : '<h1>Request not found</h1>'), SECURITY_HEADERS);
  });

  route('GET', /^\/(index\.html)?$/, (req, res) => { const page = appPage(); send(res, 200, page.html, page.headers); });

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const candidates = routes.filter((r) => r.pattern.test(url.pathname));
    const r = candidates.find((x) => x.method === req.method);
    try {
      if (!r) throw new HttpError(candidates.length ? 405 : 404, candidates.length ? 'Method not allowed' : 'Not found');
      const out = await r.handler(req, res, { url, m: url.pathname.match(r.pattern) });
      if (out !== undefined && !res.headersSent) send(res, 200, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof MetaError ? 502 : 500;
      if (status >= 500) log.error?.(e);
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError || e instanceof MetaError ? e.message : 'Something went wrong on the server.', ...(e.extra || {}) });
    }
  }

  // ---------- daily sync: accounts with auto-sync on that are due ----------
  async function tick({ budgetMs = config.syncStepMs } = {}) {
    const started = Date.now();
    const now = Date.now();
    const due = await db.all(`SELECT a.user_id, a.id FROM ad_accounts a JOIN users u ON u.id = a.user_id
      WHERE a.selected = 1 AND a.auto_sync = 1 AND u.token_status = 'ok'
        AND (a.sync_state != 'running' OR a.sync_started_at < ?)
        AND (a.sync_state = 'partial'
          OR (a.sync_state = 'waiting' AND a.next_attempt_at <= ?)
          OR (a.sync_state NOT IN ('waiting', 'partial') AND (a.last_synced_at IS NULL OR a.last_synced_at < ?)))`,
    now - LEASE_MS, now, now - config.syncEveryHours * 3600000 + 3600000);
    const results = [];
    for (const d of due) {
      // Keep going while there's time; whatever is left continues on the next run.
      let a;
      do {
        const left = budgetMs - (Date.now() - started);
        if (left < 15000) break;
        a = await runSyncStep(d.user_id, d.id, left - 10000);
      } while (a && a.sync_state === 'partial');
      results.push({ account: d.id, state: a ? a.sync_state : 'skipped' });
    }
    await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    return { ok: true, due: due.length, results };
  }
  let timer = null;
  function startScheduler(everyMs = 15 * 60000) {
    timer = setInterval(() => tick().catch((e) => log.error?.(e)), everyMs);
    timer.unref?.();
    setTimeout(() => tick().catch(() => {}), 5000).unref?.();
  }

  const server = http.createServer(handle);
  return { server, db, handle, runSyncStep, tick, startScheduler, close: () => { clearInterval(timer); server.close(); db.close(); } };
}

module.exports = { createApp };
