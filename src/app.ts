/* Campaign Analyser — browser UI. Depends on core.js (CampaignCore), charts.ts (CampaignCharts), sample.js (SAMPLE_CSV) and SheetJS (XLSX). */
(function () {
  'use strict';

  // ---------- Types ----------
  type Level = 'campaign' | 'adset' | 'ad';
  type Source = 'files' | 'meta';
  type CompareView = 'overview' | 'charts' | 'details' | 'fixes';
  interface Health { ok: boolean; mode: string; hosted?: boolean; loginModes?: string[] }
  interface Me { id: string; name: string; csrf: string; demo: boolean; connection: { status: string; expiresAt: number | null; daysLeft: number | null } }
  interface Account {
    id: string; name?: string; currency?: string; timezone?: string; selected?: boolean; autoSync: boolean;
    syncState: string; syncError: string | null; syncProgress: string | null; lastSyncedAt: number | null;
    syncedUntil: string | null; syncedFrom: string | null; historyDays: number; nextAttemptAt: number | null;
  }
  interface SavedComparison { id: string; name: string; accountId?: string; level?: Level; preset?: string; since?: string | null; until?: string | null; entityIds?: string[] }
  interface Range { since: string; until: string }
  interface MetaState {
    me: Me | null; accounts: Account[]; accountId: string | null; level: Level; preset: string;
    since: string | null; until: string | null; items: Campaign[] | null; selectedIds: string[];
    comparisons: SavedComparison[]; loading: boolean; error: string | null; range: Range | null;
    pendingSelection: string[] | null; showConnect?: boolean;
  }
  interface FileStash { campaigns: Campaign[]; selected: string[]; isExample?: boolean; warnings?: string[] }
  interface AppState {
    campaigns: Campaign[]; selected: Set<string>; settings: Settings; isExample: boolean; warnings: string[];
    tab: string; editingId: string | null; server: Health | null; source: Source; wantSource: Source;
    fileStash: FileStash | null; meta: MetaState; viewer: ShareSnapshot | null; trendMetric: string | null;
    compareView: CompareView; lastResult?: CompareResult;
  }
  class ApiError extends Error {
    status = 0;
    data: { error?: string; reconnect?: boolean } = {};
  }

  const C = window.CampaignCore;
  const $ = <T extends HTMLElement = HTMLElement>(s: string, el: ParentNode = document): T => el.querySelector(s) as T;
  const $$ = <T extends HTMLElement = HTMLElement>(s: string, el: ParentNode = document): T[] => [...el.querySelectorAll<T>(s)];
  const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
  const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const MAX_COMPARE = 5;
  const STORE_KEY = 'campaign-analyser-v1';
  const VIEWS: [CompareView, string][] = [['overview', 'Overview'], ['charts', 'Charts'], ['details', 'Details'], ['fixes', 'Fixes & plan']];

  const state: AppState = {
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
    compareView: 'overview',
  };
  let editorDraft: Campaign | null = null;

  // ---------- Storage (per-browser convenience only) ----------
  function save(): void {
    if (state.viewer) return;
    try {
      const files: FileStash | null = state.source === 'files' ? { campaigns: state.campaigns, selected: [...state.selected], isExample: state.isExample } : state.fileStash;
      const m = state.meta;
      const metaPrefs = { accountId: m.accountId, level: m.level, preset: m.preset, since: m.since, until: m.until, selected: state.source === 'meta' ? [...state.selected] : m.selectedIds };
      localStorage.setItem(STORE_KEY, JSON.stringify({ files, settings: state.settings, tab: state.tab, source: state.source, metaPrefs, compareView: state.compareView }));
    } catch (e) { /* storage unavailable: fine */ }
  }
  function load(): boolean {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      const files = d.files || { campaigns: d.campaigns, selected: d.selected, isExample: d.isExample };
      state.campaigns = ((files.campaigns || []) as Campaign[]).map(C.normaliseCampaign);
      state.selected = new Set(((files.selected || []) as string[]).filter((id) => state.campaigns.some((c) => c.id === id)));
      state.settings = { ...C.DEFAULT_SETTINGS, ...(d.settings || {}) };
      state.isExample = !!files.isExample;
      state.tab = d.tab || 'campaigns';
      state.wantSource = d.source || 'files';
      if (VIEWS.some(([v]) => v === d.compareView)) state.compareView = d.compareView;
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
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], cell = '', q = false;
    const first = text.split('\n')[0];
    const delim = first.includes('\t') && !first.includes(',') ? '\t' : ',';
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

  function rowsFromWorkbook(data: string | Uint8Array, isText: boolean): unknown[][] {
    if (typeof XLSX === 'undefined') {
      if (isText) return parseCsv(String(data).replace(/^﻿/, ''));
      throw new Error('the Excel reader did not load; export as CSV instead');
    }
    const wb = isText ? XLSX.read(data, { type: 'string', raw: false }) : XLSX.read(data, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  }

  function importRows(rows: unknown[][], sourceLabel: string): void {
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

  async function handleFiles(files: FileList | null): Promise<void> {
    for (const f of [...(files || [])]) {
      try {
        const isText = /\.(csv|tsv|txt)$/i.test(f.name);
        const data = isText ? await f.text() : new Uint8Array(await f.arrayBuffer());
        importRows(rowsFromWorkbook(data, isText), f.name);
      } catch (e) {
        state.warnings = [`${f.name}: could not be read (${errMsg(e)}). Export it again from Ads Manager as CSV or XLSX.`];
        render();
      }
    }
  }

  function loadExample(): void {
    state.campaigns = [];
    state.selected.clear();
    const res = C.rowsToCampaigns(rowsFromWorkbook(window.SAMPLE_CSV, true));
    state.campaigns = res.campaigns;
    res.campaigns.filter((c) => c.objective === 'leads').forEach((c) => state.selected.add(c.id));
    state.isExample = true;
    state.warnings = [];
    state.settings.currency = 'INR';
    save();
  }

  // ---------- Helpers ----------
  function fieldLabel(k: string): string {
    return C.FIELDS.find((f) => f.key === k)?.label || k;
  }
  const money = (v: number | null | undefined): string => C.fmtMoney(v, state.settings.currency);
  const objLabel = (o: string | null | undefined): string => (o && o in C.OBJECTIVES ? C.OBJECTIVES[o as ObjectiveKey].label : 'Not set');
  const tLabel = (t: string): string => C.TARGETING[t as TargetingType] || t;
  const metricLabel = (k: MetricKey): string => C.METRIC_DEFS[k].label;
  const shortLabel = (k: MetricKey): string => metricLabel(k).replace(/ \(.*\)$/, '');
  function selectedCampaigns(): Campaign[] {
    return state.campaigns.filter((c) => state.selected.has(c.id));
  }
  function colorSlot(id: string): number {
    const idx = selectedCampaigns().findIndex((c) => c.id === id);
    return idx === -1 ? 0 : idx + 1;
  }
  const dot = (id: string): string => `<span class="dot s${colorSlot(id)}" aria-hidden="true"></span>`;

  function funnelChips(c: Campaign): string {
    const aim = C.targetLevels(c), data = C.dataLevels(c);
    return '<span class="lv-row" aria-label="Funnel levels">' + [1, 2, 3, 4, 5].map((l) => {
      const cls = aim.includes(l) ? 'lv aim' : data.includes(l) ? 'lv data' : 'lv';
      const t = aim.includes(l) ? 'aimed at' : data.includes(l) ? 'has data' : 'no data';
      return `<span class="${cls}" title="Level ${l}: ${t}">L${l}</span>`;
    }).join('') + '</span>';
  }

  // ---------- Render: tabs ----------
  function render(): void {
    renderSource();
    $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    $$('.panel').forEach((p) => (p.hidden = p.id !== 'panel-' + state.tab));
    $('#compare-count').textContent = state.selected.size ? String(state.selected.size) : '';
    renderCampaigns();
    if (state.tab === 'compare') renderCompare();
  }

  // For synced items only the fields Meta can't supply can be filled in.
  function gapsFor(c: Campaign): string[] {
    const miss = C.missingInputs(c);
    if (c.source !== 'meta') return miss;
    // Meta sets budgets on campaigns or ad sets, never on single ads.
    return miss.filter((k) => META_EDITABLE.has(k) && !(k === 'budget' && c.level === 'ad'));
  }

  function renderCampaigns(): void {
    const host = $('#campaign-list');
    $('#example-banner').hidden = !state.isExample;
    $('#import-notes').innerHTML = state.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
    $('#import-notes').hidden = !state.warnings.length;

    if (state.source === 'meta') {
      if (!state.meta.me || !state.meta.accounts.length) { host.innerHTML = ''; return; }
      const acct = currentAccount();
      if (!state.campaigns.length) {
        const r = presetRange(state.meta.preset, state.meta.since, state.meta.until);
        const msg = !acct || !acct.lastSyncedAt
          ? (acct && (acct.syncState === 'running' || acct.syncState === 'partial') ? '<p class="empty-title">First sync in progress</p><p>Fetching your history from Meta. This takes a minute or two for most accounts.</p>' : '<p class="empty-title">This account hasn\'t been synced yet</p><p>Sync it to pull campaigns, ad sets, ads and daily results from Meta.</p><button class="btn" data-act="sync">Sync this account</button>')
          : `<p class="empty-title">Nothing ran in this period</p><p>No ${LEVEL_LABELS[state.meta.level].toLowerCase()} spent money between ${fmtDay(r.since)} and ${fmtDay(r.until)}. Try a longer date range.</p>`;
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
  const HELP: Record<string, string> = {
    universe: 'Estimated audience size shown in Ads Manager when you set up targeting.',
    qualifiedLeads: 'From your CRM: leads your team judged worth following up.',
    budget: 'The budget you planned for the whole run.',
    targeting: 'Leave on Auto to classify from universe size and notes.',
    targetingNotes: 'e.g. "Advantage+", "Interests: yoga", "1% lookalike".',
    frequency: 'Leave blank to calculate it from impressions ÷ reach.',
  };

  function openEditor(id: string | null): void {
    const isNew = !id;
    const c = isNew ? C.normaliseCampaign({ name: '', objective: 'leads', platform: 'Meta' }) : state.campaigns.find((x) => x.id === id);
    if (!c) return;
    state.editingId = c.id;
    const miss = new Set(gapsFor(c));
    const fromMeta = c.source === 'meta';
    const field = (k: string): string => {
      const f = C.FIELDS.find((x) => x.key === k) as FieldDef;
      const v = c[k] ?? '';
      const flag = miss.has(k) ? ' missing' : '';
      const help = HELP[k] ? `<span class="help">${esc(HELP[k])}</span>` : '';
      const locked = fromMeta && !META_EDITABLE.has(k) ? 'disabled' : '';
      let input: string;
      if (f.type === 'select') {
        const opts = (f.options || []).map((o) => {
          const lab = k === 'objective' ? objLabel(o) : k === 'targeting' ? (o === 'auto' ? 'Auto' : tLabel(o)) : o;
          return `<option value="${o}" ${String(v) === o ? 'selected' : ''}>${esc(lab)}</option>`;
        });
        if (k === 'objective') opts.unshift(`<option value="" ${!v ? 'selected' : ''}>Not set</option>`);
        input = `<select id="f-${k}" name="${k}" ${locked}>${opts.join('')}</select>`;
      } else {
        const type = f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'number';
        const step = f.type === 'num' || f.type === 'money' ? '0.01' : '1';
        input = `<input id="f-${k}" name="${k}" type="${type}" ${type === 'number' ? `min="0" step="${step}" inputmode="decimal"` : ''} value="${esc(v)}" ${k === 'name' ? 'required' : ''} ${locked}>`;
      }
      if (locked) return `<label class="field" for="f-${k}"><span class="flabel">${esc(f.label)} <span class="muted">· from Meta</span></span>${input}</label>`;
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
    const dlg = $<HTMLDialogElement>('#editor');
    dlg.dataset.isNew = isNew ? '1' : '';
    editorDraft = c;
    dlg.showModal();
  }

  function pickedLevels(dlg: HTMLElement, c: Campaign): number[] | null {
    const picked = $$<HTMLInputElement>('input[name="levels"]:checked', dlg).map((x) => Number(x.value));
    const obj = c.objective ? C.OBJECTIVES[c.objective as ObjectiveKey] : undefined;
    const objDefault = obj ? obj.levels : [];
    return picked.length && picked.join() !== objDefault.join() ? picked : null;
  }

  async function saveMetaEditor(dlg: HTMLDialogElement, c: Campaign): Promise<void> {
    const auto = c.autoValues || {};
    const body: Record<string, unknown> = {};
    for (const k of META_EDITABLE) {
      const el = document.getElementById('f-' + k) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;
      const raw = el.value.trim();
      const f = C.FIELDS.find((x) => x.key === k) as FieldDef;
      let v: string | number | null = raw === '' ? null : ['int', 'num', 'money'].includes(f.type) ? Number(raw) : raw;
      // Unchanged from what Meta reported: store no override.
      if (v !== null && auto[k] !== undefined && String(v) === String(auto[k])) v = null;
      if (k === 'targeting' && v === 'auto') v = null;
      body[k] = v;
    }
    body.levels = pickedLevels(dlg, c);
    try {
      await api('PUT', `/api/entities/${encodeURIComponent(c.id)}/manual`, body);
      dlg.close();
      await loadEntities();
    } catch (err) {
      $('#editor-body').insertAdjacentHTML('afterbegin', `<p class="notices" role="alert">${esc(errMsg(err))}</p>`);
    }
  }

  function saveEditor(e: Event): void {
    e.preventDefault();
    const dlg = $<HTMLDialogElement>('#editor');
    const draft = editorDraft;
    if (!draft) return;
    if (draft.source === 'meta') { saveMetaEditor(dlg, draft); return; }
    const c: Campaign = { ...draft };
    for (const f of C.FIELDS) {
      const el = document.getElementById('f-' + f.key) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;
      const raw = el.value.trim();
      if (['int', 'num', 'money'].includes(f.type)) c[f.key] = raw === '' ? undefined : Number(raw);
      else c[f.key] = raw === '' ? undefined : raw;
    }
    if (!c.name) c.name = 'Untitled campaign';
    c.levels = pickedLevels(dlg, c) || undefined;
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
  /** Lower is better for costs; higher for rates; null when neither (spend, budget, days). */
  function direction(k: MetricKey): 'lower' | 'higher' | null {
    const d = C.METRIC_DEFS[k];
    if (d.neutral || d.band) return null;
    if (d.higher) return 'higher';
    return d.fmt === 'money' ? 'lower' : null;
  }

  function bar(key: MetricKey, rank: MetricRank, items: CompareItem[], maxVal: number): string {
    return items.map((it) => {
      const v = rank.values[it.c.id];
      const w = C.isNum(v) && maxVal > 0 ? Math.max(2, (v / maxVal) * 100) : 0;
      const best = rank.best === it.c.id, worst = rank.worst === it.c.id && rank.best !== rank.worst;
      const tag = best ? '<span class="tag good">Best</span>' : worst ? '<span class="tag bad">Weakest</span>' : '';
      return `<div class="bar-row">
        <span class="bar-name">${dot(it.c.id)}${esc(it.c.name)}</span>
        <span class="bar-track">${C.isNum(v) ? `<span class="bar s${colorSlot(it.c.id)}" style="width:${w.toFixed(1)}%"></span>` : `<button class="btn tiny warn" data-edit="${esc(it.c.id)}">Add data</button>`}</span>
        <span class="bar-val">${C.isNum(v) ? esc(C.formatMetric(key, v, state.settings.currency)) : '—'}${tag}</span>
      </div>`;
    }).join('');
  }

  /** Content widths for full-width and half-width chart cards. */
  function chartWidths(host: HTMLElement): { wide: number; half: number } {
    const w = host.clientWidth || 960;
    const pad = w < 560 ? 36 : 48; // card padding, both sides
    const wide = Math.max(280, Math.min(1100, w - pad));
    const half = w >= 820 ? Math.max(280, Math.floor((w - 20) / 2) - pad) : wide;
    return { wide, half };
  }

  function chartCard(ch: ChartOut, trendLabels: Record<string, { label: string }>): string {
    const sw = ch.metrics ? `<div class="seg trend-switch" role="group" aria-label="Measure">${ch.metrics.map((k) => `<button data-trend="${k}" aria-pressed="${k === ch.metric}">${esc(trendLabels[k].label)}</button>`).join('')}</div>` : '';
    return `<figure class="card chart ${ch.size}" id="chart-${ch.id}"><figcaption><h3>${esc(ch.title)}</h3><p class="muted">${esc(ch.sub)}</p>${sw}</figcaption>
      ${ch.svg ? `<div class="chart-box">${ch.svg}</div><p class="chart-note">${esc(ch.note)}</p><details class="chart-data"><summary>View as table</summary><div class="table-wrap">${ch.table}</div></details>` : `<p class="chart-empty">${esc(ch.empty)}</p>`}</figure>`;
  }

  function notesFor(r: CompareResult, byId: Record<string, CompareItem>): string[] {
    const notices: string[] = [];
    if (r.mixedObjectives) notices.push(`These campaigns have different objectives, so they aimed at different funnel levels. Costs are compared on <b>${esc(objLabel(r.objective))}</b> terms.`);
    for (const s of r.significance) {
      if (C.isNum(s.p) && s.p > 0.05) notices.push(`The gap in ${esc(shortLabel(s.key).toLowerCase())} between ${esc(byId[s.best].c.name)} and ${esc(byId[s.worst].c.name)} could be chance. Run longer before acting on it.`);
    }
    const missingCount = r.items.reduce((n, it) => n + gapsFor(it.c).length, 0);
    if (missingCount && !state.viewer) notices.push(`${missingCount} input${missingCount === 1 ? ' is' : 's are'} missing. Fill them under <b>Details</b> or on <b>Campaigns</b>; results update straight away.`);
    return notices;
  }

  function overviewHtml(r: CompareResult, byId: Record<string, CompareItem>, widths: { wide: number; half: number }): string {
    const leader = byId[r.ranking[0]];
    const others = r.items.filter((it) => it !== leader);
    const primary = r.tiers[0].metrics[0];
    // Why it leads: the key metrics where it is best.
    const wins = r.tiers.slice(0, 2).flatMap((t) => t.ranks).filter((rk) => rk.best === leader.c.id && direction(rk.key)).map((rk) => shortLabel(rk.key).toLowerCase());
    const why = wins.length ? `Best on ${wins.slice(0, 2).join(' and ')}.` : 'Strongest across the checks overall.';

    // Headline numbers for the leader, each against the average of the others.
    const kpiKeys = ([primary, 'qualifiedPct', 'cpql', 'ctr', 'leadsPerDay'] as MetricKey[]).filter((k, i, a) => a.indexOf(k) === i && C.isNum(leader.m[k])).slice(0, 3);
    const kpis = kpiKeys.map((k) => {
      const v = leader.m[k] as number;
      const vals = others.map((it) => it.m[k]).filter(C.isNum);
      const dir = direction(k);
      let badge = '';
      if (vals.length && dir) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (avg > 0) {
          const diff = v / avg - 1;
          const good = dir === 'lower' ? diff < 0 : diff > 0;
          badge = `<span class="badge ${Math.abs(diff) < 0.005 ? '' : good ? 'up' : 'down'}">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(Math.round(diff * 100))}%</span><span class="vs">vs the others</span>`;
        }
      }
      return `<article class="card kpi"><p class="kpi-label">${esc(shortLabel(k))}</p><p class="kpi-value">${esc(C.formatMetric(k, v, state.settings.currency))}</p><p class="kpi-foot">${badge}</p></article>`;
    }).join('');

    // A sparkline of the leader's main cost over time, when daily data exists.
    let spark = '';
    const K = window.CampaignCharts;
    if (K && Array.isArray(leader.c.daily) && leader.c.daily.length >= 7) {
      const metric = ({ cpl: 'cpl', cpc: 'cpc', cpm: 'cpm', cpa: 'cpa' } as Record<string, string>)[primary] || 'spend';
      const dates = [...new Set(leader.c.daily.map((d) => d.date))].sort();
      spark = K.sparkline(K.rolling(leader.c.daily, dates, metric), { width: 220, height: 64, color: 'rgba(255,255,255,.92)', id: 'hero' });
      if (spark) spark = `<div class="hero-spark">${spark}<span>${esc(shortLabel(primary as MetricKey))}, 7-day</span></div>`;
    }
    const hero = `<article class="hero-card"><p class="hero-eyebrow">Leading ${r.items.length > 2 ? `of ${r.items.length}` : 'of the two'}</p>
      <h3 class="hero-name">${esc(leader.c.name)}</h3><p class="hero-why">${esc(why)}</p>${spark}</article>`;

    const scores = r.ranking.map((id) => r.scores[id]);
    const lo = Math.min(...scores), hi = Math.max(...scores);
    const ranking = r.ranking.map((id, i) => {
      const it = byId[id];
      const w = hi === lo ? 100 : 18 + ((r.scores[id] - lo) / (hi - lo)) * 82;
      return `<li><span class="rank">${i + 1}</span><span class="rname">${dot(id)}${esc(it.c.name)}</span><span class="rbar"><span class="s${colorSlot(id)}" style="width:${w.toFixed(0)}%"></span></span><span class="score">${r.scores[id] > 0 ? '+' : ''}${r.scores[id].toFixed(1)}</span></li>`;
    }).join('');

    const share = K ? K.buildCharts(r, { C, cur: state.settings.currency, width: widths.wide, halfWidth: widths.half, slot: colorSlot, only: ['share'] })[0] : null;
    const shareCard = share ? `<section class="card ov-share"><header class="card-head"><h3>${esc(share.title)}</h3><button class="linkish" data-view="charts">All charts</button></header>
      ${share.svg ? `<div class="chart-box">${share.svg}</div><p class="chart-note">${esc(share.note)}</p>` : `<p class="chart-empty">${esc(share.empty)}</p>`}</section>` : '';

    // Up to three next steps: move budget first, then the top fix for the weakest campaigns.
    const steps: string[] = [];
    const re = r.recommendations;
    const used = new Set<string>();
    if (re.reallocation) steps.push(`<li><span class="step-tag">Budget</span>${esc(re.reallocation.text)}</li>`);
    for (const id of [...r.ranking].reverse()) {
      const fix = (re.improve[id] || [])[0];
      if (fix && !/^No major problems/.test(fix) && !used.has(fix) && steps.length < 3) used.add(fix), steps.push(`<li><span class="step-tag">${dot(id)}${esc(byId[id].c.name)}</span>${esc(fix)}</li>`);
    }
    const next = steps.length ? `<section class="card ov-next"><header class="card-head"><h3>What to do next</h3><button class="linkish" data-view="fixes">All fixes</button></header><ol class="steps">${steps.join('')}</ol></section>` : '';

    const notices = notesFor(r, byId);
    const heads = notices.length ? `<details class="heads-up"><summary><span class="hu-dot" aria-hidden="true"></span>${notices.length} thing${notices.length === 1 ? '' : 's'} to check before acting</summary><ul>${notices.map((n) => `<li>${n}</li>`).join('')}</ul></details>` : '';

    return `${heads}
      <div class="ov-top">${hero}${kpis}</div>
      <div class="ov-mid"><div class="ov-stack"><section class="card ov-rank"><header class="card-head"><h3>Ranking</h3><button class="linkish" data-view="details">How it's scored</button></header><ol class="rank-list">${ranking}</ol></section>${next}</div>${shareCard}</div>`;
  }

  function chartsHtml(r: CompareResult, widths: { wide: number; half: number }): string {
    const K = window.CampaignCharts;
    if (!K) return '<p class="chart-empty">Charts did not load.</p>';
    const charts = K.buildCharts(r, { C, cur: state.settings.currency, width: widths.wide, halfWidth: widths.half, slot: colorSlot, trendMetric: state.trendMetric });
    return `<div class="chart-grid">${charts.map((ch) => chartCard(ch, K.TREND_METRICS)).join('')}</div>`;
  }

  function detailsHtml(r: CompareResult, byId: Record<string, CompareItem>): string {
    const tiers = r.tiers.map((t) => {
      const blocks = t.ranks.map((rk) => {
        const vals = Object.values(rk.values).filter(C.isNum);
        if (!vals.length) return '';
        return `<div class="metric"><h4>${esc(metricLabel(rk.key))}</h4>${bar(rk.key, rk, r.items, Math.max(...vals))}</div>`;
      }).join('');
      return `<section class="card tier" aria-labelledby="tier-${t.tier}"><header><span class="tier-n">Step ${t.tier} · ${t.weight} pt${t.weight === 1 ? '' : 's'}</span><h3 id="tier-${t.tier}">${esc(t.title)}</h3><p class="muted">${esc(t.why)}</p></header><div class="metrics">${blocks || '<p class="muted">No data for this step yet.</p>'}</div></section>`;
    }).join('');
    const funnelRows = C.FUNNEL_LEVELS.map((l) => {
      const cells = r.items.map((it) => {
        const aim = it.levels.includes(l.level), has = it.dataLevels.includes(l.level);
        const kpi = l.kpis.map((k) => (C.isNum(it.m[k]) && C.METRIC_DEFS[k] ? `${shortLabel(k)}: ${C.formatMetric(k, it.m[k], state.settings.currency)}` : C.isNum(it.m[k]) ? `${fieldLabel(k)}: ${C.fmtInt(it.m[k])}` : null)).filter(Boolean).slice(0, 2).join('<br>');
        return `<td class="${aim ? 'f-aim' : has ? 'f-data' : 'f-none'}"><span class="f-state">${aim ? 'Aimed at' : has ? 'Side effect' : '—'}</span>${kpi ? `<span class="f-kpi">${kpi}</span>` : ''}</td>`;
      }).join('');
      return `<tr><th scope="row"><span class="lvl">L${l.level}</span> ${esc(l.stage)}<span class="sub">${esc(l.name)}</span></th>${cells}</tr>`;
    }).join('');
    const scoreNote = `<p class="hint">Score: a campaign earns a step's points for leading a measure, and loses half for coming last. ${r.ranking.map((id) => `${esc(byId[id].c.name)} ${r.scores[id] > 0 ? '+' : ''}${r.scores[id].toFixed(1)}`).join(' · ')}.</p>`;
    return `${scoreNote}${tiers}
      <section class="card"><h3>Marketing funnel</h3><p class="muted">"Aimed at" is what each campaign should be judged on; "side effect" is data it has without aiming for it.</p>
        <div class="table-wrap"><table class="funnel"><thead><tr><th>Level</th>${r.items.map((it) => `<th>${dot(it.c.id)}${esc(it.c.name)}</th>`).join('')}</tr></thead><tbody>${funnelRows}</tbody></table></div></section>
      <section class="card two"><div><h3>In common</h3><ul>${r.commonality.common.map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">Nothing shared.</li>'}</ul></div>
        <div><h3>Where they differ</h3><ul>${r.commonality.different.map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">Very similar.</li>'}</ul></div></section>`;
  }

  function fixesHtml(r: CompareResult): string {
    const cards = r.items.map((it) => {
      const ins = r.insights[it.c.id];
      const imp = r.recommendations.improve[it.c.id];
      return `<article class="card sw"><h3>${dot(it.c.id)}${esc(it.c.name)}</h3>
        <p class="tline"><span class="chip t-${it.targeting.type}">${esc(tLabel(it.targeting.type))}</span> ${esc(it.targeting.reason)}</p>
        <div class="sw-cols"><div><h4 class="good-t">Strengths</h4><ul>${ins.strengths.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">None stand out yet.</li>'}</ul></div>
        <div><h4 class="bad-t">Weaknesses</h4><ul>${ins.weaknesses.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">None found.</li>'}</ul></div></div>
        <h4>How to improve it</h4><ol>${imp.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></article>`;
    }).join('');
    return `<div class="sw-grid">${cards}</div>
      <section class="card"><h3>Plan for a new campaign</h3><p class="muted">Built from what worked best.</p><ol class="plan">${r.recommendations.newCampaign.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        ${r.recommendations.reallocation ? `<p class="whatif"><b>What if you move budget?</b> ${esc(r.recommendations.reallocation.text)}</p>` : ''}</section>`;
  }

  /** Redraw one chart card in place, so switching a chart's measure doesn't move the page. */
  function redrawChart(id: string): void {
    const K = window.CampaignCharts;
    const old = document.getElementById('chart-' + id);
    const r = state.lastResult;
    if (!K || !old || !r) { renderCompare(); return; }
    const widths = chartWidths($('#cmp-view'));
    const ch = K.buildCharts(r, { C, cur: state.settings.currency, width: widths.wide, halfWidth: widths.half, slot: colorSlot, trendMetric: state.trendMetric, only: [id] })[0];
    if (!ch) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.trend;
    old.outerHTML = chartCard(ch, K.TREND_METRICS);
    // Keep keyboard focus on the measure button that was pressed.
    if (focused) document.querySelector<HTMLElement>(`#chart-${id} [data-trend="${focused}"]`)?.focus({ preventScroll: true });
  }

  function renderCompare(): void {
    // Re-rendering replaces the whole view; keep the reader where they were.
    const y = window.scrollY;
    renderCompareInner();
    if (y) window.scrollTo(0, Math.min(y, document.documentElement.scrollHeight));
  }

  function renderCompareInner(): void {
    const host = $('#compare-body');
    const list = selectedCampaigns();
    if (list.length < 2) {
      host.innerHTML = `<div class="page-head"><h2 class="page-title">Comparison</h2></div><div class="empty"><p class="empty-title">Pick at least two campaigns</p><p>Go to <b>Campaigns</b> and tick 2 to ${MAX_COMPARE} of them. ${list.length === 1 ? 'You have one ticked.' : ''}</p><button class="btn" data-tab-go="campaigns">Go to campaigns</button></div>`;
      return;
    }
    const r = C.compare(list, state.settings);
    state.lastResult = r;
    const byId = Object.fromEntries(r.items.map((it) => [it.c.id, it]));
    const range = state.viewer ? state.viewer.range : state.source === 'meta' ? state.meta.range : null;
    const meta = [`${r.items.length} ${state.source === 'meta' && !state.viewer ? LEVEL_LABELS[state.meta.level].toLowerCase() : 'campaigns'}`, objLabel(r.objective), range ? `${fmtDay(range.since)} – ${fmtDay(range.until)}` : ''].filter(Boolean);
    const owner = state.server && state.meta.me && !state.viewer;
    const actions = `<div class="cmp-actions">
        ${owner ? `<span class="owner-only" style="display:contents">${state.source === 'meta' ? '<button class="btn ghost small" data-act="save-cmp">Save</button>' : ''}<button class="btn ghost small" data-act="share">Share</button></span>` : ''}
        <details class="menu"><summary class="btn small">Download</summary><div class="menu-list" role="group" aria-label="Download"><button data-dl="html">Report (HTML)</button><button data-dl="csv">Data (CSV)</button><button data-dl="xlsx">Workbook (XLSX)</button></div></details>
        <span id="dl-status" role="status"></span></div>`;
    const forms = owner ? `<form class="inline-form owner-only" id="save-cmp-row" hidden><label class="sr" for="save-cmp-name">Name</label><input id="save-cmp-name" maxlength="120" placeholder="Name this comparison, e.g. Lead forms vs lookalike" required><button class="btn small" type="submit">Save</button><button class="btn ghost small" type="button" data-act="save-cmp-cancel">Cancel</button></form>
        <div class="share-out owner-only" id="share-out" hidden></div>` : '';
    const view = state.compareView;
    const tabs = `<div class="subtabs" role="group" aria-label="Comparison views">${VIEWS.map(([v, l]) => `<button data-view="${v}" aria-pressed="${v === view}">${l}</button>`).join('')}</div>`;
    const legend = `<ul class="legend" aria-label="Campaign colours">${r.items.map((it) => `<li>${dot(it.c.id)}${esc(it.c.name)}</li>`).join('')}</ul>`;

    host.innerHTML = `<div class="page-head"><div><h2 class="page-title">Comparison</h2><p class="meta-line">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</p></div>${actions}</div>
      ${forms}
      <div class="cmp-bar">${tabs}${view === 'overview' ? '' : legend}</div>
      <div class="cmp-view" id="cmp-view"></div>`;
    const viewHost = $('#cmp-view');
    const widths = chartWidths(viewHost);
    viewHost.innerHTML = view === 'charts' ? chartsHtml(r, widths) : view === 'details' ? detailsHtml(r, byId) : view === 'fixes' ? fixesHtml(r) : overviewHtml(r, byId, widths);
  }

  // ---------- Downloads ----------
  function reportHtml(r: CompareResult): string {
    const cur = state.settings.currency;
    const K = window.CampaignCharts;
    const row = (k: MetricKey): string => `<tr><th>${esc(metricLabel(k))}</th>${r.items.map((it) => `<td>${esc(C.formatMetric(k, it.m[k], cur))}</td>`).join('')}</tr>`;
    const tierTables = r.tiers.map((t) => `<h2>Step ${t.tier}: ${esc(t.title)}</h2><p>${esc(t.why)}</p><table><thead><tr><th>Metric</th>${r.items.map((it) => `<th>${esc(it.c.name)}</th>`).join('')}</tr></thead><tbody>${t.metrics.map(row).join('')}</tbody></table>`).join('');
    const per = r.items.map((it) => `<h3>${esc(it.c.name)}</h3><p><b>Targeting:</b> ${esc(tLabel(it.targeting.type))}. ${esc(it.targeting.reason)} <b>Funnel:</b> aims at ${it.levels.map((l) => 'L' + l).join(', ') || 'not set'}.</p><p><b>Strengths</b></p><ul>${r.insights[it.c.id].strengths.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>None stand out.</li>'}</ul><p><b>Weaknesses</b></p><ul>${r.insights[it.c.id].weaknesses.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>None found.</li>'}</ul><p><b>How to improve</b></p><ol>${r.recommendations.improve[it.c.id].map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`).join('');
    const date = new Date().toISOString().slice(0, 10);
    const slotOf = (id: string): number => r.items.findIndex((it) => it.c.id === id) + 1;
    const pc = K ? K.buildCharts(r, { C, cur, width: 880, halfWidth: 520, slot: slotOf, print: true }) : [];
    const swatch = (id: string): string => (K ? `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;background:${K.PAL_PRINT.s[slotOf(id)]}"></span>` : '');
    const charts = pc.length ? `<h2>Charts</h2><p class="legend">${r.items.map((it) => `<span>${swatch(it.c.id)}${esc(it.c.name)}</span>`).join('')}</p>` + pc.map((ch) => `<figure><h3>${esc(ch.title)}</h3><p class="muted">${esc(ch.sub)}</p>${ch.svg ? ch.svg + `<p>${esc(ch.note)}</p>` : `<p class="muted">${esc(ch.empty)}</p>`}</figure>`).join('') : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Campaign comparison ${date}</title><style>
      body{font:14px/1.55 Poppins,system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1b1f;max-width:960px;margin:32px auto;padding:0 20px}
      h1{font-size:28px;font-weight:400;margin:0 0 4px}h2{font-size:18px;font-weight:500;margin:28px 0 6px;border-bottom:1px solid #e6e2da;padding-bottom:4px}h3{font-size:16px;font-weight:500;margin:20px 0 4px}
      table{border-collapse:collapse;width:100%;margin:8px 0 12px;font-variant-numeric:tabular-nums}th,td{border:1px solid #e6e2da;padding:6px 8px;text-align:left;vertical-align:top}thead th{background:#f3f1ec}
      .muted{color:#6f6c75}figure{margin:16px 0 24px;break-inside:avoid}figure h3{margin:0}figure .muted{margin:0 0 6px}svg{max-width:100%;height:auto;display:block;margin:8px 0}.legend span{display:inline-flex;align-items:center;gap:4px;margin-right:16px;font-size:13px}@media print{body{margin:0}h2{break-after:avoid}table{break-inside:avoid}}</style></head><body>
      <h1>Campaign comparison</h1><p class="muted">Generated ${date} with Campaign Analyser. Currency: ${esc(cur)}. Objective basis: ${esc(objLabel(r.objective))}.</p>
      <h2>Overall ranking</h2><ol>${r.ranking.map((id) => { const it = r.items.find((x) => x.c.id === id) as CompareItem; return `<li>${esc(it.c.name)} (score ${r.scores[id].toFixed(1)})</li>`; }).join('')}</ol>
      ${charts}
      ${tierTables}
      <h2>Marketing funnel</h2><table><thead><tr><th>Level</th>${r.items.map((it) => `<th>${esc(it.c.name)}</th>`).join('')}</tr></thead><tbody>${C.FUNNEL_LEVELS.map((l) => `<tr><th>L${l.level} ${esc(l.stage)}: ${esc(l.name)}</th>${r.items.map((it) => `<td>${it.levels.includes(l.level) ? 'Aimed at' : it.dataLevels.includes(l.level) ? 'Side effect' : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <h2>Common ground and differences</h2><p><b>In common</b></p><ul>${r.commonality.common.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>Nothing shared.</li>'}</ul><p><b>Different</b></p><ul>${r.commonality.different.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h2>Campaign by campaign</h2>${per}
      <h2>Plan for a new campaign</h2><ol>${r.recommendations.newCampaign.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${r.recommendations.reallocation ? `<p>${esc(r.recommendations.reallocation.text)}</p>` : ''}
      <p class="muted">To save as PDF: open this file in a browser and use Print → Save as PDF.</p></body></html>`;
  }

  async function offerFile(filename: string, data: string | Blob, mime: string): Promise<void> {
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
      const code = (e as { code?: string } | null)?.code;
      if (code === 'declined') { status.textContent = 'Download cancelled.'; return; }
      if (code && !['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(code)) { status.textContent = `Could not save (${code}).`; return; }
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

  function download(kind: string): void {
    const r = state.lastResult;
    if (!r) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'html') offerFile(`campaign-report-${stamp}.html`, reportHtml(r), 'text/html');
    if (kind === 'csv') offerFile(`campaign-comparison-${stamp}.csv`, C.toCsv(r), 'text/csv');
    if (kind === 'xlsx') {
      if (typeof XLSX === 'undefined') { $('#dl-status').textContent = 'The Excel writer did not load. Use CSV instead.'; return; }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(C.toRows(r)), 'Comparison');
      const insights: string[][] = [['Campaign', 'Type', 'Text']];
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

  // ---------- Theme (per browser; light unless dark was chosen) ----------
  const THEME_KEY = 'campaign-analyser-theme';
  type Theme = 'light' | 'dark';
  function currentTheme(): Theme {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  function setTheme(t: Theme): void {
    if (t === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try { if (t === 'dark') localStorage.setItem(THEME_KEY, 'dark'); else localStorage.removeItem(THEME_KEY); } catch (e) { /* storage blocked: applies to this visit only */ }
    $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
  }

  // ---------- Settings ----------
  const inputVal = (id: string): string => $<HTMLInputElement>(id).value;
  function openSettings(): void {
    const s = state.settings;
    $<HTMLSelectElement>('#s-currency').value = s.currency;
    $<HTMLInputElement>('#s-targetCpl').value = s.targetCpl == null ? '' : String(s.targetCpl);
    $<HTMLInputElement>('#s-targetQ').value = String(Math.round((s.targetQualifiedPct ?? 0.3) * 100));
    $<HTMLInputElement>('#s-open').value = String(s.openUniverseMin);
    $<HTMLInputElement>('#s-focused').value = String(s.focusedUniverseMax);
    $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === currentTheme())));
    $<HTMLDialogElement>('#settings').showModal();
  }
  function saveSettings(e: Event): void {
    e.preventDefault();
    const num = (id: string): number | null => { const v = inputVal(id).trim(); return v === '' ? null : Number(v); };
    state.settings = {
      ...state.settings,
      currency: $<HTMLSelectElement>('#s-currency').value,
      targetCpl: num('#s-targetCpl'),
      targetQualifiedPct: (num('#s-targetQ') ?? 30) / 100,
      openUniverseMin: num('#s-open') ?? C.DEFAULT_SETTINGS.openUniverseMin,
      focusedUniverseMax: num('#s-focused') ?? C.DEFAULT_SETTINGS.focusedUniverseMax,
    };
    $<HTMLDialogElement>('#settings').close();
    save();
    render();
  }

  // ---------- Meta connection (only when the app is served by the Node server) ----------
  const LEVEL_LABELS: Record<Level, string> = { campaign: 'Campaigns', adset: 'Ad sets', ad: 'Ads' };
  const PRESETS: [string, string][] = [['last7', 'Last 7 days'], ['last14', 'Last 14 days'], ['last30', 'Last 30 days'], ['last90', 'Last 90 days'], ['last180', 'Last 6 months'], ['last365', 'Last 12 months'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom dates']];
  const HISTORY: [number, string][] = [[90, '3 months'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [1095, '3 years']];
  const META_EDITABLE = new Set(['qualifiedLeads', 'universe', 'budget', 'targeting', 'targetingNotes', 'objective']);
  const isoDay = (d: Date): string => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  function presetRange(preset: string, since?: string | null, until?: string | null): Range {
    const today = new Date();
    const back = (n: number): string => isoDay(new Date(today.getTime() - n * 86400000));
    switch (preset) {
      case 'last7': return { since: back(6), until: back(0) };
      case 'last14': return { since: back(13), until: back(0) };
      case 'last90': return { since: back(89), until: back(0) };
      case 'last180': return { since: back(179), until: back(0) };
      case 'last365': return { since: back(364), until: back(0) };
      case 'this_month': return { since: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), until: back(0) };
      case 'last_month': return { since: isoDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)), until: isoDay(new Date(today.getFullYear(), today.getMonth(), 0)) };
      case 'custom': if (since && until && since <= until) return { since, until }; // falls through
      default: return { since: back(29), until: back(0) };
    }
  }
  function ago(ms: number | null | undefined): string {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  // Show the year only when it isn't this year (history can go back 3 years).
  const fmtDay = (iso: string | null | undefined): string => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(iso.slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : {}) }) : '');
  const shortDate = (ms: number | undefined): string => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

  async function api<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && state.meta.me) headers['x-csrf-token'] = state.meta.me.csrf;
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/me') state.meta.me = null;
    if (!res.ok) { const e = new ApiError(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data as T;
  }

  async function detectServer(): Promise<void> {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const h = await fetch('/api/health', { headers: { accept: 'application/json' } });
      if (!h.ok) return;
      const j = await h.json();
      if (!j || !j.ok) return;
      state.server = j;
    } catch (e) { return; }
    try { state.meta.me = await api<Me>('GET', '/api/me'); } catch (e) { state.meta.me = null; }
    if (state.meta.me) await refreshAccounts();
  }

  async function refreshAccounts(): Promise<void> {
    const [a, c] = await Promise.all([api<{ accounts: Account[] }>('GET', '/api/accounts'), api<{ comparisons: SavedComparison[] }>('GET', '/api/comparisons')]);
    state.meta.accounts = a.accounts;
    state.meta.comparisons = c.comparisons;
    if (!state.meta.accounts.some((x) => x.id === state.meta.accountId)) state.meta.accountId = (state.meta.accounts.find((x) => x.selected) || state.meta.accounts[0])?.id || null;
  }
  const currentAccount = (): Account | null => state.meta.accounts.find((a) => a.id === state.meta.accountId) || null;

  function switchSource(to: Source): void {
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
  function autoSelect(items: Campaign[]): string[] {
    if (!items.length) return [];
    const obj = items[0].objective;
    return items.filter((c) => c.objective === obj).slice(0, 3).map((c) => c.id);
  }

  async function loadEntities({ keepSelection = true }: { keepSelection?: boolean } = {}): Promise<void> {
    const acct = currentAccount();
    if (!acct) return;
    if (!acct.lastSyncedAt) {
      if (acct.syncState !== 'running') return startMetaSync();
      return pollSync();
    }
    const { since, until } = presetRange(state.meta.preset, state.meta.since, state.meta.until);
    state.meta.loading = true; state.meta.error = null; renderSource();
    try {
      const d = await api<{ since: string; until: string; account: Account; campaigns: Campaign[]; currency?: string }>('GET', `/api/accounts/${acct.id}/entities?level=${state.meta.level}&since=${since}&until=${until}`);
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
      state.meta.error = errMsg(e);
    } finally {
      state.meta.loading = false;
      save();
      render();
    }
  }

  // A sync runs in steps (hosted functions are time-limited). Keep calling while
  // the server says 'partial', and show progress from a light poll meanwhile.
  let syncing = false;
  async function startMetaSync(): Promise<void> {
    const acct = currentAccount();
    if (!acct || syncing) return;
    syncing = true;
    acct.syncState = 'running';
    acct.syncProgress = 'Starting';
    renderSource();
    const poll = setInterval(async () => {
      try { const d = await api<{ account: Account }>('GET', `/api/accounts/${acct.id}`); if (d.account.syncState === 'running') { Object.assign(acct, d.account); renderSource(); } } catch (e) { /* ignore */ }
    }, 2000);
    try {
      for (let step = 0; step < 50; step++) {
        const d = await api<{ account: Account }>('POST', `/api/accounts/${acct.id}/sync`, {});
        Object.assign(acct, d.account);
        renderSource();
        if (acct.syncState !== 'partial') break;
      }
    } catch (e) {
      const err = e as ApiError;
      // 502–504: the host cut the step off. The server marks it resumable, so keep polling quietly.
      if (err.status >= 502 && err.status <= 504) acct.syncState = 'running';
      else state.meta.error = errMsg(e);
      if (err.data && err.data.reconnect && state.meta.me) state.meta.me.connection.status = 'reconnect';
    } finally {
      clearInterval(poll);
      syncing = false;
    }
    if (acct.syncState === 'running') pollSync(); // another tab or the daily job is syncing
    else await loadEntities();
  }

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function pollSync(): void {
    clearTimeout(pollTimer);
    const acct = currentAccount();
    if (!acct) return;
    if (acct.syncState === 'partial' && !syncing) { startMetaSync(); return; } // finish an interrupted sync
    if (acct.syncState !== 'running') return;
    pollTimer = setTimeout(async () => {
      try {
        const d = await api<{ account: Account }>('GET', `/api/accounts/${acct.id}`);
        Object.assign(acct, d.account);
      } catch (e) { /* keep polling */ }
      if (acct.syncState === 'running' || acct.syncState === 'partial') { renderSource(); pollSync(); }
      else loadEntities();
    }, 2000);
  }

  /** Change how far back this account keeps data; fetching older days starts straight away. */
  async function setHistory(days: number): Promise<void> {
    const acct = currentAccount();
    if (!acct) return;
    try {
      const d = await api<{ account: Account }>('PUT', `/api/accounts/${acct.id}/settings`, { historyDays: days });
      Object.assign(acct, d.account);
    } catch (e) { state.meta.error = errMsg(e); renderSource(); return; }
    renderSource();
    const wantFrom = isoDay(new Date(Date.now() - (days - 1) * 86400000));
    if (!acct.syncedFrom || wantFrom < acct.syncedFrom) startMetaSync();
  }

  async function setAutoSync(on: boolean): Promise<void> {
    const acct = currentAccount();
    if (!acct) return;
    try {
      const d = await api<{ account: Account }>('PUT', `/api/accounts/${acct.id}/settings`, { autoSync: on });
      Object.assign(acct, d.account);
    } catch (e) { state.meta.error = errMsg(e); }
    renderSource();
  }

  function syncStatusHtml(acct: Account | null): string {
    if (!acct) return '';
    if (acct.syncState === 'running' || acct.syncState === 'partial') return `<span class="sync-status" role="status"><span class="spinner" aria-hidden="true"></span>${esc(acct.syncProgress || 'Syncing')}…</span>`;
    if (state.meta.loading) return `<span class="sync-status" role="status"><span class="spinner" aria-hidden="true"></span>Loading…</span>`;
    if (acct.syncState === 'error' || acct.syncState === 'reconnect') return `<span class="sync-status err" role="status">${esc(acct.syncError || 'Sync failed')}</span>`;
    if (acct.syncState === 'waiting') return `<span class="sync-status" role="status">${esc(acct.syncError || 'Waiting for Meta')} Next try ${acct.nextAttemptAt ? new Date(acct.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'}.</span>`;
    const extra = acct.syncError ? ` · ${esc(acct.syncError)}` : '';
    return `<span class="sync-status" role="status">Synced ${ago(acct.lastSyncedAt)}${acct.syncedUntil ? ` · data to ${fmtDay(acct.syncedUntil)}` : ''}${extra}</span>`;
  }

  function connectCardHtml(): string {
    const modes = (state.server && state.server.loginModes) || ['oauth'];
    const demo = !!state.server && state.server.mode === 'demo';
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

  async function connectWithToken(e: Event): Promise<void> {
    e.preventDefault();
    const input = $<HTMLInputElement>('#token-input');
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
      status.textContent = errMsg(err);
      status.classList.add('err');
    }
  }

  function renderSource(): void {
    const host = document.getElementById('source-bar');
    if (!host) return;
    $('#file-import').hidden = state.source === 'meta';
    if (!state.server) { host.innerHTML = ''; return; }
    const pressed = (v: Source): string => `aria-pressed="${state.source === v}"`;
    let html = `<div class="seg" role="group" aria-label="Data source"><button data-source="meta" ${pressed('meta')}>Meta ads</button><button data-source="files" ${pressed('files')}>Imported files</button></div>`;
    if (state.source === 'meta') {
      const me = state.meta.me;
      const err = state.meta.error ? `<p class="notices" role="alert">${esc(state.meta.error)}</p>` : '';
      if (!me || state.meta.showConnect) html += connectCardHtml() + err;
      if (me) {
        const acct = currentAccount();
        const conn = me.connection || { status: 'ok', daysLeft: null };
        let warn = '';
        if (conn.status === 'reconnect') warn = `<p class="notices" role="alert">Your Meta connection has expired or was removed. <button class="linkish" data-act="show-connect">Reconnect</button> to keep syncing.</p>`;
        else if (conn.daysLeft !== null && conn.daysLeft <= 7) warn = `<p class="notices">Meta connections last 60 days. Yours ends in ${Math.max(0, conn.daysLeft)} day${conn.daysLeft === 1 ? '' : 's'}: <button class="linkish" data-act="show-connect">reconnect now</button> to avoid a gap.</p>`;
        if (!state.meta.accounts.length) {
          html += `<div class="connect-card"><div><h2>No ad accounts found</h2><p class="muted">Signed in as ${esc(me.name)}, but this Facebook profile can't see any ad accounts. Ask the account owner to add you in Business Settings, then try again.</p></div><button class="btn" data-act="refresh-accounts">Check again</button></div>`;
        } else {
          const custom = state.meta.preset === 'custom';
          const r = presetRange(state.meta.preset, state.meta.since, state.meta.until);
          const busy = !!acct && (acct.syncState === 'running' || acct.syncState === 'partial');
          html += `<div class="meta-bar">
            <label class="grow" for="m-account">Ad account<select id="m-account">${state.meta.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === state.meta.accountId ? 'selected' : ''}>${esc(a.name || a.id)}${a.currency ? ' · ' + esc(a.currency) : ''}</option>`).join('')}</select></label>
            <label for="m-preset">Dates<select id="m-preset">${PRESETS.map(([v, l]) => `<option value="${v}" ${v === state.meta.preset ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            ${custom ? `<label for="m-since">From<input type="date" id="m-since" value="${esc(r.since)}"></label><label for="m-until">To<input type="date" id="m-until" value="${esc(r.until)}"></label>` : ''}
            <div><span class="sr">Level</span><div class="seg" role="group" aria-label="Level">${(Object.entries(LEVEL_LABELS) as [Level, string][]).map(([v, l]) => `<button data-level="${v}" aria-pressed="${state.meta.level === v}">${l}</button>`).join('')}</div></div>
            <button class="btn small" data-act="sync" ${busy ? 'disabled' : ''}>Sync now</button>
            ${acct ? `<label class="switch" for="m-autosync"><input type="checkbox" role="switch" id="m-autosync" ${acct.autoSync ? 'checked' : ''}><span>Auto-sync daily</span></label>` : ''}
            ${acct ? `<label for="m-history" title="How far back to fetch from Meta (Meta keeps 37 months)">History<select id="m-history" ${busy ? 'disabled' : ''}>${HISTORY.map(([d, l]) => `<option value="${d}" ${d === acct.historyDays ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
            ${syncStatusHtml(acct)}
          </div>`;
          // Say so when the chosen dates start before the synced data, instead of showing silent zeros.
          if (acct && acct.syncedFrom && r.since < acct.syncedFrom && !busy) {
            const need = HISTORY.find(([d]) => isoDay(new Date(Date.now() - (d - 1) * 86400000)) <= r.since);
            html += `<p class="notices" role="status">Synced data starts on ${fmtDay(acct.syncedFrom)}, so days before that show as zero. ${need ? `<button class="linkish" data-history="${need[0]}">Fetch ${need[1]} of history</button>` : 'Meta keeps about 37 months of results, so older days aren\'t available.'}</p>`;
          }
        }
        const saved = state.meta.comparisons.length ? `<span class="saved" aria-label="Saved comparisons"><b>Saved:</b>${state.meta.comparisons.map((c) => `<span class="chip-btn"><button data-cmp="${esc(c.id)}" title="${esc(c.level ? LEVEL_LABELS[c.level] : '')}, ${esc(PRESETS.find((p) => p[0] === c.preset)?.[1] || 'custom dates')}">${esc(c.name)}</button><button data-cmp-del="${esc(c.id)}" aria-label="Delete saved comparison ${esc(c.name)}">×</button></span>`).join('')}</span>` : '';
        html += `${warn}${err}<div class="meta-sub">${saved}<span class="spacer"></span><button class="linkish" data-act="shares">Shared links</button><span>Signed in as ${esc(me.name)}${state.server.mode === 'demo' ? ' (demo)' : ''}</span><button class="linkish" data-act="logout">Sign out</button><button class="linkish" data-act="delete-me">Delete my data</button></div>
          <div class="confirm" id="confirm-delete-me" hidden><span>Delete your Meta connection and every synced number, note and share link from this app? Your ad account itself is not touched.</span><button class="btn danger small" data-act="delete-me-yes">Delete everything</button><button class="btn ghost small" data-act="delete-me-no">Cancel</button></div>`;
      }
    }
    host.innerHTML = `<div class="source">${html}</div>`;
  }

  async function applySaved(id: string): Promise<void> {
    const c = state.meta.comparisons.find((x) => x.id === id);
    if (!c) return;
    if (c.accountId) state.meta.accountId = c.accountId;
    state.meta.level = c.level || 'campaign';
    state.meta.preset = c.preset || 'custom';
    state.meta.since = c.since || null; state.meta.until = c.until || null;
    state.meta.pendingSelection = c.entityIds || null;
    state.selected = new Set();
    await loadEntities({ keepSelection: false });
    state.tab = 'compare';
    render();
  }

  interface ShareRow { token: string; title: string; url: string; active: boolean; revoked: boolean; expiresAt: number; views: number; lastViewedAt: number | null }
  async function openShares(): Promise<void> {
    const body = $('#shares-body');
    body.innerHTML = '<p class="muted">Loading…</p>';
    $<HTMLDialogElement>('#shares-dlg').showModal();
    try {
      const { shares } = await api<{ shares: ShareRow[] }>('GET', '/api/shares');
      body.innerHTML = shares.length ? `<ul class="share-list">${shares.map((s) => `<li><b>${esc(s.title)}</b>
        <span class="muted">${s.active ? `Expires ${shortDate(s.expiresAt)}` : s.revoked ? 'Revoked' : 'Expired'} · ${s.views} view${s.views === 1 ? '' : 's'}${s.lastViewedAt ? `, last ${ago(s.lastViewedAt)}` : ''}</span>
        ${s.active ? `<div class="row"><code>${esc(s.url)}</code><button class="btn tiny ghost" data-copy="${esc(s.url)}">Copy</button><button class="btn tiny danger" data-revoke="${esc(s.token)}">Revoke</button></div>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No shared links yet. Open a comparison and choose <b>Share</b>.</p>';
    } catch (e) { body.innerHTML = `<p class="notices">${esc(errMsg(e))}</p>`; }
  }

  function shareSnapshot(): { title: string; campaigns: Campaign[]; settings: Settings; range: Range | null } {
    const list = selectedCampaigns().map((c) => { const { autoValues, manualKeys, ...rest } = c; void autoValues; void manualKeys; return rest as Campaign; });
    const range = state.source === 'meta' ? state.meta.range : null;
    const single: Record<Level, string> = { campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };
    const title = (state.source === 'meta' ? `${single[state.meta.level]} comparison` : 'Campaign comparison') + (range ? `, ${fmtDay(range.since)} – ${fmtDay(range.until)}` : '');
    return { title, campaigns: list, settings: state.settings, range };
  }

  async function copyText(text: string, btn: HTMLElement | null): Promise<void> {
    try { await navigator.clipboard.writeText(text); if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); } }
    catch (e) {
      const code = btn && btn.parentElement ? btn.parentElement.querySelector('code') : null;
      const sel = getSelection();
      if (code && sel) { const r = document.createRange(); r.selectNodeContents(code); sel.removeAllRanges(); sel.addRange(r); }
    }
  }

  function signedOut(): void {
    state.meta = { ...state.meta, me: null, accounts: [], items: null, comparisons: [] };
    state.campaigns = [];
    state.selected.clear();
    render();
  }

  async function handleMetaAction(t: HTMLElement): Promise<void> {
    const act = t.dataset.act;
    if (act === 'sync') return startMetaSync();
    if (act === 'show-connect') { state.meta.showConnect = true; renderSource(); document.getElementById('token-input')?.focus(); return; }
    if (act === 'hide-connect') { state.meta.showConnect = false; renderSource(); return; }
    if (act === 'refresh-accounts') { await api<{ accounts: Account[] }>('POST', '/api/accounts/refresh', {}).then((d) => { state.meta.accounts = d.accounts; }).catch((e) => { state.meta.error = errMsg(e); }); return render(); }
    if (act === 'logout') { await api('POST', '/auth/logout', {}).catch(() => {}); return signedOut(); }
    if (act === 'delete-me') { $('#confirm-delete-me').hidden = false; return; }
    if (act === 'delete-me-no') { $('#confirm-delete-me').hidden = true; return; }
    if (act === 'delete-me-yes') { await api('DELETE', '/api/me').catch((e) => { state.meta.error = errMsg(e); }); return signedOut(); }
    if (act === 'shares') return openShares();
    if (act === 'save-cmp') { $('#save-cmp-row').hidden = false; $('#save-cmp-name').focus(); return; }
    if (act === 'save-cmp-cancel') { $('#save-cmp-row').hidden = true; return; }
    if (act === 'share') {
      const out = $('#share-out');
      out.hidden = false;
      out.innerHTML = '<span class="muted">Creating link…</span>';
      try {
        const { share } = await api<{ share: { url: string; expiresAt: number } }>('POST', '/api/shares', shareSnapshot());
        const local = /\/\/(localhost|127\.0\.0\.1)/.test(share.url);
        out.innerHTML = `<span>Anyone with this link can view this comparison (read-only) until ${shortDate(share.expiresAt)}. It's a snapshot: later syncs don't change it.</span>
          <div class="row"><code>${esc(share.url)}</code><button class="btn tiny" data-copy="${esc(share.url)}">Copy</button></div>
          ${local ? '<span class="muted">This app is running on your computer, so the link only opens here. It will work for others once the app is hosted online.</span>' : ''}`;
      } catch (e) { out.innerHTML = `<span class="notices">${esc(errMsg(e))}</span>`; }
    }
  }

  async function saveComparison(e: Event): Promise<void> {
    e.preventDefault();
    const name = inputVal('#save-cmp-name').trim();
    if (!name) return;
    try {
      const r = presetRange(state.meta.preset, state.meta.since, state.meta.until);
      const { comparison } = await api<{ comparison: SavedComparison }>('POST', '/api/comparisons', { name, accountId: state.meta.accountId, level: state.meta.level, preset: state.meta.preset, since: state.meta.preset === 'custom' ? r.since : null, until: state.meta.preset === 'custom' ? r.until : null, entityIds: [...state.selected] });
      state.meta.comparisons.unshift(comparison);
      $('#save-cmp-row').innerHTML = `<span class="muted">Saved as “${esc(comparison.name)}”. Find it on the Campaigns tab; it refreshes with new data.</span>`;
    } catch (err) { $('#save-cmp-row').insertAdjacentHTML('beforeend', `<span class="notices">${esc(errMsg(err))}</span>`); }
  }

  async function fillUsage(): Promise<void> {
    const box = document.getElementById('usage-box');
    if (!box) return;
    if (!state.meta.me) { box.hidden = true; return; }
    try {
      const u = await api<{ thisMonth?: Record<string, number>; totals: { adAccountsSynced: number; activeShareLinks: number } }>('GET', '/api/usage');
      const t = u.thisMonth || {};
      box.innerHTML = `<b>Usage this month</b><span>${t.sync || 0} syncs · ${t.meta_api_calls || 0} Meta API calls · ${t.share_created || 0} share links · ${t.comparison_saved || 0} saved comparisons</span><span>${u.totals.adAccountsSynced} ad account${u.totals.adAccountsSynced === 1 ? '' : 's'} syncing · ${u.totals.activeShareLinks} active share link${u.totals.activeShareLinks === 1 ? '' : 's'}</span>`;
      box.hidden = false;
    } catch (e) { box.hidden = true; }
  }

  function startViewer(snap: ShareSnapshot): void {
    state.viewer = snap;
    state.campaigns = (snap.campaigns || []).map(C.normaliseCampaign);
    state.selected = new Set(state.campaigns.map((c) => c.id));
    state.settings = { ...C.DEFAULT_SETTINGS, ...(snap.settings || {}) };
    state.tab = 'compare';
    state.compareView = 'overview';
    document.body.classList.add('viewer');
    const b = $('#viewer-banner');
    b.innerHTML = `<b>${esc(snap.title || 'Shared comparison')}</b><span>Read-only snapshot${snap.range ? ` of ${fmtDay(snap.range.since)} – ${fmtDay(snap.range.until)}` : ''}, shared ${snap.createdAt ? new Date(snap.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}. Link expires ${shortDate(snap.expiresAt)}.</span>`;
    b.hidden = false;
    document.title = (snap.title || 'Shared comparison') + ' · Campaign Analyser';
  }

  // ---------- Events ----------
  function wire(): void {
    document.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button, [data-tab-go]');
      if (!t) return;
      const d = t.dataset;
      if (d.source) { switchSource(d.source as Source); return; }
      if (d.level) { state.meta.level = d.level as Level; state.selected = new Set(); save(); loadEntities({ keepSelection: false }); return; }
      if (d.act) { handleMetaAction(t); return; }
      if (d.history) { setHistory(Number(d.history)); return; }
      if (d.themeSet) { setTheme(d.themeSet === 'dark' ? 'dark' : 'light'); return; }
      if (d.view) {
        state.compareView = d.view as CompareView; save(); renderCompareInner();
        const bar = document.querySelector('.cmp-bar');
        if (bar && bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: 'start' });
        return;
      }
      if (d.cmp) { applySaved(d.cmp); return; }
      if (d.cmpDel) { const id = d.cmpDel; api('DELETE', `/api/comparisons/${encodeURIComponent(id)}`).then(() => { state.meta.comparisons = state.meta.comparisons.filter((c) => c.id !== id); renderSource(); }).catch(() => {}); return; }
      if (d.copy) { copyText(d.copy, t); return; }
      if (d.revoke) { api('DELETE', `/api/shares/${encodeURIComponent(d.revoke)}`).then(openShares).catch(() => {}); return; }
      if (d.close) { $<HTMLDialogElement>('#' + d.close).close(); return; }
      if (d.trend) { state.trendMetric = d.trend; redrawChart('trend'); return; }
      if (d.dl) { (t.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); download(d.dl); return; }
      if (t.classList.contains('tab')) { state.tab = d.tab || 'campaigns'; save(); render(); window.scrollTo(0, 0); }
      else if (d.tabGo) { state.tab = d.tabGo; save(); render(); }
      else if (d.edit) openEditor(d.edit);
      else if (t.id === 'btn-add') openEditor(null);
      else if (t.id === 'btn-example') { loadExample(); render(); }
      else if (t.id === 'btn-clear') $('#confirm-clear').hidden = false;
      else if (t.id === 'btn-clear-yes') { state.campaigns = []; state.selected.clear(); state.isExample = false; state.warnings = []; $('#confirm-clear').hidden = true; save(); render(); }
      else if (t.id === 'btn-clear-no') $('#confirm-clear').hidden = true;
      else if (t.id === 'btn-settings') { openSettings(); fillUsage(); }
      else if (t.id === 'editor-cancel') $<HTMLDialogElement>('#editor').close();
      else if (t.id === 'settings-cancel') $<HTMLDialogElement>('#settings').close();
      else if (t.id === 'editor-delete') {
        const id = state.editingId;
        state.campaigns = state.campaigns.filter((c) => c.id !== id);
        if (id) state.selected.delete(id);
        $<HTMLDialogElement>('#editor').close();
        save();
        render();
      }
    });
    // Close the download menu when clicking elsewhere.
    document.addEventListener('pointerdown', (e) => {
      for (const m of $$<HTMLDetailsElement>('details.menu[open]')) if (!m.contains(e.target as Node)) m.removeAttribute('open');
    });
    document.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const tid = el.id;
      if (tid === 'm-autosync') { setAutoSync(el.checked); return; }
      if (tid === 'm-history') { setHistory(Number(el.value)); return; }
      if (tid === 'm-account') { state.meta.accountId = el.value; state.selected = new Set(); save(); loadEntities({ keepSelection: false }); return; }
      if (tid === 'm-preset') { state.meta.preset = el.value; if (el.value === 'custom') { const r = presetRange('last30'); state.meta.since = state.meta.since || r.since; state.meta.until = state.meta.until || r.until; } save(); loadEntities(); return; }
      if (tid === 'm-since' || tid === 'm-until') { state.meta[tid === 'm-since' ? 'since' : 'until'] = el.value; if (state.meta.since && state.meta.until && state.meta.since <= state.meta.until) { save(); loadEntities(); } return; }
      const id = el.dataset && el.dataset.select;
      if (!id) return;
      if (el.checked) state.selected.add(id); else state.selected.delete(id);
      save();
      render();
    });
    $<HTMLInputElement>('#file').addEventListener('change', (e) => { const input = e.target as HTMLInputElement; handleFiles(input.files); input.value = ''; });
    const dz = $('#dropzone');
    (['dragenter', 'dragover'] as const).forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    (['dragleave', 'drop'] as const).forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => handleFiles((e as DragEvent).dataTransfer ? (e as DragEvent).dataTransfer!.files : null));
    $('#editor-form').addEventListener('submit', saveEditor);
    $('#settings-form').addEventListener('submit', saveSettings);
    document.addEventListener('submit', (e) => { const id = (e.target as HTMLElement).id; if (id === 'save-cmp-row') saveComparison(e); if (id === 'token-form') connectWithToken(e); });
    if (location.hash === '#guide' || location.hash === '#compare') state.tab = location.hash.slice(1);

    // Chart tooltips: one shared box, shown on hover and on keyboard focus.
    const tip = $('#chart-tip');
    const showTip = (el: HTMLElement, x: number, y: number): void => {
      tip.textContent = el.dataset.tip || '';
      tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14)) + 'px';
      tip.style.top = (y - h - 12 < 8 ? y + 18 : y - h - 12) + 'px';
    };
    const hideTip = (): void => { tip.hidden = true; };
    const tipOf = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null);
    document.addEventListener('pointermove', (e) => {
      const el = tipOf(e.target);
      if (el) showTip(el, e.clientX, e.clientY); else if (!tip.hidden) hideTip();
    });
    document.addEventListener('focusin', (e) => {
      const el = tipOf(e.target);
      if (!el) return hideTip();
      const b = el.getBoundingClientRect();
      showTip(el, b.left + b.width / 2, b.top);
    });
    document.addEventListener('scroll', hideTip, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideTip(); $$<HTMLDetailsElement>('details.menu[open]').forEach((m) => m.removeAttribute('open')); } });

    // Redraw charts when the width changes enough to matter.
    let lastW = window.innerWidth;
    let timer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Math.abs(window.innerWidth - lastW) < 40) return;
        lastW = window.innerWidth;
        if (state.tab === 'compare') renderCompare();
      }, 180);
    });
  }

  async function start(): Promise<void> {
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
