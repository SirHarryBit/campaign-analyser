/* Campaign Analyser — browser UI. Depends on core.js (CampaignCore), sample.js (SAMPLE_CSV) and SheetJS (XLSX). */
(function () {
  'use strict';
  const C = window.CampaignCore;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const MAX_COMPARE = 5;
  const STORE_KEY = 'campaign-analyser-v1';

  const state = {
    campaigns: [],
    selected: new Set(),
    settings: { ...C.DEFAULT_SETTINGS },
    isExample: false,
    warnings: [],
    tab: 'campaigns',
    editingId: null,
    server: null,          // set when the Node server answers /api/health
    source: 'files',       // 'files' (imported) or 'meta' (synced)
    wantSource: 'files',
    fileStash: null,       // imported campaigns kept aside while looking at Meta data
    meta: { me: null, accounts: [], accountId: null, level: 'campaign', preset: 'last30', since: null, until: null, items: null, selectedIds: [], comparisons: [], loading: false, error: null, range: null, pendingSelection: null },
    viewer: null,          // a shared, read-only snapshot
    trendMetric: null,
  };

  // ---------- Storage (per-browser convenience only) ----------
  function save() {
    if (state.viewer) return;
    try {
      const files = state.source === 'files' ? { campaigns: state.campaigns, selected: [...state.selected], isExample: state.isExample } : state.fileStash;
      const m = state.meta;
      const metaPrefs = { accountId: m.accountId, level: m.level, preset: m.preset, since: m.since, until: m.until, selected: state.source === 'meta' ? [...state.selected] : m.selectedIds };
      localStorage.setItem(STORE_KEY, JSON.stringify({ files, settings: state.settings, tab: state.tab, source: state.source, metaPrefs }));
    } catch (e) { /* storage unavailable: fine */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      const files = d.files || { campaigns: d.campaigns, selected: d.selected, isExample: d.isExample };
      state.campaigns = (files.campaigns || []).map(C.normaliseCampaign);
      state.selected = new Set((files.selected || []).filter((id) => state.campaigns.some((c) => c.id === id)));
      state.settings = { ...C.DEFAULT_SETTINGS, ...(d.settings || {}) };
      state.isExample = !!files.isExample;
      state.tab = d.tab || 'campaigns';
      state.wantSource = d.source || 'files';
      if (d.metaPrefs) {
        const p = d.metaPrefs;
        Object.assign(state.meta, { accountId: p.accountId || null, level: p.level || 'campaign', preset: p.preset || 'last30', since: p.since || null, until: p.until || null, selectedIds: p.selected || [], pendingSelection: (p.selected || []).length ? p.selected : null });
      }
      return state.campaigns.length > 0;
    } catch (e) {
      return false;
    }
  }

  // ---------- Import ----------
  // Small CSV reader (quotes, commas, newlines) so CSV works even if the spreadsheet library fails to load.
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    const delim = text.split('\n')[0].includes('\t') && !text.split('\n')[0].includes(',') ? '\t' : ',';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  function rowsFromWorkbook(data, isText) {
    if (typeof XLSX === 'undefined') {
      if (isText) return parseCsv(String(data).replace(/^\ufeff/, ''));
      throw new Error('the Excel reader did not load; export as CSV instead');
    }
    const wb = isText ? XLSX.read(data, { type: 'string', raw: false }) : XLSX.read(data, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  }

  function importRows(rows, sourceLabel) {
    const res = C.rowsToCampaigns(rows);
    if (!res.campaigns.length) {
      state.warnings = [`${sourceLabel}: no campaigns found. Check that the first row holds column names.`];
      render();
      return;
    }
    if (state.isExample) { state.campaigns = []; state.selected.clear(); state.isExample = false; }
    if (res.currency) state.settings.currency = res.currency;
    state.campaigns.push(...res.campaigns);
    res.campaigns.slice(0, MAX_COMPARE - state.selected.size).forEach((c) => state.selected.add(c.id));
    const mapped = Object.keys(res.mapping).filter((k) => !['resultIndicator', 'results'].includes(k));
    state.warnings = [`${sourceLabel}: added ${res.campaigns.length} campaign${res.campaigns.length === 1 ? '' : 's'}. Recognised columns: ${mapped.map(fieldLabel).join(', ') || 'none'}.`, ...res.warnings];
    save();
    render();
  }

  async function handleFiles(files) {
    for (const f of files) {
      try {
        const isText = /\.(csv|tsv|txt)$/i.test(f.name);
        const data = isText ? await f.text() : new Uint8Array(await f.arrayBuffer());
        importRows(rowsFromWorkbook(data, isText), f.name);
      } catch (e) {
        state.warnings = [`${f.name}: could not be read (${e.message}). Export it again from Ads Manager as CSV or XLSX.`];
        render();
      }
    }
  }

  function loadExample() {
    state.campaigns = [];
    state.selected.clear();
    const rows = rowsFromWorkbook(window.SAMPLE_CSV, true);
    const res = C.rowsToCampaigns(rows);
    state.campaigns = res.campaigns;
    res.campaigns.filter((c) => c.objective === 'leads').forEach((c) => state.selected.add(c.id));
    state.isExample = true;
    state.warnings = [];
    state.settings.currency = 'INR';
    save();
  }

  // ---------- Helpers ----------
  function fieldLabel(k) {
    return (C.FIELDS.find((f) => f.key === k) || {}).label || k;
  }
  const money = (v) => C.fmtMoney(v, state.settings.currency);
  const objLabel = (o) => (C.OBJECTIVES[o] ? C.OBJECTIVES[o].label : 'Not set');
  const tLabel = (t) => C.TARGETING[t] || t;
  function selectedCampaigns() {
    return state.campaigns.filter((c) => state.selected.has(c.id));
  }
  function colorSlot(id) {
    const idx = selectedCampaigns().findIndex((c) => c.id === id);
    return idx === -1 ? 0 : idx + 1;
  }

  function funnelChips(c) {
    const aim = C.targetLevels(c), data = C.dataLevels(c);
    return '<span class="lv-row" aria-label="Funnel levels">' + [1, 2, 3, 4, 5].map((l) => {
      const cls = aim.includes(l) ? 'lv aim' : data.includes(l) ? 'lv data' : 'lv';
      const t = aim.includes(l) ? 'aimed at' : data.includes(l) ? 'has data' : 'no data';
      return `<span class="${cls}" title="Level ${l}: ${t}">L${l}</span>`;
    }).join('') + '</span>';
  }

  // ---------- Render: tabs ----------
  function render() {
    renderSource();
    $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    $$('.panel').forEach((p) => (p.hidden = p.id !== 'panel-' + state.tab));
    $('#compare-count').textContent = state.selected.size ? String(state.selected.size) : '';
    renderCampaigns();
    if (state.tab === 'compare') renderCompare();
  }

  // For synced items only the fields Meta can't supply can be filled in.
  function gapsFor(c) {
    const miss = C.missingInputs(c);
    if (c.source !== 'meta') return miss;
    // Meta sets budgets on campaigns or ad sets, never on single ads.
    return miss.filter((k) => META_EDITABLE.has(k) && !(k === 'budget' && c.level === 'ad'));
  }

  function renderCampaigns() {
    const host = $('#campaign-list');
    $('#example-banner').hidden = !state.isExample;
    $('#import-notes').innerHTML = state.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
    $('#import-notes').hidden = !state.warnings.length;

    if (state.source === 'meta') {
      if (!state.meta.me || !state.meta.accounts.length) { host.innerHTML = ''; return; }
      const acct = currentAccount();
      if (!state.campaigns.length) {
        const msg = !acct || !acct.lastSyncedAt
          ? (acct && (acct.syncState === 'running' || acct.syncState === 'partial') ? '<p class="empty-title">First sync in progress</p><p>Fetching the last 90 days from Meta. This takes a minute for most accounts.</p>' : '<p class="empty-title">This account hasn\'t been synced yet</p><p>Sync it to pull campaigns, ad sets, ads and daily results from Meta.</p><button class="btn" data-act="sync">Sync this account</button>')
          : `<p class="empty-title">Nothing ran in this period</p><p>No ${LEVEL_LABELS[state.meta.level].toLowerCase()} spent money between ${fmtDay(presetRange(state.meta.preset, state.meta.since, state.meta.until).since)} and ${fmtDay(presetRange(state.meta.preset, state.meta.since, state.meta.until).until)}. Try a longer date range.</p>`;
        host.innerHTML = `<div class="empty">${msg}</div>`;
        return;
      }
    }
    if (!state.campaigns.length) {
      host.innerHTML = `<div class="empty"><p class="empty-title">No campaigns yet</p><p>Upload an export from Meta Ads Manager or Google Ads, add a campaign by hand, or load the example data to see how it works.</p></div>`;
      return;
    }
    const rows = state.campaigns.map((c) => {
      const m = C.computeMetrics(c);
      const t = C.classifyTargeting(c, state.settings);
      const miss = gapsFor(c);
      const checked = state.selected.has(c.id);
      const disabled = !checked && state.selected.size >= MAX_COMPARE;
      const parent = c.level === 'adset' ? `in ${c.campaignName || 'campaign'}` : c.level === 'ad' ? `${c.adsetName || ''}${c.campaignName ? ' · ' + c.campaignName : ''}` : '';
      const status = c.status ? `<span class="status-chip ${c.status === 'ACTIVE' ? 'on' : ''}">${c.status === 'ACTIVE' ? 'Active' : esc(String(c.status).toLowerCase().replace(/_/g, ' '))}</span>` : '';
      const thumb = c.thumbnailUrl ? `<img class="thumb" src="${esc(c.thumbnailUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
      return `<tr>
        <td class="sel"><input type="checkbox" id="sel-${esc(c.id)}" data-select="${esc(c.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="Compare ${esc(c.name)}"></td>
        <th scope="row" class="cname"><div class="cn-row">${thumb}<div><span class="dot s${checked ? colorSlot(c.id) : 0}" aria-hidden="true"></span>${esc(c.name)}${status}<span class="sub">${parent ? esc(parent) + ' · ' : ''}${esc(c.platform || 'Other')} · ${esc(objLabel(c.objective))}${m.days ? ' · ' + m.days + ' days' : ''}</span></div></div></th>
        <td><span class="chip t-${t.type}" title="${esc(t.reason)}">${esc(tLabel(t.type))}</span></td>
        <td>${funnelChips(c)}</td>
        <td class="num">${money(m.spend)}</td>
        <td class="num">${C.fmtInt(m.leads)}</td>
        <td class="num">${money(m.cpl)}</td>
        <td class="num">${C.fmtPct(m.qualifiedPct)}</td>
        <td class="act">${miss.length ? `<button class="btn small warn" data-edit="${esc(c.id)}">Fill ${miss.length} gap${miss.length === 1 ? '' : 's'}</button>` : `<button class="btn small ghost" data-edit="${esc(c.id)}">Edit</button>`}</td>
      </tr>`;
    }).join('');
    host.innerHTML = `<div class="table-wrap"><table class="ctable">
      <thead><tr><th class="sel"><span class="sr">Compare</span></th><th>Campaign</th><th>Targeting</th><th>Funnel</th><th class="num">Spend</th><th class="num">Leads</th><th class="num">CPL</th><th class="num">Qualified</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="hint">${state.source === 'meta' && state.meta.range ? `Showing ${LEVEL_LABELS[state.meta.level].toLowerCase()} that spent between ${fmtDay(state.meta.range.since)} and ${fmtDay(state.meta.range.until)}, biggest first. ` : ''}Tick up to ${MAX_COMPARE}, then open <b>Compare</b>. Funnel chips: <span class="lv aim">L4</span> aimed at, <span class="lv data">L3</span> has data only.</p>`;
  }

  // ---------- Editor ----------
  const GROUPS = [
    { title: 'Basics', keys: ['name', 'platform', 'objective'] },
    { title: 'Budget and dates', keys: ['budget', 'spend', 'startDate', 'endDate'] },
    { title: 'Awareness · L1–L2', keys: ['impressions', 'reach', 'frequency'] },
    { title: 'Engagement · L3', keys: ['clicks', 'views'] },
    { title: 'Leads · L4', keys: ['landingPageViews', 'leads', 'qualifiedLeads'] },
    { title: 'Conversions · L5', keys: ['conversions', 'conversionValue'] },
    { title: 'Audience', keys: ['universe', 'targeting', 'targetingNotes'] },
  ];
  const HELP = {
    universe: 'Estimated audience size shown in Ads Manager when you set up targeting.',
    qualifiedLeads: 'From your CRM: leads your team judged worth following up.',
    budget: 'The budget you planned for the whole run.',
    targeting: 'Leave on Auto to classify from universe size and notes.',
    targetingNotes: 'e.g. "Advantage+", "Interests: yoga", "1% lookalike".',
    frequency: 'Leave blank to calculate it from impressions ÷ reach.',
  };

  function openEditor(id) {
    const isNew = !id;
    const c = isNew ? C.normaliseCampaign({ name: '', objective: 'leads', platform: 'Meta' }) : state.campaigns.find((x) => x.id === id);
    if (!c) return;
    state.editingId = c.id;
    const miss = new Set(gapsFor(c));
    const fromMeta = c.source === 'meta';
    const field = (k) => {
      const f = C.FIELDS.find((x) => x.key === k);
      const v = c[k] ?? '';
      const flag = miss.has(k) ? ' missing' : '';
      const help = HELP[k] ? `<span class="help">${esc(HELP[k])}</span>` : '';
      let input;
      if (f.type === 'select') {
        const opts = f.options.map((o) => {
          const lab = k === 'objective' ? objLabel(o) : k === 'targeting' ? (o === 'auto' ? 'Auto' : tLabel(o)) : o;
          return `<option value="${o}" ${String(v) === o ? 'selected' : ''}>${esc(lab)}</option>`;
        });
        if (k === 'objective') opts.unshift(`<option value="" ${!v ? 'selected' : ''}>Not set</option>`);
        input = `<select id="f-${k}" name="${k}" ${fromMeta && !META_EDITABLE.has(k) ? 'disabled' : ''}>${opts.join('')}</select>`;
      } else {
        const type = f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'number';
        const step = f.type === 'num' ? '0.01' : f.type === 'money' ? '0.01' : '1';
        input = `<input id="f-${k}" name="${k}" type="${type}" ${type === 'number' ? `min="0" step="${step}" inputmode="decimal"` : ''} value="${esc(v)}" ${k === 'name' ? 'required' : ''} ${fromMeta && !META_EDITABLE.has(k) ? 'disabled' : ''}>`;
      }
      if (fromMeta && !META_EDITABLE.has(k)) return `<label class="field" for="f-${k}"><span class="flabel">${esc(f.label)} <span class="muted">· from Meta</span></span>${input}</label>`;
      return `<label class="field${flag}" for="f-${k}"><span class="flabel">${esc(f.label)}${miss.has(k) ? '<span class="need">needed</span>' : ''}</span>${input}${help}</label>`;
    };
    const lvAim = C.targetLevels(c);
    $('#editor-body').innerHTML = `
      ${fromMeta ? '<p class="note">Numbers from Meta are locked and refresh on every sync. Fill in what Meta can\'t know (qualified leads from your CRM) or correct the audience size, budget and targeting. Your entries are kept across syncs.</p>' : ''}
      ${miss.size ? `<p class="note">Fields marked <span class="need">needed</span> are blank or zero. Fill what you know; the analysis skips what stays empty.</p>` : ''}
      ${GROUPS.map((g) => `<fieldset><legend>${g.title}</legend><div class="fgrid">${g.keys.map(field).join('')}</div></fieldset>`).join('')}
      <fieldset><legend>Funnel levels this campaign aims at</legend>
        <p class="help">Set by the objective. Tick levels to override, e.g. a lead campaign that also aims for awareness.</p>
        <div class="lv-picks">${C.FUNNEL_LEVELS.map((l) => `<label class="lv-pick"><input type="checkbox" name="levels" value="${l.level}" ${lvAim.includes(l.level) ? 'checked' : ''}> L${l.level} · ${esc(l.stage)}: ${esc(l.name)}</label>`).join('')}</div>
      </fieldset>`;
    $('#editor-title').textContent = isNew ? 'Add a campaign' : `Edit: ${c.name}`;
    $('#editor-delete').hidden = isNew || fromMeta;
    $('#editor').dataset.isNew = isNew ? '1' : '';
    $('#editor')._draft = c;
    $('#editor').showModal();
  }

  async function saveMetaEditor(dlg) {
    const c = dlg._draft;
    const auto = c.autoValues || {};
    const body = {};
    for (const k of META_EDITABLE) {
      const el = $('#f-' + k);
      if (!el) continue;
      const raw = el.value.trim();
      const f = C.FIELDS.find((x) => x.key === k);
      let v = raw === '' ? null : ['int', 'num', 'money'].includes(f.type) ? Number(raw) : raw;
      // Unchanged from what Meta reported: store no override.
      if (v !== null && auto[k] !== undefined && String(v) === String(auto[k])) v = null;
      if (k === 'targeting' && v === 'auto') v = null;
      body[k] = v;
    }
    const picked = $$('input[name="levels"]:checked', dlg).map((x) => Number(x.value));
    const objDefault = c.objective && C.OBJECTIVES[c.objective] ? C.OBJECTIVES[c.objective].levels : [];
    body.levels = picked.length && picked.join() !== objDefault.join() ? picked : null;
    try {
      await api('PUT', `/api/entities/${encodeURIComponent(c.id)}/manual`, body);
      dlg.close();
      await loadEntities();
    } catch (err) {
      $('#editor-body').insertAdjacentHTML('afterbegin', `<p class="notices" role="alert" style="padding-left:14px">${esc(err.message)}</p>`);
    }
  }

  function saveEditor(e) {
    e.preventDefault();
    const dlg = $('#editor');
    if (dlg._draft && dlg._draft.source === 'meta') return saveMetaEditor(dlg);
    const c = { ...dlg._draft };
    for (const f of C.FIELDS) {
      const el = $('#f-' + f.key);
      if (!el) continue;
      const raw = el.value.trim();
      if (['int', 'num', 'money'].includes(f.type)) c[f.key] = raw === '' ? undefined : Number(raw);
      else c[f.key] = raw === '' ? undefined : raw;
    }
    if (!c.name) c.name = 'Untitled campaign';
    const picked = $$('input[name="levels"]:checked', dlg).map((x) => Number(x.value));
    const objDefault = c.objective && C.OBJECTIVES[c.objective] ? C.OBJECTIVES[c.objective].levels : [];
    c.levels = picked.length && picked.join() !== objDefault.join() ? picked : undefined;
    if (dlg.dataset.isNew) {
      if (state.isExample) { state.campaigns = []; state.selected.clear(); state.isExample = false; }
      state.campaigns.push(c);
      if (state.selected.size < MAX_COMPARE) state.selected.add(c.id);
    } else {
      state.campaigns = state.campaigns.map((x) => (x.id === c.id ? c : x));
    }
    dlg.close();
    save();
    render();
  }

  // ---------- Compare ----------
  function bar(key, rank, items, maxVal) {
    const def = C.METRIC_DEFS[key];
    return items.map((it) => {
      const v = rank.values[it.c.id];
      const w = C.isNum(v) && maxVal > 0 ? Math.max(2, (v / maxVal) * 100) : 0;
      const best = rank.best === it.c.id, worst = rank.worst === it.c.id && rank.best !== rank.worst;
      const tag = best ? '<span class="tag good">Best</span>' : worst ? '<span class="tag bad">Weakest</span>' : '';
      return `<div class="bar-row">
        <span class="bar-name"><span class="dot s${colorSlot(it.c.id)}" aria-hidden="true"></span>${esc(it.c.name)}</span>
        <span class="bar-track">${C.isNum(v) ? `<span class="bar s${colorSlot(it.c.id)}" style="width:${w.toFixed(1)}%"></span>` : `<button class="btn tiny warn" data-edit="${esc(it.c.id)}">Add data</button>`}</span>
        <span class="bar-val">${C.isNum(v) ? esc(C.formatMetric(key, v, state.settings.currency)) : '—'}${tag}</span>
      </div>`;
    }).join('');
  }

  function renderCompare() {
    const host = $('#compare-body');
    const list = selectedCampaigns();
    if (list.length < 2) {
      host.innerHTML = `<div class="empty"><p class="empty-title">Pick at least two campaigns</p><p>Go to <b>Campaigns</b> and tick 2 to ${MAX_COMPARE} of them. ${list.length === 1 ? 'You have one ticked.' : ''}</p><button class="btn" data-tab-go="campaigns">Go to campaigns</button></div>`;
      return;
    }
    const r = C.compare(list, state.settings);
    state.lastResult = r;
    const byId = Object.fromEntries(r.items.map((it) => [it.c.id, it]));
    const leader = byId[r.ranking[0]];

    const notices = [];
    if (r.mixedObjectives) notices.push(`These campaigns have different objectives, so they were aiming at different funnel levels. Costs are compared on <b>${esc(objLabel(r.objective))}</b> terms; read the funnel section before calling a winner.`);
    for (const s of r.significance) {
      if (C.isNum(s.p) && s.p > 0.05) notices.push(`The gap in ${esc(C.METRIC_DEFS[s.key].label.toLowerCase())} between ${esc(byId[s.best].c.name)} and ${esc(byId[s.worst].c.name)} could be chance (p = ${s.p.toFixed(2)}). Run longer before acting on it.`);
    }
    const missingCount = r.items.reduce((n, it) => n + gapsFor(it.c).length, 0);
    if (missingCount && !state.viewer) notices.push(`${missingCount} input${missingCount === 1 ? ' is' : 's are'} missing across these campaigns. Use the <b>Add data</b> buttons to fill them; results update straight away.`);

    const rankingHtml = r.ranking.map((id, i) => {
      const it = byId[id];
      return `<li><span class="rank">${i + 1}</span><span class="dot s${colorSlot(id)}" aria-hidden="true"></span><span class="rname">${esc(it.c.name)}</span><span class="chip t-${it.targeting.type}">${esc(tLabel(it.targeting.type))}</span><span class="score">${r.scores[id] > 0 ? '+' : ''}${r.scores[id].toFixed(1)}</span></li>`;
    }).join('');

    const tiersHtml = r.tiers.map((t) => {
      const blocks = t.ranks.map((rk) => {
        const vals = Object.values(rk.values).filter(C.isNum);
        if (!vals.length) return '';
        const max = Math.max(...vals);
        return `<div class="metric"><h4>${esc(C.METRIC_DEFS[rk.key].label)}</h4>${bar(rk.key, rk, r.items, max)}</div>`;
      }).join('');
      return `<section class="tier" aria-labelledby="tier-${t.tier}"><header><span class="tier-n">Step ${t.tier}</span><h3 id="tier-${t.tier}">${esc(t.title)}</h3><p>${esc(t.why)}</p></header><div class="metrics">${blocks || '<p class="muted">No data for this step yet.</p>'}</div></section>`;
    }).join('');

    const funnelRows = C.FUNNEL_LEVELS.map((l) => {
      const cells = r.items.map((it) => {
        const aim = it.levels.includes(l.level), has = it.dataLevels.includes(l.level);
        const kpi = l.kpis.map((k) => (C.isNum(it.m[k]) && C.METRIC_DEFS[k] ? `${C.METRIC_DEFS[k].label.replace(/ \(.*\)/, '')}: ${C.formatMetric(k, it.m[k], state.settings.currency)}` : C.isNum(it.m[k]) ? `${fieldLabel(k)}: ${C.fmtInt(it.m[k])}` : null)).filter(Boolean).slice(0, 2).join('<br>');
        return `<td class="${aim ? 'f-aim' : has ? 'f-data' : 'f-none'}"><span class="f-state">${aim ? 'Aimed at' : has ? 'Side effect' : '—'}</span>${kpi ? `<span class="f-kpi">${kpi}</span>` : ''}</td>`;
      }).join('');
      return `<tr><th scope="row"><span class="lvl">L${l.level}</span> ${esc(l.stage)}<span class="sub">${esc(l.name)}</span></th>${cells}</tr>`;
    }).join('');

    const swHtml = r.items.map((it) => {
      const ins = r.insights[it.c.id];
      const imp = r.recommendations.improve[it.c.id];
      return `<article class="sw"><h4><span class="dot s${colorSlot(it.c.id)}" aria-hidden="true"></span>${esc(it.c.name)}</h4>
        <p class="tline"><span class="chip t-${it.targeting.type}">${esc(tLabel(it.targeting.type))} targeting</span> ${esc(it.targeting.reason)}</p>
        <div class="sw-cols"><div><h5 class="good-t">Strengths</h5><ul>${ins.strengths.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">None stand out yet.</li>'}</ul></div>
        <div><h5 class="bad-t">Weaknesses</h5><ul>${ins.weaknesses.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">None found.</li>'}</ul></div></div>
        <h5>How to improve it</h5><ol>${imp.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></article>`;
    }).join('');

    const chartW = Math.max(300, Math.min(1000, host.clientWidth - 38));
    const charts = window.CampaignCharts ? CampaignCharts.buildCharts(r, { C, cur: state.settings.currency, width: chartW, slot: colorSlot, trendMetric: state.trendMetric }) : [];
    const trendLabels = window.CampaignCharts ? CampaignCharts.TREND_METRICS : {};
    const legend = r.items.map((it) => `<li><span class="dot s${colorSlot(it.c.id)}" aria-hidden="true"></span>${esc(it.c.name)}</li>`).join('');
    const chartsHtml = charts.length ? `<section class="block charts" aria-labelledby="charts-h">
        <div class="charts-head"><div><h3 id="charts-h">Charts</h3><p class="muted">In the same order as the comparison. Hover or tab onto a mark for exact numbers; every chart also opens as a table.</p></div><ul class="legend" aria-label="Campaign colours">${legend}</ul></div>
        ${charts.map((ch) => `<figure class="chart" id="chart-${ch.id}"><figcaption><span class="eyebrow">${esc(ch.step)}</span><h4>${esc(ch.title)}</h4><p class="muted">${esc(ch.sub)}</p>${ch.key ? CampaignCharts.keyHtml(ch.key, CampaignCharts.PAL_APP) : ''}${ch.metrics ? `<div class="seg trend-switch" role="group" aria-label="Measure">${ch.metrics.map((k) => `<button data-trend="${k}" aria-pressed="${k === ch.metric}">${esc(trendLabels[k].label)}</button>`).join('')}</div>` : ''}</figcaption>
          ${ch.svg ? `<div class="chart-box">${ch.svg}</div><p class="chart-note">${esc(ch.note)}</p><details class="chart-data"><summary>Show as table</summary><div class="table-wrap">${ch.table}</div></details>` : `<p class="chart-empty">${esc(ch.empty)}</p>`}</figure>`).join('')}
      </section>` : '';

    host.innerHTML = `
      <section class="summary">
        <div class="lead-card"><p class="eyebrow">Leading campaign</p><p class="lead-name"><span class="dot s${colorSlot(leader.c.id)}" aria-hidden="true"></span>${esc(leader.c.name)}</p>
          <p class="muted">Scored on ${esc(objLabel(r.objective))} terms: cost and budget count most, then audience and lead quality, then duration.</p>
          <dl class="kv"><div><dt>CPL</dt><dd>${money(leader.m.cpl)}</dd></div><div><dt>Qualified</dt><dd>${C.fmtPct(leader.m.qualifiedPct)}</dd></div><div><dt>Cost per qualified lead</dt><dd>${money(leader.m.cpql)}</dd></div></dl></div>
        <div class="ranking"><p class="eyebrow">Overall ranking</p><ol>${rankingHtml}</ol><p class="hint">Score: points for leading a metric, weighted by step (3, 2, 1, 0.5); half a step lost for coming last.</p></div>
      </section>
      ${notices.length ? `<ul class="notices">${notices.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
      <div class="dl-row"><span>Download this comparison:</span><button class="btn" data-dl="html">Report (HTML)</button><button class="btn ghost" data-dl="csv">Data (CSV)</button><button class="btn ghost" data-dl="xlsx">Workbook (XLSX)</button><span id="dl-status" role="status"></span>
        ${state.server && state.meta.me && !state.viewer ? `<span class="owner-only" style="display:contents">${state.source === 'meta' ? '<button class="btn ghost" data-act="save-cmp">Save comparison</button>' : ''}<button class="btn ghost" data-act="share">Share link</button></span>
        <form class="inline-form owner-only" id="save-cmp-row" hidden><label class="sr" for="save-cmp-name">Name</label><input id="save-cmp-name" maxlength="120" placeholder="e.g. Lead forms vs lookalike" required><button class="btn small" type="submit">Save</button><button class="btn ghost small" type="button" data-act="save-cmp-cancel">Cancel</button></form>
        <div class="share-out owner-only" id="share-out" hidden></div>` : ''}</div>
      ${chartsHtml}
      ${tiersHtml}
      <section class="block"><h3>Marketing funnel</h3><p class="muted">Each campaign is judged on the levels it aimed at. "Side effect" means it has numbers there without aiming for them.</p>
        <div class="table-wrap"><table class="funnel"><thead><tr><th>Level</th>${r.items.map((it) => `<th><span class="dot s${colorSlot(it.c.id)}" aria-hidden="true"></span>${esc(it.c.name)}</th>`).join('')}</tr></thead><tbody>${funnelRows}</tbody></table></div></section>
      <section class="block two"><div><h3>What they have in common</h3><ul>${r.commonality.common.map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">Nothing shared.</li>'}</ul></div>
        <div><h3>Where they differ</h3><ul>${r.commonality.different.map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">Very similar.</li>'}</ul></div></section>
      <section class="block"><h3>Strengths, weaknesses and fixes</h3><div class="sw-grid">${swHtml}</div></section>
      <section class="block"><h3>Plan for a new campaign</h3><p class="muted">Built from what worked best above.</p><ol class="plan">${r.recommendations.newCampaign.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        ${r.recommendations.reallocation ? `<p class="whatif"><b>What if you move budget?</b> ${esc(r.recommendations.reallocation.text)}</p>` : ''}</section>`;
  }

  // ---------- Downloads ----------
  function reportHtml(r) {
    const cur = state.settings.currency;
    const row = (k) => `<tr><th>${esc(C.METRIC_DEFS[k].label)}</th>${r.items.map((it) => `<td>${esc(C.formatMetric(k, it.m[k], cur))}</td>`).join('')}</tr>`;
    const tierTables = r.tiers.map((t) => `<h2>Step ${t.tier}: ${esc(t.title)}</h2><p>${esc(t.why)}</p><table><thead><tr><th>Metric</th>${r.items.map((it) => `<th>${esc(it.c.name)}</th>`).join('')}</tr></thead><tbody>${t.metrics.map(row).join('')}</tbody></table>`).join('');
    const per = r.items.map((it) => `<h3>${esc(it.c.name)}</h3><p><b>Targeting:</b> ${esc(tLabel(it.targeting.type))}. ${esc(it.targeting.reason)} <b>Funnel:</b> aims at ${it.levels.map((l) => 'L' + l).join(', ') || 'not set'}.</p><p><b>Strengths</b></p><ul>${r.insights[it.c.id].strengths.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>None stand out.</li>'}</ul><p><b>Weaknesses</b></p><ul>${r.insights[it.c.id].weaknesses.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>None found.</li>'}</ul><p><b>How to improve</b></p><ol>${r.recommendations.improve[it.c.id].map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`).join('');
    const date = new Date().toISOString().slice(0, 10);
    const slotOf = (id) => r.items.findIndex((it) => it.c.id === id) + 1;
    const pc = window.CampaignCharts ? CampaignCharts.buildCharts(r, { C, cur, width: 880, slot: slotOf, print: true }) : [];
    const swatch = (id) => `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;background:${CampaignCharts.PAL_PRINT.s[slotOf(id)]}"></span>`;
    const chartsHtml = pc.length ? `<h2>Charts</h2><p class="legend">${r.items.map((it) => `<span>${swatch(it.c.id)}${esc(it.c.name)}</span>`).join('')}</p>` + pc.map((ch) => `<figure><p class="muted">${esc(ch.step)}</p><h3>${esc(ch.title)}</h3>${ch.key ? CampaignCharts.keyHtml(ch.key, CampaignCharts.PAL_PRINT) : ''}${ch.svg ? ch.svg + `<p>${esc(ch.note)}</p>` : `<p class="muted">${esc(ch.empty)}</p>`}</figure>`).join('') : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Campaign comparison ${date}</title><style>
      body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#16202c;max-width:960px;margin:32px auto;padding:0 20px}
      h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px;border-bottom:1px solid #d9dee6;padding-bottom:4px}h3{font-size:16px;margin:20px 0 4px}
      table{border-collapse:collapse;width:100%;margin:8px 0 12px;font-variant-numeric:tabular-nums}th,td{border:1px solid #d9dee6;padding:6px 8px;text-align:left;vertical-align:top}thead th{background:#eef1f5}
      .muted{color:#5b6675}figure{margin:16px 0 24px;break-inside:avoid}figure h3{margin:0 0 6px}figure .muted{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.06em}svg{max-width:100%;height:auto;display:block;margin:8px 0}.legend span,.chart-key span{display:inline-flex;align-items:center;gap:4px;margin-right:16px;font-size:13px}.chart-key{display:block;margin:4px 0}@media print{body{margin:0}h2{break-after:avoid}table{break-inside:avoid}}</style></head><body>
      <h1>Campaign comparison</h1><p class="muted">Generated ${date} with Campaign Analyser. Currency: ${esc(cur)}. Objective basis: ${esc(objLabel(r.objective))}.</p>
      <h2>Overall ranking</h2><ol>${r.ranking.map((id) => { const it = r.items.find((x) => x.c.id === id); return `<li>${esc(it.c.name)} (score ${r.scores[id].toFixed(1)})</li>`; }).join('')}</ol>
      ${chartsHtml}
      ${tierTables}
      <h2>Marketing funnel</h2><table><thead><tr><th>Level</th>${r.items.map((it) => `<th>${esc(it.c.name)}</th>`).join('')}</tr></thead><tbody>${C.FUNNEL_LEVELS.map((l) => `<tr><th>L${l.level} ${esc(l.stage)}: ${esc(l.name)}</th>${r.items.map((it) => `<td>${it.levels.includes(l.level) ? 'Aimed at' : it.dataLevels.includes(l.level) ? 'Side effect' : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <h2>Common ground and differences</h2><p><b>In common</b></p><ul>${r.commonality.common.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>Nothing shared.</li>'}</ul><p><b>Different</b></p><ul>${r.commonality.different.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h2>Campaign by campaign</h2>${per}
      <h2>Plan for a new campaign</h2><ol>${r.recommendations.newCampaign.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${r.recommendations.reallocation ? `<p>${esc(r.recommendations.reallocation.text)}</p>` : ''}
      <p class="muted">To save as PDF: open this file in a browser and use Print → Save as PDF.</p></body></html>`;
  }

  async function offerFile(filename, data, mime) {
    const status = $('#dl-status');
    status.textContent = '';
    try {
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (dl) {
        await dl.save({ filename, data });
        status.textContent = 'Saved.';
        return;
      }
    } catch (e) {
      if (e && e.code === 'declined') { status.textContent = 'Download cancelled.'; return; }
      if (e && e.code && !['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e.code)) { status.textContent = `Could not save (${e.code}).`; return; }
    }
    // Opened as a local file or on GitHub Pages: a normal browser download.
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    status.textContent = 'Download started.';
  }

  function download(kind) {
    const r = state.lastResult;
    if (!r) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'html') offerFile(`campaign-report-${stamp}.html`, reportHtml(r), 'text/html');
    if (kind === 'csv') offerFile(`campaign-comparison-${stamp}.csv`, C.toCsv(r), 'text/csv');
    if (kind === 'xlsx' && typeof XLSX === 'undefined') { $('#dl-status').textContent = 'The Excel writer did not load. Use CSV instead.'; return; }
    if (kind === 'xlsx') {
      const aoa = C.toRows(r);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Comparison');
      const insights = [['Campaign', 'Type', 'Text']];
      r.items.forEach((it) => {
        r.insights[it.c.id].strengths.forEach((s) => insights.push([it.c.name, 'Strength', s]));
        r.insights[it.c.id].weaknesses.forEach((s) => insights.push([it.c.name, 'Weakness', s]));
        r.recommendations.improve[it.c.id].forEach((s) => insights.push([it.c.name, 'Improve', s]));
      });
      r.recommendations.newCampaign.forEach((s) => insights.push(['New campaign', 'Plan', s]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(insights), 'Insights');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      offerFile(`campaign-comparison-${stamp}.xlsx`, new Blob([buf]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  }

  // ---------- Settings ----------
  function openSettings() {
    const s = state.settings;
    $('#s-currency').value = s.currency;
    $('#s-targetCpl').value = s.targetCpl ?? '';
    $('#s-targetQ').value = Math.round((s.targetQualifiedPct ?? 0.3) * 100);
    $('#s-open').value = s.openUniverseMin;
    $('#s-focused').value = s.focusedUniverseMax;
    $('#settings').showModal();
  }
  function saveSettings(e) {
    e.preventDefault();
    const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
    state.settings = {
      ...state.settings,
      currency: $('#s-currency').value,
      targetCpl: num('#s-targetCpl'),
      targetQualifiedPct: (num('#s-targetQ') ?? 30) / 100,
      openUniverseMin: num('#s-open') ?? C.DEFAULT_SETTINGS.openUniverseMin,
      focusedUniverseMax: num('#s-focused') ?? C.DEFAULT_SETTINGS.focusedUniverseMax,
    };
    $('#settings').close();
    save();
    render();
  }

  // ---------- Meta connection (only when the app is served by the Node server) ----------
  const LEVEL_LABELS = { campaign: 'Campaigns', adset: 'Ad sets', ad: 'Ads' };
  const PRESETS = [['last7', 'Last 7 days'], ['last14', 'Last 14 days'], ['last30', 'Last 30 days'], ['last90', 'Last 90 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom dates']];
  const META_EDITABLE = new Set(['qualifiedLeads', 'universe', 'budget', 'targeting', 'targetingNotes', 'objective']);
  const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  function presetRange(preset, since, until) {
    const today = new Date();
    const back = (n) => isoDay(new Date(today.getTime() - n * 86400000));
    switch (preset) {
      case 'last7': return { since: back(6), until: back(0) };
      case 'last14': return { since: back(13), until: back(0) };
      case 'last90': return { since: back(89), until: back(0) };
      case 'this_month': return { since: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), until: back(0) };
      case 'last_month': return { since: isoDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)), until: isoDay(new Date(today.getFullYear(), today.getMonth(), 0)) };
      case 'custom': if (since && until && since <= until) return { since, until }; // falls through
      default: return { since: back(29), until: back(0) };
    }
  }
  function ago(ms) {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  const fmtDay = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

  async function api(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && state.meta.me) headers['x-csrf-token'] = state.meta.me.csrf;
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/me') state.meta.me = null;
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  async function detectServer() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const h = await fetch('/api/health', { headers: { accept: 'application/json' } });
      if (!h.ok) return;
      const j = await h.json();
      if (!j || !j.ok) return;
      state.server = j;
    } catch (e) { return; }
    try { state.meta.me = await api('GET', '/api/me'); } catch (e) { state.meta.me = null; }
    if (state.meta.me) await refreshAccounts();
  }

  async function refreshAccounts() {
    const [a, c] = await Promise.all([api('GET', '/api/accounts'), api('GET', '/api/comparisons')]);
    state.meta.accounts = a.accounts;
    state.meta.comparisons = c.comparisons;
    if (!state.meta.accounts.some((x) => x.id === state.meta.accountId)) state.meta.accountId = (state.meta.accounts.find((x) => x.selected) || state.meta.accounts[0] || {}).id || null;
  }
  const currentAccount = () => state.meta.accounts.find((a) => a.id === state.meta.accountId) || null;

  function switchSource(to) {
    if (to === state.source) return;
    if (to === 'meta') {
      state.fileStash = { campaigns: state.campaigns, selected: [...state.selected], isExample: state.isExample, warnings: state.warnings };
      state.campaigns = state.meta.items || [];
      state.selected = new Set(state.meta.selectedIds || []);
      state.isExample = false;
      state.warnings = [];
      state.source = 'meta';
      if (state.meta.me && state.meta.accountId && !state.meta.items) loadEntities();
    } else {
      state.meta.items = state.campaigns;
      state.meta.selectedIds = [...state.selected];
      const f = state.fileStash || { campaigns: [], selected: [] };
      state.campaigns = f.campaigns; state.selected = new Set(f.selected); state.isExample = !!f.isExample; state.warnings = f.warnings || [];
      state.fileStash = null;
      state.source = 'files';
    }
    save();
    render();
  }

  // Pick the biggest spenders that share the top spender's objective, so the first comparison makes sense.
  function autoSelect(items) {
    if (!items.length) return [];
    const obj = items[0].objective;
    return items.filter((c) => c.objective === obj).slice(0, 3).map((c) => c.id);
  }

  async function loadEntities({ keepSelection = true } = {}) {
    const acct = currentAccount();
    if (!acct) return;
    if (!acct.lastSyncedAt) {
      if (acct.syncState !== 'running') return startMetaSync();
      return pollSync();
    }
    const { since, until } = presetRange(state.meta.preset, state.meta.since, state.meta.until);
    state.meta.loading = true; state.meta.error = null; renderSource();
    try {
      const d = await api('GET', `/api/accounts/${acct.id}/entities?level=${state.meta.level}&since=${since}&until=${until}`);
      state.meta.range = { since: d.since, until: d.until };
      Object.assign(acct, d.account);
      const items = d.campaigns.map(C.normaliseCampaign);
      state.meta.items = items;
      if (state.source === 'meta') {
        state.campaigns = items;
        const keep = keepSelection ? [...state.selected].filter((id) => items.some((c) => c.id === id)) : [];
        state.selected = new Set(keep.length >= 2 ? keep : (state.meta.pendingSelection || autoSelect(items)).filter((id) => items.some((c) => c.id === id)));
        state.meta.pendingSelection = null;
      }
      if (d.currency) state.settings.currency = d.currency;
    } catch (e) {
      state.meta.error = e.message;
    } finally {
      state.meta.loading = false;
      save();
      render();
    }
  }

  // A sync runs in steps (hosted functions are time-limited). Keep calling while
  // the server says 'partial', and show progress from a light poll meanwhile.
  let syncing = false;
  async function startMetaSync() {
    const acct = currentAccount();
    if (!acct || syncing) return;
    syncing = true;
    acct.syncState = 'running';
    acct.syncProgress = 'Starting';
    renderSource();
    const poll = setInterval(async () => {
      try { const d = await api('GET', `/api/accounts/${acct.id}`); if (d.account.syncState === 'running') { Object.assign(acct, d.account); renderSource(); } } catch (e) { /* ignore */ }
    }, 2000);
    try {
      for (let step = 0; step < 50; step++) {
        const d = await api('POST', `/api/accounts/${acct.id}/sync`, {});
        Object.assign(acct, d.account);
        renderSource();
        if (acct.syncState !== 'partial') break;
      }
    } catch (e) {
      state.meta.error = e.message;
      if (e.data && e.data.reconnect && state.meta.me) state.meta.me.connection.status = 'reconnect';
    } finally {
      clearInterval(poll);
      syncing = false;
    }
    if (acct.syncState === 'running') pollSync(); // another tab or the daily job is syncing
    else await loadEntities();
  }

  let pollTimer = null;
  function pollSync() {
    clearTimeout(pollTimer);
    const acct = currentAccount();
    if (!acct) return;
    if (acct.syncState === 'partial' && !syncing) { startMetaSync(); return; } // finish an interrupted sync
    if (acct.syncState !== 'running') return;
    pollTimer = setTimeout(async () => {
      try {
        const d = await api('GET', `/api/accounts/${acct.id}`);
        Object.assign(acct, d.account);
      } catch (e) { /* keep polling */ }
      if (acct.syncState === 'running' || acct.syncState === 'partial') { renderSource(); pollSync(); }
      else loadEntities();
    }, 2000);
  }

  async function setAutoSync(on) {
    const acct = currentAccount();
    if (!acct) return;
    try {
      const d = await api('PUT', `/api/accounts/${acct.id}/settings`, { autoSync: on });
      Object.assign(acct, d.account);
    } catch (e) { state.meta.error = e.message; }
    renderSource();
  }

  function syncStatusHtml(acct) {
    if (!acct) return '';
    if (acct.syncState === 'running' || acct.syncState === 'partial') return `<span class="sync-status" role="status"><span class="spinner" aria-hidden="true"></span>${esc(acct.syncProgress || 'Syncing')}…</span>`;
    if (state.meta.loading) return `<span class="sync-status" role="status"><span class="spinner" aria-hidden="true"></span>Loading…</span>`;
    if (acct.syncState === 'error' || acct.syncState === 'reconnect') return `<span class="sync-status err" role="status">${esc(acct.syncError || 'Sync failed')}</span>`;
    if (acct.syncState === 'waiting') return `<span class="sync-status" role="status">${esc(acct.syncError || 'Waiting for Meta')} Next try ${acct.nextAttemptAt ? new Date(acct.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'}.</span>`;
    const extra = acct.syncError ? ` · ${esc(acct.syncError)}` : '';
    return `<span class="sync-status" role="status">Synced ${ago(acct.lastSyncedAt)}${acct.syncedUntil ? ` · data to ${fmtDay(acct.syncedUntil)}` : ''}${extra}</span>`;
  }

  function connectCardHtml() {
    const modes = (state.server && state.server.loginModes) || ['oauth'];
    const demo = state.server && state.server.mode === 'demo';
    const reconnect = !!state.meta.me;
    const oauth = modes.includes('oauth') ? `<a class="btn fb" href="/auth/meta/start">Continue with Facebook</a>` : '';
    const token = modes.includes('token') ? `
      <form class="token-form" id="token-form" autocomplete="off">
        <label for="token-input"><b>${reconnect ? 'Paste a new access token' : 'Paste your access token'}</b></label>
        <div class="token-row"><input id="token-input" type="password" autocomplete="off" spellcheck="false" placeholder="EAA…" required><button class="btn" type="submit">Connect</button></div>
        <details class="token-help"><summary>How do I get a token?</summary>
          <ol>
            <li>Open your app on developers.facebook.com → <b>Marketing API</b> → <b>Tools</b>.</li>
            <li>Tick <b>ads_read</b> only, then click <b>Get Token</b> and copy it.</li>
            <li>Paste it here. It's checked against your app, swapped for a 60-day token and stored encrypted. Don't share it anywhere else.</li>
          </ol>
          ${demo ? '<p class="muted">Demo mode: paste <code>demo-short-token</code> to try it.</p>' : ''}
        </details>
        <p class="token-status" id="token-status" role="status"></p>
      </form>` : '';
    return `<div class="connect-card"><div><h2>${reconnect ? 'Reconnect Meta' : 'Connect your Meta ad account'}</h2>
      <p class="muted">Read-only access (<code>ads_read</code>): campaigns, ad sets, ads and daily results sync into the app. Nothing in your ad account is ever changed.</p>
      ${demo ? '<p class="demo-note">Demo mode: this connects to a <b>simulated</b> ad account with made-up data.</p>' : ''}
      ${token}</div>${oauth}${reconnect ? '<button class="btn ghost small" data-act="hide-connect">Cancel</button>' : ''}</div>`;
  }

  async function connectWithToken(e) {
    e.preventDefault();
    const input = $('#token-input');
    const status = $('#token-status');
    const token = input.value.trim();
    if (!token) return;
    status.textContent = 'Checking the token with Meta…';
    status.classList.remove('err');
    try {
      const res = await fetch('/auth/meta/token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ token }), credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      input.value = '';
      if (!res.ok) throw new Error(data.error || 'Could not connect.');
      location.replace('/#connected');
      location.reload();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('err');
    }
  }

  function renderSource() {
    const host = $('#source-bar');
    if (!host) return;
    $('#file-import').hidden = state.source === 'meta';
    if (!state.server) { host.innerHTML = ''; return; }
    const pressed = (v) => `aria-pressed="${state.source === v}"`;
    let html = `<div class="seg" role="group" aria-label="Data source"><button data-source="meta" ${pressed('meta')}>Meta ads</button><button data-source="files" ${pressed('files')}>Imported files</button></div>`;
    if (state.source === 'meta') {
      const me = state.meta.me;
      const err = state.meta.error ? `<p class="notices" role="alert" style="padding-left:14px">${esc(state.meta.error)}</p>` : '';
      if (!me || state.meta.showConnect) {
        html += connectCardHtml() + err;
      }
      if (me) {
        const acct = currentAccount();
        const conn = me.connection || {};
        let warn = '';
        if (conn.status === 'reconnect') warn = `<p class="notices" role="alert" style="padding-left:14px">Your Meta connection has expired or was removed. <button class="linkish" data-act="show-connect">Reconnect</button> to keep syncing.</p>`;
        else if (conn.daysLeft !== null && conn.daysLeft <= 7) warn = `<p class="notices" style="padding-left:14px">Meta connections last 60 days. Yours ends in ${Math.max(0, conn.daysLeft)} day${conn.daysLeft === 1 ? '' : 's'}: <button class="linkish" data-act="show-connect">reconnect now</button> to avoid a gap.</p>`;
        if (!state.meta.accounts.length) {
          html += `<div class="connect-card"><div><h2>No ad accounts found</h2><p class="muted">Signed in as ${esc(me.name)}, but this Facebook profile can't see any ad accounts. Ask the account owner to add you in Business Settings, then try again.</p></div><button class="btn" data-act="refresh-accounts">Check again</button></div>`;
        } else {
          const custom = state.meta.preset === 'custom';
          const r = presetRange(state.meta.preset, state.meta.since, state.meta.until);
          html += `<div class="meta-bar">
            <label class="grow" for="m-account">Ad account<select id="m-account">${state.meta.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === state.meta.accountId ? 'selected' : ''}>${esc(a.name || a.id)}${a.currency ? ' · ' + esc(a.currency) : ''}</option>`).join('')}</select></label>
            <label for="m-preset">Dates<select id="m-preset">${PRESETS.map(([v, l]) => `<option value="${v}" ${v === state.meta.preset ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            ${custom ? `<label for="m-since">From<input type="date" id="m-since" value="${esc(r.since)}"></label><label for="m-until">To<input type="date" id="m-until" value="${esc(r.until)}"></label>` : ''}
            <div><span class="sr">Level</span><div class="seg" role="group" aria-label="Level">${Object.entries(LEVEL_LABELS).map(([v, l]) => `<button data-level="${v}" aria-pressed="${state.meta.level === v}">${l}</button>`).join('')}</div></div>
            <button class="btn small" data-act="sync" ${acct && (acct.syncState === 'running' || acct.syncState === 'partial') ? 'disabled' : ''}>Sync now</button>
            ${acct ? `<label class="switch" for="m-autosync"><input type="checkbox" role="switch" id="m-autosync" ${acct.autoSync ? 'checked' : ''}><span>Auto-sync daily</span></label>` : ''}
            ${syncStatusHtml(acct)}
          </div>`;
        }
        const saved = state.meta.comparisons.length ? `<span class="saved" aria-label="Saved comparisons"><b>Saved:</b>${state.meta.comparisons.map((c) => `<span class="chip-btn"><button data-cmp="${esc(c.id)}" title="${esc(LEVEL_LABELS[c.level] || '')}, ${esc(PRESETS.find((p) => p[0] === c.preset)?.[1] || 'custom dates')}">${esc(c.name)}</button><button data-cmp-del="${esc(c.id)}" aria-label="Delete saved comparison ${esc(c.name)}">×</button></span>`).join('')}</span>` : '';
        html += `${warn}${err}<div class="meta-sub">${saved}<span class="spacer"></span><button class="linkish" data-act="shares">Shared links</button><span>Signed in as ${esc(me.name)}${state.server.mode === 'demo' ? ' (demo)' : ''}</span><button class="linkish" data-act="logout">Sign out</button><button class="linkish" data-act="delete-me">Delete my data</button></div>
          <div class="confirm" id="confirm-delete-me" hidden><span>Delete your Meta connection and every synced number, note and share link from this app? Your ad account itself is not touched.</span><button class="btn danger small" data-act="delete-me-yes">Delete everything</button><button class="btn ghost small" data-act="delete-me-no">Cancel</button></div>`;
      }
    }
    host.innerHTML = `<div class="source">${html}</div>`;
  }

  async function applySaved(id) {
    const c = state.meta.comparisons.find((x) => x.id === id);
    if (!c) return;
    if (c.accountId) state.meta.accountId = c.accountId;
    state.meta.level = c.level || 'campaign';
    state.meta.preset = c.preset || 'custom';
    state.meta.since = c.since; state.meta.until = c.until;
    state.meta.pendingSelection = c.entityIds;
    state.selected = new Set();
    await loadEntities({ keepSelection: false });
    state.tab = 'compare';
    render();
  }

  async function openShares() {
    const body = $('#shares-body');
    body.innerHTML = '<p class="muted">Loading…</p>';
    $('#shares-dlg').showModal();
    try {
      const { shares } = await api('GET', '/api/shares');
      body.innerHTML = shares.length ? `<ul class="share-list">${shares.map((s) => `<li><b>${esc(s.title)}</b>
        <span class="muted">${s.active ? `Expires ${new Date(s.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : s.revoked ? 'Revoked' : 'Expired'} · ${s.views} view${s.views === 1 ? '' : 's'}${s.lastViewedAt ? `, last ${ago(s.lastViewedAt)}` : ''}</span>
        ${s.active ? `<div class="row"><code>${esc(s.url)}</code><button class="btn tiny ghost" data-copy="${esc(s.url)}">Copy</button><button class="btn tiny danger" data-revoke="${esc(s.token)}">Revoke</button></div>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No shared links yet. Open a comparison and choose <b>Share link</b>.</p>';
    } catch (e) { body.innerHTML = `<p class="notices">${esc(e.message)}</p>`; }
  }

  function shareSnapshot() {
    const list = selectedCampaigns().map((c) => { const { autoValues, manualKeys, ...rest } = c; return rest; });
    const range = state.source === 'meta' ? state.meta.range : null;
    const single = { campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };
    const title = (state.source === 'meta' ? `${single[state.meta.level]} comparison` : 'Campaign comparison') + (range ? `, ${fmtDay(range.since)} – ${fmtDay(range.until)}` : '');
    return { title, campaigns: list, settings: state.settings, range };
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); } }
    catch (e) { const r = document.createRange(); const code = btn && btn.parentElement.querySelector('code'); if (code) { r.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(r); } }
  }

  async function handleMetaAction(t) {
    const act = t.dataset.act;
    if (act === 'sync') return startMetaSync();
    if (act === 'show-connect') { state.meta.showConnect = true; renderSource(); const i = $('#token-input'); if (i) i.focus(); return; }
    if (act === 'hide-connect') { state.meta.showConnect = false; renderSource(); return; }
    if (act === 'refresh-accounts') { await api('POST', '/api/accounts/refresh', {}).then((d) => { state.meta.accounts = d.accounts; }).catch((e) => { state.meta.error = e.message; }); return render(); }
    if (act === 'logout') { await api('POST', '/auth/logout', {}).catch(() => {}); state.meta = { ...state.meta, me: null, accounts: [], items: null, comparisons: [] }; state.campaigns = []; state.selected.clear(); return render(); }
    if (act === 'delete-me') { $('#confirm-delete-me').hidden = false; return; }
    if (act === 'delete-me-no') { $('#confirm-delete-me').hidden = true; return; }
    if (act === 'delete-me-yes') { await api('DELETE', '/api/me').catch((e) => { state.meta.error = e.message; }); state.meta = { ...state.meta, me: null, accounts: [], items: null, comparisons: [] }; state.campaigns = []; state.selected.clear(); return render(); }
    if (act === 'shares') return openShares();
    if (act === 'save-cmp') { $('#save-cmp-row').hidden = false; $('#save-cmp-name').focus(); return; }
    if (act === 'save-cmp-cancel') { $('#save-cmp-row').hidden = true; return; }
    if (act === 'share') {
      const out = $('#share-out');
      out.hidden = false;
      out.innerHTML = '<span class="muted">Creating link…</span>';
      try {
        const { share } = await api('POST', '/api/shares', shareSnapshot());
        const local = /\/\/(localhost|127\.0\.0\.1)/.test(share.url);
        out.innerHTML = `<span>Anyone with this link can view this comparison (read-only) until ${new Date(share.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. It's a snapshot: later syncs don't change it.</span>
          <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><code>${esc(share.url)}</code><button class="btn tiny" data-copy="${esc(share.url)}">Copy</button></div>
          ${local ? '<span class="muted">This app is running on your computer, so the link only opens here. It will work for others once the app is hosted online.</span>' : ''}`;
      } catch (e) { out.innerHTML = `<span class="notices">${esc(e.message)}</span>`; }
    }
  }

  async function saveComparison(e) {
    e.preventDefault();
    const name = $('#save-cmp-name').value.trim();
    if (!name) return;
    try {
      const r = presetRange(state.meta.preset, state.meta.since, state.meta.until);
      const { comparison } = await api('POST', '/api/comparisons', { name, accountId: state.meta.accountId, level: state.meta.level, preset: state.meta.preset, since: state.meta.preset === 'custom' ? r.since : null, until: state.meta.preset === 'custom' ? r.until : null, entityIds: [...state.selected] });
      state.meta.comparisons.unshift(comparison);
      $('#save-cmp-row').innerHTML = `<span class="muted">Saved as “${esc(comparison.name)}”. Find it on the Campaigns tab; it refreshes with new data.</span>`;
    } catch (err) { $('#save-cmp-row').insertAdjacentHTML('beforeend', `<span class="notices">${esc(err.message)}</span>`); }
  }

  async function fillUsage() {
    const box = $('#usage-box');
    if (!box) return;
    if (!state.meta.me) { box.hidden = true; return; }
    try {
      const u = await api('GET', '/api/usage');
      const t = u.thisMonth || {};
      box.innerHTML = `<b>Usage this month</b><span>${t.sync || 0} syncs · ${t.meta_api_calls || 0} Meta API calls · ${t.share_created || 0} share links · ${t.comparison_saved || 0} saved comparisons</span><span>${u.totals.adAccountsSynced} ad account${u.totals.adAccountsSynced === 1 ? '' : 's'} syncing · ${u.totals.activeShareLinks} active share link${u.totals.activeShareLinks === 1 ? '' : 's'}</span>`;
      box.hidden = false;
    } catch (e) { box.hidden = true; }
  }

  function startViewer(snap) {
    state.viewer = snap;
    state.campaigns = (snap.campaigns || []).map(C.normaliseCampaign);
    state.selected = new Set(state.campaigns.map((c) => c.id));
    state.settings = { ...C.DEFAULT_SETTINGS, ...(snap.settings || {}) };
    state.tab = 'compare';
    document.body.classList.add('viewer');
    const b = $('#viewer-banner');
    b.innerHTML = `<b>${esc(snap.title || 'Shared comparison')}</b><span>Read-only snapshot${snap.range ? ` of ${fmtDay(snap.range.since)} – ${fmtDay(snap.range.until)}` : ''}, shared ${new Date(snap.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. Link expires ${new Date(snap.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.</span>`;
    b.hidden = false;
    document.title = (snap.title || 'Shared comparison') + ' · Campaign Analyser';
  }

  // ---------- Events ----------
  function wire() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, [data-tab-go]');
      if (!t) return;
      if (t.dataset.source) { switchSource(t.dataset.source); return; }
      if (t.dataset.level) { state.meta.level = t.dataset.level; state.selected = new Set(); save(); loadEntities({ keepSelection: false }); return; }
      if (t.dataset.act) { handleMetaAction(t); return; }
      if (t.dataset.cmp) { applySaved(t.dataset.cmp); return; }
      if (t.dataset.cmpDel) { api('DELETE', `/api/comparisons/${encodeURIComponent(t.dataset.cmpDel)}`).then(() => { state.meta.comparisons = state.meta.comparisons.filter((c) => c.id !== t.dataset.cmpDel); renderSource(); }).catch(() => {}); return; }
      if (t.dataset.copy) { copyText(t.dataset.copy, t); return; }
      if (t.dataset.revoke) { api('DELETE', `/api/shares/${encodeURIComponent(t.dataset.revoke)}`).then(openShares).catch(() => {}); return; }
      if (t.dataset.close) { $('#' + t.dataset.close).close(); return; }
      if (t.dataset.trend) { state.trendMetric = t.dataset.trend; renderCompare(); return; }
      if (t.classList.contains('tab')) { state.tab = t.dataset.tab; save(); render(); window.scrollTo(0, 0); }
      else if (t.dataset.tabGo) { state.tab = t.dataset.tabGo; save(); render(); }
      else if (t.dataset.edit) openEditor(t.dataset.edit);
      else if (t.dataset.dl) download(t.dataset.dl);
      else if (t.id === 'btn-add') openEditor(null);
      else if (t.id === 'btn-example') { loadExample(); render(); }
      else if (t.id === 'btn-clear') $('#confirm-clear').hidden = false;
      else if (t.id === 'btn-clear-yes') { state.campaigns = []; state.selected.clear(); state.isExample = false; state.warnings = []; $('#confirm-clear').hidden = true; save(); render(); }
      else if (t.id === 'btn-clear-no') $('#confirm-clear').hidden = true;
      else if (t.id === 'btn-settings') { openSettings(); fillUsage(); }
      else if (t.id === 'editor-cancel') $('#editor').close();
      else if (t.id === 'settings-cancel') $('#settings').close();
      else if (t.id === 'editor-delete') {
        const id = state.editingId;
        state.campaigns = state.campaigns.filter((c) => c.id !== id);
        state.selected.delete(id);
        $('#editor').close();
        save();
        render();
      }
    });
    document.addEventListener('change', (e) => {
      const tid = e.target.id;
      if (tid === 'm-autosync') { setAutoSync(e.target.checked); return; }
      if (tid === 'm-account') { state.meta.accountId = e.target.value; state.selected = new Set(); save(); loadEntities({ keepSelection: false }); return; }
      if (tid === 'm-preset') { state.meta.preset = e.target.value; if (e.target.value === 'custom') { const r = presetRange('last30'); state.meta.since = state.meta.since || r.since; state.meta.until = state.meta.until || r.until; } save(); loadEntities(); return; }
      if (tid === 'm-since' || tid === 'm-until') { state.meta[tid === 'm-since' ? 'since' : 'until'] = e.target.value; if (state.meta.since && state.meta.until && state.meta.since <= state.meta.until) { save(); loadEntities(); } return; }
      const id = e.target.dataset && e.target.dataset.select;
      if (!id) return;
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      save();
      render();
    });
    $('#file').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
    $('#editor-form').addEventListener('submit', saveEditor);
    $('#settings-form').addEventListener('submit', saveSettings);
    document.addEventListener('submit', (e) => { if (e.target.id === 'save-cmp-row') saveComparison(e); if (e.target.id === 'token-form') connectWithToken(e); });
    if (location.hash === '#guide' || location.hash === '#compare') state.tab = location.hash.slice(1);

    // Chart tooltips: one shared box, shown on hover and on keyboard focus.
    const tip = $('#chart-tip');
    const showTip = (el, x, y) => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14));
      const top = y - h - 12 < 8 ? y + 18 : y - h - 12;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    };
    const hideTip = () => { tip.hidden = true; };
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) showTip(el, e.clientX, e.clientY); else if (!tip.hidden) hideTip();
    });
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) return hideTip();
      const b = el.getBoundingClientRect();
      showTip(el, b.left + b.width / 2, b.top);
    });
    document.addEventListener('scroll', hideTip, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

    // Redraw charts when the width changes enough to matter.
    let lastW = window.innerWidth, timer;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Math.abs(window.innerWidth - lastW) < 40) return;
        lastW = window.innerWidth;
        if (state.tab === 'compare') renderCompare();
      }, 180);
    });
  }

  async function start() {
    if (window.__SHARE__) {
      startViewer(window.__SHARE__);
      wire();
      render();
      return;
    }
    if (!load()) loadExample();
    wire();
    render();
    await detectServer();
    const hash = location.hash;
    if (hash.startsWith('#connect-error')) state.meta.error = 'Signing in with Meta did not finish. Try again; if it keeps failing, check the app settings in SETUP-META.md.';
    if (state.server && (hash === '#connected' || hash.startsWith('#connect-error') || state.wantSource === 'meta')) {
      if (hash === '#connected' || hash.startsWith('#connect-error')) { history.replaceState(null, '', location.pathname); state.tab = 'campaigns'; }
      switchSource('meta');
      pollSync();
    }
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
