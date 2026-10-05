// Pulls one ad account from Meta into the database, in resumable steps.
//
// Hosted functions can only run for a few minutes, so a sync is a series of steps.
// Each step does as much as fits before `deadline` and records where it stopped
// (ad_accounts.sync_cursor). The next step carries on from there.
//
//   1. structure: ad account, campaigns, ad sets, ads, audience sizes
//   2. daily results, 30 days at a time, oldest first
//
// Daily results are stored at ad level; campaign and ad-set numbers are added up
// from them. The last few days are always re-fetched, because Meta keeps
// attributing leads and purchases to recent days for a while.
'use strict';
const M = require('./map.js');

const CAMPAIGN_FIELDS = 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time';
const ADSET_FIELDS = 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,targeting';
const AD_FIELDS = 'id,name,adset_id,campaign_id,status,effective_status,creative{thumbnail_url}';
const INSIGHT_FIELDS = 'ad_id,adset_id,campaign_id,date_start,spend,impressions,reach,inline_link_clicks,actions,action_values';
const RESETTLE_DAYS = 3;           // re-fetch this many recent days on every sync
const UNIVERSE_TTL = 7 * 86400000; // refresh audience estimates weekly
const CHUNK_DAYS = 30;

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000));

/** Today's date in the ad account's own time zone (Meta reports days in that zone). */
function todayIn(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return iso(now);
  }
}

/** Split [since, until] into chunks of at most `days`. */
function chunks(since, until, days) {
  const out = [];
  for (let s = since; s <= until; s = addDays(s, days)) {
    const e = addDays(s, days - 1);
    out.push({ since: s, until: e < until ? e : until });
  }
  return out;
}

async function fetchDaily(client, accountId, range, onRows, depth = 0) {
  try {
    const rows = await client.all(`${accountId}/insights`, { level: 'ad', time_increment: 1, time_range: range, fields: INSIGHT_FIELDS, limit: 500 });
    await onRows(rows);
  } catch (e) {
    // Meta refuses big requests: split the range in half and try again.
    if (e.kind === 'too_much_data' && depth < 5 && range.since < range.until) {
      const days = Math.round((Date.parse(range.until) - Date.parse(range.since)) / 86400000) + 1;
      const mid = addDays(range.since, Math.floor(days / 2) - 1);
      await fetchDaily(client, accountId, { since: range.since, until: mid }, onRows, depth + 1);
      await fetchDaily(client, accountId, { since: addDays(mid, 1), until: range.until }, onRows, depth + 1);
      return;
    }
    throw e;
  }
}

const UPSERT_ENTITY = `INSERT INTO entities (user_id, account_id, id, level, campaign_id, adset_id, name, objective, status, daily_budget, lifetime_budget, start_time, end_time, targeting_notes, thumbnail_url, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, id) DO UPDATE SET level = excluded.level, campaign_id = excluded.campaign_id, adset_id = excluded.adset_id, name = excluded.name,
    objective = excluded.objective, status = excluded.status, daily_budget = excluded.daily_budget, lifetime_budget = excluded.lifetime_budget,
    start_time = excluded.start_time, end_time = excluded.end_time, targeting_notes = excluded.targeting_notes, thumbnail_url = excluded.thumbnail_url, updated_at = excluded.updated_at`;
const UPSERT_DAILY = `INSERT INTO daily (user_id, account_id, ad_id, adset_id, campaign_id, date, spend, impressions, reach, clicks, lpv, leads, conversions, conversion_value, views)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, ad_id, date) DO UPDATE SET spend = excluded.spend, impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks,
    lpv = excluded.lpv, leads = excluded.leads, conversions = excluded.conversions, conversion_value = excluded.conversion_value, views = excluded.views`;

async function syncStructure({ db, userId, accountId, client, progress, deadline }) {
  await progress('Reading the ad account');
  const acct = await client.get(accountId, { fields: 'id,name,currency,timezone_name,account_status' });
  await db.run('UPDATE ad_accounts SET name = ?, currency = ?, timezone = ?, account_status = ? WHERE user_id = ? AND id = ?',
    acct.name, acct.currency, acct.timezone_name, acct.account_status ?? null, userId, accountId);

  await progress('Reading campaigns, ad sets and ads');
  const campaigns = await client.all(`${accountId}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 200 });
  const adsets = await client.all(`${accountId}/adsets`, { fields: ADSET_FIELDS, limit: 200 });
  const ads = await client.all(`${accountId}/ads`, { fields: AD_FIELDS, limit: 200 });
  const t = Date.now();
  const objectiveOf = Object.fromEntries(campaigns.map((c) => [c.id, c.objective]));
  const writes = [];
  for (const c of campaigns) writes.push([UPSERT_ENTITY, userId, accountId, c.id, 'campaign', c.id, null, c.name, c.objective, c.effective_status || c.status, c.daily_budget ?? null, c.lifetime_budget ?? null, c.start_time ?? null, c.stop_time ?? null, null, null, t]);
  for (const s of adsets) writes.push([UPSERT_ENTITY, userId, accountId, s.id, 'adset', s.campaign_id, s.id, s.name, objectiveOf[s.campaign_id] ?? null, s.effective_status || s.status, s.daily_budget ?? null, s.lifetime_budget ?? null, s.start_time ?? null, s.end_time ?? null, M.targetingNotes(s.targeting) ?? null, null, t]);
  for (const a of ads) writes.push([UPSERT_ENTITY, userId, accountId, a.id, 'ad', a.campaign_id, a.adset_id, a.name, objectiveOf[a.campaign_id] ?? null, a.effective_status || a.status, null, null, null, null, null, a.creative?.thumbnail_url ?? null, t]);
  await db.batch(writes);

  // Audience size ("universe") for each ad set. Optional: skipped quietly if Meta refuses.
  await progress('Checking audience sizes');
  const stale = await db.all(`SELECT id FROM entities WHERE user_id = ? AND account_id = ? AND level = 'adset' AND (universe_at IS NULL OR universe_at < ?)`, userId, accountId, Date.now() - UNIVERSE_TTL);
  let estimateErrors = 0;
  for (const { id } of stale) {
    if (Date.now() > deadline) break; // the rest are picked up next time
    try {
      const est = await client.get(`${id}/delivery_estimate`, { optimization_goal: adsets.find((s) => s.id === id)?.optimization_goal });
      const u = M.universeFromEstimate(est);
      if (u) await db.run('UPDATE entities SET universe = ?, universe_at = ? WHERE user_id = ? AND id = ?', u, Date.now(), userId, id);
    } catch (e) {
      if (e.kind === 'auth' || e.kind === 'rate_limit') throw e;
      estimateErrors++;
    }
  }
  return { timezone: acct.timezone_name, campaigns: campaigns.length, adsets: adsets.length, ads: ads.length, estimateErrors };
}

/**
 * Run one step of a sync.
 * @param {object} o
 * @param {object} o.db
 * @param {string} o.userId
 * @param {string} o.accountId     act_…
 * @param {GraphClient} o.client
 * @param {number} [o.backfillDays]  how far back the first sync goes
 * @param {number} [o.deadline]      ms timestamp; the step stops starting new work after it
 * @param {(msg:string)=>Promise|void} [o.progress]
 * @returns {Promise<{done:boolean, rows:number, apiCalls:number, ...}>}
 */
async function syncStep({ db, userId, accountId, client, backfillDays = 90, deadline = Infinity, progress = async () => {}, now = new Date() }) {
  const startedCalls = client.calls;
  const row = await db.get('SELECT sync_cursor, synced_until, timezone FROM ad_accounts WHERE user_id = ? AND id = ?', userId, accountId);
  let cursor = row?.sync_cursor;
  let structure = null;
  let timezone = row?.timezone;

  // Fresh sync: refresh the structure first, then decide which days to fetch.
  if (!cursor) {
    structure = await syncStructure({ db, userId, accountId, client, progress, deadline });
    timezone = structure.timezone;
    const today = todayIn(timezone, now);
    cursor = row?.synced_until ? addDays(row.synced_until, -RESETTLE_DAYS) : addDays(today, -(backfillDays - 1));
    await db.run('UPDATE ad_accounts SET sync_cursor = ? WHERE user_id = ? AND id = ?', cursor, userId, accountId);
  }

  const today = todayIn(timezone, now);
  const parts = chunks(cursor, today, CHUNK_DAYS);
  let rowsSaved = 0;
  let didChunk = false;
  for (let i = 0; i < parts.length; i++) {
    // Always make progress: at least one chunk per step, more while time allows.
    if (didChunk && Date.now() > deadline) {
      return { done: false, cursor: parts[i].since, rows: rowsSaved, apiCalls: client.calls - startedCalls, ...structure };
    }
    await progress(`Fetching daily results: ${parts[i].since} to ${parts[i].until}`);
    await fetchDaily(client, accountId, parts[i], async (rows) => {
      await db.batch(rows.map((r) => {
        const m = M.mapInsightRow(r);
        return [UPSERT_DAILY, userId, accountId, r.ad_id, r.adset_id ?? null, r.campaign_id ?? null, r.date_start, m.spend ?? 0, m.impressions ?? 0, m.reach ?? 0, m.clicks ?? 0,
          m.landingPageViews ?? null, m.leads ?? null, m.conversions ?? null, m.conversionValue ?? null, m.views ?? null];
      }));
      rowsSaved += rows.length;
    });
    didChunk = true;
    await db.run('UPDATE ad_accounts SET sync_cursor = ? WHERE user_id = ? AND id = ?', addDays(parts[i].until, 1), userId, accountId);
  }

  // Finished: range totals depend on the daily data, so cached reach is now out of date.
  const since = cursor;
  await db.run('DELETE FROM totals_cache WHERE user_id = ? AND account_id = ?', userId, accountId);
  await db.run(`UPDATE ad_accounts SET sync_cursor = NULL, synced_until = ?, last_synced_at = ? WHERE user_id = ? AND id = ?`, today, Date.now(), userId, accountId);
  return {
    done: true, rows: rowsSaved, since, until: today, apiCalls: client.calls - startedCalls,
    note: structure && structure.estimateErrors ? `Audience size unavailable for ${structure.estimateErrors} ad set(s); you can type it in.` : null,
    ...structure,
  };
}

/** Run steps until the sync is complete (local use and tests). */
async function syncAccount(o) {
  let r;
  do { r = await syncStep(o); } while (!r.done);
  return r;
}

module.exports = { syncStep, syncAccount, todayIn, chunks, addDays, INSIGHT_FIELDS };
