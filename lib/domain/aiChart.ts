// A chart in an AI answer. The assistant writes it as a fenced code block in
// the language "chart" holding one JSON object; the chat draws it. This
// reads that JSON defensively — the model wrote it, so anything off is
// dropped or clamped, never trusted to be well formed.

export type AiChartType = "bar" | "line" | "area" | "pie" | "kpi";
export type AiTone = "ok" | "warn" | "bad";

export interface AiChartSpec {
  type: Exclude<AiChartType, "kpi">;
  title: string;
  /** One row per category / x value: its name and a number per series. */
  data: { name: string; values: Record<string, number> }[];
  series: string[];
  unit: string;
  stacked: boolean;
  horizontal: boolean;
}

export interface AiKpiSpec {
  type: "kpi";
  title: string;
  items: { label: string; value: string; note: string; tone: AiTone | null }[];
}

/** Series a chart may carry — the palette's validated categorical slots. */
export const AI_CHART_SERIES = 6;
/** Categories (bars, points) a chart may carry. */
export const AI_CHART_POINTS = 60;
export const AI_PIE_SLICES = 6;

const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function parseAiChart(source: string): AiChartSpec | AiKpiSpec | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: "The chart's data is not valid JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "A chart is one JSON object." };
  const o = raw as Record<string, unknown>;
  const type = str(o.type).toLowerCase() as AiChartType;
  const title = str(o.title, 160);

  if (type === "kpi") {
    const items = (Array.isArray(o.items) ? o.items : [])
      .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
      .slice(0, 8)
      .map((it) => {
        const tone = str(it.tone).toLowerCase();
        return { label: str(it.label), value: str(it.value, 40), note: str(it.note, 120), tone: tone === "ok" || tone === "warn" || tone === "bad" ? (tone as AiTone) : null };
      })
      .filter((it) => it.label && it.value);
    return items.length > 0 ? { type, title, items } : { error: "A KPI block needs items with a label and a value." };
  }

  if (type !== "bar" && type !== "line" && type !== "area" && type !== "pie") return { error: `Unknown chart type "${str(o.type)}".` };
  const rows = (Array.isArray(o.data) ? o.data : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
  const nameKey = typeof o.x === "string" && o.x ? o.x : "name";

  // the series: as listed, else every numeric field of the rows
  let series = (Array.isArray(o.series) ? o.series : [])
    .map((s) => (typeof s === "string" ? s : s && typeof s === "object" ? str((s as Record<string, unknown>).key) : ""))
    .filter((s) => s && s !== nameKey);
  if (series.length === 0) {
    const seen: string[] = [];
    for (const r of rows) for (const [k, v] of Object.entries(r)) if (k !== nameKey && num(v) !== null && !seen.includes(k)) seen.push(k);
    series = seen;
  }
  if (type === "pie") series = series.slice(0, 1);
  series = [...new Set(series)].slice(0, AI_CHART_SERIES);
  if (series.length === 0) return { error: "The chart has no numbers to draw." };

  let data = rows
    .map((r) => ({
      name: str(r[nameKey], 80),
      values: Object.fromEntries(series.map((s) => [s, num(r[s]) ?? 0])),
    }))
    .filter((d) => d.name);
  if (type === "pie") {
    // slices past the limit fold into "Other", and a pie has no negatives
    const s = series[0];
    data = data.filter((d) => d.values[s] > 0).sort((a, b) => b.values[s] - a.values[s]);
    if (data.length > AI_PIE_SLICES) {
      const rest = data.slice(AI_PIE_SLICES - 1).reduce((t, d) => t + d.values[s], 0);
      data = [...data.slice(0, AI_PIE_SLICES - 1), { name: "Other", values: { [s]: rest } }];
    }
  } else data = data.slice(0, AI_CHART_POINTS);
  if (data.length === 0) return { error: "The chart has no rows to draw." };

  return {
    type,
    title,
    data,
    series,
    unit: str(o.unit, 20),
    stacked: o.stacked === true,
    horizontal: o.horizontal === true && type === "bar",
  };
}
