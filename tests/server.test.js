// End-to-end: the real server against the simulated Meta API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startMetaMock, DEMO } = require('../mock/meta-mock.js');
const { loadConfig } = require('../server/config.js');
const { createApp } = require('../server/app.js');
const { createFakeClient } = require('./fake-libsql.js');

const quiet = { info() {}, warn() {}, error() {} };

// Every server test runs twice: on node:sqlite (local) and on the libSQL path (Turso on Vercel).
const DRIVERS = ['sqlite', 'libsql'];
let DRIVER = 'sqlite';
const dtest = (name, fn) => DRIVERS.forEach((d) => test(`[${d}] ${name}`, async () => { DRIVER = d; await fn(); }));

async function setup({ failEvery = 0, stepMs } = {}) {
  const mock = await startMetaMock({ failEvery });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
  const config = loadConfig({ DEMO: '1', DATA_DIR: dir, PORT: '0', CRON_SECRET: 'test-cron-secret' });
  config.meta.graphUrl = mock.url;
  config.meta.dialogUrl = mock.url;
  config.allowDemoCallbacks = true;
  if (stepMs !== undefined) config.syncStepMs = stepMs;
  if (DRIVER === 'libsql') config.db = { client: createFakeClient() };
  const app = await createApp(config, { sleep: async () => {}, log: quiet });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  config.baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const jar = {};
  const call = async (method, p, { body, csrf, raw } = {}) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(p.startsWith('http') ? p : config.baseUrl + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  async function signIn() {
    const start = await call('GET', '/auth/meta/start', { raw: true });
    assert.strictEqual(start.status, 302);
    const dialog = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const back = await call('GET', dialog.headers.get('location'), { raw: true });
    assert.strictEqual(back.headers.get('location'), '/#connected');
    return (await call('GET', '/api/me')).body;
  }
  const done = async () => { app.close(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, mock, config, call, signIn, jar, done };
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

dtest('sign in, sync and read campaigns, ad sets and ads', async () => {
  const t = await setup();
  try {
    assert.strictEqual((await t.call('GET', '/api/me')).status, 401);
    const me = await t.signIn();
    assert.strictEqual(me.id, DEMO.userId);
    assert.ok(me.csrf);
    // The token is stored encrypted, never in plain text.
    const row = await t.app.db.get('SELECT token_enc FROM users WHERE id = ?', me.id);
    assert.ok(row.token_enc && !row.token_enc.includes(DEMO.longToken));

    const accts = (await t.call('GET', '/api/accounts')).body.accounts;
    assert.strictEqual(accts.length, 1);
    const id = accts[0].id;

    assert.strictEqual((await t.call('POST', `/api/accounts/${id}/sync`, { body: { wait: true } })).status, 403, 'CSRF token required');
    const synced = await t.call('POST', `/api/accounts/${id}/sync`, { body: { wait: true }, csrf: me.csrf });
    assert.strictEqual(synced.body.account.syncState, 'ok', JSON.stringify(synced.body));

    const camp = (await t.call('GET', `/api/accounts/${id}/entities?level=campaign&since=${isoDaysAgo(29)}&until=${isoDaysAgo(0)}`)).body;
    assert.strictEqual(camp.campaigns.length, 5);
    const adv = camp.campaigns.find((c) => /Advantage/.test(c.name));
    assert.strictEqual(adv.objective, 'leads');
    assert.ok(adv.leads > 0 && adv.spend > 0 && adv.reach > 0);
    assert.strictEqual(adv.landingPageViews, undefined, 'instant-form campaign has no landing page');
    assert.ok(adv.budget >= 2500 * 28 && adv.budget <= 2500 * 30, 'daily budget × days');
    assert.ok(adv.universe > 20000000, 'audience size from the delivery estimate');
    assert.match(adv.targetingNotes, /Advantage\+/);
    assert.ok(adv.daily.length >= 28);
    const wellness = camp.campaigns.find((c) => /Wellness/.test(c.name));
    assert.ok(wellness.budget > 0, 'ad set budgets add up to a campaign budget');
    const lal = camp.campaigns.find((c) => /Lookalike/.test(c.name));
    assert.ok(lal.landingPageViews > 0 && lal.leads > 0);
    const reachCampaign = camp.campaigns.find((c) => /Reach/.test(c.name));
    assert.strictEqual(reachCampaign.objective, 'awareness');

    const adsets = (await t.call('GET', `/api/accounts/${id}/entities?level=adset&since=${isoDaysAgo(29)}&until=${isoDaysAgo(0)}`)).body.campaigns;
    assert.strictEqual(adsets.length, 7);
    assert.ok(adsets.every((a) => a.campaignName));
    const ads = (await t.call('GET', `/api/accounts/${id}/entities?level=ad&since=${isoDaysAgo(29)}&until=${isoDaysAgo(0)}`)).body.campaigns;
    assert.strictEqual(ads.length, 8);
    assert.ok(ads.every((a) => a.thumbnailUrl && a.adsetName));

    // A second sync only re-fetches the last few days.
    const before = t.mock.stats.calls;
    await t.call('POST', `/api/accounts/${id}/sync`, { body: { wait: true }, csrf: me.csrf });
    assert.ok(t.mock.stats.calls - before < 12, 'incremental sync is cheap');
  } finally { await t.done(); }
});

dtest('manual inputs, saved comparisons, share links, usage', async () => {
  const t = await setup();
  try {
    const me = await t.signIn();
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    await t.call('POST', `/api/accounts/${id}/sync`, { body: { wait: true }, csrf: me.csrf });
    const q = `level=campaign&since=${isoDaysAgo(29)}&until=${isoDaysAgo(0)}`;
    const list = (await t.call('GET', `/api/accounts/${id}/entities?${q}`)).body.campaigns;
    const target = list[0];

    const put = await t.call('PUT', `/api/entities/${target.id}/manual`, { body: { qualifiedLeads: 42, universe: 'abc', targeting: 'focused', evil: 'x' }, csrf: me.csrf });
    assert.deepStrictEqual(put.body.manual, { qualifiedLeads: 42, targeting: 'focused' });
    const after = (await t.call('GET', `/api/accounts/${id}/entities?${q}`)).body.campaigns.find((c) => c.id === target.id);
    assert.strictEqual(after.qualifiedLeads, 42);
    assert.strictEqual(after.targeting, 'focused');
    await t.call('PUT', `/api/entities/${target.id}/manual`, { body: { targeting: null }, csrf: me.csrf });
    assert.strictEqual((await t.call('GET', `/api/accounts/${id}/entities?${q}`)).body.campaigns.find((c) => c.id === target.id).targeting, 'auto');

    const saved = await t.call('POST', '/api/comparisons', { body: { name: 'Lead forms vs lookalike', accountId: id, level: 'campaign', preset: 'last30', entityIds: [list[0].id, list[1].id] }, csrf: me.csrf });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual((await t.call('GET', '/api/comparisons')).body.comparisons.length, 1);
    await t.call('DELETE', `/api/comparisons/${saved.body.comparison.id}`, { csrf: me.csrf });
    assert.strictEqual((await t.call('GET', '/api/comparisons')).body.comparisons.length, 0);

    const share = await t.call('POST', '/api/shares', { body: { title: 'August </script><script>alert(1)</script>', campaigns: list.slice(0, 2), days: 7 }, csrf: me.csrf });
    const token = share.body.share.token;
    const page = await fetch(`${t.config.baseUrl}/r/${token}`);
    const html = await page.text();
    assert.strictEqual(page.status, 200);
    assert.ok(html.includes('window.__SHARE__'));
    assert.ok(!html.includes('</script><script>alert(1)'), 'snapshot is escaped');
    assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
    await t.call('DELETE', `/api/shares/${token}`, { csrf: me.csrf });
    assert.strictEqual((await fetch(`${t.config.baseUrl}/r/${token}`)).status, 410);

    const usage = (await t.call('GET', '/api/usage')).body;
    assert.ok(usage.thisMonth.sync >= 1 && usage.thisMonth.share_created === 1 && usage.thisMonth.meta_api_calls > 0);
  } finally { await t.done(); }
});

dtest('sync survives Meta rate limits', async () => {
  const t = await setup({ failEvery: 4 });
  try {
    const me = await t.signIn();
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    const r = await t.call('POST', `/api/accounts/${id}/sync`, { body: { wait: true }, csrf: me.csrf });
    assert.strictEqual(r.body.account.syncState, 'ok');
    assert.ok(t.mock.stats.rateLimited > 0);
  } finally { await t.done(); }
});

dtest('Meta data-deletion callback removes everything for that user', async () => {
  const t = await setup();
  try {
    const me = await t.signIn();
    const acct = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    await t.call('POST', `/api/accounts/${acct}/sync`, { body: {}, csrf: me.csrf });
    assert.ok((await t.app.db.get('SELECT COUNT(*) AS n FROM daily')).n > 0);
    const payload = Buffer.from(JSON.stringify({ user_id: me.id, algorithm: 'HMAC-SHA256' })).toString('base64url');
    const sig = crypto.createHmac('sha256', DEMO.appSecret).update(payload).digest('base64url');
    const bad = await fetch(`${t.config.baseUrl}/meta/data-deletion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=xx.${payload}` });
    assert.strictEqual(bad.status, 400);
    const res = await fetch(`${t.config.baseUrl}/meta/data-deletion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=${sig}.${payload}` });
    const body = await res.json();
    assert.ok(body.confirmation_code && body.url.includes('/meta/deletion-status'));
    assert.strictEqual((await t.app.db.get('SELECT COUNT(*) AS n FROM users')).n, 0);
    assert.strictEqual((await t.app.db.get('SELECT COUNT(*) AS n FROM daily')).n, 0, 'synced data removed too');
    assert.strictEqual((await t.call('GET', '/api/me')).status, 401);
    assert.strictEqual((await fetch(body.url)).status, 200);
  } finally { await t.done(); }
});

dtest('expired Meta token asks the user to reconnect', async () => {
  const t = await setup();
  try {
    const me = await t.signIn();
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    // Corrupt the stored token so Meta rejects it (code 190).
    const S = require('../server/security.js');
    await t.app.db.run('UPDATE users SET token_enc = ? WHERE id = ?', S.encrypt('revoked-token', t.config.key), me.id);
    const r = await t.call('POST', `/api/accounts/${id}/sync`, { body: { wait: true }, csrf: me.csrf });
    assert.strictEqual(r.body.account.syncState, 'reconnect');
    assert.strictEqual((await t.call('GET', '/api/me')).body.connection.status, 'reconnect');
  } finally { await t.done(); }
});

dtest('security: share snapshots are whitelisted, $ in names is safe, scripts need a nonce', async () => {
  const t = await setup();
  try {
    const me = await t.signIn();
    const evil = [
      { id: '1"><img src=x onerror=alert(1)>', name: "Lead $' form $&", spend: 100, leads: 5, objective: 'leads', thumbnailUrl: 'https://evil.example/x.png', daily: [{ date: '2026-08-01', spend: 'x' }], onclick: 'bad' },
      { id: 'ok_2', name: 'Second', spend: 50, leads: 2, objective: 'leads' },
    ];
    const share = await t.call('POST', '/api/shares', { body: { campaigns: evil, settings: { currency: 'INR<script>' } }, csrf: me.csrf });
    const row = await t.app.db.get('SELECT snapshot FROM shares WHERE token = ?', share.body.share.token);
    const snap = JSON.parse(row.snapshot);
    assert.strictEqual(snap.campaigns[0].id, 'item1', 'unsafe id replaced');
    assert.strictEqual(snap.campaigns[0].thumbnailUrl, undefined);
    assert.strictEqual(snap.campaigns[0].onclick, undefined);
    assert.strictEqual(snap.campaigns[0].daily[0].spend, null);
    assert.strictEqual(snap.settings.currency, undefined);
    const res = await fetch(`${t.config.baseUrl}/r/${share.body.share.token}`);
    const html = await res.text();
    assert.ok(html.length < 400000, 'page not duplicated by $ patterns');
    assert.strictEqual((html.match(/window\.__SHARE__ = /g) || []).length, 1);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    const nonce = csp.match(/nonce-([^']+)/)[1];
    assert.ok([...html.matchAll(/<script(?=[\s>])([^>]*)>/g)].every((m) => m[1].includes(`nonce="${nonce}"`)), 'every script carries the nonce');
  } finally { await t.done(); }
});

dtest('security: junk cookies, bad ranges, demo mode only on localhost', async () => {
  const t = await setup();
  try {
    await t.signIn();
    t.jar['other'] = '%E0%A4%A';
    assert.strictEqual((await t.call('GET', '/api/me')).status, 200, 'malformed cookie ignored');
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    assert.strictEqual((await t.call('GET', `/api/accounts/${id}/entities?since=2010-01-01&until=2026-01-01`)).status, 400);
    assert.throws(() => loadConfig({ DEMO: '1', HOST: '0.0.0.0', DATA_DIR: t.config.dataDir }), /Demo mode only runs on this computer/);
    assert.throws(() => loadConfig({ META_APP_ID: '123', META_APP_SECRET: '', DATA_DIR: t.config.dataDir }), /META_APP_SECRET/);
  } finally { await t.done(); }
});


dtest('a sync split into short steps ends with the same data', async () => {
  const t = await setup({ stepMs: 1 }); // every step stops after one chunk of work
  try {
    const me = await t.signIn();
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    let steps = 0, a;
    do { a = (await t.call('POST', `/api/accounts/${id}/sync`, { body: {}, csrf: me.csrf })).body.account; steps++; } while (a.syncState === 'partial' && steps < 20);
    assert.ok(steps >= 3, `took ${steps} steps`);
    assert.strictEqual(a.syncState, 'ok');
    const camp = (await t.call('GET', `/api/accounts/${id}/entities?level=campaign&since=${isoDaysAgo(29)}&until=${isoDaysAgo(0)}`)).body;
    assert.strictEqual(camp.campaigns.length, 5);
    assert.ok(camp.campaigns.every((c) => c.daily.length > 0));
  } finally { await t.done(); }
});

dtest('auto-sync toggle decides what the daily cron syncs', async () => {
  const t = await setup();
  try {
    const me = await t.signIn();
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    await t.call('POST', `/api/accounts/${id}/sync`, { body: {}, csrf: me.csrf });
    // Pretend the last sync was two days ago.
    await t.app.db.run('UPDATE ad_accounts SET last_synced_at = ? WHERE id = ?', Date.now() - 2 * 86400000, id);

    assert.strictEqual((await t.call('GET', '/api/cron/sync')).status, 401, 'cron needs the secret');
    const off = await t.call('PUT', `/api/accounts/${id}/settings`, { body: { autoSync: false }, csrf: me.csrf });
    assert.strictEqual(off.body.account.autoSync, false);
    const cronOff = await fetch(`${t.config.baseUrl}/api/cron/sync`, { headers: { authorization: 'Bearer test-cron-secret' } }).then((r) => r.json());
    assert.strictEqual(cronOff.due, 0, 'auto-sync off: not synced');

    await t.call('PUT', `/api/accounts/${id}/settings`, { body: { autoSync: true }, csrf: me.csrf });
    const cronOn = await fetch(`${t.config.baseUrl}/api/cron/sync`, { headers: { authorization: 'Bearer test-cron-secret' } }).then((r) => r.json());
    assert.strictEqual(cronOn.due, 1);
    assert.strictEqual(cronOn.results[0].state, 'ok');
    assert.strictEqual((await t.call('PUT', `/api/accounts/${id}/settings`, { body: { autoSync: 'yes' }, csrf: me.csrf })).status, 400);
  } finally { await t.done(); }
});

dtest('a sync lease stops two syncs of one account at once', async () => {
  const t = await setup();
  try {
    const me = await t.signIn();
    const id = (await t.call('GET', '/api/accounts')).body.accounts[0].id;
    await t.app.db.run(`UPDATE ad_accounts SET sync_state = 'running', sync_started_at = ? WHERE id = ?`, Date.now(), id);
    const before = t.mock.stats.calls;
    const r = await t.call('POST', `/api/accounts/${id}/sync`, { body: {}, csrf: me.csrf });
    assert.strictEqual(r.body.account.syncState, 'running');
    assert.strictEqual(t.mock.stats.calls, before, 'no Meta calls while another sync holds the lease');
    // A lease older than the function time limit is taken over.
    await t.app.db.run('UPDATE ad_accounts SET sync_started_at = ? WHERE id = ?', Date.now() - 400000, id);
    assert.strictEqual((await t.call('POST', `/api/accounts/${id}/sync`, { body: {}, csrf: me.csrf })).body.account.syncState, 'ok');
  } finally { await t.done(); }
});

test('hosted config: refuses to start without what Vercel needs', () => {
  const base = { VERCEL: '1', META_APP_ID: '123', META_APP_SECRET: 's', BASE_URL: 'https://x.vercel.app' };
  assert.throws(() => loadConfig({ ...base }), /Turso/);
  assert.throws(() => loadConfig({ ...base, TURSO_DATABASE_URL: 'libsql://db.turso.io' }), /APP_SECRET_KEY is missing/);
  assert.throws(() => loadConfig({ ...base, TURSO_DATABASE_URL: 'libsql://db.turso.io', APP_SECRET_KEY: 'short' }), /32 random bytes/);
  assert.throws(() => loadConfig({ VERCEL: '1', BASE_URL: 'https://x.vercel.app' }), /Demo mode only runs on this computer/);
  const key = crypto.randomBytes(32).toString('base64');
  const c = loadConfig({ ...base, TURSO_DATABASE_URL: 'libsql://db.turso.io', TURSO_AUTH_TOKEN: 't', APP_SECRET_KEY: key });
  assert.deepStrictEqual(c.db, { url: 'libsql://db.turso.io', authToken: 't' });
  assert.strictEqual(c.hosted, true);
  assert.strictEqual(c.baseUrl, 'https://x.vercel.app');
});

test('the Vercel entry point serves the app', async () => {
  const http = require('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-vercel-'));
  const saved = { ...process.env };
  Object.assign(process.env, { DEMO: '1', DATA_DIR: dir });
  delete process.env.VERCEL;
  try {
    delete require.cache[require.resolve('../api/index.js')];
    const handler = require('../api/index.js');
    const srv = http.createServer(handler);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.strictEqual(health.ok, true);
    const page = await fetch(`${base}/`);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /nonce-/);
    await new Promise((r) => srv.close(r));
  } finally {
    process.env = saved;
    // Windows won't delete a database file that's still open; the app keeps it open
    // for the life of the process (as a warm Vercel function does), so skip cleanup errors.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder; the OS clears it */ }
  }
});
