// Shared types for the browser code (core.ts, charts.ts, app.ts) and tests.
// core.ts is wrapped so the same file runs in the browser and in Node; these declarations describe what it exposes.

type MetricKey =
  | 'days' | 'spend' | 'budget' | 'budgetUsedPct' | 'dailySpend' | 'impressions' | 'reach' | 'frequency'
  | 'cpm' | 'clicks' | 'ctr' | 'cpc' | 'views' | 'costPerView' | 'landingPageViews' | 'lpvRate'
  | 'leads' | 'cpl' | 'leadConvRate' | 'leadsPerDay' | 'qualifiedLeads' | 'qualifiedPct' | 'cpql'
  | 'conversions' | 'cpa' | 'roas' | 'universe' | 'penetration';

type Metrics = Record<MetricKey, number | null>;
type TargetingType = 'open' | 'loose' | 'focused' | 'unknown';
type ObjectiveKey = 'awareness' | 'traffic' | 'engagement' | 'video_views' | 'leads' | 'conversions';

interface DailyRow {
  date: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  leads?: number;
  conversions?: number;
}

interface Campaign {
  id: string;
  name: string;
  platform?: string;
  objective?: ObjectiveKey | '';
  level?: 'campaign' | 'adset' | 'ad';
  source?: 'meta' | 'file';
  status?: string;
  startDate?: string;
  /** When it began (Meta start time, else first synced day with spend). Used for sorting the list. */
  startedAt?: string;
  endDate?: string;
  budget?: number;
  spend?: number;
  impressions?: number;
  reach?: number;
  clicks?: number;
  leads?: number;
  qualifiedLeads?: number;
  views?: number;
  landingPageViews?: number;
  frequency?: number;
  conversions?: number;
  conversionValue?: number;
  universe?: number;
  targeting?: string;
  targetingNotes?: string;
  levels?: number[];
  daily?: DailyRow[];
  thumbnailUrl?: string;
  campaignName?: string;
  adsetName?: string;
  autoValues?: Record<string, unknown>;
  manualKeys?: string[];
  [key: string]: unknown;
}

interface Settings {
  currency: string;
  targetCpl: number | null;
  targetQualifiedPct: number;
  openUniverseMin: number;
  focusedUniverseMax: number;
  minLeadsForConfidence: number;
  learningPhaseDays: number;
}

interface CompareItem {
  c: Campaign;
  m: Metrics;
  targeting: { type: TargetingType; reason: string };
  levels: number[];
  dataLevels: number[];
}

interface MetricRank {
  key: MetricKey;
  values: Record<string, number | null>;
  best: string | null;
  worst: string | null;
  spread: number | null;
}

interface Tier {
  tier: number;
  title: string;
  why: string;
  weight: number;
  metrics: MetricKey[];
  ranks: MetricRank[];
}

interface CompareResult {
  items: CompareItem[];
  objective: ObjectiveKey | null;
  tiers: Tier[];
  scores: Record<string, number>;
  ranking: string[];
  mixedObjectives: boolean;
  sharedLevels: number[];
  significance: { key: MetricKey; p: number | null; best: string; worst: string }[];
  settings: Settings;
  insights: Record<string, { strengths: string[]; weaknesses: string[] }>;
  commonality: { common: string[]; different: string[] };
  recommendations: {
    improve: Record<string, string[]>;
    newCampaign: string[];
    reallocation: null | { from: string; to: string; moved: number; netLeads: number; text: string };
  };
}

interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'date' | 'money' | 'int' | 'num';
  options?: string[];
}

interface MetricDef {
  label: string;
  fmt: 'money' | 'pct' | 'int' | 'num' | 'x';
  neutral?: boolean;
  higher?: boolean;
  band?: [number, number];
}

interface FunnelLevel { level: number; stage: string; name: string; kpis: MetricKey[] }

interface CoreApi {
  FUNNEL_LEVELS: FunnelLevel[];
  OBJECTIVES: Record<ObjectiveKey, { label: string; levels: number[]; primaryCost: MetricKey }>;
  PLATFORMS: string[];
  TARGETING: Record<TargetingType, string>;
  DEFAULT_SETTINGS: Settings;
  FIELDS: FieldDef[];
  METRIC_DEFS: Record<MetricKey, MetricDef>;
  rowsToCampaigns(rows: unknown[][], opts?: { platform?: string }): { campaigns: Campaign[]; mapping: Record<string, number>; headers?: string[]; currency?: string | null; warnings: string[] };
  normaliseCampaign(c: Partial<Campaign>): Campaign;
  // These read whatever fields a campaign has, so they accept partial ones.
  computeMetrics(c: Partial<Campaign>): Metrics;
  targetLevels(c: Partial<Campaign>): number[];
  dataLevels(c: Partial<Campaign>): number[];
  classifyTargeting(c: Partial<Campaign>, settings?: Settings): { type: TargetingType; reason: string };
  missingInputs(c: Partial<Campaign>): string[];
  parseNumber(v: unknown): number | null;
  parseDate(v: unknown): string | null;
  mapColumns(headers: string[]): Record<string, number>;
  comparisonTiers(objective: ObjectiveKey | null): Omit<Tier, 'ranks'>[];
  twoProportionP(x1: unknown, n1: unknown, x2: unknown, n2: unknown): number | null;
  compare(campaigns: Campaign[], settings?: Settings): CompareResult;
  isNum(v: unknown): v is number;
  fmtMoney(v: number | null | undefined, currency?: string): string;
  fmtPct(v: number | null | undefined): string;
  fmtInt(v: number | null | undefined): string;
  fmtCompact(v: number | null | undefined): string;
  formatMetric(key: MetricKey, v: number | null | undefined, currency?: string): string;
  toCsv(r: CompareResult): string;
  toRows(r: CompareResult): unknown[][];
  objectiveOf(c: Partial<Campaign>): ObjectiveKey | null;
  statusKind(c: Partial<Campaign>): 'active' | 'inactive' | 'unknown';
  listView(items: Campaign[], opts?: Partial<ListViewOpts>): ListViewResult;
  listTotals(items: Campaign[]): ListTotals;
  listToCsv(items: Campaign[]): string;
}

interface ListTotals {
  count: number;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  qualifiedLeads: number;
  cpl: number | null;
  qualifiedPct: number | null;
}
type StatusFilter = 'all' | 'active' | 'inactive';
type ListSort = 'default' | 'newest' | 'oldest' | 'name';
interface ListViewOpts { q: string; status: StatusFilter; sort: ListSort }
interface ListViewResult {
  items: Campaign[];
  counts: { all: number; active: number; inactive: number };
  total: number;
  anyStatus: boolean;
}

// ---------- charts ----------

interface ChartOptions {
  C: CoreApi;
  cur: string;
  /** Width for full-width charts. */
  width: number;
  /** Width for charts that sit two to a row (defaults to `width`). */
  halfWidth?: number;
  slot: (id: string) => number;
  print?: boolean;
  trendMetric?: string | null;
  /** Only build these charts (by id). */
  only?: string[];
}

interface ChartOut {
  id: string;
  title: string;
  sub: string;
  size: 'wide' | 'half';
  svg?: string;
  note?: string;
  table?: string;
  empty?: string;
  key?: [string, string][];
  metric?: string;
  metrics?: string[];
}

interface ChartPalette { s: string[]; ink: string; ink2: string; line: string; surface: string; brand: string }

interface ChartsApi {
  buildCharts(r: CompareResult, opts: ChartOptions): ChartOut[];
  keyHtml(key: [string, string][] | undefined, pal: ChartPalette): string;
  PAL_APP: ChartPalette;
  PAL_PRINT: ChartPalette;
  ticks(max: number, n?: number): number[];
  shortMoney(C: CoreApi, cur: string, v: number): string;
  TREND_METRICS: Record<string, { label: string }>;
  rolling(daily: DailyRow[], dates: string[], metric: string, win?: number): (number | null)[];
  sparkline(values: (number | null)[], o: { width: number; height: number; color: string; id: string }): string;
}

// ---------- browser globals ----------

interface ShareSnapshot {
  title?: string;
  campaigns?: Campaign[];
  settings?: Partial<Settings>;
  range?: { since: string; until: string } | null;
  createdAt?: number;
  expiresAt?: number;
}

interface ClaudeRuntime {
  use(name: 'downloads'): Promise<{ save(o: { filename: string; data: string | Blob }): Promise<void> } | null>;
}

interface XlsxLike {
  read(data: unknown, opts: object): { SheetNames: string[]; Sheets: Record<string, unknown> };
  write(wb: unknown, opts: object): ArrayBuffer;
  utils: {
    sheet_to_json(ws: unknown, opts: object): unknown[][];
    book_new(): unknown;
    aoa_to_sheet(rows: unknown[][]): unknown;
    book_append_sheet(wb: unknown, ws: unknown, name: string): void;
  };
}

interface Window {
  CampaignCore: CoreApi;
  CampaignCharts?: ChartsApi;
  SAMPLE_CSV: string;
  __SHARE__?: ShareSnapshot;
  claude?: ClaudeRuntime;
}

declare var XLSX: XlsxLike | undefined;
