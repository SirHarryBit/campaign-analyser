/* Campaign Analyser – charts.
 * Pure functions that turn a comparison result into SVG strings, so the same
 * charts render in the app (themed through CSS variables, custom tooltips) and
 * in the downloaded report (fixed light colours, native <title> tooltips).
 * Exposes `CampaignCharts` on window, and module.exports in Node.
 */
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const CH = 7; // rough width of one 13px character, for truncation

  // Palettes. App: CSS variables (follow light/dark). Report: fixed light values.
  const PAL_APP = {
    s: ['var(--s0)', 'var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'],
    ink: 'var(--ink)', ink2: 'var(--ink-2)', line: 'var(--line)', surface: 'var(--surface)',
  };
  const PAL_PRINT = {
    s: ['#b9c1cd', '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'],
    ink: '#141c27', ink2: '#4d5868', line: '#d8dee8', surface: '#ffffff',
  };

  // ---------- helpers ----------
  function trunc(s, px) {
    const max = Math.max(4, Math.floor(px / CH));
    s = String(s ?? '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw - 1e-12);
  }
  function ticks(max, n = 4) {
    if (!(max > 0)) return [0, 1];
    const step = niceStep(max / n);
    const out = [];
    for (let v = 0; v < max + step - 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function symbol(C, cur) {
    return C.fmtMoney(0, cur).replace(/[\d.,\s]/g, '') || cur + ' ';
  }
  function shortMoney(C, cur, v) {
    const sym = symbol(C, cur);
    const t = (x) => String(+x.toFixed(x < 10 ? 1 : 0));
    if (cur === 'INR') {
      if (v >= 1e7) return sym + t(v / 1e7) + 'Cr';
      if (v >= 1e5) return sym + t(v / 1e5) + 'L';
    } else if (v >= 1e6) return sym + t(v / 1e6) + 'M';
    if (v >= 1e3) return sym + t(v / 1e3) + 'k';
    return sym + t(v);
  }
  const pct0 = (v) => Math.round(v * 100) + '%';
  const shortPct = (v) => (v < 0.1 ? +(v * 100).toFixed(1) : Math.round(v * 100)) + '%';
  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  }
  const DAY = 86400000;

  // A bar with a 4px rounded data end, square at the baseline.
  function hbar(x, y, w, h, r = 4) {
    if (w <= 0) return '';
    r = Math.min(r, w, h / 2);
    return `M${x},${y}h${(w - r).toFixed(2)}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r).toFixed(2)}z`;
  }

  // Interactive mark wrapper: custom tooltip in the app, <title> in the report.
  function tipAttrs(ctx, text) {
    return ctx.nativeTips ? '' : ` tabindex="0" data-tip="${esc(text)}"`;
  }
  function tipTitle(ctx, text) {
    return ctx.nativeTips ? `<title>${esc(text)}</title>` : '';
  }
  function txt(x, y, s, { size = 12, fill, anchor = 'start', weight = 400, mono = false } = {}) {
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}"${mono ? ' font-family="IBM Plex Mono, ui-monospace, monospace"' : ''} style="fill:${fill}">${esc(s)}</text>`;
  }
  function svgWrap(W, H, label, body) {
    return `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" font-family="Public Sans, system-ui, sans-serif">${body}</svg>`;
  }
  function table(head, rows) {
    return `<table class="chart-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody></table>`;
  }

  // Shared row layout for the horizontal charts. Narrow screens put the name above the bar.
  function rowLayout(W, n, { valW = 150, rowGap = 36 } = {}) {
    const narrow = W < 560;
    const labelW = narrow ? 0 : Math.min(250, Math.round(W * 0.3));
    const vW = narrow ? 0 : valW;
    const rowH = narrow ? 50 : rowGap;
    const top = 6, axisH = 24;
    const x0 = narrow ? 2 : labelW + 12;
    const x1 = W - (narrow ? 8 : vW + 12);
    return { W, narrow, labelW, vW, rowH, top, axisH, x0, x1, H: top + n * rowH + axisH, y: (i) => top + i * rowH, barY: (i) => top + i * rowH + (narrow ? 26 : 11) };
  }
  // Row name + value text, placed for wide or narrow layouts.
  function rowText(L, W, i, name, value, pal) {
    if (L.narrow) {
      const valPx = value.length * 6.6;
      return txt(2, L.y(i) + 15, trunc(name, W - valPx - 16), { size: 13, fill: pal.ink, weight: 600 }) +
        txt(W - 2, L.y(i) + 15, value, { size: 12, fill: pal.ink2, anchor: 'end', mono: true });
    }
    return txt(L.labelW, L.barY(i) + 10, trunc(name, L.labelW), { size: 13, fill: pal.ink, anchor: 'end', weight: 600 }) +
      txt(W - 2, L.barY(i) + 10, value, { size: 12, fill: pal.ink2, anchor: 'end', mono: true });
  }
  function xAxis(L, scale, tickVals, fmt, pal) {
    const yTop = L.top - 2, yBot = L.H - L.axisH + 2;
    return tickVals.map((t) => {
      const x = scale(t);
      return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yTop}" y2="${yBot}" style="stroke:${pal.line}" stroke-width="1"/>` +
        edgeTxt(x, L.H - 6, fmt(t), L.W, pal);
    }).join('');
  }

  // Tick label that never spills past the left or right edge.
  function edgeTxt(x, y, s, W, pal) {
    const half = (String(s).length * 6.6) / 2;
    const anchor = x - half < 0 ? 'start' : x + half > W ? 'end' : 'middle';
    return txt(anchor === 'start' ? Math.max(x, 0) : anchor === 'end' ? Math.min(x, W) : x, y, s, { size: 11, fill: pal.ink2, anchor, mono: true });
  }

  // ---------- 1. Budget and spend (bullet) ----------
  function budgetSpend(ctx) {
    const { items, C, cur, pal, W } = ctx;
    const rows = items.filter((it) => isNum(it.m.spend));
    if (rows.length < 2) return { empty: 'Add amount spent to at least two campaigns to see this.' };
    const max = Math.max(...rows.map((it) => Math.max(it.m.spend, it.m.budget || 0)));
    const tv = ticks(max);
    const L = rowLayout(W, rows.length, { valW: 160 });
    const sx = (v) => L.x0 + (v / tv[tv.length - 1]) * (L.x1 - L.x0);
    let body = xAxis(L, sx, tv, (t) => shortMoney(C, cur, t), pal);
    rows.forEach((it, i) => {
      const m = it.m, y = L.barY(i), col = pal.s[ctx.slot(it.c.id)];
      const used = isNum(m.budget) && m.budget > 0 ? m.spend / m.budget : null;
      const tip = `${it.c.name}\nSpent ${C.fmtMoney(m.spend, cur)}${isNum(m.budget) ? ` of ${C.fmtMoney(m.budget, cur)} budget (${pct0(used)} used)` : ' · no budget entered'}`;
      body += `<g${tipAttrs(ctx, tip)} class="mark">${tipTitle(ctx, tip)}<rect x="${L.x0}" y="${y - 6}" width="${L.x1 - L.x0}" height="24" fill="transparent"/>` +
        `<path d="${hbar(L.x0, y, sx(m.spend) - L.x0, 12)}" style="fill:${col}"/>` +
        (isNum(m.budget) && m.budget > 0 ? `<line x1="${sx(m.budget).toFixed(1)}" x2="${sx(m.budget).toFixed(1)}" y1="${y - 5}" y2="${y + 17}" style="stroke:${pal.ink}" stroke-width="2"/>` : '') + '</g>';
      body += rowText(L, W, i, it.c.name, isNum(m.budget) ? `${shortMoney(C, cur, m.spend)} of ${shortMoney(C, cur, m.budget)} · ${pct0(used)}` : `${shortMoney(C, cur, m.spend)} · no budget`, pal);
    });
    const under = rows.filter((it) => isNum(it.m.budgetUsedPct) && it.m.budgetUsedPct < 0.7);
    const note = under.length
      ? `${under.map((it) => it.c.name).join(', ')} spent under 70% of budget. Delivery was limited (audience too small, bid cap, or ads rejected), so its results may be understated.`
      : 'Every campaign with a budget spent most of it, so spend is a fair basis for comparison.';
    return {
      svg: svgWrap(W, L.H, 'Bar chart of amount spent per campaign with budget markers', body),
      key: [['bar', 'Amount spent'], ['tick', 'Budget']],
      note,
      table: table(['Campaign', 'Spent', 'Budget', 'Budget used'], rows.map((it) => [it.c.name, C.fmtMoney(it.m.spend, cur), C.fmtMoney(it.m.budget, cur), C.fmtPct(it.m.budgetUsedPct)])),
    };
  }

  // ---------- 2. Share of spend vs share of results (100% stacks) ----------
  function shareOfResults(ctx) {
    const { items, C, cur, pal, W } = ctx;
    const cand = [['spend', 'Spend'], ['leads', 'Leads'], ['qualifiedLeads', 'Qualified leads'], ['conversions', 'Conversions']];
    const skipped = [];
    const metrics = cand.filter(([k, label]) => {
      const vals = items.map((it) => (k === 'spend' ? it.m.spend : it.c[k]));
      const tot = vals.filter(isNum).reduce((a, b) => a + b, 0);
      if (!(tot > 0)) return false;
      if (vals.some((v) => !isNum(v))) { skipped.push(`${label.toLowerCase()} (missing for ${items.filter((it, j) => !isNum(vals[j])).map((it) => it.c.name).join(', ')})`); return false; }
      return true;
    });
    if (metrics.length < 2 || metrics[0][0] !== 'spend') return { empty: 'Needs amount spent and at least one result (leads, qualified leads or conversions) for every campaign.' };
    const L = rowLayout(W, metrics.length, { valW: 0, rowGap: 40 });
    L.x1 = W - 4; L.H -= L.axisH - 4;
    const shares = {};
    let body = '';
    metrics.forEach(([k, label], i) => {
      const vals = items.map((it) => (k === 'spend' ? it.m.spend : it.c[k]));
      const tot = vals.reduce((a, b) => a + b, 0);
      shares[k] = {};
      const y = L.barY(i) - 4, h = 20, span = L.x1 - L.x0;
      let x = L.x0;
      body += L.narrow ? txt(2, L.y(i) + 15, label, { size: 13, fill: pal.ink, weight: 600 }) : txt(L.labelW, y + 14, label, { size: 13, fill: pal.ink, anchor: 'end', weight: 600 });
      items.forEach((it, j) => {
        const s = vals[j] / tot;
        shares[k][it.c.id] = s;
        const w = s * span;
        const gap = j < items.length - 1 ? 2 : 0;
        const val = k === 'spend' ? C.fmtMoney(vals[j], cur) : C.fmtInt(vals[j]);
        const tip = `${it.c.name}\n${label}: ${val} (${pct0(s)} of total)`;
        if (w > 0.5) {
          body += `<g${tipAttrs(ctx, tip)} class="mark">${tipTitle(ctx, tip)}<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(0.5, w - gap).toFixed(1)}" height="${h}" rx="3" style="fill:${pal.s[ctx.slot(it.c.id)]}"/>`;
          if (w - gap >= 44) {
            const cx = x + (w - gap) / 2;
            body += `<rect x="${(cx - 18).toFixed(1)}" y="${y + 3}" width="36" height="14" rx="7" style="fill:${pal.surface}" opacity="0.92"/>` + txt(cx, y + 14, pct0(s), { size: 11, fill: pal.ink, anchor: 'middle', mono: true, weight: 600 });
          }
          body += '</g>';
        }
        x += w;
      });
    });
    // Efficiency story: compare the best available result row with spend share.
    const resultKey = metrics[metrics.length - 1][0];
    const resultLabel = metrics[metrics.length - 1][1].toLowerCase();
    const eff = items.map((it) => ({ it, s: shares.spend[it.c.id], r: shares[resultKey][it.c.id] })).filter((e) => e.s > 0);
    eff.sort((a, b) => b.r / b.s - a.r / a.s);
    const best = eff[0], worst = eff[eff.length - 1];
    let note = `${best.it.c.name} took ${pct0(best.s)} of the spend and brought ${pct0(best.r)} of the ${resultLabel}.`;
    if (worst !== best) note += ` ${worst.it.c.name} took ${pct0(worst.s)} of the spend for ${pct0(worst.r)} of the ${resultLabel}.`;
    note += ' A result share bigger than the spend share means money worked harder there.';
    if (skipped.length) note += ` Not shown: ${skipped.join('; ')}.`;
    return {
      svg: svgWrap(W, L.H, `Stacked bars comparing each campaign's share of spend and of ${resultLabel}`, body),
      note,
      table: table(['Campaign', ...metrics.map((m) => m[1] + ' share')], items.map((it) => [it.c.name, ...metrics.map(([k]) => pct0(shares[k][it.c.id]))])),
    };
  }

  // ---------- 3. CPL vs cost per qualified lead (dumbbell) ----------
  function leadQualityCost(ctx) {
    const { items, C, cur, pal, W } = ctx;
    const rows = items.filter((it) => isNum(it.m.cpl) && isNum(it.m.cpql));
    if (rows.length < 2) return { empty: 'Add qualified leads (from your CRM) to at least two lead campaigns to see this.' };
    const max = Math.max(...rows.map((it) => it.m.cpql));
    const tv = ticks(max);
    const L = rowLayout(W, rows.length, { valW: 150 });
    const sx = (v) => L.x0 + 6 + (v / tv[tv.length - 1]) * (L.x1 - L.x0 - 12);
    let body = xAxis(L, sx, tv, (t) => shortMoney(C, cur, t), pal);
    rows.forEach((it, i) => {
      const m = it.m, cy = L.barY(i) + 6, col = pal.s[ctx.slot(it.c.id)];
      const a = sx(m.cpl), b = sx(m.cpql);
      const mult = m.cpql / m.cpl;
      const tip = `${it.c.name}\nCPL ${C.fmtMoney(m.cpl, cur)} → per qualified lead ${C.fmtMoney(m.cpql, cur)} (${mult.toFixed(1)}×)`;
      body += `<g${tipAttrs(ctx, tip)} class="mark">${tipTitle(ctx, tip)}<rect x="${L.x0}" y="${cy - 12}" width="${L.x1 - L.x0}" height="24" fill="transparent"/>` +
        `<line x1="${a.toFixed(1)}" x2="${b.toFixed(1)}" y1="${cy}" y2="${cy}" style="stroke:${col}" stroke-width="2"/>` +
        `<circle cx="${a.toFixed(1)}" cy="${cy}" r="5" style="fill:${pal.surface};stroke:${col}" stroke-width="2"/>` +
        `<circle cx="${b.toFixed(1)}" cy="${cy}" r="6" style="fill:${col};stroke:${pal.surface}" stroke-width="2"/></g>`;
      body += rowText(L, W, i, it.c.name, `${shortMoney(C, cur, m.cpl)} → ${shortMoney(C, cur, m.cpql)} · ${mult.toFixed(1)}×`, pal);
    });
    const byCpl = [...rows].sort((p, q) => p.m.cpl - q.m.cpl);
    const byCpql = [...rows].sort((p, q) => p.m.cpql - q.m.cpql);
    let note;
    if (byCpl[0] !== byCpql[0]) {
      note = `${byCpl[0].c.name} has the cheapest leads (${C.fmtMoney(byCpl[0].m.cpl, cur)}), but ${byCpql[0].c.name} has the cheapest qualified leads (${C.fmtMoney(byCpql[0].m.cpql, cur)} vs ${C.fmtMoney(byCpl[0].m.cpql, cur)}). Judge lead campaigns on the filled dot.`;
    } else {
      note = `${byCpl[0].c.name} wins on both: cheapest leads and cheapest qualified leads. The longer the line, the more junk leads a campaign pays for.`;
    }
    return {
      svg: svgWrap(W, L.H, 'Dumbbell chart from cost per lead to cost per qualified lead', body),
      key: [['hollow', 'Cost per lead'], ['filled', 'Cost per qualified lead']],
      note,
      table: table(['Campaign', 'CPL', 'Cost per qualified lead', 'Multiple'], rows.map((it) => [it.c.name, C.fmtMoney(it.m.cpl, cur), C.fmtMoney(it.m.cpql, cur), (it.m.cpql / it.m.cpl).toFixed(1) + '×'])),
    };
  }

  // ---------- 4. Cost vs quality map (bubble scatter) ----------
  function costQualityMap(ctx) {
    const { r, items, C, cur, pal, W } = ctx;
    const xKey = r.tiers[0].metrics[0];
    const haveQ = items.filter((it) => isNum(it.m.qualifiedPct)).length >= 2;
    const yKey = haveQ ? 'qualifiedPct' : 'ctr';
    const pts = items.filter((it) => isNum(it.m[xKey]) && isNum(it.m[yKey]));
    const xLab = C.METRIC_DEFS[xKey].label, yLab = C.METRIC_DEFS[yKey].label;
    if (pts.length < 2) return { empty: `Needs ${xLab.toLowerCase()} and ${yLab.toLowerCase()} for at least two campaigns.` };
    const H = W < 560 ? 300 : 340;
    const m = { l: 52, r: 18, t: 30, b: 44 };
    const xt = ticks(Math.max(...pts.map((p) => p.m[xKey])) * 1.12);
    const yt = ticks(Math.max(...pts.map((p) => p.m[yKey])) * 1.15);
    const sx = (v) => m.l + (v / xt[xt.length - 1]) * (W - m.l - m.r);
    const sy = (v) => H - m.b - (v / yt[yt.length - 1]) * (H - m.t - m.b);
    const fx = (v) => (C.METRIC_DEFS[xKey].fmt === 'money' ? shortMoney(C, cur, v) : String(v));
    let body = '';
    xt.forEach((t) => { body += `<line x1="${sx(t).toFixed(1)}" x2="${sx(t).toFixed(1)}" y1="${m.t}" y2="${H - m.b}" style="stroke:${pal.line}"/>` + edgeTxt(sx(t), H - m.b + 16, fx(t), W, pal); });
    yt.forEach((t) => { body += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" style="stroke:${pal.line}"/>` + txt(m.l - 6, sy(t) + 4, shortPct(t), { size: 11, fill: pal.ink2, anchor: 'end', mono: true }); });
    // Median guides split the plot into four zones.
    const med = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
    const mx = med(pts.map((p) => p.m[xKey])), my = med(pts.map((p) => p.m[yKey]));
    body += `<line x1="${sx(mx).toFixed(1)}" x2="${sx(mx).toFixed(1)}" y1="${m.t}" y2="${H - m.b}" style="stroke:${pal.ink2}" stroke-width="1" opacity="0.45"/>`;
    body += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(my).toFixed(1)}" y2="${sy(my).toFixed(1)}" style="stroke:${pal.ink2}" stroke-width="1" opacity="0.45"/>`;
    body += txt(m.l + 6, m.t + 14, 'Cheaper and better', { size: 11, fill: pal.ink2, weight: 600 });
    body += txt(W - m.r - 6, H - m.b - 8, 'Costlier and weaker', { size: 11, fill: pal.ink2, anchor: 'end', weight: 600 });
    body += txt(m.l - 44, 14, `↑ ${yLab.replace(/ \(.*\)$/, '')}: higher is better`, { size: 12, fill: pal.ink2 });
    body += txt(W - m.r, H - 6, `${xLab.replace(/ \(.*\)$/, '')}: left is cheaper →`, { size: 12, fill: pal.ink2, anchor: 'end' });
    const maxSpend = Math.max(...pts.map((p) => p.m.spend || 0)) || 1;
    const placed = pts.map((it) => { const cx = sx(it.m[xKey]), cy = sy(it.m[yKey]), rr = 6 + 10 * Math.sqrt((it.m.spend || 0) / (Math.max(...pts.map((p) => p.m.spend || 0)) || 1)); return { x0: cx - rr, x1: cx + rr, y0: cy - rr, y1: cy + rr }; });
    placed.push({ x0: m.l, x1: m.l + 120, y0: m.t, y1: m.t + 18 }, { x0: W - m.r - 130, x1: W - m.r, y0: H - m.b - 20, y1: H - m.b });
    // Draw biggest first so small bubbles stay on top.
    const order = [...pts].sort((a, b) => (b.m.spend || 0) - (a.m.spend || 0));
    let labels = '';
    order.forEach((it) => {
      const cx = sx(it.m[xKey]), cy = sy(it.m[yKey]);
      const rad = 6 + 10 * Math.sqrt((it.m.spend || 0) / maxSpend);
      const col = pal.s[ctx.slot(it.c.id)];
      const tip = `${it.c.name}\n${xLab}: ${C.formatMetric(xKey, it.m[xKey], cur)}\n${yLab}: ${C.fmtPct(it.m[yKey])}\nSpent: ${C.fmtMoney(it.m.spend, cur)}`;
      body += `<g${tipAttrs(ctx, tip)} class="mark">${tipTitle(ctx, tip)}<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${Math.max(rad, 12)}" fill="transparent"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" style="fill:${col};stroke:${pal.surface}" stroke-width="2" opacity="0.9"/></g>`;
      const name = trunc(it.c.name, Math.min(220, (W - m.l - m.r) * 0.55));
      const tw = name.length * 6.6;
      const cands = [];
      for (const off of [0, 15, -15, 30, -30]) {
        cands.push({ anchor: 'start', x: cx + rad + 6, y: cy + 4 + off });
        cands.push({ anchor: 'end', x: cx - rad - 6, y: cy + 4 + off });
      }
      cands.push({ anchor: 'middle', x: cx, y: cy - rad - 6 }, { anchor: 'middle', x: cx, y: cy + rad + 15 });
      const boxOf = (c) => {
        let x0 = c.anchor === 'start' ? c.x : c.anchor === 'end' ? c.x - tw : c.x - tw / 2;
        if (c.anchor === 'middle') { x0 = Math.min(W - m.r - tw - 2, Math.max(m.l + 2, x0)); c.x = x0 + tw / 2; }
        return { x0, x1: x0 + tw, y0: c.y - 11, y1: c.y + 3 };
      };
      const inside = (b) => b.x0 >= m.l + 2 && b.x1 <= W - m.r && b.y0 >= m.t && b.y1 <= H - m.b - 2;
      const free = (b) => !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
      let pick = cands.find((c) => { const b = boxOf(c); return inside(b) && free(b); }) || cands.find((c) => inside(boxOf(c))) || cands[0];
      const box = boxOf(pick);
      const lx = pick.x, ly = pick.y, anchorL = pick.anchor;
      placed.push(box);
      labels += txt(lx, ly, name, { size: 12, fill: pal.ink, anchor: anchorL, weight: 600 });
    });
    body += labels;
    const good = pts.filter((p) => p.m[xKey] <= mx && p.m[yKey] >= my).map((p) => p.c.name);
    const bad = pts.filter((p) => p.m[xKey] > mx && p.m[yKey] < my).map((p) => p.c.name);
    let note = good.length ? `Top-left (cheaper and better than the middle): ${good.join(', ')}.` : 'No campaign is both cheaper and better than the middle of the group.';
    if (bad.length) note += ` Bottom-right (costlier and weaker): ${bad.join(', ')}.`;
    if (!haveQ) note += ' Using click-through rate for quality because qualified leads are missing.';
    note += ' Bubble size shows amount spent.';
    return {
      svg: svgWrap(W, H, `Scatter plot of ${xLab} against ${yLab}`, body),
      note,
      table: table(['Campaign', xLab, yLab, 'Spent'], pts.map((it) => [it.c.name, C.formatMetric(xKey, it.m[xKey], cur), C.fmtPct(it.m[yKey]), C.fmtMoney(it.m.spend, cur)])),
    };
  }

  // ---------- 5. Timeline ----------
  function timeline(ctx) {
    const { items, C, cur, pal, W } = ctx;
    const rows = items.filter((it) => it.c.startDate && it.c.endDate);
    if (rows.length < 2) return { empty: 'Add start and end dates to at least two campaigns to see this.' };
    const t0 = Math.min(...rows.map((it) => Date.parse(it.c.startDate)));
    const t1 = Math.max(...rows.map((it) => Date.parse(it.c.endDate))) + DAY;
    const spanDays = Math.round((t1 - t0) / DAY);
    const L = rowLayout(W, rows.length, { valW: 160 });
    const sx = (t) => L.x0 + ((t - t0) / (t1 - t0)) * (L.x1 - L.x0);
    const stepDays = [1, 2, 7, 14, 30, 61, 91].find((s) => spanDays / s <= (L.narrow ? 4 : 6)) || 182;
    const tv = [];
    for (let t = t0; t <= t1; t += stepDays * DAY) tv.push(t);
    let body = xAxis(L, sx, tv, (t) => fmtDate(new Date(t).toISOString().slice(0, 10)), pal);
    rows.forEach((it, i) => {
      const a = sx(Date.parse(it.c.startDate)), b = sx(Date.parse(it.c.endDate) + DAY), y = L.barY(i);
      const days = it.m.days;
      const tip = `${it.c.name}\n${fmtDate(it.c.startDate)} – ${fmtDate(it.c.endDate)} · ${days} days\n${C.fmtMoney(it.m.dailySpend, cur)} a day`;
      body += `<g${tipAttrs(ctx, tip)} class="mark">${tipTitle(ctx, tip)}<rect x="${L.x0}" y="${y - 6}" width="${L.x1 - L.x0}" height="24" fill="transparent"/><rect x="${a.toFixed(1)}" y="${y}" width="${Math.max(3, b - a - 1).toFixed(1)}" height="12" rx="4" style="fill:${pal.s[ctx.slot(it.c.id)]}"/></g>`;
      body += rowText(L, W, i, it.c.name, `${days} days · ${shortMoney(C, cur, it.m.dailySpend || 0)}/day`, pal);
    });
    // Longest overlap between two campaigns on the same platform.
    let ov = null;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const p = rows[i], q = rows[j];
      const d = Math.round((Math.min(Date.parse(p.c.endDate), Date.parse(q.c.endDate)) + DAY - Math.max(Date.parse(p.c.startDate), Date.parse(q.c.startDate))) / DAY);
      if (d > 0 && (p.c.platform || '') === (q.c.platform || '') && (!ov || d > ov.d)) ov = { p, q, d };
    }
    const short = rows.filter((it) => it.m.days < 7).map((it) => it.c.name);
    let note = ov ? `${ov.p.c.name} and ${ov.q.c.name} ran together for ${ov.d} days on ${ov.p.c.platform || 'the same platform'}. If their audiences overlap they bid against each other and push costs up.` : 'No two campaigns on the same platform ran at the same time.';
    if (short.length) note += ` ${short.join(', ')} ran under a week, so ${short.length === 1 ? 'it was' : 'they were'} probably still in the learning phase.`;
    const missing = items.filter((it) => !(it.c.startDate && it.c.endDate)).map((it) => it.c.name);
    if (missing.length) note += ` No dates for ${missing.join(', ')}.`;
    return {
      svg: svgWrap(W, L.H, 'Timeline of when each campaign ran', body),
      note,
      table: table(['Campaign', 'Start', 'End', 'Days', 'Daily spend'], rows.map((it) => [it.c.name, it.c.startDate, it.c.endDate, String(it.m.days), C.fmtMoney(it.m.dailySpend, cur)])),
    };
  }

  // ---------- 6. Day by day (needs daily data from a Meta sync) ----------
  const TREND_METRICS = {
    cpl: { label: 'Cost per lead', money: true, num: (w) => w.spend, den: (w) => w.leads },
    cpc: { label: 'Cost per click', money: true, num: (w) => w.spend, den: (w) => w.clicks },
    cpm: { label: 'Cost per 1,000 impressions', money: true, num: (w) => w.spend * 1000, den: (w) => w.impressions },
    cpa: { label: 'Cost per conversion', money: true, num: (w) => w.spend, den: (w) => w.conversions },
    ctr: { label: 'Click-through rate', pct: true, num: (w) => w.clicks, den: (w) => w.impressions },
    spend: { label: 'Spend per day', money: true, num: (w) => w.spend, den: (w) => w.days },
    leads: { label: 'Leads per day', num: (w) => w.leads, den: (w) => w.days },
  };
  const DEFAULT_TREND = { leads: 'cpl', traffic: 'cpc', engagement: 'cpc', video_views: 'cpm', awareness: 'cpm', conversions: 'cpa' };

  /** 7-day rolling value of a metric for each date (sums first, then divide). */
  function rolling(daily, dates, metric, win = 7) {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const def = TREND_METRICS[metric];
    return dates.map((date, i) => {
      const w = { spend: 0, impressions: 0, clicks: 0, leads: 0, conversions: 0, days: 0 };
      let have = 0;
      for (let j = Math.max(0, i - win + 1); j <= i; j++) {
        const d = byDate.get(dates[j]);
        w.days++;
        if (!d) continue;
        have++;
        w.spend += d.spend || 0; w.impressions += d.impressions || 0; w.clicks += d.clicks || 0;
        w.leads += d.leads || 0; w.conversions += d.conversions || 0;
      }
      if (!byDate.has(date) || have < Math.min(3, i + 1)) return null;
      const den = def.den(w);
      return den > 0 ? def.num(w) / den : null;
    });
  }

  function trendChart(ctx) {
    const { r, items, C, cur, pal, W } = ctx;
    const withDaily = items.filter((it) => Array.isArray(it.c.daily) && it.c.daily.length >= 3);
    if (withDaily.length < 2) return { empty: 'Day-by-day lines need data synced from Meta. Imported files only have totals.' };
    const available = Object.keys(TREND_METRICS).filter((k) => {
      if (k === 'cpl' || k === 'leads') return withDaily.some((it) => it.c.daily.some((d) => d.leads > 0));
      if (k === 'cpa') return withDaily.some((it) => it.c.daily.some((d) => d.conversions > 0));
      return true;
    });
    let metric = ctx.trendMetric && available.includes(ctx.trendMetric) ? ctx.trendMetric : DEFAULT_TREND[r.objective];
    if (!available.includes(metric)) metric = available[0];
    const def = TREND_METRICS[metric];
    const allDates = [...new Set(withDaily.flatMap((it) => it.c.daily.map((d) => d.date)))].sort();
    const series = withDaily.map((it) => ({ it, vals: rolling(it.c.daily, allDates, metric) }));
    const maxV = Math.max(0, ...series.flatMap((s) => s.vals.filter(isNum)));
    if (!(maxV > 0)) return { empty: `No ${def.label.toLowerCase()} in this period.`, metric, metrics: available };
    const narrow = W < 560;
    const H = narrow ? 260 : 300;
    const m = { l: 52, r: narrow ? 12 : 150, t: 12, b: 30 };
    const yt = ticks(maxV * 1.1);
    const n = allDates.length;
    const sx = (i) => m.l + (n === 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
    const sy = (v) => H - m.b - (v / yt[yt.length - 1]) * (H - m.t - m.b);
    const fmt = (v) => (def.money ? shortMoney(C, cur, v) : def.pct ? shortPct(v) : (v < 10 ? v.toFixed(1) : String(Math.round(v))));
    const fmtLong = (v) => (!isNum(v) ? '—' : def.money ? C.fmtMoney(v, cur) : def.pct ? C.fmtPct(v) : v.toFixed(1));
    let body = '';
    yt.forEach((t) => { body += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" style="stroke:${pal.line}"/>` + txt(m.l - 6, sy(t) + 4, fmt(t), { size: 11, fill: pal.ink2, anchor: 'end', mono: true }); });
    const step = Math.max(1, Math.ceil(n / (narrow ? 4 : 7)));
    for (let i = 0; i < n; i += step) body += edgeTxt(sx(i), H - 8, fmtDate(allDates[i]), W - m.r + 20, pal);
    // Lines, broken where there is no value.
    for (const s of series) {
      const col = pal.s[ctx.slot(s.it.c.id)];
      let d = '', pen = false;
      s.vals.forEach((v, i) => {
        if (!isNum(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
        pen = true;
      });
      body += `<path d="${d}" fill="none" style="stroke:${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // Direct labels at each line's last value (wide screens), nudged apart.
    if (!narrow) {
      const ends = series.map((s) => {
        let i = s.vals.length - 1; while (i >= 0 && !isNum(s.vals[i])) i--;
        return i < 0 ? null : { s, i, y: sy(s.vals[i]) };
      }).filter(Boolean).sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
      for (const e of ends) {
        body += `<circle cx="${sx(e.i).toFixed(1)}" cy="${sy(e.s.vals[e.i]).toFixed(1)}" r="3.5" style="fill:${pal.s[ctx.slot(e.s.it.c.id)]};stroke:${pal.surface}" stroke-width="2"/>`;
        body += txt(W - m.r + 8, e.y + 4, trunc(e.s.it.c.name, m.r - 12), { size: 12, fill: pal.ink, weight: 600 });
      }
    }
    // Hover columns: a crosshair and one tooltip listing every line at that date.
    const colW = n > 1 ? (W - m.l - m.r) / (n - 1) : W - m.l - m.r;
    allDates.forEach((date, i) => {
      const lines = series.map((s) => `${s.it.c.name}: ${fmtLong(s.vals[i])}`).join('\n');
      const tip = `${fmtDate(date)} · ${def.label} (7-day)\n${lines}`;
      const x = sx(i);
      body += `<g class="mark col"${ctx.nativeTips ? '' : ` data-tip="${esc(tip)}"`}>${tipTitle(ctx, tip)}<rect x="${(x - colW / 2).toFixed(1)}" y="${m.t}" width="${Math.max(2, colW).toFixed(1)}" height="${H - m.t - m.b}" fill="transparent"/><line class="xhair" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${m.t}" y2="${H - m.b}" style="stroke:${pal.ink2}" stroke-width="1" opacity="0"/></g>`;
    });
    // Story: compare the first and last full week.
    const changes = series.map((s) => {
      const vals = s.vals.map((v, i) => [v, i]).filter(([v]) => isNum(v));
      if (vals.length < 10) return null;
      const first = vals[Math.min(6, vals.length - 1)][0], last = vals[vals.length - 1][0];
      return { s, first, last, pct: first > 0 ? last / first - 1 : null };
    }).filter((x) => x && isNum(x.pct));
    const lowerBetter = def.money && metric !== 'spend';
    let note = `Lines are 7-day rolling ${def.label.toLowerCase()}, so single-day spikes are smoothed out.`;
    if (changes.length) {
      const worst = [...changes].sort((a, b) => (lowerBetter ? b.pct - a.pct : a.pct - b.pct))[0];
      const dir = worst.pct > 0 ? 'rose' : 'fell';
      const bad = lowerBetter ? worst.pct > 0.15 : worst.pct < -0.15;
      note = `${worst.s.it.c.name}: ${def.label.toLowerCase()} ${dir} ${Math.abs(Math.round(worst.pct * 100))}% from its first week (${fmtLong(worst.first)}) to its latest (${fmtLong(worst.last)}).` +
        (bad ? (lowerBetter ? ' Rising costs over time often mean the audience is tiring of the ads: refresh the creative or widen the audience.' : ' A falling rate over time often means creative fatigue.') : '') + ' ' + note;
    }
    return {
      svg: svgWrap(W, H, `Line chart of ${def.label} by day`, body),
      metric, metrics: available,
      note,
      table: table(['Campaign', `${def.label}: first week`, 'Latest week', 'Change'], changes.map((c) => [c.s.it.c.name, fmtLong(c.first), fmtLong(c.last), (c.pct > 0 ? '+' : '') + Math.round(c.pct * 100) + '%'])),
    };
  }

  const CHARTS = [
    { id: 'budget', step: 'Step 1 · Cost and budget', title: 'Budget and spend', sub: 'How much went into each campaign, and how much of the plan was used.', fn: budgetSpend },
    { id: 'share', step: 'Step 1 · Cost and budget', title: 'Share of spend vs share of results', sub: 'Who took the money, and who delivered.', fn: shareOfResults },
    { id: 'quality', step: 'Step 2 · Audience and lead quality', title: 'Cheap leads vs cheap good leads', sub: 'From cost per lead to cost per qualified lead.', fn: leadQualityCost, leadsOnly: true },
    { id: 'map', step: 'Step 2 · Audience and lead quality', title: 'Cost vs quality map', sub: 'The top-left corner is where you want to be.', fn: costQualityMap },
    { id: 'time', step: 'Step 3 · Duration', title: 'When they ran', sub: 'Length of each run, overlaps and daily spend.', fn: timeline },
    { id: 'trend', step: 'Step 3 · Duration', title: 'Day by day', sub: 'How each one moved over the period. Spot fatigue and rising costs early.', fn: trendChart, dailyOnly: true },
  ];

  /**
   * Build every chart for a comparison result.
   * opts: { C, cur, width, slot(id) -> 1..5, print: bool }
   */
  function buildCharts(r, opts) {
    const ctx = { r, items: r.items, C: opts.C, cur: opts.cur, W: Math.round(opts.width), slot: opts.slot, pal: opts.print ? PAL_PRINT : PAL_APP, nativeTips: !!opts.print, trendMetric: opts.trendMetric };
    const hasDaily = r.items.some((it) => Array.isArray(it.c.daily) && it.c.daily.length);
    return CHARTS.filter((c) => (!c.leadsOnly || r.objective === 'leads') && (!c.dailyOnly || hasDaily)).map((c) => {
      let out;
      try { out = c.fn(ctx); } catch (e) { out = { empty: 'This chart could not be drawn from the current data.' }; }
      return { ...c, ...out };
    });
  }

  // Small inline key swatches for charts with more than one mark type.
  function keyHtml(key, pal) {
    if (!key) return '';
    const sw = {
      bar: `<svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" rx="2" style="fill:${pal.ink2}"/></svg>`,
      tick: `<svg width="6" height="14" aria-hidden="true"><rect x="2" width="2" height="14" style="fill:${pal.ink}"/></svg>`,
      hollow: `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" style="fill:none;stroke:${pal.ink2}" stroke-width="2"/></svg>`,
      filled: `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5.5" style="fill:${pal.ink2}"/></svg>`,
    };
    return `<span class="chart-key">${key.map(([k, l]) => `<span>${sw[k]} ${esc(l)}</span>`).join('')}</span>`;
  }

  const api = { buildCharts, keyHtml, PAL_APP, PAL_PRINT, ticks, shortMoney, CHARTS, TREND_METRICS, rolling };
  root.CampaignCharts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
