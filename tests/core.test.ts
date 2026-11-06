// Run with: node --test tests/
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const C: CoreApi = require('../src/core.ts');
const { SAMPLE_CSV }: { SAMPLE_CSV: string } = require('../src/sample.ts');

function csvRows(text: string): string[][] {
  // tiny CSV splitter for tests (the app uses SheetJS)
  return text.split('\n').map((l: string) => l.split(','));
}

test('parseNumber handles currency, commas, percents and blanks', () => {
  assert.equal(C.parseNumber('₹1,23,456.50'), 123456.5);
  assert.equal(C.parseNumber('2.5%'), 0.025);
  assert.equal(C.parseNumber('--'), null);
  assert.equal(C.parseNumber(''), null);
  assert.equal(C.parseNumber(42), 42);
});

test('parseDate reads ISO, Indian dd/mm/yyyy and Excel serials', () => {
  assert.equal(C.parseDate('2026-08-01'), '2026-08-01');
  assert.equal(C.parseDate('05/08/2026'), '2026-08-05');
  assert.equal(C.parseDate(46235), '2026-08-01');
});

test('Meta export headers map to fields, ignoring "Cost per lead"', () => {
  const m = C.mapColumns(['Campaign name', 'Reporting starts', 'Amount spent (INR)', 'Cost per lead', 'Leads', 'Result indicator', 'Results']);
  assert.equal(m.name, 0);
  assert.equal(m.spend, 2);
  assert.equal(m.leads, 4);
  assert.equal(m.resultIndicator, 5);
});

test('Results column becomes leads when the indicator says lead', () => {
  const rows = [['Campaign name', 'Result indicator', 'Results', 'Amount spent (INR)'], ['A', 'actions:onsite_conversion.lead_grouped', '50', '5000']];
  const { campaigns, currency } = C.rowsToCampaigns(rows);
  assert.equal(campaigns[0].leads, 50);
  assert.equal(campaigns[0].objective, 'leads');
  assert.equal(currency, 'INR');
});

test('rows with the same campaign name are merged; reach is not summed', () => {
  const rows = [['Campaign name', 'Day', 'Amount spent', 'Reach', 'Leads'], ['A', '2026-08-01', '100', '1000', '2'], ['A', '2026-08-02', '150', '1200', '3'], ['Total', '', '250', '', '5']];
  const { campaigns, warnings } = C.rowsToCampaigns(rows);
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].spend, 250);
  assert.equal(campaigns[0].leads, 5);
  assert.equal(campaigns[0].reach, 1200);
  assert.equal(campaigns[0].startDate, '2026-08-01');
  assert.equal(campaigns[0].endDate, '2026-08-02');
  assert.ok(warnings.some((w) => /Reach cannot be added/.test(w)));
});

test('metrics: CPL, qualified %, CPM, frequency, duration', () => {
  const c = C.normaliseCampaign({ name: 'x', spend: 10000, leads: 100, qualifiedLeads: 25, impressions: 200000, reach: 80000, clicks: 2000, startDate: '2026-08-01', endDate: '2026-08-10' });
  const m = C.computeMetrics(c);
  assert.equal(m.cpl, 100);
  assert.equal(m.qualifiedPct, 0.25);
  assert.equal(m.cpm, 50);
  assert.equal(m.frequency, 2.5);
  assert.equal(m.days, 10);
  assert.equal(m.ctr, 0.01);
});

test('zero landing page views is treated as not tracked', () => {
  assert.equal(C.computeMetrics({ clicks: 100, landingPageViews: 0, leads: 10 }).lpvRate, null);
});

test('zero leads gives no CPL instead of Infinity', () => {
  const m = C.computeMetrics({ spend: 500, leads: 0 });
  assert.equal(m.cpl, null);
});

test('targeting: notes first, then universe thresholds, then override', () => {
  assert.equal(C.classifyTargeting({ targetingNotes: 'Advantage+ audience' }).type, 'open');
  assert.equal(C.classifyTargeting({ targetingNotes: '1% lookalike' }).type, 'focused');
  assert.equal(C.classifyTargeting({ universe: 25000000 }).type, 'open');
  assert.equal(C.classifyTargeting({ universe: 3000000 }).type, 'loose');
  assert.equal(C.classifyTargeting({ universe: 400000 }).type, 'focused');
  assert.equal(C.classifyTargeting({}).type, 'unknown');
  assert.equal(C.classifyTargeting({ universe: 400000, targeting: 'open' }).type, 'open');
});

test('funnel: objective sets target levels; data sets covered levels', () => {
  assert.deepEqual(C.targetLevels({ objective: 'awareness' }), [1, 2]);
  assert.deepEqual(C.targetLevels({ objective: 'leads', levels: [3, 4] }), [3, 4]);
  assert.deepEqual(C.dataLevels({ impressions: 10, reach: 5, clicks: 1, leads: 1 }), [1, 2, 3, 4]);
});

test('missing inputs flag zeros and blanks that matter for the objective', () => {
  const miss = C.missingInputs({ objective: 'leads', spend: 100, leads: 10, qualifiedLeads: 0, startDate: '2026-01-01', endDate: '2026-01-05', impressions: 1000 });
  assert.ok(miss.includes('qualifiedLeads'));
  assert.ok(miss.includes('universe'));
  assert.ok(miss.includes('budget'));
  assert.ok(!miss.includes('spend'));
});

test('comparison order for lead campaigns: CPL & budget, then universe & qualified %, then duration', () => {
  const tiers = C.comparisonTiers('leads');
  assert.deepEqual(tiers.map((t) => t.title), ['Cost and budget', 'Audience and lead quality', 'Duration', 'Supporting signals']);
  assert.equal(tiers[0].metrics[0], 'cpl');
  assert.ok(tiers[1].metrics.includes('universe') && tiers[1].metrics.includes('qualifiedPct'));
  assert.equal(C.comparisonTiers('awareness')[0].metrics[0], 'cpm');
});

test('sample data: lookalike wins on cost per qualified lead; open audience flagged for quality', () => {
  const { campaigns } = C.rowsToCampaigns(csvRows(SAMPLE_CSV));
  assert.equal(campaigns.length, 4);
  const leadCampaigns = campaigns.filter((c) => c.objective === 'leads');
  const r = C.compare(leadCampaigns);
  const lookalike = leadCampaigns.find((c) => /Lookalike/.test(c.name)) as Campaign;
  const open = leadCampaigns.find((c) => /Open/.test(c.name)) as Campaign;
  const cpql = r.tiers[1]!.ranks.find((x) => x.key === 'cpql');
  assert.equal(cpql?.best, lookalike.id);
  assert.ok(r.insights[open.id]!.weaknesses.some((w) => /qualified/.test(w)));
  assert.ok(r.recommendations.newCampaign.length > 3);
  assert.ok(C.toCsv(r).split('\n').length === 4);
});

test('two-proportion test: big gap with big samples is significant, tiny samples are not', () => {
  assert.ok((C.twoProportionP(120, 300, 60, 300) as number) < 0.01);
  assert.ok((C.twoProportionP(3, 10, 2, 10) as number) > 0.5);
});

// ---------- list: search, status filter, sort ----------
const mk = (name: string, status: string, startedAt: string | undefined, extra: Partial<Campaign> = {}): Campaign => ({ id: name, name, status, startedAt, ...extra });
const LIST = [
  mk('Diwali Leads', 'ACTIVE', '2026-10-20'),
  mk('Brand Reach', 'PAUSED', '2026-08-01'),
  mk('Autism Awareness', 'ACTIVE', '2026-09-15'),
  mk('Old Promo', 'ARCHIVED', undefined),
  mk('Retarget', 'CAMPAIGN_PAUSED', '2026-09-15', { campaignName: 'Diwali Leads' }),
];

test('statusKind: only ACTIVE counts as active; no status is unknown', () => {
  assert.strictEqual(C.statusKind({ status: 'ACTIVE' }), 'active');
  assert.strictEqual(C.statusKind({ status: 'active ' }), 'active');
  for (const s of ['PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'WITH_ISSUES']) assert.strictEqual(C.statusKind({ status: s }), 'inactive');
  assert.strictEqual(C.statusKind({}), 'unknown');
  assert.strictEqual(C.statusKind({ status: '' }), 'unknown');
});

test('listView filters by status and reports counts that ignore the status filter', () => {
  const a = C.listView(LIST, { status: 'active' });
  assert.deepStrictEqual(a.items.map((c) => c.name), ['Diwali Leads', 'Autism Awareness']);
  const i = C.listView(LIST, { status: 'inactive' });
  assert.deepStrictEqual(i.items.map((c) => c.name), ['Brand Reach', 'Old Promo', 'Retarget']);
  assert.deepStrictEqual(a.counts, { all: 5, active: 2, inactive: 3 });
  assert.strictEqual(C.listView(LIST, {}).items.length, 5);
  assert.strictEqual(C.listView(LIST, { status: 'bogus' as StatusFilter }).items.length, 5);
});

test('listView search is case-insensitive, matches every word, and also checks parent names', () => {
  assert.deepStrictEqual(C.listView(LIST, { q: 'DIWALI' }).items.map((c) => c.name), ['Diwali Leads', 'Retarget']);
  assert.deepStrictEqual(C.listView(LIST, { q: 'promo old' }).items.map((c) => c.name), ['Old Promo']);
  assert.strictEqual(C.listView(LIST, { q: 'nothing like this' }).items.length, 0);
  const both = C.listView(LIST, { q: 'diwali', status: 'active' });
  assert.deepStrictEqual(both.items.map((c) => c.name), ['Diwali Leads']);
  assert.deepStrictEqual(both.counts, { all: 2, active: 1, inactive: 1 }, 'counts follow the search');
});

test('listView sorts by start date with undated items last, and keeps ties in the given order', () => {
  const names = (sort: ListSort) => C.listView(LIST, { sort }).items.map((c) => c.name);
  assert.deepStrictEqual(names('newest'), ['Diwali Leads', 'Autism Awareness', 'Retarget', 'Brand Reach', 'Old Promo']);
  assert.deepStrictEqual(names('oldest'), ['Brand Reach', 'Autism Awareness', 'Retarget', 'Diwali Leads', 'Old Promo']);
  assert.deepStrictEqual(names('default'), LIST.map((c) => c.name));
  assert.deepStrictEqual(names('name'), ['Autism Awareness', 'Brand Reach', 'Diwali Leads', 'Old Promo', 'Retarget']);
});

test('listView falls back to startDate (CSV imports) and hides the status control when nothing has a status', () => {
  const csv = [{ id: '1', name: 'A', startDate: '2026-01-02' }, { id: '2', name: 'B', startDate: '2026-03-04' }];
  const v = C.listView(csv, { sort: 'newest' });
  assert.deepStrictEqual(v.items.map((c) => c.name), ['B', 'A']);
  assert.strictEqual(v.anyStatus, false);
  assert.strictEqual(C.listView(LIST, {}).anyStatus, true);
});

test('listTotals adds up what is shown; cost per lead and qualified % only use rows that track leads', () => {
  const rows = [
    mk('A', 'ACTIVE', '2026-10-01', { spend: 1000, impressions: 10000, clicks: 200, leads: 10, qualifiedLeads: 4 }),
    mk('B', 'ACTIVE', '2026-10-02', { spend: 500, impressions: 5000, clicks: 50 }),
    mk('C', 'PAUSED', '2026-10-03', { spend: 300, leads: 5, qualifiedLeads: 1 }),
  ];
  const t = C.listTotals(rows);
  assert.strictEqual(t.count, 3);
  assert.strictEqual(t.spend, 1800);
  assert.strictEqual(t.impressions, 15000);
  assert.strictEqual(t.clicks, 250);
  assert.strictEqual(t.leads, 15);
  assert.strictEqual(t.cpl, 1300 / 15);
  assert.strictEqual(t.qualifiedPct, 5 / 15);
  const none = C.listTotals([]);
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.cpl, null);
});

test('listToCsv writes the rows given, escapes awkward names, and ends with a totals row', () => {
  const rows = [
    mk('Plain', 'ACTIVE', '2026-10-01', { spend: 100, leads: 2 }),
    mk('Has, "quotes"', 'PAUSED', '2026-10-02', { spend: 50 }),
  ];
  const lines = C.listToCsv(rows).split('\n');
  assert.strictEqual(lines.length, 4);
  assert.ok(lines[0].startsWith('Name,Level,'));
  assert.ok(lines[1].startsWith('Plain,'));
  assert.ok(lines[2].startsWith('"Has, ""quotes""",'));
  assert.ok(lines[3].startsWith('Total (2),'));
  assert.strictEqual(C.listToCsv([]).split('\n').length, 2);
});
