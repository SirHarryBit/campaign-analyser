// A simulated Meta Graph / Marketing API for demo mode and tests.
// It answers the same endpoints the real API does, in the same shapes
// (cursor paging, `actions` arrays, budgets in paise, error objects), with
// made-up data for a fictional yoga studio. Dates are relative to today, so
// the demo always looks current. Nothing here talks to Meta.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const DEMO = {
  appId: 'demo-app',
  appSecret: 'demo-secret',
  userId: '100000000000001',
  userName: 'Demo user',
  shortToken: 'demo-short-token',
  longToken: 'demo-long-token',
  accountId: 'act_1000000001',
  noAdsToken: 'demo-token-without-ads-read',
};

// ---------- deterministic randomness ----------
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    const t = (h ^= h >>> 16) >>> 0;
    return t / 4294967296;
  };
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

// ---------- the fictional account ----------
function buildAccount(now = today()) {
  const d = (n) => addDays(now, n);
  const t = (n) => iso(d(n)) + 'T09:00:00+0530';
  const campaigns = [
    { id: '120200000000001', name: 'Lead form – Advantage+ (Mumbai)', objective: 'OUTCOME_LEADS', status: 'ACTIVE', daily_budget: '250000', start_time: t(-60), form: true },
    { id: '120200000000002', name: 'Lead form – Wellness interests', objective: 'OUTCOME_LEADS', status: 'ACTIVE', daily_budget: '200000', start_time: t(-60), form: true },
    { id: '120200000000003', name: 'Website leads – Lookalike 1%', objective: 'OUTCOME_LEADS', status: 'PAUSED', lifetime_budget: '6000000', start_time: t(-45), stop_time: t(-6), form: false },
    { id: '120200000000004', name: 'Studio launch – Reach', objective: 'OUTCOME_AWARENESS', status: 'PAUSED', daily_budget: '80000', start_time: t(-30), stop_time: t(-17) },
    { id: '120200000000005', name: 'Weekend workshop – Traffic', objective: 'OUTCOME_TRAFFIC', status: 'ACTIVE', daily_budget: '100000', start_time: t(-20) },
  ];
  const mumbai = { cities: [{ key: '1035921', name: 'Mumbai' }] };
  // Per ad set: cost per 1,000 impressions (₹), audience size, targeting spec.
  const adsets = [
    { id: '120210000000011', campaign_id: '120200000000001', name: 'Advantage+ 25-45', cpm: 95, universe: [21000000, 26000000], targeting: { geo_locations: mumbai, age_min: 25, age_max: 45, targeting_automation: { advantage_audience: 1 } } },
    { id: '120210000000021', campaign_id: '120200000000002', name: 'Yoga + meditation', cpm: 150, universe: [3400000, 4100000], targeting: { geo_locations: mumbai, age_min: 25, age_max: 50, flexible_spec: [{ interests: [{ id: '1', name: 'Yoga' }, { id: '2', name: 'Meditation' }] }] } },
    { id: '120210000000022', campaign_id: '120200000000002', name: 'Fitness + nutrition', cpm: 140, universe: [5200000, 6100000], targeting: { geo_locations: mumbai, age_min: 22, age_max: 45, flexible_spec: [{ interests: [{ id: '3', name: 'Physical fitness' }, { id: '4', name: 'Nutrition' }] }] } },
    { id: '120210000000031', campaign_id: '120200000000003', name: '1% lookalike of members', cpm: 210, universe: [480000, 560000], targeting: { geo_locations: { countries: ['IN'] }, custom_audiences: [{ id: '9', name: '1% Lookalike (IN) – Members list', subtype: 'LOOKALIKE' }] } },
    { id: '120210000000032', campaign_id: '120200000000003', name: 'Website visitors 30 days', cpm: 260, universe: [38000, 46000], targeting: { geo_locations: mumbai, custom_audiences: [{ id: '8', name: 'Website visitors – 30 days', subtype: 'WEBSITE' }] } },
    { id: '120210000000041', campaign_id: '120200000000004', name: 'Mumbai 22-50 broad', cpm: 60, universe: [9000000, 10000000], targeting: { geo_locations: mumbai, age_min: 22, age_max: 50 } },
    { id: '120210000000051', campaign_id: '120200000000005', name: 'Workshop – interests', cpm: 120, universe: [2600000, 3100000], targeting: { geo_locations: mumbai, flexible_spec: [{ interests: [{ id: '5', name: 'Yoga' }, { id: '6', name: 'Workshops' }] }] } },
  ];
  // Per ad: click-through rate, landing-page load rate, lead rate per click, fatigue per day.
  const ads = [
    { id: '120230000000111', adset_id: '120210000000011', name: 'Reel – member testimonial', ctr: 0.017, lpv: 0, leadRate: 0.075, fatigue: 0.004, video: true, colour: '#2a78d6' },
    { id: '120230000000112', adset_id: '120210000000011', name: 'Static – first class free', ctr: 0.012, lpv: 0, leadRate: 0.06, fatigue: 0.012, colour: '#eb6834' },
    { id: '120230000000211', adset_id: '120210000000021', name: 'Carousel – class types', ctr: 0.014, lpv: 0, leadRate: 0.065, fatigue: 0.003, colour: '#1baf7a' },
    { id: '120230000000221', adset_id: '120210000000022', name: 'Reel – morning flow', ctr: 0.016, lpv: 0, leadRate: 0.052, fatigue: 0.005, video: true, colour: '#eda100' },
    { id: '120230000000311', adset_id: '120210000000031', name: 'Static – member story', ctr: 0.011, lpv: 0.78, leadRate: 0.11, fatigue: 0.002, colour: '#e87ba4' },
    { id: '120230000000321', adset_id: '120210000000032', name: 'Static – come back offer', ctr: 0.019, lpv: 0.82, leadRate: 0.16, fatigue: 0.006, colour: '#2a78d6' },
    { id: '120230000000411', adset_id: '120210000000041', name: 'Reel – studio tour', ctr: 0.006, lpv: 0, leadRate: 0, fatigue: 0.004, video: true, colour: '#1baf7a' },
    { id: '120230000000511', adset_id: '120210000000051', name: 'Static – workshop poster', ctr: 0.021, lpv: 0.71, leadRate: 0, fatigue: 0.004, colour: '#eb6834' },
  ];
  const campaignById = Object.fromEntries(campaigns.map((c) => [c.id, c]));
  const adsetById = Object.fromEntries(adsets.map((a) => [a.id, a]));
  for (const a of adsets) {
    const c = campaignById[a.campaign_id];
    a.status = c.status; a.start_time = c.start_time; a.end_time = c.stop_time;
    a.optimization_goal = c.objective === 'OUTCOME_LEADS' ? (c.form ? 'LEAD_GENERATION' : 'OFFSITE_CONVERSIONS') : c.objective === 'OUTCOME_TRAFFIC' ? 'LANDING_PAGE_VIEWS' : 'REACH';
  }
  // Campaign 2 uses ad set budgets (no campaign budget), like many real accounts.
  delete campaignById['120200000000002'].daily_budget;
  adsetById['120210000000021'].daily_budget = '120000';
  adsetById['120210000000022'].daily_budget = '80000';
  for (const ad of ads) { const s = adsetById[ad.adset_id]; ad.campaign_id = s.campaign_id; ad.status = s.status; }
  return { campaigns, adsets, ads, campaignById, adsetById, now };
}

// Daily spend per ad set: its share of the campaign budget, with weekday noise.
function dailyRow(acc, ad, date) {
  const s = acc.adsetById[ad.adset_id];
  const c = acc.campaignById[ad.campaign_id];
  const start = c.start_time.slice(0, 10), stop = c.stop_time ? c.stop_time.slice(0, 10) : null;
  if (date < start || (stop && date > stop) || date > iso(acc.now)) return null;
  const rnd = seeded(ad.id + date);
  const siblings = acc.ads.filter((x) => x.adset_id === ad.adset_id).length;
  const adsetsInCampaign = acc.adsets.filter((x) => x.campaign_id === c.id).length;
  let daily;
  if (c.lifetime_budget) {
    const days = (Date.parse(stop) - Date.parse(start)) / 86400000 + 1;
    daily = Number(c.lifetime_budget) / 100 / days / adsetsInCampaign;
  } else if (s.daily_budget) daily = Number(s.daily_budget) / 100;
  else daily = Number(c.daily_budget) / 100 / adsetsInCampaign;
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const weekend = dow === 0 || dow === 6 ? 1.12 : 1;
  const spend = (daily / siblings) * (0.86 + rnd() * 0.22) * weekend;
  const age = (Date.parse(date) - Date.parse(start)) / 86400000;
  const cpm = s.cpm * (1 + age * 0.004) * (0.9 + rnd() * 0.2);
  const impressions = Math.round((spend / cpm) * 1000);
  const freqDay = 1.08 + rnd() * 0.12;
  const reach = Math.round(impressions / freqDay);
  const ctr = Math.max(0.002, ad.ctr * (1 - ad.fatigue * age) * (0.85 + rnd() * 0.3));
  const clicks = Math.round(impressions * ctr);
  const lpv = ad.lpv ? Math.round(clicks * ad.lpv * (0.92 + rnd() * 0.12)) : 0;
  const base = ad.lpv ? lpv : clicks;
  const leads = Math.round(base * ad.leadRate * (0.75 + rnd() * 0.5));
  const actions = [{ action_type: 'link_click', value: String(clicks) }];
  if (lpv) actions.push({ action_type: 'landing_page_view', value: String(lpv) }, { action_type: 'omni_landing_page_view', value: String(lpv) });
  if (leads) {
    actions.push({ action_type: 'lead', value: String(leads) });
    actions.push({ action_type: c.form ? 'onsite_conversion.lead_grouped' : 'offsite_conversion.fb_pixel_lead', value: String(leads) });
  }
  if (ad.video) actions.push({ action_type: 'video_view', value: String(Math.round(impressions * (0.22 + rnd() * 0.08))) });
  return { spend, impressions, reach, clicks, actions };
}

function sumActions(rows) {
  const m = new Map();
  for (const r of rows) for (const a of r.actions) m.set(a.action_type, (m.get(a.action_type) || 0) + Number(a.value));
  return [...m].map(([action_type, v]) => ({ action_type, value: String(v) }));
}

function insights(acc, q) {
  const level = q.get('level') || 'account';
  const range = JSON.parse(q.get('time_range') || 'null') || { since: iso(addDays(acc.now, -29)), until: iso(acc.now) };
  const inc = q.get('time_increment');
  const days = Math.round((Date.parse(range.until) - Date.parse(range.since)) / 86400000) + 1;
  if (inc === '1' && level === 'ad' && days > 120) return { error: { code: 1, message: 'Please reduce the amount of data you\'re asking for, then retry your request' } };
  const filtering = JSON.parse(q.get('filtering') || '[]');
  const idFilter = filtering.find((f) => /\.id$|_id$/.test(f.field));
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(iso(addDays(new Date(range.since + 'T00:00:00Z'), i)));
  const keyOf = (ad) => (level === 'ad' ? ad.id : level === 'adset' ? ad.adset_id : level === 'campaign' ? ad.campaign_id : 'account');
  const groups = new Map();
  for (const ad of acc.ads) {
    const key = keyOf(ad);
    if (idFilter && !idFilter.value.includes(key)) continue;
    for (const date of dates) {
      const r = dailyRow(acc, ad, date);
      if (!r) continue;
      const gk = inc === '1' ? key + '|' + date : key;
      if (!groups.has(gk)) groups.set(gk, { key, date, ad, rows: [], dates: new Set() });
      groups.get(gk).rows.push(r);
      groups.get(gk).dates.add(date);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const spend = g.rows.reduce((a, r) => a + r.spend, 0);
    const impressions = g.rows.reduce((a, r) => a + r.impressions, 0);
    const dailyReach = g.rows.reduce((a, r) => a + r.reach, 0);
    // Unique reach over many days is smaller than the sum of daily reach: people see the ad on several days.
    const n = g.dates.size;
    const reach = inc === '1' ? dailyReach : Math.round(dailyReach / (1 + 0.035 * (n - 1)));
    const c = acc.campaignById[g.ad.campaign_id], s = acc.adsetById[g.ad.adset_id];
    const row = {
      spend: spend.toFixed(2), impressions: String(impressions), reach: String(reach), frequency: (impressions / Math.max(1, reach)).toFixed(6),
      clicks: String(Math.round(g.rows.reduce((a, r) => a + r.clicks, 0) * 1.35)), inline_link_clicks: String(g.rows.reduce((a, r) => a + r.clicks, 0)),
      actions: sumActions(g.rows), account_id: DEMO.accountId.slice(4), account_currency: 'INR',
      date_start: inc === '1' ? g.date : range.since, date_stop: inc === '1' ? g.date : range.until,
    };
    if (level !== 'account') { row.campaign_id = c.id; row.campaign_name = c.name; row.objective = c.objective; }
    if (level === 'adset' || level === 'ad') { row.adset_id = s.id; row.adset_name = s.name; }
    if (level === 'ad') { row.ad_id = g.ad.id; row.ad_name = g.ad.name; }
    out.push(row);
  }
  out.sort((a, b) => (a.date_start + (a.ad_id || a.adset_id || a.campaign_id || '')).localeCompare(b.date_start + (b.ad_id || b.adset_id || b.campaign_id || '')));
  return { data: out };
}

function pick(obj, fields) {
  const out = { id: obj.id };
  for (const f of fields) {
    const k = f.replace(/\{.*$/, '');
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function page(req, base, items, q) {
  const limit = Math.min(Number(q.get('limit') || 25), 500);
  const after = Number(q.get('after') || 0);
  const slice = items.slice(after, after + limit);
  const body = { data: slice, paging: { cursors: { before: String(after), after: String(after + slice.length) } } };
  if (after + limit < items.length) {
    const u = new URL(req.url, base);
    u.searchParams.set('after', String(after + limit));
    body.paging.next = base + u.pathname + u.search;
  }
  return body;
}

function thumb(colour, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" rx="10" fill="${colour}"/><circle cx="60" cy="48" r="20" fill="#fff" opacity=".85"/><rect x="22" y="80" width="76" height="10" rx="5" fill="#fff" opacity=".85"/><text x="60" y="108" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#fff">${label}</text></svg>`;
}

/**
 * Start the simulator. Options:
 *  port (0 = random), failEvery (inject a rate-limit error every N API calls), log
 * Returns { url, close, server, stats }.
 */
function startMetaMock({ port = 0, failEvery = 0, version = 'v25.0' } = {}) {
  const stats = { calls: 0, rateLimited: 0 };
  let acc = buildAccount();
  const server = http.createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    const u = new URL(req.url, base);
    const q = u.searchParams;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    // A new day: rebuild so "today" moves forward in long-running demos.
    if (iso(acc.now) !== iso(today())) acc = buildAccount();

    // OAuth dialog: approve straight away and send the user back.
    if (u.pathname.endsWith('/dialog/oauth')) {
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', 'demo-code');
      back.searchParams.set('state', q.get('state') || '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname.startsWith('/thumb/')) {
      const ad = acc.ads.find((a) => u.pathname.includes(a.id));
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
      return res.end(thumb(ad ? ad.colour : '#888', ad && ad.video ? 'VIDEO' : 'IMAGE'));
    }
    const m = u.pathname.match(/^\/(v\d+\.\d+)\/(.+)$/);
    if (!m) return send(404, { error: { message: 'Unknown path', code: 803 } });
    const path = m[2];

    if (path === 'oauth/access_token') {
      if (q.get('client_secret') !== DEMO.appSecret) return send(400, { error: { message: 'Error validating client secret.', type: 'OAuthException', code: 1 } });
      if (q.get('grant_type') === 'fb_exchange_token') return send(200, { access_token: DEMO.longToken, token_type: 'bearer', expires_in: 5184000 });
      if (q.get('code') !== 'demo-code') return send(400, { error: { message: 'Invalid verification code format.', type: 'OAuthException', code: 100 } });
      return send(200, { access_token: DEMO.shortToken, token_type: 'bearer', expires_in: 5183 });
    }

    stats.calls++;
    const token = q.get('access_token');
    if (token !== DEMO.longToken && token !== DEMO.shortToken && token !== DEMO.noAdsToken) return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
    const proof = q.get('appsecret_proof');
    if (proof && proof !== crypto.createHmac('sha256', DEMO.appSecret).update(token).digest('hex')) return send(400, { error: { message: 'Invalid appsecret_proof provided in the API argument', code: 100 } });
    const usage = { 'x-business-use-case-usage': JSON.stringify({ [DEMO.accountId.slice(4)]: [{ type: 'ads_insights', call_count: Math.min(99, stats.calls % 100), total_cputime: 5, total_time: 5, estimated_time_to_regain_access: 0 }] }) };
    if (failEvery && stats.calls % failEvery === 0) {
      stats.rateLimited++;
      return send(400, { error: { message: 'User request limit reached', type: 'OAuthException', code: 17, is_transient: true } }, usage);
    }
    const fields = (q.get('fields') || '').split(',').filter(Boolean);

    if (path === 'me') return send(200, { id: DEMO.userId, name: DEMO.userName }, usage);
    if (path === 'me/permissions') return send(200, { data: token === DEMO.noAdsToken ? [{ permission: 'public_profile', status: 'granted' }] : [{ permission: 'ads_read', status: 'granted' }, { permission: 'public_profile', status: 'granted' }] }, usage);
    if (path === 'me/adaccounts') return send(200, page(req, base, [{ id: DEMO.accountId, account_id: DEMO.accountId.slice(4), name: 'Demo ad account (simulated)', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1 }], q), usage);
    if (path === DEMO.accountId) return send(200, { id: DEMO.accountId, name: 'Demo ad account (simulated)', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1 }, usage);
    if (path === `${DEMO.accountId}/campaigns`) return send(200, page(req, base, acc.campaigns.map((c) => pick({ ...c, effective_status: c.status }, fields)), q), usage);
    if (path === `${DEMO.accountId}/adsets`) return send(200, page(req, base, acc.adsets.map((a) => pick({ ...a, effective_status: a.status }, fields)), q), usage);
    if (path === `${DEMO.accountId}/ads`) {
      return send(200, page(req, base, acc.ads.map((a) => pick({ ...a, effective_status: a.status, creative: { id: 'cr' + a.id, thumbnail_url: 'data:image/svg+xml;base64,' + Buffer.from(thumb(a.colour, a.video ? 'VIDEO' : 'IMAGE')).toString('base64') } }, fields)), q), usage);
    }
    if (path === `${DEMO.accountId}/insights`) {
      const body = insights(acc, q);
      if (body.error) return send(400, body, usage);
      return send(200, page(req, base, body.data, q), usage);
    }
    const est = path.match(/^(\d+)\/delivery_estimate$/);
    if (est) {
      const s = acc.adsetById[est[1]];
      if (!s) return send(400, { error: { message: 'Unsupported get request.', code: 100 } }, usage);
      return send(200, { data: [{ estimate_mau_lower_bound: s.universe[0], estimate_mau_upper_bound: s.universe[1], estimate_ready: true }] }, usage);
    }
    return send(400, { error: { message: `Unsupported get request. Object with ID '${path}' does not exist`, type: 'GraphMethodException', code: 100 } }, usage);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, server, stats, version, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startMetaMock, buildAccount, DEMO };

if (require.main === module) {
  startMetaMock({ port: Number(process.env.PORT) || 8790 }).then((m) => console.log(`Simulated Meta API on ${m.url}`));
}
