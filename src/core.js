/*
 * Campaign Analyser — core engine.
 * Pure functions only (no DOM), so the same file runs in the browser and in Node tests.
 * Exposes `CampaignCore` on window, and module.exports in Node.
 */
(function (root) {
  'use strict';

  // ---------- Constants ----------

  const FUNNEL_LEVELS = [
    { level: 1, stage: 'Awareness', name: 'Reach & impressions', kpis: ['impressions', 'reach', 'cpm'] },
    { level: 2, stage: 'Awareness', name: 'Frequency', kpis: ['frequency'] },
    { level: 3, stage: 'Engagement', name: 'Clicks & views', kpis: ['clicks', 'ctr', 'cpc', 'views', 'costPerView'] },
    { level: 4, stage: 'Engagement', name: 'Landing page, lead forms & qualified leads', kpis: ['landingPageViews', 'leads', 'cpl', 'qualifiedPct', 'cpql'] },
    { level: 5, stage: 'Conversion', name: 'Conversions', kpis: ['conversions', 'cpa', 'roas'] },
  ];

  const OBJECTIVES = {
    awareness: { label: 'Awareness / reach', levels: [1, 2], primaryCost: 'cpm' },
    traffic: { label: 'Traffic', levels: [3], primaryCost: 'cpc' },
    engagement: { label: 'Engagement', levels: [3], primaryCost: 'cpc' },
    video_views: { label: 'Video views', levels: [3], primaryCost: 'costPerView' },
    leads: { label: 'Leads', levels: [4], primaryCost: 'cpl' },
    conversions: { label: 'Sales / conversions', levels: [5], primaryCost: 'cpa' },
  };

  const PLATFORMS = ['Meta', 'Google', 'LinkedIn', 'YouTube', 'Other'];
  const TARGETING = { open: 'Open', loose: 'Loose', focused: 'Focused', unknown: 'Not classified' };

  const DEFAULT_SETTINGS = {
    currency: 'INR',
    targetCpl: null, // your own target, optional
    targetQualifiedPct: 0.3, // 30%
    openUniverseMin: 10000000, // ≥ 10M people ⇒ open
    focusedUniverseMax: 1000000, // ≤ 1M people ⇒ focused
    minLeadsForConfidence: 30,
    learningPhaseDays: 7,
  };

  // Every field a campaign can hold. `input: true` means the user can type it in.
  const FIELDS = [
    { key: 'name', label: 'Campaign', type: 'text' },
    { key: 'platform', label: 'Platform', type: 'select', options: PLATFORMS },
    { key: 'objective', label: 'Objective', type: 'select', options: Object.keys(OBJECTIVES) },
    { key: 'startDate', label: 'Start', type: 'date' },
    { key: 'endDate', label: 'End', type: 'date' },
    { key: 'budget', label: 'Budget', type: 'money' },
    { key: 'spend', label: 'Spend', type: 'money' },
    { key: 'impressions', label: 'Impressions', type: 'int' },
    { key: 'reach', label: 'Reach', type: 'int' },
    { key: 'frequency', label: 'Frequency', type: 'num' },
    { key: 'clicks', label: 'Link clicks', type: 'int' },
    { key: 'views', label: 'Video views', type: 'int' },
    { key: 'landingPageViews', label: 'Landing page views', type: 'int' },
    { key: 'leads', label: 'Leads', type: 'int' },
    { key: 'qualifiedLeads', label: 'Qualified leads', type: 'int' },
    { key: 'conversions', label: 'Conversions', type: 'int' },
    { key: 'conversionValue', label: 'Conversion value', type: 'money' },
    { key: 'universe', label: 'Universe (audience size)', type: 'int' },
    { key: 'targeting', label: 'Targeting', type: 'select', options: ['auto', 'open', 'loose', 'focused'] },
    { key: 'targetingNotes', label: 'Targeting notes', type: 'text' },
  ];

  // Header aliases for Meta Ads Manager, Google Ads and generic exports (lower-case, trimmed).
  const ALIASES = {
    name: ['campaign name', 'campaign', 'ad set name', 'ad name', 'name'],
    platform: ['platform', 'publisher platform', 'channel', 'network'],
    objective: ['objective', 'campaign objective', 'campaign type', 'buying type objective'],
    startDate: ['reporting starts', 'starts', 'start date', 'start', 'campaign start date', 'day'],
    endDate: ['reporting ends', 'ends', 'end date', 'end', 'campaign end date'],
    budget: ['budget', 'campaign budget', 'ad set budget', 'lifetime budget', 'daily budget'],
    spend: ['amount spent', 'spend', 'cost', 'amount spent (inr)', 'amount spent (usd)', 'total spent'],
    impressions: ['impressions', 'impr.', 'impr'],
    reach: ['reach', 'unique reach'],
    frequency: ['frequency', 'avg. impr. freq. / user'],
    clicks: ['link clicks', 'clicks', 'clicks (all)', 'outbound clicks'],
    views: ['thruplays', 'video views', 'views', 'video plays', '3-second video plays'],
    landingPageViews: ['landing page views', 'website landing page views'],
    leads: ['leads', 'on-facebook leads', 'website leads', 'meta leads', 'lead form submissions'],
    qualifiedLeads: ['qualified leads', 'qualified', 'sqls', 'mqls'],
    conversions: ['conversions', 'purchases', 'website purchases', 'all conv.'],
    conversionValue: ['conversion value', 'purchase conversion value', 'conv. value', 'purchases conversion value'],
    universe: ['universe', 'audience size', 'estimated audience size', 'potential reach'],
    targetingNotes: ['targeting', 'audience', 'audience name', 'targeting notes'],
    resultIndicator: ['result indicator', 'result type'],
    results: ['results'],
  };

  const ADDITIVE = ['budget', 'spend', 'impressions', 'clicks', 'views', 'landingPageViews', 'leads', 'qualifiedLeads', 'conversions', 'conversionValue'];

  // ---------- Parsing helpers ----------

  function normHeader(h) {
    return String(h || '')
      .toLowerCase()
      .replace(/\((inr|usd|eur|gbp|aud|cad|sgd|aed)\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectCurrency(headers) {
    for (const h of headers) {
      const m = String(h).match(/\((INR|USD|EUR|GBP|AUD|CAD|SGD|AED)\)/i);
      if (m) return m[1].toUpperCase();
    }
    return null;
  }

  function parseNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s || s === '-' || s === '--' || /^n\/?a$/i.test(s)) return null;
    const pct = s.endsWith('%');
    s = s.replace(/[₹$€£,\s%]/g, '').replace(/^(inr|usd|rs\.?)/i, '');
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return pct ? n / 100 : n;
  }

  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      // Excel serial date
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); // dd/mm/yyyy (India default)
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  function guessObjective(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/lead/.test(t)) return 'leads';
    if (/(purchase|sale|conversion|catalog|app install)/.test(t)) return 'conversions';
    if (/(video|thruplay)/.test(t)) return 'video_views';
    if (/(traffic|link click|landing page)/.test(t)) return 'traffic';
    if (/(engag|post|message|like)/.test(t)) return 'engagement';
    if (/(aware|reach|brand|impression)/.test(t)) return 'awareness';
    return null;
  }

  /** Build {field: headerIndex} from a header row. */
  function mapColumns(headers) {
    const norm = headers.map(normHeader);
    const map = {};
    for (const [field, aliases] of Object.entries(ALIASES)) {
      let idx = -1;
      for (const a of aliases) {
        idx = norm.indexOf(a);
        if (idx !== -1) break;
      }
      if (idx === -1) {
        // looser contains-match, but never let "cost per lead" count as "cost"
        idx = norm.findIndex((h) => aliases.some((a) => a.length > 4 && h.startsWith(a) && !/per |rate|%/.test(h)));
      }
      if (idx !== -1) map[field] = idx;
    }
    return map;
  }

  function detectPlatform(headers) {
    const n = headers.map(normHeader);
    if (n.includes('amount spent') || n.includes('reporting starts') || n.includes('result indicator')) return 'Meta';
    if (n.includes('impr.') || n.includes('all conv.') || n.includes('avg. cpc')) return 'Google';
    return null;
  }

  /**
   * Turn spreadsheet rows (array of arrays, first row = headers) into campaigns.
   * Rows sharing a campaign name are merged (daily or ad-set breakdowns).
   */
  function rowsToCampaigns(rows, opts = {}) {
    if (!rows || rows.length < 2) return { campaigns: [], mapping: {}, warnings: ['The file has no data rows.'] };
    const headers = rows[0].map((h) => String(h ?? ''));
    const mapping = mapColumns(headers);
    const warnings = [];
    const platformGuess = detectPlatform(headers) || opts.platform || null;
    const currency = detectCurrency(headers);
    if (mapping.name === undefined) warnings.push('No campaign name column found; rows were named "Campaign 1", "Campaign 2"….');
    if (mapping.spend === undefined) warnings.push('No spend column found. Add spend by hand to get cost metrics.');

    const byName = new Map();
    rows.slice(1).forEach((r, i) => {
      if (!r || r.every((c) => c === null || c === undefined || String(c).trim() === '')) return;
      const get = (f) => (mapping[f] === undefined ? undefined : r[mapping[f]]);
      const rawName = String(get('name') ?? '').trim();
      if (/^(total|results from|grand total)/i.test(rawName)) return; // skip export summary rows
      const name = rawName || `Campaign ${i + 1}`;
      const c = { name };
      for (const f of ['budget', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'views', 'landingPageViews', 'leads', 'qualifiedLeads', 'conversions', 'conversionValue', 'universe']) {
        const v = parseNumber(get(f));
        if (v !== null) c[f] = v;
      }
      // Meta "Results" column carries leads when the result indicator says so.
      const indicator = String(get('resultIndicator') ?? '').toLowerCase();
      const results = parseNumber(get('results'));
      if (results !== null) {
        if (/lead/.test(indicator) && c.leads === undefined) c.leads = results;
        else if (/(purchase|conversion)/.test(indicator) && c.conversions === undefined) c.conversions = results;
        else if (/(thruplay|video)/.test(indicator) && c.views === undefined) c.views = results;
        else if (/(link_click|link click)/.test(indicator) && c.clicks === undefined) c.clicks = results;
      }
      c.startDate = parseDate(get('startDate'));
      c.endDate = parseDate(get('endDate')) || c.startDate;
      const p = String(get('platform') ?? '').trim();
      c.platform = PLATFORMS.find((x) => x.toLowerCase() === p.toLowerCase()) || (/(facebook|instagram)/i.test(p) ? 'Meta' : null) || platformGuess || 'Other';
      c.objective = guessObjective(get('objective')) || guessObjective(indicator) || null;
      const notes = get('targetingNotes');
      if (notes) c.targetingNotes = String(notes);

      if (!byName.has(name)) byName.set(name, c);
      else mergeInto(byName.get(name), c);
    });

    const campaigns = [...byName.values()].map((c) => normaliseCampaign({ ...c, currency: currency || undefined }));
    if (campaigns.some((c) => c._mergedRows)) warnings.push('Some campaigns had several rows (daily or ad-set breakdown) and were added together. Reach cannot be added across rows, so it shows the largest single row; correct it if you know the real figure.');
    return { campaigns, mapping, headers, currency, warnings };
  }

  function mergeInto(a, b) {
    for (const f of ADDITIVE) if (b[f] !== undefined) a[f] = (a[f] || 0) + b[f];
    if (b.reach !== undefined) a.reach = Math.max(a.reach || 0, b.reach);
    if (b.universe !== undefined) a.universe = Math.max(a.universe || 0, b.universe);
    if (b.startDate && (!a.startDate || b.startDate < a.startDate)) a.startDate = b.startDate;
    if (b.endDate && (!a.endDate || b.endDate > a.endDate)) a.endDate = b.endDate;
    a.frequency = undefined; // recomputed from impressions / reach
    a._mergedRows = (a._mergedRows || 1) + 1;
  }

  let idCounter = 0;
  function newId() {
    idCounter += 1;
    return 'c' + Date.now().toString(36) + idCounter.toString(36);
  }

  function normaliseCampaign(c) {
    const out = { id: c.id || newId(), targeting: 'auto', platform: 'Other', ...c };
    for (const f of FIELDS) {
      if (['int', 'num', 'money'].includes(f.type) && out[f.key] !== undefined && out[f.key] !== null) {
        const n = parseNumber(out[f.key]);
        out[f.key] = n === null ? undefined : n;
      }
    }
    return out;
  }

  // ---------- Metrics ----------

  const div = (a, b) => (isNum(a) && isNum(b) && b > 0 ? a / b : null);
  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function durationDays(c) {
    if (!c.startDate || !c.endDate) return null;
    const d = (Date.parse(c.endDate) - Date.parse(c.startDate)) / 86400000;
    return isNaN(d) ? null : Math.max(1, Math.round(d) + 1);
  }

  function objectiveOf(c) {
    return c.objective && OBJECTIVES[c.objective] ? c.objective : null;
  }

  function computeMetrics(c) {
    // A zero in a tracking column usually means "not tracked" (e.g. instant forms have no landing page), not a real zero.
    if (c.landingPageViews === 0) c = { ...c, landingPageViews: undefined };
    const days = durationDays(c);
    const frequency = isNum(c.frequency) && c.frequency > 0 ? c.frequency : div(c.impressions, c.reach);
    const m = {
      days,
      spend: isNum(c.spend) ? c.spend : null,
      budget: isNum(c.budget) ? c.budget : null,
      budgetUsedPct: div(c.spend, c.budget),
      dailySpend: div(c.spend, days),
      impressions: c.impressions ?? null,
      reach: c.reach ?? null,
      frequency,
      cpm: isNum(c.spend) && isNum(c.impressions) && c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null,
      clicks: c.clicks ?? null,
      ctr: div(c.clicks, c.impressions),
      cpc: div(c.spend, c.clicks),
      views: c.views ?? null,
      costPerView: div(c.spend, c.views),
      landingPageViews: c.landingPageViews ?? null,
      lpvRate: div(c.landingPageViews, c.clicks),
      leads: c.leads ?? null,
      cpl: div(c.spend, c.leads),
      leadConvRate: isNum(c.landingPageViews) && c.landingPageViews > 0 ? div(c.leads, c.landingPageViews) : div(c.leads, c.clicks),
      leadsPerDay: div(c.leads, days),
      qualifiedLeads: c.qualifiedLeads ?? null,
      qualifiedPct: div(c.qualifiedLeads, c.leads),
      cpql: div(c.spend, c.qualifiedLeads),
      conversions: c.conversions ?? null,
      cpa: div(c.spend, c.conversions),
      roas: div(c.conversionValue, c.spend),
      universe: c.universe ?? null,
      penetration: div(c.reach, c.universe),
    };
    return m;
  }

  // ---------- Funnel levels ----------

  /** Levels the campaign is *aiming* at (objective, or the user's override). */
  function targetLevels(c) {
    if (Array.isArray(c.levels) && c.levels.length) return [...c.levels].sort();
    const o = objectiveOf(c);
    return o ? OBJECTIVES[o].levels : [];
  }

  /** Levels the campaign has *data* for. */
  function dataLevels(c) {
    const has = (k) => isNum(c[k]) && c[k] > 0;
    const lv = [];
    if (has('impressions') || has('reach')) lv.push(1);
    if (has('frequency') || (has('impressions') && has('reach'))) lv.push(2);
    if (has('clicks') || has('views')) lv.push(3);
    if (has('landingPageViews') || has('leads') || has('qualifiedLeads')) lv.push(4);
    if (has('conversions')) lv.push(5);
    return lv;
  }

  // ---------- Targeting ----------

  function classifyTargeting(c, settings = DEFAULT_SETTINGS) {
    if (c.targeting && c.targeting !== 'auto' && TARGETING[c.targeting]) return { type: c.targeting, reason: 'Set by you.' };
    const notes = String(c.targetingNotes || '').toLowerCase();
    if (/(advantage\+|advantage plus|broad|no detailed targeting|open targeting)/.test(notes)) return { type: 'open', reason: 'Targeting notes mention broad / Advantage+ audiences.' };
    if (/(lookalike|look-alike|custom audience|retarget|remarket|website visitors|customer list|engaged)/.test(notes)) return { type: 'focused', reason: 'Targeting notes mention a lookalike, custom or retargeting audience.' };
    const u = c.universe;
    if (isNum(u) && u > 0) {
      if (u >= settings.openUniverseMin) return { type: 'open', reason: `Universe of ${fmtCompact(u)} is at or above the open threshold (${fmtCompact(settings.openUniverseMin)}).` };
      if (u <= settings.focusedUniverseMax) return { type: 'focused', reason: `Universe of ${fmtCompact(u)} is at or below the focused threshold (${fmtCompact(settings.focusedUniverseMax)}).` };
      return { type: 'loose', reason: `Universe of ${fmtCompact(u)} sits between the focused and open thresholds.` };
    }
    if (/(interest|behaviou?r|demographic|job title|layer)/.test(notes)) return { type: 'loose', reason: 'Targeting notes mention interest or demographic layers.' };
    return { type: 'unknown', reason: 'Add the universe (audience size) or targeting notes to classify it.' };
  }

  // ---------- Missing data ----------

  /** Inputs that matter for this campaign and are missing or zero. */
  function missingInputs(c) {
    const o = objectiveOf(c);
    const need = ['spend', 'startDate', 'endDate', 'impressions', 'universe'];
    if (!o) need.unshift('objective');
    const lv = targetLevels(c);
    if (lv.includes(1) || lv.includes(2)) need.push('reach');
    if (lv.includes(3)) need.push('clicks');
    if (lv.includes(4) || o === 'leads') need.push('leads', 'qualifiedLeads');
    if (lv.includes(5)) need.push('conversions');
    if (!c.budget) need.push('budget');
    return [...new Set(need)].filter((k) => {
      const v = c[k];
      return v === undefined || v === null || v === '' || v === 0;
    });
  }

  // ---------- Comparison ----------

  // lower = better unless `higher: true`
  const METRIC_DEFS = {
    cpl: { label: 'Cost per lead (CPL)', fmt: 'money' },
    cpql: { label: 'Cost per qualified lead', fmt: 'money' },
    cpm: { label: 'Cost per 1,000 impressions (CPM)', fmt: 'money' },
    cpc: { label: 'Cost per link click (CPC)', fmt: 'money' },
    costPerView: { label: 'Cost per video view', fmt: 'money' },
    cpa: { label: 'Cost per conversion (CPA)', fmt: 'money' },
    spend: { label: 'Amount spent', fmt: 'money', neutral: true },
    budget: { label: 'Budget', fmt: 'money', neutral: true },
    dailySpend: { label: 'Average daily spend', fmt: 'money', neutral: true },
    budgetUsedPct: { label: 'Budget used', fmt: 'pct', neutral: true },
    universe: { label: 'Universe (audience size)', fmt: 'int', neutral: true },
    penetration: { label: 'Universe reached', fmt: 'pct', higher: true },
    qualifiedPct: { label: 'Qualified leads %', fmt: 'pct', higher: true },
    days: { label: 'Duration (days)', fmt: 'int', neutral: true },
    leadsPerDay: { label: 'Leads per day', fmt: 'num', higher: true },
    leads: { label: 'Leads', fmt: 'int', higher: true },
    reach: { label: 'Reach', fmt: 'int', higher: true },
    impressions: { label: 'Impressions', fmt: 'int', higher: true },
    frequency: { label: 'Frequency', fmt: 'num', band: [1.5, 3.5] },
    ctr: { label: 'Click-through rate (CTR)', fmt: 'pct', higher: true },
    lpvRate: { label: 'Clicks that loaded the page', fmt: 'pct', higher: true },
    leadConvRate: { label: 'Page visitors who became leads', fmt: 'pct', higher: true },
    roas: { label: 'Return on ad spend (ROAS)', fmt: 'x', higher: true },
  };

  /**
   * The comparison order. For lead campaigns it follows the order Hridesh's
   * marketing contact uses: CPL & budget → universe & qualified % → duration.
   * For other objectives the cost metric of that funnel level replaces CPL.
   */
  function comparisonTiers(objective) {
    const primary = objective && OBJECTIVES[objective] ? OBJECTIVES[objective].primaryCost : 'cpl';
    return [
      { tier: 1, title: 'Cost and budget', why: 'Compared first: what each result cost and how much money went in.', weight: 3, metrics: [primary, 'spend', 'budget', 'dailySpend'] },
      { tier: 2, title: 'Audience and lead quality', why: 'Then: how big the audience was, how much of it you reached, and how many leads were worth having.', weight: 2, metrics: ['universe', 'penetration', 'qualifiedPct', 'cpql'] },
      { tier: 3, title: 'Duration', why: 'Then: how long each ran. Short runs may still be in the platform\'s learning phase.', weight: 1, metrics: ['days', 'leadsPerDay'] },
      { tier: 4, title: 'Supporting signals', why: 'These explain the numbers above: creative pull, audience fatigue and landing-page friction.', weight: 0.5, metrics: ['cpm', 'ctr', 'cpc', 'frequency', 'lpvRate', 'leadConvRate', 'roas'].filter((k) => k !== primary) },
    ];
  }

  function dominantObjective(campaigns) {
    const counts = {};
    for (const c of campaigns) {
      const o = objectiveOf(c) || 'leads';
      counts[o] = (counts[o] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'leads';
  }

  function median(arr) {
    const a = arr.filter(isNum).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /** Rank campaigns on one metric. Returns {values: {id: v}, best, worst}. */
  function rankMetric(key, items) {
    const def = METRIC_DEFS[key] || {};
    const vals = items.map((it) => ({ id: it.c.id, v: it.m[key] })).filter((x) => isNum(x.v));
    const res = { key, values: Object.fromEntries(items.map((it) => [it.c.id, it.m[key]])), best: null, worst: null, spread: null };
    if (vals.length < 2 || def.neutral) return res;
    let sorted;
    if (def.band) {
      const mid = (def.band[0] + def.band[1]) / 2;
      sorted = [...vals].sort((a, b) => Math.abs(a.v - mid) - Math.abs(b.v - mid));
    } else {
      sorted = [...vals].sort((a, b) => (def.higher ? b.v - a.v : a.v - b.v));
    }
    res.best = sorted[0].id;
    res.worst = sorted[sorted.length - 1].id;
    const lo = Math.min(...vals.map((x) => x.v));
    const hi = Math.max(...vals.map((x) => x.v));
    res.spread = lo > 0 ? hi / lo - 1 : null;
    return res;
  }

  /** Two-proportion z-test; returns two-sided p-value or null. */
  function twoProportionP(x1, n1, x2, n2) {
    if (![x1, n1, x2, n2].every(isNum) || n1 <= 0 || n2 <= 0) return null;
    const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (se === 0) return null;
    const z = Math.abs(p1 - p2) / se;
    return 2 * (1 - normCdf(z));
  }
  function normCdf(z) {
    // Abramowitz–Stegun approximation
    const t = 1 / (1 + 0.2316419 * z);
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return 1 - prob;
  }

  function compare(campaigns, settings = DEFAULT_SETTINGS) {
    const items = campaigns.map((c) => ({ c, m: computeMetrics(c), targeting: classifyTargeting(c, settings), levels: targetLevels(c), dataLevels: dataLevels(c) }));
    const objective = dominantObjective(campaigns);
    const tiers = comparisonTiers(objective).map((t) => ({ ...t, ranks: t.metrics.map((k) => rankMetric(k, items)) }));

    // weighted score: winning a metric earns the tier weight, losing costs it
    const scores = Object.fromEntries(items.map((it) => [it.c.id, 0]));
    for (const t of tiers) for (const r of t.ranks) {
      if (r.best) scores[r.best] += t.weight;
      if (r.worst && r.worst !== r.best) scores[r.worst] -= t.weight / 2;
    }
    const ranking = [...items].sort((a, b) => scores[b.c.id] - scores[a.c.id]).map((it) => it.c.id);

    const mixedObjectives = new Set(items.map((it) => objectiveOf(it.c) || 'unset')).size > 1;
    const sharedLevels = items.length ? items.map((it) => it.levels).reduce((acc, lv) => acc.filter((x) => lv.includes(x))) : [];

    // significance of qualified-% and CTR differences between best and worst
    const significance = [];
    const q = tiers[1].ranks.find((r) => r.key === 'qualifiedPct');
    if (q && q.best && q.worst && q.best !== q.worst) {
      const a = items.find((it) => it.c.id === q.best).c, b = items.find((it) => it.c.id === q.worst).c;
      significance.push({ key: 'qualifiedPct', p: twoProportionP(a.qualifiedLeads, a.leads, b.qualifiedLeads, b.leads), best: q.best, worst: q.worst });
    }
    const ctr = rankMetric('ctr', items);
    if (ctr.best && ctr.worst && ctr.best !== ctr.worst) {
      const a = items.find((it) => it.c.id === ctr.best).c, b = items.find((it) => it.c.id === ctr.worst).c;
      significance.push({ key: 'ctr', p: twoProportionP(a.clicks, a.impressions, b.clicks, b.impressions), best: ctr.best, worst: ctr.worst });
    }

    const result = { items, objective, tiers, scores, ranking, mixedObjectives, sharedLevels, significance, settings };
    result.insights = buildInsights(result);
    result.commonality = commonAndDifferent(result);
    result.recommendations = buildRecommendations(result);
    return result;
  }

  // ---------- Insights (rules engine) ----------

  function buildInsights(r) {
    const { items, settings } = r;
    const med = (k) => median(items.map((it) => it.m[k]));
    const medCpl = med('cpl'), medCpm = med('cpm'), medCtr = med('ctr');
    const out = {};
    for (const it of items) {
      const { c, m } = it;
      const s = [], w = [];
      const obj = objectiveOf(c);
      const name = c.name;

      if (isNum(m.cpl) && isNum(medCpl) && items.length > 1) {
        if (m.cpl <= medCpl * 0.8) s.push(`Leads came ${pctDiff(m.cpl, medCpl)} cheaper than the group's middle CPL.`);
        else if (m.cpl >= medCpl * 1.2) w.push(`Leads cost ${pctDiff(m.cpl, medCpl)} more than the group's middle CPL.`);
      }
      if (isNum(settings.targetCpl) && isNum(m.cpl)) {
        if (m.cpl <= settings.targetCpl) s.push(`CPL is within your target of ${fmtMoney(settings.targetCpl, settings.currency)}.`);
        else w.push(`CPL is above your target of ${fmtMoney(settings.targetCpl, settings.currency)}.`);
      }
      if (isNum(m.qualifiedPct)) {
        if (m.qualifiedPct >= settings.targetQualifiedPct) s.push(`${fmtPct(m.qualifiedPct)} of leads were qualified, at or above your ${fmtPct(settings.targetQualifiedPct)} target.`);
        else w.push(`Only ${fmtPct(m.qualifiedPct)} of leads were qualified (target ${fmtPct(settings.targetQualifiedPct)}). Cheap leads that don't qualify are not cheap.`);
      } else if (obj === 'leads' || isNum(m.leads)) {
        w.push('Qualified leads are missing, so lead quality cannot be judged. Add the count from your CRM.');
      }
      if (isNum(m.ctr)) {
        if (m.ctr >= 0.02) s.push(`Strong click-through rate (${fmtPct(m.ctr)}): the ad gets people to act.`);
        else if (m.ctr < 0.008) w.push(`Low click-through rate (${fmtPct(m.ctr)}): the creative or offer isn't stopping the scroll.`);
        else if (isNum(medCtr) && items.length > 1 && m.ctr > medCtr * 1.25) s.push(`Click-through rate is above the group's middle value.`);
      }
      if (isNum(m.frequency)) {
        if (m.frequency > 3.5) w.push(`Frequency of ${m.frequency.toFixed(1)}: the same people saw the ad many times. Expect fatigue and rising costs.`);
        else if (obj === 'awareness' && m.frequency < 1.5) w.push(`Frequency of ${m.frequency.toFixed(1)} is low for an awareness campaign; people may not remember one view.`);
        else if (m.frequency >= 1.5 && m.frequency <= 3) s.push(`Healthy frequency (${m.frequency.toFixed(1)}): enough repeats without wearing people out.`);
      }
      if (isNum(m.cpm) && isNum(medCpm) && items.length > 1 && m.cpm > medCpm * 1.5) w.push(`CPM is ${pctDiff(m.cpm, medCpm)} above the group: the audience is expensive to reach, often because it is narrow or heavily contested.`);
      if (isNum(m.lpvRate) && m.lpvRate < 0.6) w.push(`Only ${fmtPct(m.lpvRate)} of clicks loaded the landing page. Check page speed and accidental clicks.`);
      if (isNum(m.leadConvRate) && isNum(c.landingPageViews) && m.leadConvRate < 0.05) w.push(`Only ${fmtPct(m.leadConvRate)} of page visitors became leads. The page or form has friction.`);
      if (isNum(m.leadConvRate) && isNum(c.landingPageViews) && m.leadConvRate >= 0.12) s.push(`${fmtPct(m.leadConvRate)} of page visitors became leads: the page converts well.`);
      if (isNum(m.penetration)) {
        if (m.penetration > 0.6 && isNum(m.frequency) && m.frequency > 2.5) w.push(`Reached ${fmtPct(m.penetration)} of the universe with high frequency: the audience is saturated.`);
        else if (m.penetration < 0.05 && isNum(m.days) && m.days >= 14) w.push(`Reached only ${fmtPct(m.penetration)} of the universe in ${m.days} days: the budget is small for this audience.`);
      }
      if (isNum(m.days) && m.days < settings.learningPhaseDays) w.push(`Ran only ${m.days} day${m.days === 1 ? '' : 's'}; platforms are usually still learning in the first week, so results are less reliable.`);
      if (isNum(m.leads) && m.leads > 0 && m.leads < settings.minLeadsForConfidence) w.push(`${m.leads} leads is a small sample; treat the percentages as rough.`);
      if (isNum(m.budgetUsedPct) && m.budgetUsedPct < 0.7) w.push(`Spent ${fmtPct(m.budgetUsedPct)} of its budget: the platform struggled to deliver, often a sign the audience is too narrow or the bid too low.`);
      if (isNum(m.roas)) (m.roas >= 3 ? s : m.roas < 1 ? w : s).push(`Return on ad spend of ${m.roas.toFixed(2)}×${m.roas < 1 ? ', below break-even' : ''}.`);

      const t = it.targeting.type;
      if (t === 'open' && isNum(m.qualifiedPct) && m.qualifiedPct < settings.targetQualifiedPct) w.push('Open targeting with low lead quality: the platform is finding cheap leads, not the right ones.');
      if (t === 'focused' && isNum(m.cpm) && isNum(medCpm) && m.cpm > medCpm * 1.3) w.push('Focused targeting is pushing the CPM up.');
      if (t === 'focused' && isNum(m.qualifiedPct) && m.qualifiedPct >= settings.targetQualifiedPct) s.push('Focused targeting is paying off in lead quality.');

      out[c.id] = { strengths: s, weaknesses: w };
    }
    return out;
  }

  function commonAndDifferent(r) {
    const { items } = r;
    if (items.length < 2) return { common: [], different: [] };
    const common = [], different = [];
    const same = (f, label, fmt = (x) => x) => {
      const vals = items.map(f);
      const uniq = [...new Set(vals.map(String))];
      if (uniq.length === 1 && vals[0] !== null && vals[0] !== undefined && vals[0] !== 'unknown') common.push(`${label}: ${fmt(vals[0])}`);
      else different.push(`${label}: ${items.map((it, i) => `${it.c.name} — ${vals[i] === null || vals[i] === undefined ? 'not set' : fmt(vals[i])}`).join('; ')}`);
    };
    same((it) => it.c.platform, 'Platform');
    same((it) => objectiveOf(it.c), 'Objective', (o) => OBJECTIVES[o]?.label || o);
    same((it) => it.targeting.type, 'Targeting', (t) => TARGETING[t]);
    same((it) => it.levels.join(','), 'Funnel levels aimed at', (s) => (s ? s.split(',').map((l) => 'L' + l).join(' + ') : 'not set'));
    const spreads = [];
    for (const t of r.tiers) for (const rk of t.ranks) if (isNum(rk.spread) && rk.spread >= 0.25) spreads.push({ t: t.tier, rk });
    // keep the order of importance, and only the five biggest gaps
    spreads.sort((a, b) => a.t - b.t || b.rk.spread - a.rk.spread).slice(0, 5).forEach(({ rk }) => {
      const best = items.find((it) => it.c.id === rk.best), worst = items.find((it) => it.c.id === rk.worst);
      different.push(`${METRIC_DEFS[rk.key].label}: ${best ? best.c.name : ''} is best, ${worst ? worst.c.name : ''} weakest (${Math.round(rk.spread * 100)}% apart)`);
    });
    return { common, different };
  }

  // ---------- Recommendations ----------

  function buildRecommendations(r) {
    const { items, settings, ranking } = r;
    const recs = { improve: {}, newCampaign: [], reallocation: null };
    const byId = Object.fromEntries(items.map((it) => [it.c.id, it]));

    for (const it of items) {
      const { c, m } = it;
      const list = [];
      if (isNum(m.frequency) && m.frequency > 3.5) list.push('Refresh the creative (new hook, new visual) and widen the audience to bring frequency under 3.');
      if (isNum(m.ctr) && m.ctr < 0.008) list.push('Test 2–3 new creatives with a clearer first line and a visible offer; keep the one with the best CTR after 3–4 days.');
      if (isNum(m.qualifiedPct) && m.qualifiedPct < settings.targetQualifiedPct) list.push('Add a qualifying question to the lead form (budget, location or timeline) and switch the form to "higher intent" so fewer casual leads get through.');
      if (it.targeting.type === 'open' && isNum(m.qualifiedPct) && m.qualifiedPct < settings.targetQualifiedPct) list.push('Move from open to loose targeting: layer 2–3 interests or a lookalike of your qualified leads.');
      if (it.targeting.type === 'focused' && isNum(m.cpm) && (isNum(m.budgetUsedPct) ? m.budgetUsedPct < 0.8 : true) && isNum(m.cpl) && m.cpl > (median(items.map((x) => x.m.cpl)) || Infinity)) list.push('Loosen the focused audience (fewer stacked conditions, or a 1–3% lookalike) so the platform has room to find cheaper leads.');
      if (isNum(m.lpvRate) && m.lpvRate < 0.6) list.push('Speed up the landing page (aim for under 3 seconds on mobile) and check that ad placements are not causing accidental clicks.');
      if (isNum(m.leadConvRate) && isNum(c.landingPageViews) && m.leadConvRate < 0.05) list.push('Cut form fields to the essentials and move the form above the fold, or try an instant (in-platform) lead form.');
      if (isNum(m.days) && m.days < settings.learningPhaseDays) list.push(`Let it run at least ${settings.learningPhaseDays}–14 days without major edits before judging it.`);
      if (isNum(m.penetration) && m.penetration < 0.05 && isNum(m.days) && m.days >= 14) list.push('Raise the daily budget or narrow the universe so the campaign reaches a meaningful share of it.');
      if (isNum(m.penetration) && m.penetration > 0.6) list.push('The audience is nearly used up: add a new audience or a lookalike before scaling budget.');
      if (!list.length) list.push(ranking[0] === c.id ? 'This is the best performer. Scale its budget gradually (about 20% every few days) and watch CPL.' : 'No major problems found. Test one change at a time (creative, then audience) to beat the leader.');
      recs.improve[c.id] = list;
    }

    // New campaign blueprint from the leader
    const lead = byId[ranking[0]];
    if (lead) {
      const lm = lead.m;
      const obj = objectiveOf(lead.c) || r.objective;
      recs.newCampaign.push(`Objective: ${OBJECTIVES[obj]?.label || 'Leads'}, the same as the best performer (${lead.c.name}).`);
      if (lead.targeting.type !== 'unknown') recs.newCampaign.push(`Targeting: start ${TARGETING[lead.targeting.type].toLowerCase()}, which worked best here${isNum(lead.c.universe) ? `, with a universe around ${fmtCompact(lead.c.universe)}` : ''}.`);
      recs.newCampaign.push(`Duration: at least 14 days, so the platform finishes learning and you have enough leads to judge quality.`);
      if (isNum(lm.cpl)) {
        const target = isNum(settings.targetCpl) ? Math.min(settings.targetCpl, lm.cpl) : lm.cpl;
        const leadsGoal = 100;
        recs.newCampaign.push(`Budget: about ${fmtMoney(target * leadsGoal, settings.currency)} for ~${leadsGoal} leads at a ${fmtMoney(target, settings.currency)} CPL (${fmtMoney((target * leadsGoal) / 14, settings.currency)} a day over 14 days). Expect CPL to rise as you scale.`);
      }
      if (isNum(lm.frequency)) recs.newCampaign.push('Frequency: keep it between 1.5 and 3; refresh creative once it passes 3.');
      recs.newCampaign.push('Lead form: include one qualifying question, and send qualified-lead counts back from your CRM every week so this tool can judge quality.');
      recs.newCampaign.push('Creative: reuse the angle of the best ad from the leader, and test 2–3 variations against it.');
    }

    // Budget reallocation what-if: move 20% from worst CPL to best CPL
    const cplRank = r.tiers[0].ranks[0];
    if (cplRank && cplRank.key === 'cpl' && cplRank.best && cplRank.worst && cplRank.best !== cplRank.worst) {
      const b = byId[cplRank.best].m, w = byId[cplRank.worst].m;
      if (isNum(w.spend) && isNum(b.cpl) && isNum(w.cpl)) {
        const moved = w.spend * 0.2;
        const lost = moved / w.cpl, gained = moved / (b.cpl * 1.15); // assume ~15% CPL rise when scaling
        recs.reallocation = {
          from: byId[cplRank.worst].c.name,
          to: byId[cplRank.best].c.name,
          moved,
          netLeads: gained - lost,
          text: `Moving 20% of ${byId[cplRank.worst].c.name}'s spend (${fmtMoney(moved, settings.currency)}) to ${byId[cplRank.best].c.name} would give roughly ${Math.round(gained - lost)} more leads, assuming its CPL rises about 15% as it scales.`,
        };
      }
    }
    return recs;
  }

  // ---------- Formatting ----------

  function fmtMoney(v, currency = 'INR') {
    if (!isNum(v)) return '—';
    const opts = { style: 'currency', currency, maximumFractionDigits: v >= 100 ? 0 : 2 };
    try {
      return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', opts).format(v);
    } catch (e) {
      return currency + ' ' + v.toFixed(2);
    }
  }
  function fmtPct(v) {
    if (!isNum(v)) return '—';
    return (v * 100).toFixed(v < 0.1 ? 2 : 1) + '%';
  }
  function fmtInt(v) {
    if (!isNum(v)) return '—';
    return new Intl.NumberFormat('en-IN').format(Math.round(v));
  }
  function fmtCompact(v) {
    if (!isNum(v)) return '—';
    if (v >= 1e7) return (v / 1e7).toFixed(v >= 1e8 ? 0 : 1) + ' crore';
    if (v >= 1e5) return (v / 1e5).toFixed(v >= 1e6 ? 0 : 1) + ' lakh';
    return fmtInt(v);
  }
  function pctDiff(a, b) {
    return Math.round(Math.abs(a / b - 1) * 100) + '%';
  }
  function formatMetric(key, v, currency) {
    const def = METRIC_DEFS[key] || {};
    switch (def.fmt) {
      case 'money': return fmtMoney(v, currency);
      case 'pct': return fmtPct(v);
      case 'int': return fmtInt(v);
      case 'x': return isNum(v) ? v.toFixed(2) + '×' : '—';
      default: return isNum(v) ? v.toFixed(2) : '—';
    }
  }

  // ---------- Exports ----------

  function toRows(result) {
    const keys = ['spend', 'budget', 'days', 'dailySpend', 'impressions', 'reach', 'frequency', 'cpm', 'clicks', 'ctr', 'cpc', 'views', 'costPerView', 'landingPageViews', 'lpvRate', 'leads', 'cpl', 'leadConvRate', 'qualifiedLeads', 'qualifiedPct', 'cpql', 'conversions', 'cpa', 'roas', 'universe', 'penetration'];
    const head = ['Campaign', 'Platform', 'Objective', 'Targeting', 'Start', 'End', 'Score', ...keys.map((k) => (METRIC_DEFS[k] ? METRIC_DEFS[k].label : k))];
    const rows = [head];
    for (const it of result.items) {
      rows.push([it.c.name, it.c.platform, OBJECTIVES[objectiveOf(it.c)]?.label || '', TARGETING[it.targeting.type], it.c.startDate || '', it.c.endDate || '', result.scores[it.c.id], ...keys.map((k) => (isNum(it.m[k]) ? +it.m[k].toFixed(4) : ''))]);
    }
    return rows;
  }

  function toCsv(result) {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return toRows(result).map((r) => r.map(esc).join(',')).join('\n');
  }

  const api = {
    FUNNEL_LEVELS, OBJECTIVES, PLATFORMS, TARGETING, DEFAULT_SETTINGS, FIELDS, METRIC_DEFS,
    parseNumber, parseDate, mapColumns, rowsToCampaigns, normaliseCampaign, newId,
    durationDays, computeMetrics, targetLevels, dataLevels, classifyTargeting, missingInputs,
    comparisonTiers, compare, rankMetric, twoProportionP, median,
    fmtMoney, fmtPct, fmtInt, fmtCompact, formatMetric, toCsv, toRows, objectiveOf, isNum,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CampaignCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
