// A chart in an AI answer. The assistant writes it as a fenced code block in
// the language "chart" holding one JSON object; the chat, the inbox and a
// printed report draw it. This reads that JSON defensively — the model wrote
// it, so anything off is dropped or clamped, never trusted to be well formed —
// and does the arithmetic a form needs (a Pareto's running share, a
// histogram's bins, a waterfall's floating bars, a Gantt's time axis), so the
// drawing only draws.
//
// The forms, by the job each does (the system prompt tells the assistant the
// same, lib/server/ai/agent.ts):
//   bar · line · area · combo   compare, follow over time, parts stacked —
//                               on ONE value scale, with target lines and one
//                               thing picked out
//   pie                         a few parts of a whole
//   kpi                         headline figures, with a trend and progress
//   pareto                      causes ranked, the vital few standing out
//   histogram                   how values spread
//   scatter                     two measures per item
//   heatmap                     how much where two dimensions cross
//   progress                    done against target
//   funnel                      a pipeline of stages
//   waterfall                   what moved a total
//   gantt                       a schedule
//   dumbbell                    before → after per item
//   radar                       a few things scored on several measures
//   treemap                     many parts of a whole

export const AI_CHART_TYPES = [
  "bar", "line", "area", "combo", "pie", "kpi", "pareto", "histogram", "scatter", "heatmap", "progress", "funnel", "waterfall", "gantt", "dumbbell", "radar", "treemap",
] as const;
export type AiChartType = (typeof AI_CHART_TYPES)[number];
export type AiTone = "ok" | "warn" | "bad";
export type AiSeriesKind = "bar" | "line" | "area";

export const AI_CHART_LIMITS = {
  /** Series a chart may carry — the palette's validated categorical slots. */
  series: 6,
  /** Series where any two marks can sit side by side (scatter, radar). */
  overlapping: 3,
  /** Categories (bars, points) a cartesian chart may carry. */
  points: 60,
  slices: 6,
  kpis: 8,
  trend: 24,
  targets: 3,
  highlight: 10,
  paretoBars: 20,
  values: 5000,
  bins: 30,
  scatter: 500,
  heatRows: 40,
  heatCols: 40,
  progress: 20,
  funnel: 8,
  waterfall: 30,
  tasks: 80,
  ganttRows: 30,
  dumbbell: 40,
  radarAxes: 12,
  treemap: 60,
} as const;

/** @deprecated kept for older imports — AI_CHART_LIMITS.series */
export const AI_CHART_SERIES = AI_CHART_LIMITS.series;
export const AI_CHART_POINTS = AI_CHART_LIMITS.points;
export const AI_PIE_SLICES = AI_CHART_LIMITS.slices;

export interface AiRow {
  name: string;
  values: Record<string, number>;
}

/** bar, line, area and combo: categories along one axis, a number per series. */
export interface AiXYSpec {
  type: "bar" | "line" | "area" | "combo";
  title: string;
  unit: string;
  data: AiRow[];
  series: string[];
  /** How each series is drawn — the chart's type, or for combo its own. */
  kinds: Record<string, AiSeriesKind>;
  stacked: false | "normal" | "percent";
  horizontal: boolean;
  /** Target or limit lines across the value axis. */
  targets: { value: number; label: string }[];
  /** What the chart is about: categories (one series) or series picked out, the rest in gray. */
  highlight: string[];
}

export interface AiPieSpec {
  type: "pie";
  title: string;
  unit: string;
  series: string[];
  data: AiRow[];
}

export interface AiKpiItem {
  label: string;
  value: string;
  note: string;
  tone: AiTone | null;
  /** The latest values, oldest first. */
  trend: number[];
  /** Per cent of its target. */
  progress: number | null;
}

export interface AiKpiSpec {
  type: "kpi";
  title: string;
  items: AiKpiItem[];
}

export interface AiParetoSpec {
  type: "pareto";
  title: string;
  unit: string;
  /** Largest first ("Other" last); share and cumulative are fractions of the whole. */
  data: { name: string; value: number; share: number; cumulative: number; vital: boolean }[];
  /** How many make the first 80%. */
  vital: number;
}

export interface AiHistogramSpec {
  type: "histogram";
  title: string;
  unit: string;
  bins: { from: number; to: number; count: number }[];
  n: number;
  mean: number;
  median: number;
}

export interface AiScatterSpec {
  type: "scatter";
  title: string;
  xLabel: string;
  yLabel: string;
  sized: boolean;
  groups: string[];
  points: { x: number; y: number; size: number | null; group: string; name: string }[];
}

export interface AiHeatmapSpec {
  type: "heatmap";
  title: string;
  unit: string;
  rows: string[];
  cols: string[];
  values: number[][];
  totals: boolean;
}

export interface AiProgressSpec {
  type: "progress";
  title: string;
  unit: string;
  /** No target: the value is itself a percentage. */
  items: { label: string; value: number; target: number | null; note: string; tone: AiTone | null }[];
}

export interface AiFunnelSpec {
  type: "funnel";
  title: string;
  unit: string;
  data: { name: string; value: number }[];
}

export interface AiWaterfallSpec {
  type: "waterfall";
  title: string;
  unit: string;
  /** Each bar floats from start to end; a total stands on zero. */
  data: { name: string; value: number; total: boolean; start: number; end: number }[];
}

export interface AiGanttTask {
  row: string;
  label: string;
  /** Epoch milliseconds; a whole day ends at the next midnight. */
  start: number;
  end: number;
  startText: string;
  endText: string;
  group: string;
}

export interface AiGanttSpec {
  type: "gantt";
  title: string;
  rows: string[];
  groups: string[];
  tasks: AiGanttTask[];
  from: number;
  to: number;
  /** Some task carries a time of day, not only a date. */
  withTime: boolean;
}

export interface AiDumbbellSpec {
  type: "dumbbell";
  title: string;
  unit: string;
  series: [string, string];
  data: { name: string; a: number; b: number }[];
}

export interface AiRadarSpec {
  type: "radar";
  title: string;
  unit: string;
  series: string[];
  data: AiRow[];
}

export interface AiTreemapSpec {
  type: "treemap";
  title: string;
  unit: string;
  groups: string[];
  data: { name: string; value: number; group: string }[];
}

export type AiChartSpec =
  | AiXYSpec
  | AiPieSpec
  | AiKpiSpec
  | AiParetoSpec
  | AiHistogramSpec
  | AiScatterSpec
  | AiHeatmapSpec
  | AiProgressSpec
  | AiFunnelSpec
  | AiWaterfallSpec
  | AiGanttSpec
  | AiDumbbellSpec
  | AiRadarSpec
  | AiTreemapSpec;

type Raw = Record<string, unknown>;
type Fail = { error: string };

/** The name of the slice or category the rest fold into. */
export const OTHER_NAME = "Other";

const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[,٬\s]/g, "").replace(/%$/, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const objects = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isObj) : []);
const strings = (v: unknown, max: number, len = 80): string[] => (Array.isArray(v) ? [...new Set(v.map((s) => str(s, len)).filter(Boolean))].slice(0, max) : []);
const toneOf = (v: unknown): AiTone | null => {
  const t = str(v).toLowerCase();
  return t === "ok" || t === "warn" || t === "bad" ? t : null;
};
const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

/** A fenced block the chat draws as a chart: one in the language "chart" —
 *  or a JSON object naming a chart type, whatever the fence says (json, kpi,
 *  Chart …), so a block the model labelled loosely still draws. */
export function isChartBlock(lang: string, text: string): boolean {
  const l = lang.trim().toLowerCase();
  if (l === "chart") return true;
  if (l !== "" && l !== "json" && l !== "charts" && !(AI_CHART_TYPES as readonly string[]).includes(l)) return false;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const o = JSON.parse(t) as unknown;
    return isObj(o) && (AI_CHART_TYPES as readonly string[]).includes(str(o.type).toLowerCase());
  } catch {
    return false;
  }
}

export function parseAiChart(source: string): AiChartSpec | Fail {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: "The chart's data is not valid JSON." };
  }
  if (!isObj(raw)) return { error: "A chart is one JSON object." };
  const type = str(raw.type).toLowerCase();
  const title = str(raw.title, 160);
  const unit = str(raw.unit, 20);
  switch (type) {
    case "bar":
    case "line":
    case "area":
    case "combo":
      return parseXY(raw, type, title, unit);
    case "pie":
      return parsePie(raw, title, unit);
    case "kpi":
      return parseKpi(raw, title);
    case "pareto":
      return parsePareto(raw, title, unit);
    case "histogram":
      return parseHistogram(raw, title, unit);
    case "scatter":
    case "bubble":
      return parseScatter(raw, title);
    case "heatmap":
      return parseHeatmap(raw, title, unit);
    case "progress":
    case "gauge":
      return parseProgress(raw, title, unit);
    case "funnel":
      return parseFunnel(raw, title, unit);
    case "waterfall":
      return parseWaterfall(raw, title, unit);
    case "gantt":
    case "timeline":
      return parseGantt(raw, title);
    case "dumbbell":
      return parseDumbbell(raw, title, unit);
    case "radar":
      return parseRadar(raw, title, unit);
    case "treemap":
      return parseTreemap(raw, title, unit);
    default:
      return { error: `Unknown chart type "${str(raw.type)}".` };
  }
}

// ------------------------------------------------------------ rows & series

/** The series of row-shaped data: as listed (a name, or {key, kind}), else
 *  every numeric field of the rows; and how a combo draws each. */
function seriesOf(raw: Raw, rows: Raw[], nameKey: string, max: number): { series: string[]; kinds: Record<string, AiSeriesKind> } {
  const kinds: Record<string, AiSeriesKind> = {};
  let series = (Array.isArray(raw.series) ? raw.series : [])
    .map((s) => {
      if (typeof s === "string") return s.trim();
      if (!isObj(s)) return "";
      const key = str(s.key ?? s.name);
      const kind = str(s.kind ?? s.type).toLowerCase();
      if (key && (kind === "bar" || kind === "line" || kind === "area")) kinds[key] = kind;
      return key;
    })
    .filter((s) => s && s !== nameKey);
  if (series.length === 0) {
    const seen: string[] = [];
    for (const r of rows) for (const [k, v] of Object.entries(r)) if (k !== nameKey && num(v) !== null && !seen.includes(k)) seen.push(k);
    series = seen;
  }
  return { series: [...new Set(series)].slice(0, max), kinds };
}

function rowsOf(rows: Raw[], nameKey: string, series: readonly string[], max: number): AiRow[] {
  return rows
    .map((r) => ({ name: str(r[nameKey], 80), values: Object.fromEntries(series.map((s) => [s, num(r[s]) ?? 0])) }))
    .filter((d) => d.name)
    .slice(0, max);
}

function stackedOf(v: unknown): AiXYSpec["stacked"] {
  if (v === true) return "normal";
  const s = str(v).toLowerCase();
  if (s === "normal" || s === "true") return "normal";
  if (s === "percent" || s === "100%" || s === "expand") return "percent";
  return false;
}

function targetsOf(v: unknown): AiXYSpec["targets"] {
  return objects(v)
    .map((t) => ({ value: num(t.value ?? t.y ?? t.x), label: str(t.label, 40) }))
    .filter((t): t is { value: number; label: string } => t.value !== null)
    .slice(0, AI_CHART_LIMITS.targets);
}

function parseXY(raw: Raw, type: AiXYSpec["type"], title: string, unit: string): AiXYSpec | Fail {
  const rows = objects(raw.data);
  const nameKey = typeof raw.x === "string" && raw.x ? raw.x : "name";
  const { series, kinds } = seriesOf(raw, rows, nameKey, AI_CHART_LIMITS.series);
  if (series.length === 0) return { error: "The chart has no numbers to draw." };
  const data = rowsOf(rows, nameKey, series, AI_CHART_LIMITS.points);
  if (data.length === 0) return { error: "The chart has no rows to draw." };
  const own: AiSeriesKind = type === "combo" ? "bar" : type;
  const drawn: Record<string, AiSeriesKind> = {};
  // a combo with no kinds given: the first series as bars, the rest as lines
  series.forEach((s, i) => (drawn[s] = type === "combo" ? kinds[s] ?? (i === 0 ? "bar" : "line") : own));
  const stacked = stackedOf(raw.stacked);
  return {
    type,
    title,
    unit,
    data,
    series,
    kinds: drawn,
    // a stack needs two series to stack; lines never stack, nor turn into
    // shares beside the bars of a combo
    stacked: type === "line" || series.length < 2 ? false : type === "combo" && stacked === "percent" ? "normal" : stacked,
    horizontal: raw.horizontal === true && type === "bar",
    targets: targetsOf(raw.targets ?? raw.target),
    highlight: strings(raw.highlight, AI_CHART_LIMITS.highlight),
  };
}

function parsePie(raw: Raw, title: string, unit: string): AiPieSpec | Fail {
  const rows = objects(raw.data);
  const nameKey = typeof raw.x === "string" && raw.x ? raw.x : "name";
  const { series } = seriesOf(raw, rows, nameKey, 1);
  if (series.length === 0) return { error: "The chart has no numbers to draw." };
  const s = series[0];
  // slices past the limit fold into "Other", and a pie has no negatives
  let data = rowsOf(rows, nameKey, series, 500).filter((d) => d.values[s] > 0).sort((a, b) => b.values[s] - a.values[s]);
  if (data.length > AI_CHART_LIMITS.slices) {
    const rest = data.slice(AI_CHART_LIMITS.slices - 1).reduce((t, d) => t + d.values[s], 0);
    data = [...data.slice(0, AI_CHART_LIMITS.slices - 1), { name: OTHER_NAME, values: { [s]: rest } }];
  }
  if (data.length === 0) return { error: "The chart has no rows to draw." };
  return { type: "pie", title, unit, series, data };
}

function parseKpi(raw: Raw, title: string): AiKpiSpec | Fail {
  const items = objects(raw.items)
    .slice(0, AI_CHART_LIMITS.kpis)
    .map((it) => {
      const progress = num(it.progress);
      return {
        label: str(it.label),
        value: str(it.value, 40),
        note: str(it.note, 120),
        tone: toneOf(it.tone),
        trend: (Array.isArray(it.trend) ? it.trend.map(num).filter((n): n is number => n !== null) : []).slice(-AI_CHART_LIMITS.trend),
        progress: progress === null ? null : Math.max(0, progress),
      };
    })
    .filter((it) => it.label && it.value);
  return items.length > 0 ? { type: "kpi", title, items } : { error: "A KPI block needs items with a label and a value." };
}

/** One {name, value} per row — value, or the first number of the row. */
function pairsOf(raw: Raw): { name: string; value: number; group: string }[] {
  return objects(raw.data)
    .map((r) => {
      const named = num(r.value);
      const value = named ?? (Object.entries(r).filter(([k]) => k !== "name" && k !== "group").map(([, v]) => num(v)).find((n) => n !== null) ?? null);
      return { name: str(r.name, 80), value, group: str(r.group, 60) };
    })
    .filter((r): r is { name: string; value: number; group: string } => !!r.name && r.value !== null);
}

// ------------------------------------------------------------------ pareto

function parsePareto(raw: Raw, title: string, unit: string): AiParetoSpec | Fail {
  const pairs = pairsOf(raw).filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  if (pairs.length === 0) return { error: "A Pareto needs causes with a count above zero." };
  const max = AI_CHART_LIMITS.paretoBars;
  const head = pairs.length > max ? pairs.slice(0, max - 1) : pairs;
  const rest = pairs.length > max ? pairs.slice(max - 1).reduce((t, p) => t + p.value, 0) : 0;
  const bars = rest > 0 ? [...head, { name: OTHER_NAME, value: rest, group: "" }] : head;
  const total = bars.reduce((t, b) => t + b.value, 0);
  let run = 0;
  let vital = 0;
  const data = bars.map((b) => {
    const before = run;
    run += b.value;
    // a cause is one of the vital few while what came before it is under 80%
    const isVital = b.name !== OTHER_NAME && before / total < 0.8;
    if (isVital) vital += 1;
    return { name: b.name, value: b.value, share: round(b.value / total), cumulative: round(run / total), vital: isVital };
  });
  return { type: "pareto", title, unit, data, vital };
}

// --------------------------------------------------------------- histogram

/** A round step near `raw`: 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function parseHistogram(raw: Raw, title: string, unit: string): AiHistogramSpec | Fail {
  const values = (Array.isArray(raw.values) ? raw.values : []).map(num).filter((n): n is number => n !== null).slice(0, AI_CHART_LIMITS.values);
  if (values.length === 0) return { error: "A histogram needs its values." };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const asked = num(raw.bins);
  const count = Math.max(1, Math.min(AI_CHART_LIMITS.bins, asked !== null ? Math.round(asked) : Math.ceil(Math.log2(n) + 1)));
  const size = num(raw.binSize);
  let step = size !== null && size > 0 ? size : max === min ? 1 : niceStep((max - min) / count);
  const binsFrom = (s: number) => Math.floor(min / s) * s;
  const binsOf = (s: number) => Math.floor((max - binsFrom(s)) / s + 1e-9) + 1;
  // a bin size too fine for the range widens until the bins fit
  while (binsOf(step) > AI_CHART_LIMITS.bins) step = niceStep(step * 2);
  const start = binsFrom(step);
  const nBins = binsOf(step);
  const bins = Array.from({ length: nBins }, (_, k) => ({ from: round(start + k * step), to: round(start + (k + 1) * step), count: 0 }));
  for (const v of sorted) bins[Math.min(nBins - 1, Math.floor((v - start) / step + 1e-9))].count += 1;
  const mean = sorted.reduce((t, v) => t + v, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { type: "histogram", title, unit, bins, n, mean: round(mean, 3), median: round(median, 3) };
}

// ----------------------------------------------------------------- scatter

/** The groups a chart keeps — the most common first, the rest as "Other". */
function keepGroups(names: readonly string[], max: number): string[] {
  const count = new Map<string, number>();
  for (const g of names) if (g) count.set(g, (count.get(g) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([g]) => g);
}

function parseScatter(raw: Raw, title: string): AiScatterSpec | Fail {
  const pts = objects(raw.points ?? raw.data)
    .slice(0, AI_CHART_LIMITS.scatter)
    .map((p) => ({ x: num(p.x), y: num(p.y), size: num(p.size ?? p.z), group: str(p.group, 60), name: str(p.name ?? p.label, 80) }))
    .filter((p): p is { x: number; y: number; size: number | null; group: string; name: string } => p.x !== null && p.y !== null);
  if (pts.length === 0) return { error: "A scatter needs points with x and y." };
  const kept = keepGroups(pts.map((p) => p.group), AI_CHART_LIMITS.overlapping);
  const anyOther = pts.some((p) => !kept.includes(p.group));
  const groups = kept.length === 0 ? [""] : anyOther ? [...kept, OTHER_NAME] : kept;
  const sized = pts.some((p) => p.size !== null && p.size > 0);
  return {
    type: "scatter",
    title,
    xLabel: str(raw.xLabel, 40),
    yLabel: str(raw.yLabel, 40),
    sized,
    groups,
    points: pts.map((p) => ({ ...p, size: sized ? Math.max(0, p.size ?? 0) : null, group: kept.length === 0 ? "" : kept.includes(p.group) ? p.group : OTHER_NAME })),
  };
}

// ----------------------------------------------------------------- heatmap

function parseHeatmap(raw: Raw, title: string, unit: string): AiHeatmapSpec | Fail {
  const rows = strings(raw.rows, AI_CHART_LIMITS.heatRows);
  const cols = strings(raw.cols ?? raw.columns, AI_CHART_LIMITS.heatCols, 40);
  if (rows.length === 0 || cols.length === 0) return { error: "A heatmap needs its rows and its columns." };
  const grid = Array.isArray(raw.values) ? raw.values : [];
  const values = rows.map((_, i) => cols.map((_, j) => {
    const r = grid[i];
    return Array.isArray(r) ? num(r[j]) ?? 0 : 0;
  }));
  return { type: "heatmap", title, unit, rows, cols, values, totals: raw.totals === true };
}

// ---------------------------------------------------------------- progress

function parseProgress(raw: Raw, title: string, unit: string): AiProgressSpec | Fail {
  const items = objects(raw.items ?? raw.data)
    .slice(0, AI_CHART_LIMITS.progress)
    .map((it) => {
      const target = num(it.target);
      return { label: str(it.label ?? it.name), value: num(it.value), target: target !== null && target > 0 ? target : null, note: str(it.note, 120), tone: toneOf(it.tone) };
    })
    .filter((it): it is AiProgressSpec["items"][number] => !!it.label && it.value !== null);
  return items.length > 0 ? { type: "progress", title, unit, items } : { error: "Progress needs items with a label and a value." };
}

// ------------------------------------------------------------------ funnel

function parseFunnel(raw: Raw, title: string, unit: string): AiFunnelSpec | Fail {
  const data = pairsOf(raw).map(({ name, value }) => ({ name, value: Math.max(0, value) })).slice(0, AI_CHART_LIMITS.funnel);
  return data.length >= 2 ? { type: "funnel", title, unit, data } : { error: "A funnel needs at least two stages." };
}

// --------------------------------------------------------------- waterfall

function parseWaterfall(raw: Raw, title: string, unit: string): AiWaterfallSpec | Fail {
  const rows = objects(raw.data).slice(0, AI_CHART_LIMITS.waterfall);
  let run = 0;
  const data: AiWaterfallSpec["data"] = [];
  for (const r of rows) {
    const name = str(r.name, 80);
    if (!name) continue;
    const value = num(r.value);
    if (r.total === true) {
      // a total stands on zero: the value given, else the running total
      if (value !== null) run = value;
      data.push({ name, value: round(run), total: true, start: 0, end: round(run) });
    } else if (value !== null) {
      data.push({ name, value, total: false, start: round(run), end: round(run + value) });
      run += value;
    }
  }
  return data.length > 0 ? { type: "waterfall", title, unit, data } : { error: "A waterfall needs its steps." };
}

// ------------------------------------------------------------------- gantt

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A day (YYYY-MM-DD, UTC midnight) or a moment — and whether it had a time. */
function momentOf(v: unknown): { ms: number; withTime: boolean; text: string } | null {
  const s = str(v, 40);
  if (DATE_ONLY.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(ms) ? { ms, withTime: false, text: s } : null;
  }
  if (DATE_TIME.test(s)) {
    const iso = s.replace(" ", "T");
    // a time with no zone is the factory clock's — written as given
    const ms = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(ms) ? { ms, withTime: true, text: s.replace("T", " ").slice(0, 16) } : null;
  }
  return null;
}

function parseGantt(raw: Raw, title: string): AiGanttSpec | Fail {
  const tasks: AiGanttTask[] = [];
  let withTime = false;
  for (const t of objects(raw.tasks ?? raw.data).slice(0, AI_CHART_LIMITS.tasks)) {
    const row = str(t.row ?? t.name, 60);
    const a = momentOf(t.start);
    const b = momentOf(t.end ?? t.start);
    if (!row || !a || !b) continue;
    // a whole day runs to the next midnight
    const end = b.withTime ? b.ms : b.ms + DAY_MS;
    if (end <= a.ms) continue;
    withTime ||= a.withTime || b.withTime;
    tasks.push({ row, label: str(t.label, 80), start: a.ms, end, startText: a.text, endText: b.text, group: str(t.group, 60) });
  }
  if (tasks.length === 0) return { error: "A Gantt needs tasks with a row, a start and an end (YYYY-MM-DD)." };
  const rows = [...new Set(tasks.map((t) => t.row))].slice(0, AI_CHART_LIMITS.ganttRows);
  const shown = tasks.filter((t) => rows.includes(t.row));
  const kept = keepGroups(shown.map((t) => t.group), AI_CHART_LIMITS.series);
  const anyOther = shown.some((t) => t.group && !kept.includes(t.group));
  return {
    type: "gantt",
    title,
    rows,
    groups: anyOther ? [...kept, OTHER_NAME] : kept,
    tasks: shown.map((t) => ({ ...t, group: !t.group ? "" : kept.includes(t.group) ? t.group : OTHER_NAME })),
    from: Math.min(...shown.map((t) => t.start)),
    to: Math.max(...shown.map((t) => t.end)),
    withTime,
  };
}

// ---------------------------------------------------------------- dumbbell

function parseDumbbell(raw: Raw, title: string, unit: string): AiDumbbellSpec | Fail {
  const rows = objects(raw.data);
  const { series } = seriesOf(raw, rows, "name", 2);
  if (series.length < 2) return { error: "A dumbbell needs two series — before and after." };
  const data = rows
    .map((r) => ({ name: str(r.name, 80), a: num(r[series[0]]), b: num(r[series[1]]) }))
    .filter((d): d is { name: string; a: number; b: number } => !!d.name && d.a !== null && d.b !== null)
    .slice(0, AI_CHART_LIMITS.dumbbell);
  return data.length > 0 ? { type: "dumbbell", title, unit, series: [series[0], series[1]], data } : { error: "The chart has no rows to draw." };
}

// ------------------------------------------------------------------- radar

function parseRadar(raw: Raw, title: string, unit: string): AiRadarSpec | Fail {
  const rows = objects(raw.data);
  const { series } = seriesOf(raw, rows, "name", AI_CHART_LIMITS.overlapping);
  if (series.length === 0) return { error: "The chart has no numbers to draw." };
  const data = rowsOf(rows, "name", series, AI_CHART_LIMITS.radarAxes);
  return data.length >= 3 ? { type: "radar", title, unit, series, data } : { error: "A radar needs at least three measures." };
}

// ----------------------------------------------------------------- treemap

function parseTreemap(raw: Raw, title: string, unit: string): AiTreemapSpec | Fail {
  const pairs = pairsOf(raw).filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  if (pairs.length === 0) return { error: "A treemap needs parts with a size above zero." };
  const max = AI_CHART_LIMITS.treemap;
  const head = pairs.length > max ? pairs.slice(0, max - 1) : pairs;
  const rest = pairs.length > max ? pairs.slice(max - 1).reduce((t, p) => t + p.value, 0) : 0;
  const kept = keepGroups(head.map((p) => p.group), AI_CHART_LIMITS.series);
  const data = head.map((p) => ({ name: p.name, value: p.value, group: !p.group ? "" : kept.includes(p.group) ? p.group : OTHER_NAME }));
  if (rest > 0) data.push({ name: OTHER_NAME, value: rest, group: kept.length ? OTHER_NAME : "" });
  const anyOther = data.some((d) => d.group === OTHER_NAME);
  return { type: "treemap", title, unit, groups: anyOther ? [...kept, OTHER_NAME] : kept, data };
}
