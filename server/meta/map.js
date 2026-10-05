// Turns Meta Marketing API objects into the analyser's campaign fields.
// Pure functions: no network, no database. Tested in tests/meta-map.test.js.
'use strict';

// Currencies Meta reports without minor units (budgets are already whole units).
// Everything else (INR, USD, EUR…) is reported in the smallest unit, e.g. paise.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'PYG', 'TWD', 'VND']);
function currencyOffset(currency) {
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100;
}
function budgetToUnits(raw, currency) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n / currencyOffset(currency) : undefined;
}

// Meta objectives (new "ODAX" names and legacy ones) → analyser objectives.
const OBJECTIVE_MAP = {
  OUTCOME_LEADS: 'leads', LEAD_GENERATION: 'leads',
  OUTCOME_SALES: 'conversions', CONVERSIONS: 'conversions', PRODUCT_CATALOG_SALES: 'conversions', OUTCOME_APP_PROMOTION: 'conversions', APP_INSTALLS: 'conversions',
  OUTCOME_TRAFFIC: 'traffic', LINK_CLICKS: 'traffic',
  OUTCOME_ENGAGEMENT: 'engagement', POST_ENGAGEMENT: 'engagement', PAGE_LIKES: 'engagement', MESSAGES: 'engagement', EVENT_RESPONSES: 'engagement',
  OUTCOME_AWARENESS: 'awareness', REACH: 'awareness', BRAND_AWARENESS: 'awareness',
  VIDEO_VIEWS: 'video_views',
};
function mapObjective(metaObjective) {
  return OBJECTIVE_MAP[String(metaObjective || '').toUpperCase()];
}

// Meta reports results inside an `actions` array: [{ action_type, value }].
// Lead types overlap ("lead" already includes form and pixel leads), so we take
// the first matching group in priority order instead of adding them up.
const ACTION_GROUPS = {
  leads: [['lead'], ['onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'onsite_web_lead']],
  landingPageViews: [['landing_page_view'], ['omni_landing_page_view']],
  conversions: [['omni_purchase'], ['purchase'], ['offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase']],
  views: [['video_view']],
};
function actionValue(actions, key) {
  if (!Array.isArray(actions)) return undefined;
  const byType = new Map(actions.map((a) => [a.action_type, Number(a.value)]));
  for (const group of ACTION_GROUPS[key]) {
    const present = group.filter((t) => byType.has(t));
    if (present.length) return present.reduce((sum, t) => sum + (byType.get(t) || 0), 0);
  }
  return undefined;
}

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** One insights row (any level, any date range) → additive metric fields. */
function mapInsightRow(row) {
  return {
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    frequency: num(row.frequency),
    clicks: num(row.inline_link_clicks ?? row.clicks),
    landingPageViews: actionValue(row.actions, 'landingPageViews'),
    leads: actionValue(row.actions, 'leads'),
    conversions: actionValue(row.actions, 'conversions'),
    conversionValue: actionValue(row.action_values, 'conversions'),
    views: actionValue(row.actions, 'views'),
  };
}

/**
 * A short, human description of an ad set's targeting. The engine's targeting
 * classifier reads these words (Advantage+, lookalike, interests…).
 */
function targetingNotes(t) {
  if (!t || typeof t !== 'object') return undefined;
  const parts = [];
  if (t.targeting_automation && Number(t.targeting_automation.advantage_audience) === 1) parts.push('Advantage+ audience');
  const custom = t.custom_audiences || [];
  if (custom.length) {
    const lal = custom.filter((a) => /lookalike/i.test(a.name || '') || a.subtype === 'LOOKALIKE');
    if (lal.length) parts.push(`Lookalike: ${lal.map((a) => a.name).join(', ')}`);
    const other = custom.filter((a) => !lal.includes(a));
    if (other.length) parts.push(`Custom audience: ${other.map((a) => a.name).join(', ')}`);
  }
  const interests = [];
  for (const spec of t.flexible_spec || []) {
    for (const k of ['interests', 'behaviors', 'work_positions', 'life_events']) for (const i of spec[k] || []) interests.push(i.name);
  }
  for (const i of t.interests || []) interests.push(i.name);
  if (interests.length) parts.push(`Interests: ${interests.slice(0, 6).join(', ')}${interests.length > 6 ? '…' : ''}`);
  const geo = t.geo_locations || {};
  const places = [...(geo.cities || []).map((c) => c.name), ...(geo.regions || []).map((r) => r.name), ...(geo.countries || [])];
  if (places.length) parts.push(places.slice(0, 4).join(', '));
  if (t.age_min || t.age_max) parts.push(`${t.age_min || 18}-${t.age_max || '65+'}`);
  if (!custom.length && !interests.length && !parts.includes('Advantage+ audience')) parts.push('Broad (no detailed targeting)');
  return parts.join('; ');
}

/** Midpoint of Meta's audience estimate, or undefined. */
function universeFromEstimate(est) {
  const d = Array.isArray(est?.data) ? est.data[0] : est;
  if (!d) return undefined;
  const lo = num(d.estimate_mau_lower_bound), hi = num(d.estimate_mau_upper_bound);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > 0) return Math.round((lo + hi) / 2);
  const single = num(d.estimate_mau ?? d.users);
  return Number.isFinite(single) && single > 0 ? single : undefined;
}

const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : undefined);
function daysInclusive(since, until) {
  return Math.round((Date.parse(until) - Date.parse(since)) / 86400000) + 1;
}

/**
 * Budget for the chosen date range. Lifetime budgets are used as they are.
 * Daily budgets are multiplied by the days the entity was live inside the range.
 */
function budgetForRange(entity, since, until, currency) {
  const startRaw = dateOnly(entity.start_time);
  const endRaw = dateOnly(entity.end_time || entity.stop_time);
  const start = startRaw && startRaw > since ? startRaw : since;
  const end = endRaw && endRaw < until ? endRaw : until;
  const liveDays = daysInclusive(start, end);
  if (liveDays <= 0) return undefined;
  const life = budgetToUnits(entity.lifetime_budget, currency);
  if (life) {
    // A lifetime budget covers the whole flight: count only the share that falls inside the range.
    if (!startRaw || !endRaw) return life;
    const flight = daysInclusive(startRaw, endRaw);
    return flight > 0 ? life * Math.min(1, liveDays / flight) : life;
  }
  const daily = budgetToUnits(entity.daily_budget, currency);
  return daily ? daily * liveDays : undefined;
}

module.exports = {
  currencyOffset, budgetToUnits, mapObjective, actionValue, mapInsightRow,
  targetingNotes, universeFromEstimate, budgetForRange, daysInclusive, dateOnly,
};
