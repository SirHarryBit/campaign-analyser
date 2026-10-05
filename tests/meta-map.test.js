const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/meta/map.js');
const { GraphClient, MetaError, regainMsFromHeaders } = require('../server/meta/client.js');

test('budgets: INR paise to rupees, zero-decimal currencies untouched', () => {
  assert.strictEqual(M.budgetToUnits('600000', 'INR'), 6000);
  assert.strictEqual(M.budgetToUnits('5000', 'JPY'), 5000);
  assert.strictEqual(M.budgetToUnits('0', 'INR'), undefined);
});

test('objectives: new and legacy names', () => {
  assert.strictEqual(M.mapObjective('OUTCOME_LEADS'), 'leads');
  assert.strictEqual(M.mapObjective('LEAD_GENERATION'), 'leads');
  assert.strictEqual(M.mapObjective('OUTCOME_AWARENESS'), 'awareness');
  assert.strictEqual(M.mapObjective('VIDEO_VIEWS'), 'video_views');
  assert.strictEqual(M.mapObjective('SOMETHING_NEW'), undefined);
});

test('leads are not double counted when "lead" and its parts are both reported', () => {
  const actions = [
    { action_type: 'lead', value: '40' },
    { action_type: 'onsite_conversion.lead_grouped', value: '30' },
    { action_type: 'offsite_conversion.fb_pixel_lead', value: '10' },
    { action_type: 'landing_page_view', value: '500' },
  ];
  assert.strictEqual(M.actionValue(actions, 'leads'), 40);
  assert.strictEqual(M.actionValue(actions.slice(1), 'leads'), 40);
  assert.strictEqual(M.actionValue(actions, 'landingPageViews'), 500);
  assert.strictEqual(M.actionValue(actions, 'conversions'), undefined);
});

test('insight row mapping uses link clicks and purchase values', () => {
  const m = M.mapInsightRow({
    spend: '1234.5', impressions: '10000', reach: '4000', clicks: '300', inline_link_clicks: '210',
    actions: [{ action_type: 'omni_purchase', value: '5' }], action_values: [{ action_type: 'omni_purchase', value: '9000' }],
  });
  assert.strictEqual(m.spend, 1234.5);
  assert.strictEqual(m.clicks, 210);
  assert.strictEqual(m.conversions, 5);
  assert.strictEqual(m.conversionValue, 9000);
  assert.strictEqual(m.leads, undefined);
});

test('targeting notes feed the open / loose / focused classifier', () => {
  assert.match(M.targetingNotes({ targeting_automation: { advantage_audience: 1 }, geo_locations: { cities: [{ name: 'Mumbai' }] } }), /Advantage\+ audience/);
  assert.match(M.targetingNotes({ custom_audiences: [{ name: '1% Lookalike (IN) - Members' }] }), /Lookalike/);
  assert.match(M.targetingNotes({ flexible_spec: [{ interests: [{ name: 'Yoga' }, { name: 'Meditation' }] }] }), /Interests: Yoga, Meditation/);
  assert.match(M.targetingNotes({ geo_locations: { countries: ['IN'] }, age_min: 25, age_max: 45 }), /Broad/);
});

test('universe is the midpoint of the audience estimate', () => {
  assert.strictEqual(M.universeFromEstimate({ data: [{ estimate_mau_lower_bound: 3000000, estimate_mau_upper_bound: 3600000 }] }), 3300000);
  assert.strictEqual(M.universeFromEstimate({ data: [] }), undefined);
});

test('budget for a date range: daily budget × live days, lifetime as is', () => {
  assert.strictEqual(M.budgetForRange({ daily_budget: '200000', start_time: '2026-08-05T10:00:00+0530' }, '2026-08-01', '2026-08-10', 'INR'), 2000 * 6);
  assert.strictEqual(M.budgetForRange({ lifetime_budget: '4000000' }, '2026-08-01', '2026-08-10', 'INR'), 40000);
  assert.strictEqual(M.budgetForRange({}, '2026-08-01', '2026-08-10', 'INR'), undefined);
  // Lifetime ₹40,000 over a 40-day flight, 10 of those days in range → ₹10,000.
  assert.strictEqual(M.budgetForRange({ lifetime_budget: '4000000', start_time: '2026-07-22T00:00:00+0530', stop_time: '2026-08-30T00:00:00+0530' }, '2026-08-01', '2026-08-10', 'INR'), 10000);
});

// ---- Graph client against a fake fetch ----
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = responses.shift();
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      headers: new Map(Object.entries(r.headers || {})),
      json: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};

test('client adds appsecret_proof and follows paging', async () => {
  const f = fakeFetch([
    { body: { data: [{ id: 1 }], paging: { next: 'https://graph.example/v25.0/next?after=x&access_token=t' } } },
    { body: { data: [{ id: 2 }] } },
  ]);
  const c = new GraphClient({ token: 't', appSecret: 's', baseUrl: 'https://graph.example', fetchImpl: f, sleep: noSleep });
  const all = await c.all('act_1/campaigns', { fields: 'id', limit: 1 });
  assert.deepStrictEqual(all.map((x) => x.id), [1, 2]);
  assert.match(f.calls[0], /appsecret_proof=[0-9a-f]{64}/);
  assert.match(f.calls[0], /\/v25\.0\/act_1\/campaigns/);
});

test('client waits out a rate limit, then succeeds', async () => {
  const waits = [];
  const f = fakeFetch([
    { status: 400, body: { error: { code: 17, message: 'User request limit reached' } }, headers: { 'x-business-use-case-usage': JSON.stringify({ 1: [{ call_count: 100, estimated_time_to_regain_access: 1 }] }) } },
    { body: { data: [] } },
  ]);
  const c = new GraphClient({ token: 't', fetchImpl: f, sleep: async (ms) => waits.push(ms) });
  await c.get('me');
  assert.ok(waits.includes(60000), 'waited the minute Meta asked for');
});

test('client gives up on long rate limits and on expired tokens', async () => {
  const long = fakeFetch([{ status: 400, body: { error: { code: 80000, message: 'Too many calls' } }, headers: { 'x-business-use-case-usage': JSON.stringify({ 1: [{ estimated_time_to_regain_access: 30 }] }) } }]);
  await assert.rejects(new GraphClient({ token: 't', fetchImpl: long, sleep: noSleep }).get('me'), (e) => e instanceof MetaError && e.kind === 'rate_limit' && e.retryAfterMs === 1800000);
  const expired = fakeFetch([{ status: 400, body: { error: { code: 190, message: 'Session has expired' } } }]);
  await assert.rejects(new GraphClient({ token: 't', fetchImpl: expired, sleep: noSleep }).get('me'), (e) => e.kind === 'auth');
});

test('regain time is read from usage headers', () => {
  const h = new Map([['x-ad-account-usage', JSON.stringify({ acc_id_util_pct: 99, reset_time_duration: 2 })]]);
  assert.strictEqual(regainMsFromHeaders(h), 120000);
});

test('client: stops before a wait or request would run past its deadline', async () => {
  const limited = async () => new Response(JSON.stringify({ error: { message: 'User request limit reached', code: 17 } }), {
    status: 400, headers: { 'x-business-use-case-usage': JSON.stringify({ 1: [{ estimated_time_to_regain_access: 1 }] }) },
  });
  const slept = [];
  const c = new GraphClient({ token: 't', fetchImpl: limited, sleep: async (ms) => { slept.push(ms); } });
  c.deadline = Date.now() + 10000; // Meta asks for a 60 s wait; only 10 s left
  await assert.rejects(c.get('act_1/insights'), (e) => e instanceof MetaError && e.kind === 'deadline');
  assert.deepStrictEqual(slept, []);
  // With under 5 s left, no new request starts at all.
  let fetched = 0;
  const c2 = new GraphClient({ token: 't', fetchImpl: async () => { fetched++; return new Response('{}'); } });
  c2.deadline = Date.now() + 3000;
  await assert.rejects(c2.get('me'), (e) => e.kind === 'deadline');
  assert.strictEqual(fetched, 0);
});
