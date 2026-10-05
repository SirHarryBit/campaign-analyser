// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const { SAMPLE_CSV } = require('../src/sample.js');

function csvRows(text) {
  // tiny CSV splitter for tests (the app uses SheetJS)
  return text.split('\n').map((l) => l.split(','));
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
  const lookalike = leadCampaigns.find((c) => /Lookalike/.test(c.name));
  const open = leadCampaigns.find((c) => /Open/.test(c.name));
  const cpql = r.tiers[1].ranks.find((x) => x.key === 'cpql');
  assert.equal(cpql.best, lookalike.id);
  assert.ok(r.insights[open.id].weaknesses.some((w) => /qualified/.test(w)));
  assert.ok(r.recommendations.newCampaign.length > 3);
  assert.ok(C.toCsv(r).split('\n').length === 4);
});

test('two-proportion test: big gap with big samples is significant, tiny samples are not', () => {
  assert.ok(C.twoProportionP(120, 300, 60, 300) < 0.01);
  assert.ok(C.twoProportionP(3, 10, 2, 10) > 0.5);
});
