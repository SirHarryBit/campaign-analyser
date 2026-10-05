// Minimal Meta Graph / Marketing API client: no dependencies, built on fetch.
// - appsecret_proof on every call (Meta's recommended token hardening)
// - follows cursor paging
// - backs off on rate limits and transient errors, using Meta's usage headers
'use strict';
const crypto = require('node:crypto');

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const isRateLimit = (code) => RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014);

class MetaError extends Error {
  constructor(message, { code, subcode, status, fbtraceId, retryAfterMs, kind } = {}) {
    super(message);
    this.name = 'MetaError';
    this.code = code;
    this.subcode = subcode;
    this.status = status;
    this.fbtraceId = fbtraceId;
    this.retryAfterMs = retryAfterMs;
    // kind: 'auth' (reconnect needed), 'rate_limit', 'permission', 'too_much_data', 'transient', 'other'
    this.kind = kind || 'other';
  }
}

function classify(err, status) {
  const code = err.code;
  if (code === 190 || code === 102 || status === 401) return 'auth';
  if (isRateLimit(code)) return 'rate_limit';
  if (code === 10 || code === 200 || code === 294 || (code >= 200 && code <= 299)) return 'permission';
  if (code === 1 && /reduce the amount of data/i.test(err.message || '')) return 'too_much_data';
  if (err.is_transient || code === 1 || code === 2 || status >= 500) return 'transient';
  return 'other';
}

/** Largest "minutes until access returns" from Meta's usage headers, in ms. */
function regainMsFromHeaders(headers) {
  let mins = 0;
  for (const h of ['x-business-use-case-usage', 'x-ad-account-usage', 'x-app-usage']) {
    const raw = headers.get(h);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const values = h === 'x-business-use-case-usage' ? Object.values(parsed).flat() : [parsed];
      for (const v of values) {
        const m = Number(v.estimated_time_to_regain_access ?? v.reset_time_duration ?? 0);
        if (m > mins) mins = m;
      }
    } catch { /* ignore malformed header */ }
  }
  return mins * 60000;
}

/** Highest usage percentage Meta reports (0–100+). */
function usagePctFromHeaders(headers) {
  let pct = 0;
  for (const h of ['x-business-use-case-usage', 'x-ad-account-usage', 'x-app-usage']) {
    const raw = headers.get(h);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const values = h === 'x-business-use-case-usage' ? Object.values(parsed).flat() : [parsed];
      for (const v of values) {
        for (const k of ['call_count', 'total_cputime', 'total_time', 'acc_id_util_pct']) {
          const n = Number(v[k]);
          if (n > pct) pct = n;
        }
      }
    } catch { /* ignore */ }
  }
  return pct;
}

class GraphClient {
  /**
   * @param {object} o
   * @param {string} o.token        user access token
   * @param {string} [o.appSecret]  app secret, for appsecret_proof
   * @param {string} [o.version]    e.g. 'v25.0'
   * @param {string} [o.baseUrl]    'https://graph.facebook.com' or the simulator
   * @param {number} [o.maxRetries]
   * @param {number} [o.maxWaitMs]  longest wait we'll sleep through before giving up
   */
  constructor({ token, appSecret, version = 'v25.0', baseUrl = 'https://graph.facebook.com', fetchImpl = fetch, sleep, maxRetries = 4, maxWaitMs = 120000, timeoutMs = 30000 } = {}) {
    this.token = token;
    this.proof = appSecret ? crypto.createHmac('sha256', appSecret).update(token).digest('hex') : null;
    this.version = version;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = maxRetries;
    this.maxWaitMs = maxWaitMs;
    this.timeoutMs = timeoutMs;
    // Absolute time (ms) after which no new request or wait may start. Serverless hosts stop the
    // function at a fixed limit, so a sync step must end cleanly before that instead of being killed.
    this.deadline = Infinity;
    this.calls = 0;
    this.lastUsagePct = 0;
  }

  url(path, params = {}, { auth = true } = {}) {
    const u = new URL(/^https?:/.test(path) ? path : `${this.baseUrl}/${this.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    if (auth && !u.searchParams.has('access_token')) u.searchParams.set('access_token', this.token);
    if (auth && this.proof && !u.searchParams.has('appsecret_proof')) u.searchParams.set('appsecret_proof', this.proof);
    return u.toString();
  }

  async get(path, params) {
    return this.request(this.url(path, params));
  }

  /** Calls that must not carry a user token (the OAuth code exchange). */
  async getNoAuth(path, params) {
    return this.request(this.url(path, params, { auth: false }));
  }

  /** Throws a 'deadline' error if waiting `ms` more would run past the deadline. */
  checkTime(ms = 0) {
    if (Date.now() + ms > this.deadline) throw new MetaError('Out of time for this step; the sync continues in the next one.', { kind: 'deadline' });
  }

  async wait(ms) {
    this.checkTime(ms);
    await this.sleep(ms);
  }

  async request(url) {
    let attempt = 0;
    for (;;) {
      // Slow down before Meta makes us stop.
      if (this.lastUsagePct >= 90) await this.wait(10000);
      else if (this.lastUsagePct >= 75) await this.wait(2000);
      this.checkTime(5000); // not worth starting a request with less than 5 s left
      const timeout = Math.max(1000, Math.min(this.timeoutMs, this.deadline - Date.now()));
      let res, body;
      try {
        this.calls++;
        res = await this.fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        if (attempt++ < this.maxRetries) { await this.wait(this.backoff(attempt)); continue; }
        throw new MetaError(`Could not reach Meta: ${e.message}`, { kind: 'transient' });
      }
      this.lastUsagePct = usagePctFromHeaders(res.headers);
      if (res.ok && !body.error) return body;

      const err = body.error || { message: `HTTP ${res.status}` };
      const kind = classify(err, res.status);
      const regain = regainMsFromHeaders(res.headers);
      const meta = { code: err.code, subcode: err.error_subcode, status: res.status, fbtraceId: err.fbtrace_id, kind };
      if (kind === 'rate_limit') {
        const wait = regain || this.backoff(attempt + 2);
        if (wait > this.maxWaitMs || attempt >= this.maxRetries) throw new MetaError(err.message || 'Meta rate limit reached', { ...meta, retryAfterMs: wait || 60000 });
        attempt++;
        await this.wait(wait);
        continue;
      }
      if (kind === 'transient' && attempt < this.maxRetries) { attempt++; await this.wait(this.backoff(attempt)); continue; }
      throw new MetaError(err.message || 'Meta API error', meta);
    }
  }

  backoff(attempt) {
    return Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  /** Every item across all pages. */
  async all(path, params, { maxPages = 200 } = {}) {
    const out = [];
    let body = await this.get(path, params);
    for (let page = 0; ; page++) {
      if (Array.isArray(body.data)) out.push(...body.data);
      const next = body.paging && body.paging.next;
      if (!next || page >= maxPages) break;
      body = await this.request(next);
    }
    return out;
  }
}

module.exports = { GraphClient, MetaError, isRateLimit, regainMsFromHeaders, usagePctFromHeaders, classify };
