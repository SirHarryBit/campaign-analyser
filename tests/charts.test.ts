const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert') = require('node:assert');
const C: CoreApi = require('../src/core.js');
const K: ChartsApi = require('../src/charts.ts');
const { SAMPLE_CSV }: { SAMPLE_CSV: string } = require('../src/sample.js');

function sampleResult(n = 3): CompareResult {
  const rows = SAMPLE_CSV.split('\n').map((l) => l.split(','));
  const { campaigns } = C.rowsToCampaigns(rows);
  return C.compare(campaigns.slice(0, n), C.DEFAULT_SETTINGS);
}
const opts = (r: CompareResult, width = 800): ChartOptions => ({ C, cur: 'INR', width, halfWidth: Math.round(width / 2), slot: (id) => r.items.findIndex((it) => it.c.id === id) + 1 });

test('lead comparison draws donuts, rings, mirrored columns, map and timeline', () => {
  const r = sampleResult(3);
  const charts = K.buildCharts(r, opts(r));
  assert.deepStrictEqual(charts.map((c) => c.id), ['share', 'budget', 'quality', 'map', 'time']);
  for (const c of charts) {
    assert.ok(c.svg && c.svg.startsWith('<svg'), c.id + ' has svg');
    assert.ok(!/NaN|undefined|Infinity/.test(c.svg), c.id + ' has no NaN/undefined');
    assert.ok(c.table && c.table.includes('<table'), c.id + ' has a table view');
    assert.ok(c.note && c.note.length > 20 && c.note.length < 200, c.id + ' has a short note');
  }
  const byId = Object.fromEntries(charts.map((c) => [c.id, c]));
  assert.match(byId.share.svg as string, /stroke-linecap="round"/, 'donut segments are rounded arcs');
  assert.match(byId.budget.svg as string, /Ring charts/);
  assert.match(byId.quality.svg as string, /cost per qualified lead below/);
  assert.strictEqual(byId.share.size, 'half');
  assert.strictEqual(byId.quality.size, 'wide');
});

test('quality chart calls out cheap leads that are not cheap good leads', () => {
  const r = sampleResult(3);
  const q = K.buildCharts(r, opts(r)).find((c) => c.id === 'quality') as ChartOut;
  assert.match(q.note as string, /Open audience lead form has the cheapest leads/);
  assert.match(q.note as string, /Lookalike of members has the cheapest qualified leads/);
});

test('gradient ids are unique per chart, and print mode uses fixed colours and native titles', () => {
  const r = sampleResult(3);
  const app = K.buildCharts(r, opts(r)).map((c) => c.svg || '').join('');
  const ids = [...app.matchAll(/<(?:linear|radial)Gradient id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 5);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate gradient ids on the page');
  const print = K.buildCharts(r, { ...opts(r, 880), print: true });
  assert.ok((print[0].svg as string).includes('<title>') && !(print[0].svg as string).includes('data-tip'));
  assert.ok(!(print[0].svg as string).includes('var(--'), 'report charts do not depend on page CSS');
});

test('narrow width still renders', () => {
  const r = sampleResult(3);
  const narrow = K.buildCharts(r, opts(r, 340));
  assert.ok(narrow.every((c) => c.svg && !/NaN/.test(c.svg)));
});

test('without budgets the budget chart falls back to spend columns', () => {
  const r = sampleResult(3);
  r.items.forEach((it) => { it.m.budget = null; it.m.budgetUsedPct = null; });
  const b = K.buildCharts(r, opts(r)).find((c) => c.id === 'budget') as ChartOut;
  assert.match(b.svg as string, /Column chart of amount spent/);
  assert.match(b.note as string, /budget/);
});

test('missing qualified leads gives a helpful empty state', () => {
  const r = sampleResult(3);
  r.items.forEach((it) => { it.m.cpql = null; it.m.qualifiedPct = null; it.c.qualifiedLeads = undefined; });
  const charts = K.buildCharts(r, opts(r));
  assert.match((charts.find((c) => c.id === 'quality') as ChartOut).empty as string, /qualified leads/);
  assert.match((charts.find((c) => c.id === 'map') as ChartOut).note as string, /click-through rate/);
  // The donut falls back from qualified leads to leads.
  assert.match((charts.find((c) => c.id === 'share') as ChartOut).svg as string, />Leads</);
});

test('only: builds just the charts asked for', () => {
  const r = sampleResult(3);
  assert.deepStrictEqual(K.buildCharts(r, { ...opts(r), only: ['share'] }).map((c) => c.id), ['share']);
});

test('nice ticks and short money', () => {
  assert.deepStrictEqual(K.ticks(58200), [0, 20000, 40000, 60000]);
  assert.strictEqual(K.shortMoney(C, 'INR', 150000), '₹1.5L');
});

test('sparkline draws a path, skips gaps, and needs two points', () => {
  const s = K.sparkline([1, null, 3, 2], { width: 120, height: 40, color: '#fff', id: 'x' });
  assert.match(s, /<path d="M/);
  assert.strictEqual(K.sparkline([1, null], { width: 120, height: 40, color: '#fff', id: 'x' }), '');
});

test('day-by-day chart appears only with daily data and uses 7-day rolling sums', () => {
  const r = sampleResult(3);
  assert.ok(!K.buildCharts(r, opts(r)).some((c) => c.id === 'trend'), 'no daily data, no trend chart');
  const days = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10));
  r.items.forEach((it, k) => { it.c.daily = days.map((date, i) => ({ date, spend: 1000, impressions: 10000, clicks: 100, leads: k === 0 ? Math.max(1, 10 - Math.floor(i / 3)) : 8 })); });
  const t = K.buildCharts(r, opts(r)).find((c) => c.id === 'trend') as ChartOut;
  assert.ok(t.svg && t.svg.includes('xhair'));
  assert.ok(t.svg.includes(' C'), 'lines are smoothed');
  assert.strictEqual(t.metric, 'cpl');
  assert.match(t.note as string, /rose \d+%/);
  const roll = K.rolling([{ date: '2026-08-01', spend: 100, leads: 1 }, { date: '2026-08-02', spend: 100, leads: 3 }, { date: '2026-08-03', spend: 100, leads: 0 }], ['2026-08-01', '2026-08-02', '2026-08-03'], 'cpl');
  assert.strictEqual(roll[2], 75);
});
