const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');
const K = require('../src/charts.js');
const { SAMPLE_CSV } = require('../src/sample.js');

function sampleResult(n = 3) {
  const rows = SAMPLE_CSV.split('\n').map((l) => l.split(','));
  const { campaigns } = C.rowsToCampaigns(rows);
  return C.compare(campaigns.slice(0, n), C.DEFAULT_SETTINGS);
}
const opts = (r, width = 800) => ({ C, cur: 'INR', width, slot: (id) => r.items.findIndex((it) => it.c.id === id) + 1 });

test('lead comparison draws all five charts', () => {
  const r = sampleResult(3);
  const charts = K.buildCharts(r, opts(r));
  assert.deepStrictEqual(charts.map((c) => c.id), ['budget', 'share', 'quality', 'map', 'time']);
  for (const c of charts) {
    assert.ok(c.svg && c.svg.startsWith('<svg'), c.id + ' has svg');
    assert.ok(!/NaN|undefined/.test(c.svg), c.id + ' has no NaN/undefined');
    assert.ok(c.table.includes('<table'), c.id + ' has a table view');
    assert.ok(c.note.length > 20, c.id + ' has a note');
  }
});

test('quality chart calls out cheap leads that are not cheap good leads', () => {
  const r = sampleResult(3);
  const q = K.buildCharts(r, opts(r)).find((c) => c.id === 'quality');
  assert.match(q.note, /Open audience lead form has the cheapest leads/);
  assert.match(q.note, /Lookalike of members has the cheapest qualified leads/);
});

test('narrow width still renders and print mode uses native titles', () => {
  const r = sampleResult(3);
  const narrow = K.buildCharts(r, opts(r, 340));
  assert.ok(narrow.every((c) => c.svg));
  const print = K.buildCharts(r, { ...opts(r, 880), print: true });
  assert.ok(print[0].svg.includes('<title>') && !print[0].svg.includes('data-tip'));
});

test('missing qualified leads gives a helpful empty state', () => {
  const r = sampleResult(3);
  r.items.forEach((it) => { delete it.m.cpql; delete it.m.qualifiedPct; it.c.qualifiedLeads = undefined; });
  const charts = K.buildCharts(r, opts(r));
  assert.match(charts.find((c) => c.id === 'quality').empty, /qualified leads/);
  assert.match(charts.find((c) => c.id === 'map').note, /click-through rate/);
});

test('nice ticks', () => {
  assert.deepStrictEqual(K.ticks(58200), [0, 20000, 40000, 60000]);
  assert.strictEqual(K.shortMoney(C, 'INR', 150000), '₹1.5L');
});

test('day-by-day chart appears only with daily data and uses 7-day rolling sums', () => {
  const r = sampleResult(3);
  assert.ok(!K.buildCharts(r, opts(r)).some((c) => c.id === 'trend'), 'no daily data, no trend chart');
  const days = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10));
  r.items.forEach((it, k) => { it.c.daily = days.map((date, i) => ({ date, spend: 1000, impressions: 10000, clicks: 100, leads: k === 0 ? Math.max(1, 10 - Math.floor(i / 3)) : 8 })); });
  const t = K.buildCharts(r, opts(r)).find((c) => c.id === 'trend');
  assert.ok(t.svg && t.svg.includes('xhair'));
  assert.strictEqual(t.metric, 'cpl');
  assert.match(t.note, /rose \d+%/);
  const roll = K.rolling([{ date: '2026-08-01', spend: 100, leads: 1 }, { date: '2026-08-02', spend: 100, leads: 3 }, { date: '2026-08-03', spend: 100, leads: 0 }], ['2026-08-01', '2026-08-02', '2026-08-03'], 'cpl');
  assert.strictEqual(roll[2], 75);
});
