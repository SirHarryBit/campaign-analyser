/* Campaign Analyser – charts.
 * Pure functions that turn a comparison result into SVG strings, so the same
 * charts render in the app (themed through CSS variables, custom tooltips) and
 * in the downloaded report (fixed light colours, native <title> tooltips).
 * Exposes `CampaignCharts` on window, and module.exports in Node.
 */
(function (root: { CampaignCharts?: ChartsApi }) {
  interface Ctx {
    r: CompareResult;
    items: CompareItem[];
    C: CoreApi;
    cur: string;
    W: number;
    slot: (id: string) => number;
    pal: ChartPalette;
    nativeTips: boolean;
    trendMetric?: string | null;
    uid: string;
  }
  type ChartBody = Omit<ChartOut, 'id' | 'title' | 'sub' | 'size'>;
  interface ChartDef { id: string; title: string; sub: string; size: 'wide' | 'half'; fn: (ctx: Ctx) => ChartBody; leadsOnly?: boolean; dailyOnly?: boolean }

  const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
  const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
  const CH = 7; // rough width of one 13px character, for truncation
  const FONT = 'Poppins, system-ui, sans-serif';
  const f1 = (n: number): string => n.toFixed(1);

  // Palettes. App: CSS variables (follow light/dark). Report: fixed light values.
  const PAL_APP: ChartPalette = {
    s: ['var(--s0)', 'var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'],
    ink: 'var(--ink)', ink2: 'var(--ink-2)', line: 'var(--line)', surface: 'var(--surface)', brand: 'var(--brand)',
  };
  const PAL_PRINT: ChartPalette = {
    s: ['#c9c6bf', '#5b6cf0', '#ec8a2a', '#22b0c8', '#d9548a', '#8a9a2c'],
    ink: '#1c1b1f', ink2: '#6f6c75', line: '#e6e2da', surface: '#ffffff', brand: '#4f5fe6',
  };

  // ---------- helpers ----------
  function trunc(s: unknown, px: number): string {
    const max = Math.max(4, Math.floor(px / CH));
    const t = String(s ?? '');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
  function niceStep(raw: number): number {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw - 1e-12) as number;
  }
  function ticks(max: number, n = 4): number[] {
    if (!(max > 0)) return [0, 1];
    const step = niceStep(max / n);
    const out: number[] = [];
    for (let v = 0; v < max + step - 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function symbol(C: CoreApi, cur: string): string {
    return C.fmtMoney(0, cur).replace(/[\d.,\s]/g, '') || cur + ' ';
  }
  function shortMoney(C: CoreApi, cur: string, v: number): string {
    const sym = symbol(C, cur);
    const t = (x: number): string => String(+x.toFixed(x < 10 ? 1 : 0));
    if (cur === 'INR') {
      if (v >= 1e7) return sym + t(v / 1e7) + 'Cr';
      if (v >= 1e5) return sym + t(v / 1e5) + 'L';
    } else if (v >= 1e6) return sym + t(v / 1e6) + 'M';
    if (v >= 1e3) return sym + t(v / 1e3) + 'k';
    return sym + t(v);
  }
  const pct0 = (v: number): string => Math.round(v * 100) + '%';
  const shortPct = (v: number): string => (v < 0.1 ? +(v * 100).toFixed(1) : Math.round(v * 100)) + '%';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso: string): string {
    const d = new Date(iso + 'T00:00:00Z');
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  const DAY = 86400000;
  const colorOf = (ctx: Ctx, id: string): string => ctx.pal.s[ctx.slot(id)] ?? ctx.pal.s[0];
  const gradId = (ctx: Ctx, chart: string, slot: number): string => `${ctx.uid}-${chart}-${slot}`;
  const fillUrl = (ctx: Ctx, chart: string, id: string): string => `url(#${gradId(ctx, chart, ctx.slot(id))})`;

  /**
   * One linear gradient per campaign colour. dir: 'down' = strong at the top,
   * 'up' = strong at the bottom, 'right' = strong at the right end.
   */
  function gradDefs(ctx: Ctx, chart: string, ids: string[], dir: 'down' | 'up' | 'right', strong = 1, faint = 0.32): string {
    const [x2, y2, a, b] = dir === 'right' ? [1, 0, faint, strong] : dir === 'up' ? [0, 1, faint, strong] : [0, 1, strong, faint];
    return [...new Set(ids.map(ctx.slot))].map((slot) => {
      const col = ctx.pal.s[slot];
      return `<linearGradient id="${gradId(ctx, chart, slot)}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" style="stop-color:${col};stop-opacity:${a}"/><stop offset="1" style="stop-color:${col};stop-opacity:${b}"/></linearGradient>`;
    }).join('');
  }
  // Fine diagonal texture laid over bars (the reference design's hatched look).
  function hatchDef(ctx: Ctx, chart: string): string {
    return `<pattern id="${ctx.uid}-${chart}-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.4" height="5" style="fill:${ctx.pal.surface}" opacity="0.28"/></pattern>`;
  }

  // Column with a rounded data end; grows up (dir -1) or down (dir 1) from y0.
  function vbar(x: number, y0: number, w: number, h: number, dir: -1 | 1, r = 8): string {
    if (h <= 0.5) return '';
    r = Math.min(r, w / 2, h);
    const yEnd = y0 + dir * h;
    const mid = f1(w - 2 * r);
    return dir < 0
      ? `M${f1(x)},${f1(y0)}V${f1(yEnd + r)}a${r},${r} 0 0 1 ${r},${-r}h${mid}a${r},${r} 0 0 1 ${r},${r}V${f1(y0)}Z`
      : `M${f1(x)},${f1(y0)}V${f1(yEnd - r)}a${r},${r} 0 0 0 ${r},${r}h${mid}a${r},${r} 0 0 0 ${r},${-r}V${f1(y0)}Z`;
  }
  // Point on a circle; angle 0 is 12 o'clock, clockwise.
  function polar(cx: number, cy: number, r: number, a: number): [number, number] {
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }
  function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
    const [x0, y0] = polar(cx, cy, r, a0);
    const [x1, y1] = polar(cx, cy, r, a1);
    return `M${f1(x0)},${f1(y0)}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f1(x1)},${f1(y1)}`;
  }

  // Interactive mark wrapper: custom tooltip in the app, <title> in the report.
  function tipAttrs(ctx: Ctx, text: string): string {
    return ctx.nativeTips ? '' : ` tabindex="0" data-tip="${esc(text)}"`;
  }
  function tipTitle(ctx: Ctx, text: string): string {
    return ctx.nativeTips ? `<title>${esc(text)}</title>` : '';
  }
  interface TxtOpts { size?: number; fill: string; anchor?: 'start' | 'middle' | 'end'; weight?: number }
  function txt(x: number, y: number, s: unknown, { size = 12, fill, anchor = 'start', weight = 400 }: TxtOpts): string {
    return `<text x="${f1(x)}" y="${f1(y)}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" style="fill:${fill};font-variant-numeric:tabular-nums">${esc(s)}</text>`;
  }
  function svgWrap(W: number, H: number, label: string, body: string, defs = ''): string {
    return `<svg class="chart-svg" width="${W}" height="${Math.ceil(H)}" viewBox="0 0 ${W} ${Math.ceil(H)}" role="img" aria-label="${esc(label)}" font-family="${FONT}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
  }
  function table(head: string[], rows: string[][]): string {
    return `<table class="chart-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody></table>`;
  }
  // Tick label that never spills past the left or right edge.
  function edgeTxt(x: number, y: number, s: string, W: number, pal: ChartPalette): string {
    const half = (s.length * 6.6) / 2;
    const anchor = x - half < 0 ? 'start' : x + half > W ? 'end' : 'middle';
    return txt(anchor === 'start' ? Math.max(x, 0) : anchor === 'end' ? Math.min(x, W) : x, y, s, { size: 11, fill: pal.ink2, anchor });
  }

  // ---------- donut (share of spend vs share of results) ----------
  interface Slice { value: number; id: string; tip: string }
  function donutG(ctx: Ctx, chart: string, cx: number, cy: number, R: number, thick: number, slices: Slice[]): string {
    const tot = slices.reduce((a, s) => a + s.value, 0);
    if (!(tot > 0)) return '';
    const rMid = R - thick / 2;
    const gap = 3 / rMid; // 3px between segments
    const cap = thick / 2 / rMid; // round caps reach past the angle by this much
    let a = 0;
    let out = `<circle cx="${cx}" cy="${cy}" r="${f1(rMid)}" fill="none" style="stroke:${ctx.pal.line}" stroke-width="${f1(thick)}" opacity="0.5"/>`;
    for (const s of slices) {
      const span = (s.value / tot) * Math.PI * 2;
      const a0 = a + gap / 2 + cap, a1 = a + span - gap / 2 - cap;
      const col = colorOf(ctx, s.id);
      let mark: string;
      if (slices.length === 1) mark = `<circle cx="${cx}" cy="${cy}" r="${f1(rMid)}" fill="none" style="stroke:${col}" stroke-width="${f1(thick)}"/>`;
      else if (a1 > a0) mark = `<path d="${arcPath(cx, cy, rMid, a0, a1)}" fill="none" stroke="${fillUrl(ctx, chart, s.id)}" stroke-width="${f1(thick)}" stroke-linecap="round"/>`;
      else { const [px, py] = polar(cx, cy, rMid, a + span / 2); mark = span > 0 ? `<circle cx="${f1(px)}" cy="${f1(py)}" r="${f1(Math.min(thick / 2, (span * rMid) / 2 + 1))}" style="fill:${col}"/>` : ''; }
      if (mark) out += `<g class="mark"${tipAttrs(ctx, s.tip)}>${tipTitle(ctx, s.tip)}${mark}</g>`;
      a += span;
    }
    return out;
  }

  // ---------- 1. Spend vs results (two donuts) ----------
  function shareOfResults(ctx: Ctx): ChartBody {
    const { items, C, cur, pal, W } = ctx;
    if (items.some((it) => !isNum(it.m.spend)) || !(items.reduce((a, it) => a + (it.m.spend || 0), 0) > 0)) return { empty: 'Needs amount spent for every campaign.' };
    const cand: [keyof Campaign & string, string][] = [['qualifiedLeads', 'Qualified leads'], ['leads', 'Leads'], ['conversions', 'Conversions']];
    const pick = cand.find(([k]) => items.every((it) => isNum(it.c[k])) && items.reduce((a, it) => a + (it.c[k] as number), 0) > 0);
    if (!pick) return { empty: 'Needs leads or conversions for every campaign.' };
    const [rk, rLabel] = pick;
    const spendTot = items.reduce((a, it) => a + (it.m.spend as number), 0);
    const resTot = items.reduce((a, it) => a + (it.c[rk] as number), 0);
    const share = items.map((it) => ({ it, s: (it.m.spend as number) / spendTot, r: (it.c[rk] as number) / resTot }));

    const D = Math.min(176, Math.floor((W - 28) / 2));
    const R = D / 2, thick = Math.max(14, Math.round(R * 0.27));
    const gapX = W - 2 * D;
    const cx1 = gapX / 3 + R, cx2 = W - gapX / 3 - R, cy = R + 4;
    let body = donutG(ctx, 'share', cx1, cy, R, thick, share.map((x) => ({ value: x.s, id: x.it.c.id, tip: `${x.it.c.name}\nSpend: ${C.fmtMoney(x.it.m.spend, cur)} (${pct0(x.s)})` })));
    body += donutG(ctx, 'share', cx2, cy, R, thick, share.map((x) => ({ value: x.r, id: x.it.c.id, tip: `${x.it.c.name}\n${rLabel}: ${C.fmtInt(x.it.c[rk] as number)} (${pct0(x.r)})` })));
    body += txt(cx1, cy - 6, 'Spend', { size: 12, fill: pal.ink2, anchor: 'middle' }) + txt(cx1, cy + 16, shortMoney(C, cur, spendTot), { size: D > 140 ? 20 : 16, fill: pal.ink, anchor: 'middle', weight: 500 });
    body += txt(cx2, cy - 6, rLabel, { size: 12, fill: pal.ink2, anchor: 'middle' }) + txt(cx2, cy + 16, C.fmtInt(resTot), { size: D > 140 ? 20 : 16, fill: pal.ink, anchor: 'middle', weight: 500 });
    // Legend rows: share of spend → share of results.
    let y = D + 30;
    for (const x of share) {
      const col = colorOf(ctx, x.it.c.id);
      const diff = Math.round((x.r - x.s) * 100);
      const right = `${pct0(x.s)} → ${pct0(x.r)}`;
      const delta = `${diff > 0 ? '+' : ''}${diff} pts`;
      body += `<rect x="2" y="${y - 9}" width="10" height="10" rx="3" style="fill:${col}"/>`;
      body += txt(20, y, trunc(x.it.c.name, W - 150), { size: 12.5, fill: pal.ink, weight: 500 });
      body += txt(W - 54, y, right, { size: 12, fill: pal.ink2, anchor: 'end' });
      body += txt(W - 2, y, delta, { size: 12, fill: pal.ink, anchor: 'end', weight: 600 });
      y += 26;
    }
    const eff = [...share].sort((a, b) => b.r / b.s - a.r / a.s);
    const best = eff[0], worst = eff[eff.length - 1];
    let note = `${best.it.c.name} got ${pct0(best.r)} of the ${rLabel.toLowerCase()} from ${pct0(best.s)} of the spend.`;
    if (worst !== best) note += ` ${worst.it.c.name}: ${pct0(worst.s)} of spend, ${pct0(worst.r)} of ${rLabel.toLowerCase()}.`;
    return {
      svg: svgWrap(W, y - 8, `Two donut charts: each campaign's share of spend and of ${rLabel.toLowerCase()}`, body, gradDefs(ctx, 'share', items.map((it) => it.c.id), 'right', 1, 0.6)),
      note,
      table: table(['Campaign', 'Share of spend', `Share of ${rLabel.toLowerCase()}`], share.map((x) => [x.it.c.name, pct0(x.s), pct0(x.r)])),
    };
  }

  // ---------- 2. Budget used (rings), or spend columns without budgets ----------
  function ringG(ctx: Ctx, cx: number, cy: number, R: number, thick: number, frac: number, stroke: string, tip: string): string {
    const rMid = R - thick / 2;
    const f = Math.max(0, Math.min(1, frac));
    let arc = '';
    if (f >= 0.999) arc = `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rMid)}" fill="none" stroke="${stroke}" stroke-width="${thick}"/>`;
    else if (f > 0) arc = `<path d="${arcPath(cx, cy, rMid, 0, Math.max(0.05, f * Math.PI * 2))}" fill="none" stroke="${stroke}" stroke-width="${thick}" stroke-linecap="round"/>`;
    return `<g class="mark"${tipAttrs(ctx, tip)}>${tipTitle(ctx, tip)}<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rMid)}" fill="none" style="stroke:${ctx.pal.line}" stroke-width="${thick}" opacity="0.6"/>${arc}</g>`;
  }
  function budgetSpend(ctx: Ctx): ChartBody {
    const { items, C, cur, pal, W } = ctx;
    const withBudget = items.filter((it) => isNum(it.m.spend) && isNum(it.m.budget) && (it.m.budget as number) > 0);
    if (withBudget.length >= 2) {
      const n = withBudget.length;
      const cols = n <= 3 || W >= 470 ? n : 3;
      const cell = W / cols;
      const D = Math.min(112, cell - 18);
      const thick = Math.max(9, Math.round(D * 0.12));
      const rowH = D + 50;
      const rows = Math.ceil(n / cols);
      let body = '';
      withBudget.forEach((it, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const inRow = Math.min(cols, n - row * cols);
        const offset = (W - inRow * cell) / 2;
        const cx = offset + cell * col + cell / 2, cy = row * rowH + D / 2 + 4;
        const used = (it.m.spend as number) / (it.m.budget as number);
        const tip = `${it.c.name}\nSpent ${C.fmtMoney(it.m.spend, cur)} of ${C.fmtMoney(it.m.budget, cur)} (${pct0(used)})`;
        body += ringG(ctx, cx, cy, D / 2, thick, used, fillUrl(ctx, 'budget', it.c.id), tip);
        body += txt(cx, cy + 6, pct0(used), { size: D > 90 ? 19 : 16, fill: pal.ink, anchor: 'middle', weight: 500 });
        body += txt(cx, row * rowH + D + 24, trunc(it.c.name, cell - 8), { size: 12, fill: pal.ink, anchor: 'middle', weight: 500 });
        body += txt(cx, row * rowH + D + 40, `${shortMoney(C, cur, it.m.spend as number)} of ${shortMoney(C, cur, it.m.budget as number)}`, { size: 11.5, fill: pal.ink2, anchor: 'middle' });
      });
      const under = withBudget.filter((it) => isNum(it.m.budgetUsedPct) && (it.m.budgetUsedPct as number) < 0.7);
      const note = under.length
        ? `${under.map((it) => it.c.name).join(', ')} spent under 70% of budget, so ${under.length === 1 ? 'its' : 'their'} results may be understated.`
        : 'Every campaign spent most of its budget, so spend is a fair basis for comparison.';
      return {
        svg: svgWrap(W, rows * rowH, 'Ring charts of how much of each budget was spent', body, gradDefs(ctx, 'budget', withBudget.map((it) => it.c.id), 'down', 1, 0.55)),
        note,
        table: table(['Campaign', 'Spent', 'Budget', 'Budget used'], items.map((it) => [it.c.name, C.fmtMoney(it.m.spend, cur), C.fmtMoney(it.m.budget, cur), C.fmtPct(it.m.budgetUsedPct)])),
      };
    }
    // Fallback: gradient columns of amount spent.
    const rows = items.filter((it) => isNum(it.m.spend));
    if (rows.length < 2) return { empty: 'Add amount spent to at least two campaigns to see this.' };
    const H = 210, top = 22, bot = 40;
    const max = Math.max(...rows.map((it) => it.m.spend as number));
    const band = W / rows.length, bw = Math.min(54, band * 0.55);
    let body = `<line x1="0" x2="${W}" y1="${H - bot}" y2="${H - bot}" style="stroke:${pal.line}"/>`;
    rows.forEach((it, i) => {
      const h = ((it.m.spend as number) / max) * (H - top - bot);
      const x = band * i + (band - bw) / 2;
      const tip = `${it.c.name}\nSpent ${C.fmtMoney(it.m.spend, cur)} · no budget entered`;
      body += `<g class="mark"${tipAttrs(ctx, tip)}>${tipTitle(ctx, tip)}<path d="${vbar(x, H - bot, bw, h, -1)}" fill="${fillUrl(ctx, 'budget', it.c.id)}"/><path d="${vbar(x, H - bot, bw, h, -1)}" fill="url(#${ctx.uid}-budget-hatch)"/></g>`;
      body += txt(x + bw / 2, H - bot - h - 7, shortMoney(C, cur, it.m.spend as number), { size: 11.5, fill: pal.ink, anchor: 'middle', weight: 500 });
      body += txt(x + bw / 2, H - bot + 18, trunc(it.c.name, band - 6), { size: 11.5, fill: pal.ink2, anchor: 'middle' });
    });
    return {
      svg: svgWrap(W, H, 'Column chart of amount spent per campaign', body, gradDefs(ctx, 'budget', rows.map((it) => it.c.id), 'down') + hatchDef(ctx, 'budget')),
      note: 'Add each campaign\'s budget to see how much of it was used.',
      table: table(['Campaign', 'Spent'], rows.map((it) => [it.c.name, C.fmtMoney(it.m.spend, cur)])),
    };
  }

  // ---------- 3. Cost per lead vs cost per qualified lead (mirrored columns) ----------
  function leadQualityCost(ctx: Ctx): ChartBody {
    const { items, C, cur, pal, W } = ctx;
    const rows = items.filter((it) => isNum(it.m.cpl) && isNum(it.m.cpql));
    if (rows.length < 2) return { empty: 'Add qualified leads (from your CRM) to at least two lead campaigns to see this.' };
    const narrow = W < 520;
    const half = narrow ? 92 : 118;
    const m = { l: narrow ? 62 : 82, r: 8, t: 24 }; // left margin holds the two rotated captions and the tick labels
    const y0 = m.t + half;
    const H = m.t + 2 * half + 20 + 24;
    const tv = ticks(Math.max(...rows.map((it) => it.m.cpql as number)));
    const top = tv[tv.length - 1];
    const sh = (v: number): number => (v / top) * half;
    const band = (W - m.l - m.r) / rows.length;
    const bw = Math.min(58, band * 0.5);
    let body = '';
    // Grid: mirrored ticks above and below the zero line.
    for (const t of tv.slice(1)) {
      for (const dir of [-1, 1]) {
        const y = y0 + dir * sh(t);
        body += `<line x1="${m.l}" x2="${W - m.r}" y1="${f1(y)}" y2="${f1(y)}" style="stroke:${pal.line}" stroke-dasharray="2 4"/>` + txt(m.l - 8, y + 4, shortMoney(C, cur, t), { size: 11, fill: pal.ink2, anchor: 'end' });
      }
    }
    body += `<line x1="${m.l}" x2="${W - m.r}" y1="${y0}" y2="${y0}" style="stroke:${pal.ink2}" opacity="0.5"/>`;
    body += txt(m.l - 8, y0 + 4, '0', { size: 11, fill: pal.ink2, anchor: 'end' });
    // Captions run up the left edge, clear of every bar and value label.
    // Rotated text runs bottom-to-top: 'start' grows upward from the point, 'end' grows downward.
    const vcap = (y: number, anchor: 'start' | 'end', s: string): string => `<text x="0" y="0" transform="translate(12 ${f1(y)}) rotate(-90)" font-size="11.5" text-anchor="${anchor}" font-weight="500" style="fill:${pal.ink2}">${esc(s)}</text>`;
    body += vcap(y0 - 8, 'start', 'Per lead ↑') + vcap(y0 + 8, 'end', '↓ Per qualified lead');
    rows.forEach((it, i) => {
      const x = m.l + band * i + (band - bw) / 2;
      const a = sh(it.m.cpl as number), b = sh(it.m.cpql as number);
      const mult = (it.m.cpql as number) / (it.m.cpl as number);
      const tip = `${it.c.name}\nCost per lead ${C.fmtMoney(it.m.cpl, cur)}\nCost per qualified lead ${C.fmtMoney(it.m.cpql, cur)} (${mult.toFixed(1)}×)`;
      body += `<g class="mark"${tipAttrs(ctx, tip)}>${tipTitle(ctx, tip)}<rect x="${f1(m.l + band * i)}" y="${m.t}" width="${f1(band)}" height="${2 * half}" fill="transparent"/>` +
        `<path d="${vbar(x, y0 - 1, bw, a, -1)}" fill="${fillUrl(ctx, 'qup', it.c.id)}"/><path d="${vbar(x, y0 - 1, bw, a, -1)}" fill="url(#${ctx.uid}-quality-hatch)"/>` +
        `<path d="${vbar(x, y0 + 1, bw, b, 1)}" fill="${fillUrl(ctx, 'qdn', it.c.id)}"/><path d="${vbar(x, y0 + 1, bw, b, 1)}" fill="url(#${ctx.uid}-quality-hatch)"/></g>`;
      body += txt(x + bw / 2, y0 - a - 7, shortMoney(C, cur, it.m.cpl as number), { size: 11.5, fill: pal.ink, anchor: 'middle', weight: 500 });
      body += txt(x + bw / 2, y0 + b + 15, shortMoney(C, cur, it.m.cpql as number), { size: 11.5, fill: pal.ink, anchor: 'middle', weight: 500 });
      body += txt(x + bw / 2, H - 6, trunc(it.c.name, band - 6), { size: 11.5, fill: pal.ink2, anchor: 'middle' });
    });
    const byCpl = [...rows].sort((p, q) => (p.m.cpl as number) - (q.m.cpl as number));
    const byCpql = [...rows].sort((p, q) => (p.m.cpql as number) - (q.m.cpql as number));
    const note = byCpl[0] !== byCpql[0]
      ? `${byCpl[0].c.name} has the cheapest leads, but ${byCpql[0].c.name} has the cheapest qualified leads. Judge on the lower bars.`
      : `${byCpl[0].c.name} has the cheapest leads and the cheapest qualified leads. A long lower bar means paying for junk leads.`;
    const ids = rows.map((it) => it.c.id);
    return {
      svg: svgWrap(W, H, 'Mirrored column chart: cost per lead above the line, cost per qualified lead below', body,
        gradDefs(ctx, 'qup', ids, 'down', 1, 0.3) + gradDefs(ctx, 'qdn', ids, 'up', 0.85, 0.22) + hatchDef(ctx, 'quality')),
      note,
      table: table(['Campaign', 'Cost per lead', 'Cost per qualified lead', 'Multiple'], rows.map((it) => [it.c.name, C.fmtMoney(it.m.cpl, cur), C.fmtMoney(it.m.cpql, cur), ((it.m.cpql as number) / (it.m.cpl as number)).toFixed(1) + '×'])),
    };
  }

  // ---------- 4. Cost vs quality map (bubble scatter) ----------
  function costQualityMap(ctx: Ctx): ChartBody {
    const { r, items, C, cur, pal, W } = ctx;
    const xKey = r.tiers[0].metrics[0];
    const haveQ = items.filter((it) => isNum(it.m.qualifiedPct)).length >= 2;
    const yKey: MetricKey = haveQ ? 'qualifiedPct' : 'ctr';
    const pts = items.filter((it) => isNum(it.m[xKey]) && isNum(it.m[yKey]));
    const xLab = C.METRIC_DEFS[xKey].label, yLab = C.METRIC_DEFS[yKey].label;
    const shortLab = (s: string): string => s.replace(/ \(.*\)$/, '');
    if (pts.length < 2) return { empty: `Needs ${xLab.toLowerCase()} and ${yLab.toLowerCase()} for at least two campaigns.` };
    const xv = (it: CompareItem): number => it.m[xKey] as number;
    const yv = (it: CompareItem): number => it.m[yKey] as number;
    const H = W < 560 ? 290 : 320;
    const m = { l: 46, r: 14, t: 26, b: 40 };
    const xt = ticks(Math.max(...pts.map(xv)) * 1.12);
    const yt = ticks(Math.max(...pts.map(yv)) * 1.15);
    const sx = (v: number): number => m.l + (v / xt[xt.length - 1]) * (W - m.l - m.r);
    const sy = (v: number): number => H - m.b - (v / yt[yt.length - 1]) * (H - m.t - m.b);
    const fx = (v: number): string => (C.METRIC_DEFS[xKey].fmt === 'money' ? shortMoney(C, cur, v) : String(v));
    const med = (arr: number[]): number => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
    const mx = med(pts.map(xv)), my = med(pts.map(yv));
    // The good corner, softly tinted.
    let body = `<rect x="${m.l}" y="${m.t}" width="${f1(Math.max(0, sx(mx) - m.l))}" height="${f1(Math.max(0, sy(my) - m.t))}" rx="10" style="fill:${pal.brand}" opacity="0.07"/>`;
    xt.forEach((t) => { body += edgeTxt(sx(t), H - m.b + 16, fx(t), W, pal); });
    yt.forEach((t) => { body += `<line x1="${m.l}" x2="${W - m.r}" y1="${f1(sy(t))}" y2="${f1(sy(t))}" style="stroke:${pal.line}" stroke-dasharray="2 4"/>` + txt(m.l - 6, sy(t) + 4, shortPct(t), { size: 11, fill: pal.ink2, anchor: 'end' }); });
    body += `<line x1="${f1(sx(mx))}" x2="${f1(sx(mx))}" y1="${m.t}" y2="${H - m.b}" style="stroke:${pal.ink2}" opacity="0.35"/>`;
    body += `<line x1="${m.l}" x2="${W - m.r}" y1="${f1(sy(my))}" y2="${f1(sy(my))}" style="stroke:${pal.ink2}" opacity="0.35"/>`;
    body += txt(m.l + 8, m.t + 16, 'Cheaper and better', { size: 11, fill: pal.ink2, weight: 500 });
    body += txt(m.l - 40, 12, `↑ ${shortLab(yLab)}`, { size: 11.5, fill: pal.ink2, weight: 500 });
    body += txt(W - m.r, H - 4, `${shortLab(xLab)} → cheaper to the left`, { size: 11.5, fill: pal.ink2, anchor: 'end', weight: 500 });
    const maxSpend = Math.max(...pts.map((p) => p.m.spend || 0)) || 1;
    const radOf = (it: CompareItem): number => 7 + 11 * Math.sqrt((it.m.spend || 0) / maxSpend);
    interface Box { x0: number; x1: number; y0: number; y1: number }
    const placed: Box[] = pts.map((it) => { const cx = sx(xv(it)), cy = sy(yv(it)), rr = radOf(it); return { x0: cx - rr, x1: cx + rr, y0: cy - rr, y1: cy + rr }; });
    placed.push({ x0: m.l, x1: m.l + 130, y0: m.t, y1: m.t + 20 });
    let labels = '', defs = '';
    // Biggest first so small bubbles stay on top.
    [...pts].sort((a, b) => (b.m.spend || 0) - (a.m.spend || 0)).forEach((it) => {
      const cx = sx(xv(it)), cy = sy(yv(it)), rad = radOf(it), col = colorOf(ctx, it.c.id);
      const gid = `${ctx.uid}-map-${ctx.slot(it.c.id)}`;
      defs += `<radialGradient id="${gid}" cx="0.35" cy="0.3" r="0.75"><stop offset="0" style="stop-color:${col};stop-opacity:0.55"/><stop offset="1" style="stop-color:${col};stop-opacity:1"/></radialGradient>`;
      const tip = `${it.c.name}\n${xLab}: ${C.formatMetric(xKey, xv(it), cur)}\n${yLab}: ${C.fmtPct(yv(it))}\nSpent: ${C.fmtMoney(it.m.spend, cur)}`;
      body += `<g class="mark"${tipAttrs(ctx, tip)}>${tipTitle(ctx, tip)}<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(Math.max(rad, 12))}" fill="transparent"/><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rad)}" fill="url(#${gid})" style="stroke:${pal.surface}" stroke-width="2"/></g>`;
      // Try the full name beside the bubble, then shorter names, before giving up on a free spot.
      type Cand = { anchor: 'start' | 'end' | 'middle'; x: number; y: number };
      const inside = (b: Box): boolean => b.x0 >= m.l + 2 && b.x1 <= W - m.r && b.y0 >= m.t && b.y1 <= H - m.b - 2;
      const free = (b: Box): boolean => !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
      let chosen: { c: Cand; b: Box; name: string } | null = null;
      for (const px of [Math.min(200, (W - m.l - m.r) * 0.5), 130, 84]) {
        const name = trunc(it.c.name, px);
        const tw = name.length * 6.6;
        const cands: Cand[] = [];
        for (const off of [0, 15, -15]) cands.push({ anchor: 'start', x: cx + rad + 6, y: cy + 4 + off }, { anchor: 'end', x: cx - rad - 6, y: cy + 4 + off });
        cands.push({ anchor: 'middle', x: cx, y: cy - rad - 6 }, { anchor: 'middle', x: cx, y: cy + rad + 15 });
        const boxOf = (c: Cand): Box => {
          const x0 = c.anchor === 'start' ? c.x : c.anchor === 'end' ? c.x - tw : c.x - tw / 2;
          return { x0, x1: x0 + tw, y0: c.y - 11, y1: c.y + 3 };
        };
        const hit = cands.find((c) => { const b = boxOf(c); return inside(b) && free(b); });
        if (hit) { chosen = { c: hit, b: boxOf(hit), name }; break; }
        if (!chosen) { const fit = cands.find((c) => inside(boxOf(c))); if (fit) chosen = { c: fit, b: boxOf(fit), name }; }
      }
      if (!chosen) { const name = trunc(it.c.name, 84); chosen = { c: { anchor: 'middle', x: Math.min(W - m.r - 50, Math.max(m.l + 50, cx)), y: cy - rad - 6 }, b: { x0: 0, x1: 0, y0: 0, y1: 0 }, name }; }
      placed.push(chosen.b);
      labels += txt(chosen.c.x, chosen.c.y, chosen.name, { size: 12, fill: pal.ink, anchor: chosen.c.anchor, weight: 500 });
    });
    body += labels;
    const good = pts.filter((p) => xv(p) <= mx && yv(p) >= my).map((p) => p.c.name);
    let note = good.length ? `Cheaper and better than the middle of the group: ${good.join(', ')}.` : 'No campaign is both cheaper and better than the middle of the group.';
    if (!haveQ) note += ' Quality here is click-through rate, because qualified leads are missing.';
    return {
      svg: svgWrap(W, H, `Bubble chart of ${xLab} against ${yLab}; bubble size is amount spent`, body, defs),
      note,
      table: table(['Campaign', xLab, yLab, 'Spent'], pts.map((it) => [it.c.name, C.formatMetric(xKey, xv(it), cur), C.fmtPct(yv(it)), C.fmtMoney(it.m.spend, cur)])),
    };
  }

  // ---------- 5. Timeline (rounded gradient pills) ----------
  function timeline(ctx: Ctx): ChartBody {
    const { items, C, cur, pal, W } = ctx;
    const rows = items.filter((it) => it.c.startDate && it.c.endDate);
    if (rows.length < 2) return { empty: 'Add start and end dates to at least two campaigns to see this.' };
    const start = (it: CompareItem): number => Date.parse(it.c.startDate as string);
    const end = (it: CompareItem): number => Date.parse(it.c.endDate as string);
    const t0 = Math.min(...rows.map(start));
    const t1 = Math.max(...rows.map(end)) + DAY;
    const spanDays = Math.round((t1 - t0) / DAY);
    const rowH = 46, top = 4, axisH = 22;
    const H = top + rows.length * rowH + axisH;
    const sx = (t: number): number => 2 + ((t - t0) / (t1 - t0)) * (W - 4);
    const stepDays = [1, 2, 7, 14, 30, 61, 91].find((s) => spanDays / s <= (W < 560 ? 4 : 6)) || 182;
    let body = '';
    for (let t = t0; t <= t1; t += stepDays * DAY) {
      const x = sx(t);
      body += `<line x1="${f1(x)}" x2="${f1(x)}" y1="${top}" y2="${H - axisH + 2}" style="stroke:${pal.line}" stroke-dasharray="2 4"/>` + edgeTxt(x, H - 5, fmtDate(new Date(t).toISOString().slice(0, 10)), W, pal);
    }
    rows.forEach((it, i) => {
      const a = sx(start(it)), b = sx(end(it) + DAY), y = top + i * rowH + 20;
      const tip = `${it.c.name}\n${fmtDate(it.c.startDate as string)} – ${fmtDate(it.c.endDate as string)} · ${it.m.days} days\n${C.fmtMoney(it.m.dailySpend, cur)} a day`;
      body += txt(2, y - 6, trunc(it.c.name, W * 0.6), { size: 12, fill: pal.ink, weight: 500 });
      body += txt(W - 2, y - 6, `${it.m.days} days · ${shortMoney(C, cur, it.m.dailySpend || 0)}/day`, { size: 11.5, fill: pal.ink2, anchor: 'end' });
      body += `<g class="mark"${tipAttrs(ctx, tip)}>${tipTitle(ctx, tip)}<rect x="0" y="${y - 4}" width="${W}" height="22" fill="transparent"/><rect x="${f1(a)}" y="${y}" width="${f1(Math.max(6, b - a - 1))}" height="14" rx="7" fill="${fillUrl(ctx, 'time', it.c.id)}"/></g>`;
    });
    let ov: { p: CompareItem; q: CompareItem; d: number } | null = null;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const p = rows[i], q = rows[j];
      const d = Math.round((Math.min(end(p), end(q)) + DAY - Math.max(start(p), start(q))) / DAY);
      if (d > 0 && (p.c.platform || '') === (q.c.platform || '') && (!ov || d > ov.d)) ov = { p, q, d };
    }
    const short = rows.filter((it) => (it.m.days || 0) < 7).map((it) => it.c.name);
    let note = ov ? `${ov.p.c.name} and ${ov.q.c.name} ran together for ${ov.d} days and may have bid for the same people.` : 'No two campaigns on the same platform ran at the same time.';
    if (short.length) note += ` ${short.join(', ')} ran under a week (still learning).`;
    return {
      svg: svgWrap(W, H, 'Timeline of when each campaign ran', body, gradDefs(ctx, 'time', rows.map((it) => it.c.id), 'right', 1, 0.45)),
      note,
      table: table(['Campaign', 'Start', 'End', 'Days', 'Daily spend'], rows.map((it) => [it.c.name, it.c.startDate as string, it.c.endDate as string, String(it.m.days), C.fmtMoney(it.m.dailySpend, cur)])),
    };
  }

  // ---------- 6. Day by day (smoothed lines with soft area fills) ----------
  interface Window7 { spend: number; impressions: number; clicks: number; leads: number; conversions: number; days: number }
  interface TrendDef { label: string; money?: boolean; pct?: boolean; num: (w: Window7) => number; den: (w: Window7) => number }
  const TREND_METRICS: Record<string, TrendDef> = {
    cpl: { label: 'Cost per lead', money: true, num: (w) => w.spend, den: (w) => w.leads },
    cpc: { label: 'Cost per click', money: true, num: (w) => w.spend, den: (w) => w.clicks },
    cpm: { label: 'Cost per 1,000 impressions', money: true, num: (w) => w.spend * 1000, den: (w) => w.impressions },
    cpa: { label: 'Cost per conversion', money: true, num: (w) => w.spend, den: (w) => w.conversions },
    ctr: { label: 'Click-through rate', pct: true, num: (w) => w.clicks, den: (w) => w.impressions },
    spend: { label: 'Spend per day', money: true, num: (w) => w.spend, den: (w) => w.days },
    leads: { label: 'Leads per day', num: (w) => w.leads, den: (w) => w.days },
  };
  const DEFAULT_TREND: Record<string, string> = { leads: 'cpl', traffic: 'cpc', engagement: 'cpc', video_views: 'cpm', awareness: 'cpm', conversions: 'cpa' };

  /** 7-day rolling value of a metric for each date (sums first, then divide). */
  function rolling(daily: DailyRow[], dates: string[], metric: string, win = 7): (number | null)[] {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const def = TREND_METRICS[metric];
    return dates.map((date, i) => {
      const w: Window7 = { spend: 0, impressions: 0, clicks: 0, leads: 0, conversions: 0, days: 0 };
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

  /** Smooth path through points (Catmull-Rom as cubic Béziers), y clamped to [yMin, yMax]. */
  function smooth(pts: [number, number][], yMin: number, yMax: number): string {
    if (!pts.length) return '';
    const cl = (y: number): number => Math.max(yMin, Math.min(yMax, y));
    let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, cl(p1[1] + (p2[1] - p0[1]) / 6)];
      const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, cl(p2[1] - (p3[1] - p1[1]) / 6)];
      d += `C${f1(c1[0])},${f1(c1[1])} ${f1(c2[0])},${f1(c2[1])} ${f1(p2[0])},${f1(p2[1])}`;
    }
    return d;
  }

  function trendChart(ctx: Ctx): ChartBody {
    const { r, items, C, cur, pal, W } = ctx;
    const withDaily = items.filter((it) => Array.isArray(it.c.daily) && (it.c.daily as DailyRow[]).length >= 3);
    if (withDaily.length < 2) return { empty: 'Day-by-day lines need data synced from Meta. Imported files only have totals.' };
    const daily = (it: CompareItem): DailyRow[] => it.c.daily as DailyRow[];
    const available = Object.keys(TREND_METRICS).filter((k) => {
      if (k === 'cpl' || k === 'leads') return withDaily.some((it) => daily(it).some((d) => (d.leads || 0) > 0));
      if (k === 'cpa') return withDaily.some((it) => daily(it).some((d) => (d.conversions || 0) > 0));
      return true;
    });
    let metric = ctx.trendMetric && available.includes(ctx.trendMetric) ? ctx.trendMetric : DEFAULT_TREND[r.objective || 'leads'];
    if (!available.includes(metric)) metric = available[0];
    const def = TREND_METRICS[metric];
    const allDates = [...new Set(withDaily.flatMap((it) => daily(it).map((d) => d.date)))].sort();
    const series = withDaily.map((it) => ({ it, vals: rolling(daily(it), allDates, metric) }));
    const maxV = Math.max(0, ...series.flatMap((s) => s.vals.filter(isNum)));
    if (!(maxV > 0)) return { empty: `No ${def.label.toLowerCase()} in this period.`, metric, metrics: available };
    const narrow = W < 560;
    const H = narrow ? 250 : 290;
    const m = { l: 50, r: narrow ? 10 : 150, t: 12, b: 30 };
    const yt = ticks(maxV * 1.1);
    const n = allDates.length;
    const sx = (i: number): number => m.l + (n === 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
    const sy = (v: number): number => H - m.b - (v / yt[yt.length - 1]) * (H - m.t - m.b);
    const fmt = (v: number): string => (def.money ? shortMoney(C, cur, v) : def.pct ? shortPct(v) : v < 10 ? v.toFixed(1) : String(Math.round(v)));
    const fmtLong = (v: number | null): string => (!isNum(v) ? '—' : def.money ? C.fmtMoney(v, cur) : def.pct ? C.fmtPct(v) : v.toFixed(1));
    let body = '';
    yt.forEach((t) => { body += `<line x1="${m.l}" x2="${W - m.r}" y1="${f1(sy(t))}" y2="${f1(sy(t))}" style="stroke:${pal.line}" stroke-dasharray="2 4"/>` + txt(m.l - 8, sy(t) + 4, fmt(t), { size: 11, fill: pal.ink2, anchor: 'end' }); });
    const step = Math.max(1, Math.ceil(n / (narrow ? 4 : 7)));
    for (let i = 0; i < n; i += step) body += edgeTxt(sx(i), H - 8, fmtDate(allDates[i]), W - m.r + 20, pal);
    const base = H - m.b;
    // Areas first (all series), then lines on top.
    let areas = '', lines = '';
    for (const s of series) {
      const runs: [number, number][][] = [];
      let cur2: [number, number][] = [];
      s.vals.forEach((v, i) => { if (isNum(v)) cur2.push([sx(i), sy(v)]); else if (cur2.length) { runs.push(cur2); cur2 = []; } });
      if (cur2.length) runs.push(cur2);
      for (const run of runs) {
        const d = smooth(run, m.t, base);
        areas += `<path d="${d}L${f1(run[run.length - 1][0])},${base}L${f1(run[0][0])},${base}Z" fill="${fillUrl(ctx, 'trend', s.it.c.id)}"/>`;
        lines += `<path d="${d}" fill="none" style="stroke:${colorOf(ctx, s.it.c.id)}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
    }
    body += areas + lines;
    // Direct labels at each line's last value (wide screens), nudged apart.
    if (!narrow) {
      const ends = series.map((s) => {
        let i = s.vals.length - 1; while (i >= 0 && !isNum(s.vals[i])) i--;
        return i < 0 ? null : { s, i, y: sy(s.vals[i] as number) };
      }).filter((e): e is NonNullable<typeof e> => e !== null).sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
      for (const e of ends) {
        body += `<circle cx="${f1(sx(e.i))}" cy="${f1(sy(e.s.vals[e.i] as number))}" r="4" style="fill:${colorOf(ctx, e.s.it.c.id)};stroke:${pal.surface}" stroke-width="2"/>`;
        body += txt(W - m.r + 10, e.y + 4, trunc(e.s.it.c.name, m.r - 14), { size: 12, fill: pal.ink, weight: 500 });
      }
    }
    // Hover columns: a crosshair and one tooltip listing every line at that date.
    const colW = n > 1 ? (W - m.l - m.r) / (n - 1) : W - m.l - m.r;
    allDates.forEach((date, i) => {
      const tip = `${fmtDate(date)} · ${def.label} (7-day)\n${series.map((s) => `${s.it.c.name}: ${fmtLong(s.vals[i])}`).join('\n')}`;
      const x = sx(i);
      body += `<g class="mark col"${ctx.nativeTips ? '' : ` data-tip="${esc(tip)}"`}>${tipTitle(ctx, tip)}<rect x="${f1(x - colW / 2)}" y="${m.t}" width="${f1(Math.max(2, colW))}" height="${H - m.t - m.b}" fill="transparent"/><line class="xhair" x1="${f1(x)}" x2="${f1(x)}" y1="${m.t}" y2="${base}" style="stroke:${pal.ink2}" stroke-width="1" opacity="0"/></g>`;
    });
    // Story: first full week vs latest week.
    const changes = series.map((s) => {
      const vals = s.vals.filter(isNum);
      if (vals.length < 10) return null;
      const first = vals[Math.min(6, vals.length - 1)], last = vals[vals.length - 1];
      return first > 0 ? { s, first, last, pct: last / first - 1 } : null;
    }).filter((x): x is NonNullable<typeof x> => x !== null);
    const lowerBetter = !!def.money && metric !== 'spend';
    let note = `7-day rolling ${def.label.toLowerCase()}, so single-day spikes are smoothed out.`;
    if (changes.length) {
      const worst = [...changes].sort((a, b) => (lowerBetter ? b.pct - a.pct : a.pct - b.pct))[0];
      const bad = lowerBetter ? worst.pct > 0.15 : worst.pct < -0.15;
      note = `${worst.s.it.c.name}: ${def.label.toLowerCase()} ${worst.pct > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(worst.pct * 100))}% since its first week.` +
        (bad ? (lowerBetter ? ' Rising costs often mean ad fatigue: refresh the creative or widen the audience.' : ' A falling rate often means ad fatigue.') : '');
    }
    return {
      svg: svgWrap(W, H, `Line chart of ${def.label} by day`, body, gradDefs(ctx, 'trend', withDaily.map((it) => it.c.id), 'down', 0.24, 0)),
      metric, metrics: available,
      note,
      table: table(['Campaign', `${def.label}: first week`, 'Latest week', 'Change'], changes.map((c) => [c.s.it.c.name, fmtLong(c.first), fmtLong(c.last), (c.pct > 0 ? '+' : '') + Math.round(c.pct * 100) + '%'])),
    };
  }

  /** Small line for headline cards; null gaps are skipped. */
  function sparkline(values: (number | null)[], o: { width: number; height: number; color: string; id: string }): string {
    const vals = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => isNum(p[1]));
    if (vals.length < 2) return '';
    const lo = Math.min(...vals.map((p) => p[1])), hi = Math.max(...vals.map((p) => p[1]));
    const pad = 6;
    const sx = (i: number): number => pad + (i / (values.length - 1)) * (o.width - 2 * pad);
    const sy = (v: number): number => o.height - pad - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (o.height - 2 * pad);
    const pts = vals.map(([i, v]) => [sx(i), sy(v)] as [number, number]);
    const d = smooth(pts, pad / 2, o.height - pad / 2);
    const dots = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].map(([x, y]) => `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.5" fill="${o.color}"/>`).join('');
    return `<svg class="spark" width="${o.width}" height="${o.height}" viewBox="0 0 ${o.width} ${o.height}" aria-hidden="true"><path d="${d}" fill="none" stroke="${o.color}" stroke-width="2" stroke-linecap="round"/>${dots}</svg>`;
  }

  const CHARTS: ChartDef[] = [
    { id: 'share', size: 'half', title: 'Spend vs results', sub: 'Who took the money, and who delivered.', fn: shareOfResults },
    { id: 'budget', size: 'half', title: 'Budget used', sub: 'How much of each plan was spent.', fn: budgetSpend },
    { id: 'quality', size: 'wide', title: 'Cheap leads vs good leads', sub: 'Cost per lead above the line, cost per qualified lead below.', fn: leadQualityCost, leadsOnly: true },
    { id: 'map', size: 'half', title: 'Cost vs quality', sub: 'Top-left is where you want to be. Bigger bubbles spent more.', fn: costQualityMap },
    { id: 'time', size: 'half', title: 'When they ran', sub: 'Run length and daily spend.', fn: timeline },
    { id: 'trend', size: 'wide', title: 'Day by day', sub: 'Spot fatigue and rising costs early.', fn: trendChart, dailyOnly: true },
  ];

  /** Build the charts for a comparison result. */
  function buildCharts(r: CompareResult, opts: ChartOptions): ChartOut[] {
    const hasDaily = r.items.some((it) => Array.isArray(it.c.daily) && (it.c.daily as DailyRow[]).length > 0);
    return CHARTS
      .filter((c) => (!c.leadsOnly || r.objective === 'leads') && (!c.dailyOnly || hasDaily) && (!opts.only || opts.only.includes(c.id)))
      .map((c) => {
        const W = Math.round(c.size === 'half' ? opts.halfWidth ?? opts.width : opts.width);
        const ctx: Ctx = { r, items: r.items, C: opts.C, cur: opts.cur, W, slot: opts.slot, pal: opts.print ? PAL_PRINT : PAL_APP, nativeTips: !!opts.print, trendMetric: opts.trendMetric, uid: opts.print ? 'p' : 'g' };
        let out: ChartBody;
        try { out = c.fn(ctx); } catch (e) { out = { empty: 'This chart could not be drawn from the current data.' }; }
        return { id: c.id, title: c.title, sub: c.sub, size: c.size, ...out };
      });
  }

  // Small inline key swatches for charts with more than one mark type.
  function keyHtml(key: [string, string][] | undefined, pal: ChartPalette): string {
    if (!key) return '';
    const sw: Record<string, string> = {
      bar: `<svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" rx="3" style="fill:${pal.ink2}"/></svg>`,
      tick: `<svg width="6" height="14" aria-hidden="true"><rect x="2" width="2" height="14" style="fill:${pal.ink}"/></svg>`,
    };
    return `<span class="chart-key">${key.map(([k, l]) => `<span>${sw[k] || ''} ${esc(l)}</span>`).join('')}</span>`;
  }

  const api: ChartsApi = { buildCharts, keyHtml, PAL_APP, PAL_PRINT, ticks, shortMoney, TREND_METRICS, rolling, sparkline };
  root.CampaignCharts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (globalThis as { CampaignCharts?: ChartsApi }));
