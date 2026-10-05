// Share snapshots come from the browser, so they are untrusted. Rebuild them
// from a whitelist: known fields, safe types, bounded sizes. Anything else is dropped.
'use strict';

const NUM_FIELDS = ['budget', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'views', 'landingPageViews', 'leads', 'qualifiedLeads', 'conversions', 'conversionValue', 'universe'];
const TEXT_FIELDS = { name: 300, platform: 30, campaignName: 300, adsetName: 300, targetingNotes: 1000, status: 40, notes: 2000 };
const OBJECTIVES = ['awareness', 'traffic', 'engagement', 'video_views', 'leads', 'conversions'];
const TARGETING = ['auto', 'open', 'loose', 'focused'];
const LEVELS = ['campaign', 'adset', 'ad'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SETTINGS_NUM = ['targetCpl', 'targetQualifiedPct', 'openUniverseMin', 'focusedUniverseMax', 'minLeadsForConfidence', 'learningPhaseDays'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13 ? v : undefined);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function cleanCampaign(c, i) {
  if (!c || typeof c !== 'object') return null;
  const out = { id: typeof c.id === 'string' && ID.test(c.id) ? c.id : `item${i + 1}` };
  for (const k of NUM_FIELDS) { const v = num(c[k]); if (v !== undefined) out[k] = v; }
  for (const [k, max] of Object.entries(TEXT_FIELDS)) { const v = text(c[k], max); if (v !== undefined) out[k] = v; }
  if (!out.name) out.name = `Item ${i + 1}`;
  if (OBJECTIVES.includes(c.objective)) out.objective = c.objective;
  if (TARGETING.includes(c.targeting)) out.targeting = c.targeting;
  if (LEVELS.includes(c.level)) out.level = c.level;
  if (c.source === 'meta') out.source = 'meta';
  for (const k of ['startDate', 'endDate']) if (typeof c[k] === 'string' && DATE.test(c[k])) out[k] = c[k];
  if (Array.isArray(c.levels)) out.levels = c.levels.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= 5).slice(0, 5);
  if (Array.isArray(c.daily)) {
    out.daily = c.daily.slice(0, 1200).filter((d) => d && typeof d.date === 'string' && DATE.test(d.date)).map((d) => {
      const row = { date: d.date };
      for (const k of ['spend', 'impressions', 'clicks', 'leads', 'lpv', 'conversions']) { const v = num(d[k]); row[k] = v === undefined ? null : v; }
      return row;
    });
  }
  // Thumbnails are left out on purpose: they would make viewers' browsers load images from other hosts.
  return out;
}

function cleanSnapshot(body) {
  const campaigns = (Array.isArray(body.campaigns) ? body.campaigns : []).slice(0, 5).map(cleanCampaign).filter(Boolean);
  const ids = new Set();
  campaigns.forEach((c, i) => { if (ids.has(c.id)) c.id = `${c.id}-${i}`; ids.add(c.id); });
  const s = body.settings && typeof body.settings === 'object' ? body.settings : {};
  const settings = {};
  if (typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency)) settings.currency = s.currency;
  for (const k of SETTINGS_NUM) { const v = num(s[k]); if (v !== undefined) settings[k] = v; }
  const r = body.range;
  const range = r && DATE.test(r.since || '') && DATE.test(r.until || '') ? { since: r.since, until: r.until } : null;
  return { title: text(body.title, 140) || 'Campaign comparison', campaigns, settings, range };
}

module.exports = { cleanSnapshot };
