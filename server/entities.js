// Builds analyser-ready campaign objects (the same shape a CSV import produces)
// from synced Meta data, for any level (campaign, ad set, ad) and date range.
'use strict';
const M = require('./meta/map.js');

const LEVELS = ['campaign', 'adset', 'ad'];
const MANUAL_KEYS = ['qualifiedLeads', 'universe', 'budget', 'targeting', 'targetingNotes', 'objective', 'levels', 'notes'];

function cleanManual(input) {
  const out = {};
  for (const k of MANUAL_KEYS) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === null || v === '' || v === undefined) { out[k] = null; continue; }
    if (['qualifiedLeads', 'universe', 'budget'].includes(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else if (k === 'levels') {
      if (Array.isArray(v)) out[k] = v.map(Number).filter((x) => x >= 1 && x <= 5);
    } else if (k === 'targeting') {
      if (['auto', 'open', 'loose', 'focused'].includes(v)) out[k] = v;
    } else {
      out[k] = String(v).slice(0, 2000);
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {object} o.db
 * @param {string} o.userId
 * @param {string} o.accountId
 * @param {'campaign'|'adset'|'ad'} o.level
 * @param {string} o.since  YYYY-MM-DD
 * @param {string} o.until  YYYY-MM-DD
 * @param {Object<string,{reach:number,frequency:number}>} [o.reach]  unique reach for the range, by entity id
 */
async function buildCampaigns({ db, userId, accountId, level, since, until, reach = {} }) {
  if (!LEVELS.includes(level)) throw new Error('Unknown level');
  const account = await db.get('SELECT * FROM ad_accounts WHERE user_id = ? AND id = ?', userId, accountId);
  const currency = account?.currency || 'INR';
  const ents = await db.all('SELECT * FROM entities WHERE user_id = ? AND account_id = ?', userId, accountId);
  const byId = Object.fromEntries(ents.map((e) => [e.id, e]));
  const keyCol = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id';

  const days = await db.all(`SELECT ${keyCol} AS k, date, SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
      SUM(lpv) AS lpv, SUM(leads) AS leads, SUM(conversions) AS conversions, SUM(conversion_value) AS conversion_value, SUM(views) AS views,
      COUNT(lpv) AS lpv_n, COUNT(leads) AS leads_n, COUNT(conversions) AS conv_n, COUNT(views) AS views_n
    FROM daily WHERE user_id = ? AND account_id = ? AND date BETWEEN ? AND ? GROUP BY ${keyCol}, date ORDER BY date`, userId, accountId, since, until);

  const manualRows = await db.all('SELECT entity_id, json FROM manual_inputs WHERE user_id = ?', userId);
  const manual = Object.fromEntries(manualRows.map((r) => [r.entity_id, JSON.parse(r.json)]));

  const groups = new Map();
  for (const d of days) {
    if (!d.k) continue;
    if (!groups.has(d.k)) groups.set(d.k, []);
    groups.get(d.k).push(d);
  }
  const adsetsOf = (campaignId) => ents.filter((e) => e.level === 'adset' && e.campaign_id === campaignId);

  const out = [];
  for (const [id, series] of groups) {
    const e = byId[id];
    if (!e) continue;
    const live = series.filter((d) => d.spend > 0 || d.impressions > 0);
    if (!live.length) continue;
    const sum = (k) => series.reduce((a, d) => a + (d[k] || 0), 0);
    const tracked = (k, n) => (series.some((d) => d[n] > 0) ? sum(k) : undefined);
    const campaign = byId[e.campaign_id];
    const adset = e.adset_id ? byId[e.adset_id] : null;

    // Budget for this range.
    let budget;
    if (level === 'campaign') {
      budget = M.budgetForRange(e, since, until, currency);
      if (!budget) {
        const parts = adsetsOf(e.id).map((s) => M.budgetForRange(s, since, until, currency)).filter(Boolean);
        if (parts.length) budget = parts.reduce((a, b) => a + b, 0);
      }
    } else if (level === 'adset') {
      budget = M.budgetForRange(e, since, until, currency);
    }

    // Audience size and targeting description.
    let universe, notes;
    if (level === 'campaign') {
      const sets = adsetsOf(e.id);
      const us = sets.map((s) => s.universe).filter(Boolean);
      universe = us.length ? Math.max(...us) : undefined;
      notes = [...new Set(sets.map((s) => s.targeting_notes).filter(Boolean))].join(' | ') || undefined;
    } else {
      const s = level === 'adset' ? e : adset;
      universe = s?.universe || undefined;
      notes = s?.targeting_notes || undefined;
    }

    const r = reach[id] || {};
    const base = {
      id: e.id,
      source: 'meta',
      level,
      name: e.name,
      platform: 'Meta',
      objective: M.mapObjective(e.objective || campaign?.objective),
      metaObjective: e.objective || campaign?.objective,
      status: e.status,
      campaignName: level !== 'campaign' ? campaign?.name : undefined,
      adsetName: level === 'ad' ? adset?.name : undefined,
      thumbnailUrl: e.thumbnail_url || undefined,
      startDate: live[0].date,
      endDate: live[live.length - 1].date,
      budget,
      spend: Math.round(sum('spend') * 100) / 100,
      impressions: sum('impressions'),
      reach: r.reach || undefined,
      frequency: r.frequency || undefined,
      clicks: sum('clicks'),
      landingPageViews: tracked('lpv', 'lpv_n'),
      leads: tracked('leads', 'leads_n'),
      conversions: tracked('conversions', 'conv_n'),
      conversionValue: tracked('conversion_value', 'conv_n'),
      views: tracked('views', 'views_n'),
      universe,
      targetingNotes: notes,
      targeting: 'auto',
      daily: series.map((d) => ({ date: d.date, spend: Math.round(d.spend * 100) / 100, impressions: d.impressions, clicks: d.clicks, leads: d.leads ?? null, lpv: d.lpv ?? null, conversions: d.conversions ?? null })),
      autoValues: { budget, universe, targetingNotes: notes, objective: M.mapObjective(e.objective || campaign?.objective) },
    };
    // Things the user typed in win over what Meta reported.
    const man = manual[id] || {};
    for (const [k, v] of Object.entries(man)) if (v !== null && v !== undefined && k !== 'notes') base[k] = v;
    if (man.notes) base.notes = man.notes;
    base.manualKeys = Object.keys(man).filter((k) => man[k] !== null && man[k] !== undefined);
    out.push(base);
  }
  out.sort((a, b) => b.spend - a.spend);
  return { currency, campaigns: out };
}

module.exports = { buildCampaigns, cleanManual, LEVELS, MANUAL_KEYS };
