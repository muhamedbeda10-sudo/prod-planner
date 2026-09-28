"use client";

import { useMemo, useState, type ComponentProps } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, LabelList,
} from "recharts";
import { ExportButton } from "@/components/ExportButton";
import { OdooInsightsSection } from "@/components/OdooInsights";
import type { OdooInsights } from "@/lib/domain/odooInsights";
import {
  pctChange, periodLabel,
  type OdooDashboardData, type OdooSeries,
} from "@/lib/domain/odooStats";

// The Odoo dashboard — what was logged each day, by product. One period row
// scopes everything below it: the headline numbers, a card per product, how
// the close-out is going (components/OdooInsights.tsx: close-rate gauge,
// funnel, status donut, lead time, aging, burn-up, BOM mix), the stacked
// columns per day (every count written on its segment), one small chart per
// product, totals and closed-vs-open, and the same numbers as a table with an
// Excel export — the chart is never the only way to read a value.

// The sheet's six products keep their fixed colours; a product logged beyond
// them takes the next free slot of the palette in the order it appears in
// the period's series, so a newcomer is coloured, named and legended like
// the rest. "Other" (a row with no product) stays grey.
const FIXED_VAR: Record<string, string> = {
  Tank: "var(--viz-1)",
  "Top Cover": "var(--viz-2)",
  "Core Frame": "var(--viz-3)",
  Encloser: "var(--viz-4)",
  "Cable Box": "var(--viz-5)",
  Conservator: "var(--viz-6)",
  Other: "var(--viz-other)",
};
/** Ink for a number written INSIDE a segment: white on the dark hues, dark on the light ones. */
const FIXED_INK: Record<string, string> = {
  Tank: "#fff", "Top Cover": "#fff", "Core Frame": "#fff", Encloser: "#fff",
  "Cable Box": "#1a2420", Conservator: "#1a2420", Other: "#fff",
};
const EXTRA: { color: string; ink: string }[] = [
  { color: "var(--viz-7)", ink: "#fff" },
  { color: "var(--viz-8)", ink: "#1a2420" },
  { color: "var(--viz-1)", ink: "#fff" },
  { color: "var(--viz-2)", ink: "#fff" },
  { color: "var(--viz-3)", ink: "#fff" },
  { color: "var(--viz-4)", ink: "#fff" },
  { color: "var(--viz-5)", ink: "#1a2420" },
  { color: "var(--viz-6)", ink: "#1a2420" },
];
type Palette = { color: (s: OdooSeries) => string; ink: (s: OdooSeries) => string };
function paletteFor(series: readonly OdooSeries[]): Palette {
  const color: Record<string, string> = {};
  const ink: Record<string, string> = {};
  let extra = 0;
  for (const s of series) {
    if (FIXED_VAR[s]) { color[s] = FIXED_VAR[s]; ink[s] = FIXED_INK[s]; continue; }
    const slot = EXTRA[extra % EXTRA.length];
    extra += 1;
    color[s] = slot.color;
    ink[s] = slot.ink;
  }
  return { color: (s) => color[s] ?? "var(--viz-other)", ink: (s) => ink[s] ?? "#fff" };
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 1 }));

/** A legend in OUR series order, with text in the text colour — recharts would
 *  sort it alphabetically and paint each name in its series colour. */
type LegendItem = { value: string; color: string };
function legendProps(items: LegendItem[]): ComponentProps<typeof Legend> {
  const order = items.map((i) => i.value);
  return {
    wrapperStyle: { fontSize: 12 },
    iconType: "square",
    iconSize: 10,
    formatter: (value: unknown) => <span style={{ color: "var(--foreground)" }}>{String(value)}</span>,
    itemSorter: (item: { value?: unknown }) => order.indexOf(String(item.value)),
  } as ComponentProps<typeof Legend>;
}

/** Room above the tallest column for its cap label: the next multiple of 5 past +12%. */
const headroom = (max: number) => Math.max(5, Math.ceil((max * 1.12) / 5) * 5);

/** Tick interval so at most `max` day labels show — the rest stay in the tooltip and table. */
const tickEvery = (n: number, max: number) => (n > max ? Math.ceil(n / max) - 1 : 0);

// ---- labels written on the marks ----

type LabelBox = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown };

/** The count inside a stacked segment — only when the segment is tall and wide enough to hold it. */
function segmentLabel(ink: string) {
  const SegLabel = (p: LabelBox) => {
    const v = Number(p.value ?? 0);
    const w = Number(p.width ?? 0), h = Number(p.height ?? 0);
    if (!v || h < 13 || w < 16) return null;
    return (
      <text x={Number(p.x) + w / 2} y={Number(p.y) + h / 2} dy={3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill={ink} pointerEvents="none">
        {fmt(v)}
      </text>
    );
  };
  return SegLabel;
}

/** The column's total on its cap. */
function TopLabel(p: LabelBox) {
  const v = Number(p.value ?? 0);
  if (!v) return null;
  return (
    <text x={Number(p.x) + Number(p.width ?? 0) / 2} y={Number(p.y)} dy={-4} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--foreground)" pointerEvents="none">
      {fmt(v)}
    </text>
  );
}

/** The stack's total, written once per column by whichever segment is on
 *  top that day. The day is read off the label's own entry: recharts leaves
 *  a zero-height segment out of the label list, so an index would drift onto
 *  the wrong column. */
function stackTotalAccessor(series: OdooSeries, present: readonly OdooSeries[]) {
  return (entry: { payload?: Record<string, unknown> }) => {
    const row = entry.payload;
    if (!row) return "";
    const top = [...present].reverse().find((s) => Number(row[s] ?? 0) > 0);
    return top === series ? fmt(present.reduce((n, s) => n + Number(row[s] ?? 0), 0)) : "";
  };
}

// ---- headline numbers and the product cards ----

function Delta({ cur, prev, suffix = "" }: { cur: number; prev: number | null; suffix?: string }) {
  const pct = pctChange(cur, prev);
  if (pct === null) return prev === null ? null : <span className="text-xs text-muted">new — none before</span>;
  const cls = pct > 0 ? "text-ok-fg" : pct < 0 ? "text-bad-fg" : "text-muted";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  return (
    <span className={`text-xs font-bold ${cls}`} title={`Previous period: ${fmt(prev!)}${suffix}`}>
      {arrow} {Math.abs(pct)}% <span className="font-normal text-muted">vs previous</span>
    </span>
  );
}

function Stat({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: React.ReactNode }) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-[10rem] flex-1">
      <div className="text-xs font-bold text-muted">{label}</div>
      <div className="text-[28px] font-semibold leading-tight ltr">{value}</div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {delta}
        {sub && <span className="text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/** A dozen-ish thin bars of the product's daily quantity — a shape, not a chart. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const w = 100, h = 28, gap = n > 40 ? 0.4 : 1;
  const bw = Math.max(0.6, w / n - gap);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-7 block" aria-hidden="true">
      {values.map((v, i) => {
        const bh = v > 0 ? Math.max(1.5, (v / max) * h) : 0;
        return <rect key={i} x={i * (w / n)} y={h - bh} width={bw} height={bh} fill={color} opacity={v > 0 ? 1 : 0} rx={0.6} />;
      })}
    </svg>
  );
}

function ProductCards({ d, present, pal }: { d: OdooDashboardData; present: OdooSeries[]; pal: Palette }) {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]">
      {present.map((s) => {
        const t = d.totals.find((x) => x.series === s)!;
        const daily = d.days.map((p) => p.bySeries[s]);
        const best = Math.max(0, ...daily);
        return (
          <div key={s} className="bg-surface border rounded-xl px-4 py-3 border-t-4" style={{ borderTopColor: pal.color(s) }}>
            <div className="flex items-center gap-2 text-xs font-bold text-muted">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: pal.color(s) }} />
              {s}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-semibold leading-tight ltr">{fmt(t.qty)}</span>
              <span className="text-xs text-muted">{t.rows} row{t.rows === 1 ? "" : "s"} · {t.share}%</span>
            </div>
            <div className="min-h-[1rem]"><Delta cur={t.qty} prev={t.prevQty} /></div>
            <div className="mt-1.5"><Sparkline values={daily} color={pal.color(s)} /></div>
            <div className="text-[11px] text-muted mt-0.5">best day {fmt(best)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ---- chart pieces ----

function ChartScroller({ minWidth, height, children }: { minWidth: number; height: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto viz">
      <div style={{ minWidth, height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

type TipRow = { name?: string | number; value?: number | string; color?: string; dataKey?: string | number };

/** Value first, series second; a short stroke of the series colour keys each row. */
function Tip({ active, label, payload, total }: { active?: boolean; label?: string | number; payload?: TipRow[]; total?: boolean }) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => Number(p.value) > 0);
  const sum = payload.reduce((a, p) => a + Number(p.value ?? 0), 0);
  return (
    <div className="bg-surface border rounded-lg shadow-md px-3 py-2 text-xs min-w-[10rem]">
      <div className="font-bold mb-1">{String(label)}</div>
      {rows.length === 0 && <div className="text-muted">nothing logged</div>}
      {rows.map((p) => (
        <div key={String(p.dataKey ?? p.name)} className="flex items-center gap-2 py-0.5">
          <span className="inline-block w-3 h-0.5 rounded" style={{ background: p.color }} />
          <span className="font-extrabold tabnum ltr">{fmt(Number(p.value))}</span>
          <span className="text-muted">{String(p.name)}</span>
        </div>
      ))}
      {total && rows.length > 1 && (
        <div className="flex items-center gap-2 pt-1 mt-1 border-t">
          <span className="inline-block w-3" />
          <span className="font-extrabold tabnum ltr">{fmt(sum)}</span>
          <span className="text-muted">total</span>
        </div>
      )}
    </div>
  );
}

function Card({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-surface border rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div>
          <h2 className="font-bold leading-tight">{title}</h2>
          {sub && <p className="text-xs text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function DailyByProduct({ d, present, pal }: { d: OdooDashboardData; present: OdooSeries[]; pal: Palette }) {
  const data = d.days.map((p) => ({ label: p.label, ...p.bySeries }));
  const n = d.days.length;
  return (
    <ChartScroller minWidth={Math.max(560, n * 34)} height={340}>
      <BarChart data={data} margin={{ top: 18, right: 16, left: -12, bottom: 0 }} barCategoryGap="25%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={tickEvery(n, 16)} tickLine={false} />
        <YAxis domain={[0, headroom]} tickCount={6} allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<Tip total />} cursor={{ fill: "var(--surface-2)" }} />
        <Legend {...legendProps(present.map((s) => ({ value: s, color: pal.color(s) })))} />
        {present.map((s, i) => (
          <Bar
            key={s} dataKey={s} name={s} stackId="qty" fill={pal.color(s)}
            stroke="var(--surface)" strokeWidth={2} maxBarSize={28}
            radius={i === present.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          >
            <LabelList dataKey={s} content={segmentLabel(pal.ink(s))} />
            <LabelList valueAccessor={stackTotalAccessor(s, present)} position="top" fontSize={10} fontWeight={700} fill="var(--foreground)" />
          </Bar>
        ))}
      </BarChart>
    </ChartScroller>
  );
}

/** One small chart per product, on a shared scale, every day's count on its cap. */
function SmallMultiples({ d, present, pal }: { d: OdooDashboardData; present: OdooSeries[]; pal: Palette }) {
  const n = d.days.length;
  const yMax = Math.max(1, ...d.days.flatMap((p) => present.map((s) => p.bySeries[s])));
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {present.map((s) => {
        const data = d.days.map((p) => ({ label: p.label, qty: p.bySeries[s] }));
        const t = d.totals.find((x) => x.series === s)!;
        return (
          <div key={s} className="border rounded-lg p-2">
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-sm font-bold flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: pal.color(s) }} />
                {s}
              </span>
              <span className="text-xs text-muted tabnum">{fmt(t.qty)} in period</span>
            </div>
            <ChartScroller minWidth={Math.max(240, n * (n > 45 ? 9 : 14))} height={150}>
              <BarChart data={data} margin={{ top: 14, right: 10, left: -6, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={tickEvery(n, 8)} tickLine={false} />
                <YAxis domain={[0, headroom(yMax)]} tickCount={4} allowDecimals={false} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
                <Bar dataKey="qty" name={s} fill={pal.color(s)} maxBarSize={18} radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  <LabelList dataKey="qty" content={TopLabel} />
                </Bar>
              </BarChart>
            </ChartScroller>
          </div>
        );
      })}
    </div>
  );
}

function ProductTotals({ d }: { d: OdooDashboardData }) {
  const data = d.totals.map((t) => ({ series: t.series, qty: t.qty, label: `${fmt(t.qty)}  ·  ${t.share}%` }));
  return (
    <ChartScroller minWidth={360} height={Math.max(160, 30 + data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 84, left: 8, bottom: 0 }} barCategoryGap="35%">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="series" tick={{ fontSize: 12 }} width={100} axisLine={false} tickLine={false} />
        <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey="qty" name="Qty" maxBarSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false} fill="var(--brand)">
          <LabelList dataKey="label" position="right" fontSize={11} fill="var(--foreground)" />
        </Bar>
      </BarChart>
    </ChartScroller>
  );
}

/** Logged beside closed, per day — two columns, because a close lands on the
 *  day the status went to Done, not on the day the row was logged. */
function LoggedVsClosed({ d }: { d: OdooDashboardData }) {
  const data = d.days.map((p) => ({ label: p.label, Logged: p.loggedQty, Closed: p.doneQty }));
  const n = d.days.length;
  const yMax = Math.max(1, ...d.days.map((p) => Math.max(p.loggedQty, p.doneQty)));
  return (
    <ChartScroller minWidth={Math.max(420, n * 22)} height={240}>
      <BarChart data={data} margin={{ top: 14, right: 16, left: -12, bottom: 0 }} barCategoryGap="25%" barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={tickEvery(n, 10)} tickLine={false} />
        <YAxis domain={[0, headroom(yMax)]} tickCount={5} allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
        <Legend {...legendProps([{ value: "Logged", color: "var(--viz-other)" }, { value: "Closed", color: "var(--brand)" }])} />
        <Bar dataKey="Logged" fill="var(--viz-other)" maxBarSize={18} radius={[3, 3, 0, 0]} isAnimationActive={false}>
          <LabelList dataKey="Logged" content={TopLabel} />
        </Bar>
        <Bar dataKey="Closed" fill="var(--brand)" maxBarSize={18} radius={[3, 3, 0, 0]} isAnimationActive={false}>
          <LabelList dataKey="Closed" content={TopLabel} />
        </Bar>
      </BarChart>
    </ChartScroller>
  );
}

// ---- table view: the same numbers, readable without the chart ----

function DayTable({ d, present, pal }: { d: OdooDashboardData; present: OdooSeries[]; pal: Palette }) {
  const days = [...d.days].filter((p) => p.rows > 0 || p.loggedRows > 0 || p.doneRows > 0).reverse();
  const closedBasis = d.basis === "closed";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 text-left">
            <th className="p-2">Day</th>
            {present.map((s) => (
              <th key={s} className="p-2 text-center whitespace-nowrap">
                <span className="inline-block w-2.5 h-2.5 rounded-sm align-middle me-1" style={{ background: pal.color(s) }} />
                {s}
              </th>
            ))}
            <th className="p-2 text-center">{closedBasis ? "Closed qty" : "Logged qty"}</th>
            <th className="p-2 text-center">Rows</th>
            <th className="p-2 text-center text-muted" title={closedBasis ? "Quantity logged that day" : "Quantity whose status went to Done that day, whichever day it was logged"}>
              {closedBasis ? "Logged qty" : "Closed qty"}
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map((p) => (
            <tr key={p.dateISO} className="border-t">
              <td className="p-2 whitespace-nowrap tabnum ltr">{p.dateISO}</td>
              {present.map((s) => (
                <td key={s} className="p-2 text-center tabnum">{p.bySeries[s] > 0 ? fmt(p.bySeries[s]) : <span className="text-muted">—</span>}</td>
              ))}
              <td className="p-2 text-center tabnum font-extrabold">{fmt(p.qty)}</td>
              <td className="p-2 text-center tabnum">{p.rows}</td>
              <td className="p-2 text-center tabnum text-muted">{(closedBasis ? p.loggedQty : p.doneQty) > 0 ? fmt(closedBasis ? p.loggedQty : p.doneQty) : "—"}</td>
            </tr>
          ))}
          {days.length > 0 && (
            <tr className="border-t bg-surface-2 font-extrabold">
              <td className="p-2">Total</td>
              {present.map((s) => (
                <td key={s} className="p-2 text-center tabnum">{fmt(d.totals.find((t) => t.series === s)?.qty ?? 0)}</td>
              ))}
              <td className="p-2 text-center tabnum">{fmt(d.kpi.qty)}</td>
              <td className="p-2 text-center tabnum">{d.kpi.rows}</td>
              <td className="p-2 text-center tabnum text-muted">{fmt(closedBasis ? d.kpi.loggedQty : d.kpi.doneQty)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- the page body ----

export function OdooDashboard({ data: d }: { data: OdooDashboardData & { insights: OdooInsights } }) {
  const [showTable, setShowTable] = useState(false);
  const present = d.series;
  const pal = useMemo(() => paletteFor(present), [present]);
  const title = periodLabel(d.period);
  // a narrowed dashboard must say so on the page, not only in the picker —
  // printed or screenshotted, the numbers are otherwise the whole plant's
  const bomLabel = d.bom === null ? null : d.bom === "" ? "rows with no BOM in their code" : d.bom;
  const prevTitle = d.previous ? periodLabel({ range: "custom", fromISO: d.previous.fromISO, toISO: d.previous.toISO }) : null;
  const closedBasis = d.basis === "closed";
  const word = closedBasis ? "closed" : "logged";
  const doneNowPct = d.kpi.loggedRows > 0 ? Math.round((d.kpi.doneNowRows / d.kpi.loggedRows) * 100) : 0;

  const exportRows = useMemo(
    () => d.days.filter((p) => p.rows > 0 || p.loggedRows > 0 || p.doneRows > 0).map((p) => ({
      Day: p.dateISO,
      ...Object.fromEntries(present.map((s) => [`${s} (${word})`, p.bySeries[s]])),
      [`Total ${word}`]: p.qty,
      [`Rows ${word}`]: p.rows,
      "Logged qty": p.loggedQty,
      "Logged rows": p.loggedRows,
      "Closed qty": p.doneQty,
      "Closed rows": p.doneRows,
    })),
    [d, present, word]
  );

  if (d.kpi.rows === 0) {
    const other = closedBasis
      ? d.kpi.loggedRows > 0 ? ` ${d.kpi.loggedRows} row(s) were logged in it — switch to "Logged day" to see them.` : ""
      : d.kpi.doneRows > 0 ? ` ${d.kpi.doneRows} row(s) were closed in it — switch to "Closed day" to see them.` : "";
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">{title}{bomLabel && <> · <b className="text-foreground">{bomLabel}</b></>}</p>
        <p className="text-sm text-muted bg-surface border rounded-xl p-4">
          Nothing {word} {bomLabel ? "on this BOM " : ""}in this period.{other} {other ? "" : `Pick a wider one${bomLabel ? " or another BOM" : ""}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-bold">{title}</span>
          {bomLabel && <span> · BOM <b className="text-accent">{bomLabel}</b></span>}
          {prevTitle && <span className="text-muted"> · compared with {prevTitle}</span>}
        </div>
        <ExportButton rows={exportRows} filename={`odoo-dashboard-${d.bom ? `${d.bom}-` : ""}${d.period.fromISO ?? "all"}-${d.period.toISO}.xlsx`} sheetName="By day" />
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat label={`Quantity ${word}`} value={fmt(d.kpi.qty)} delta={<Delta cur={d.kpi.qty} prev={d.kpi.prevQty} />} />
        <Stat label={`Rows ${word}`} value={fmt(d.kpi.rows)} delta={<Delta cur={d.kpi.rows} prev={d.kpi.prevRows} />} sub={`${d.kpi.activeDays} day(s) with ${closedBasis ? "closings" : "entries"}`} />
        {closedBasis ? (
          <Stat label="Logged in period" value={fmt(d.kpi.loggedQty)} sub={`${d.kpi.loggedRows} row(s) entered · ${doneNowPct}% of them Done by now`} />
        ) : (
          <Stat label="Closed in period" value={fmt(d.kpi.doneQty)} sub={`${d.kpi.doneRows} row(s) moved to Done · ${doneNowPct}% of the logged rows are Done now`} />
        )}
        <Stat label="Per active day" value={fmt(d.kpi.qtyPerActiveDay)} sub={`qty on the days that had ${closedBasis ? "closings" : "rows"}`} />
      </div>

      <section>
        <h2 className="font-bold mb-2">Per product <span className="text-muted font-normal text-sm">· {word}</span></h2>
        <ProductCards d={d} present={present} pal={pal} />
      </section>

      <OdooInsightsSection
        ins={d.insights}
        colorOf={(product) => pal.color(product)}
        file={(name) => `odoo-${name}-${d.bom ? `${d.bom}-` : ""}${d.period.fromISO ?? "all"}-${d.period.toISO}.xlsx`}
      />

      <Card title={`Quantity ${word} per day, by product`} sub={`Each column is a day (the day rows were ${word}); every segment carries its count, the cap the day's total. Hover a column for the full breakdown.`}>
        <DailyByProduct d={d} present={present} pal={pal} />
      </Card>

      <Card title="Each product, day by day" sub={`One chart per product on the same scale, the quantity ${word} on every column.`}>
        <SmallMultiples d={d} present={present} pal={pal} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Totals per product" sub={`Quantity ${word} and share of the period.`}>
          <ProductTotals d={d} />
        </Card>
        <Card title="Logged vs closed, per day" sub="Logged on the day the row was entered; closed on the day its status went to Done.">
          <LoggedVsClosed d={d} />
        </Card>
      </div>

      <section className="bg-surface border rounded-xl overflow-hidden">
        <button type="button" className="w-full text-left px-4 py-3 font-bold flex items-center justify-between" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
          <span>The numbers as a table</span>
          <span className="text-muted text-sm">{showTable ? "Hide" : "Show"}</span>
        </button>
        {showTable && <DayTable d={d} present={present} pal={pal} />}
      </section>
    </div>
  );
}
