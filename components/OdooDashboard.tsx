"use client";

import { formatDate } from "@/lib/domain/format";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { productColor, productInk } from "@/lib/domain/productColors";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, LabelList,
} from "recharts";
import { ExportButton } from "@/components/ExportButton";
import { OdooInsightsSection } from "@/components/OdooInsights";
import type { OdooInsights } from "@/lib/domain/odooInsights";
import { axisWidth, describeDelta, niceScale, DELTA_MIN_BASE } from "@/lib/domain/chartScale";
import {
  periodLabel,
  ODOO_COMPARE_LABEL,
  type OdooDashboardData, type OdooSeries,
} from "@/lib/domain/odooStats";

// The Odoo dashboard — what was logged each day, by product. One period row
// scopes everything below it: the headline numbers, a card per product, how
// the close-out is going (components/OdooInsights.tsx: close-rate gauge,
// funnel, status donut, lead time, aging, burn-up, BOM mix), the stacked
// columns per day (every count written on its segment), one small chart per
// product, totals and closed-vs-open, and the same numbers as a table with an
// Excel export — the chart is never the only way to read a value.

// Every product wears its ONE colour from the app's product map
// (lib/domain/productColors.ts) — the same here as on the Plan Tracker and
// the KPI cards, whatever else the period holds. A name outside the map
// (and "Other", a row with no product) reads grey.
type Palette = { color: (s: OdooSeries) => string; ink: (s: OdooSeries) => string };
const PAL: Palette = { color: (s) => productColor(s), ink: (s) => productInk(s) };

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

/** The day axis: recharts drops whichever labels would collide (keeping the
 *  first and last), so a label is always readable and never overlaps. */
const DAY_AXIS = { interval: "preserveStartEnd", minTickGap: 14 } as const;

// ---- labels written on the marks ----

type LabelBox = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown };

/** The count inside a stacked segment — only when the segment is tall and wide enough to hold it. */
function segmentLabel(ink: string) {
  const SegLabel = (p: LabelBox) => {
    const v = Number(p.value ?? 0);
    const w = Number(p.width ?? 0), h = Number(p.height ?? 0);
    // only where the number fits inside the segment, with a little air
    if (!v || h < 13 || w < fmt(v).length * 6.5 + 4) return null;
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
  const dv = describeDelta(cur, prev);
  if (dv.kind === "none") return null;
  const title = `Compared period: ${fmt(prev!)}${suffix}`;
  if (dv.kind === "new") return <span className="text-xs text-muted" title={title}>new — none before</span>;
  if (dv.kind === "same") return <span className="text-xs text-muted" title={title}>• same as previous</span>;
  const up = dv.kind === "pct" ? dv.pct > 0 : dv.diff > 0;
  const zero = dv.kind === "pct" && dv.pct === 0;
  const cls = zero ? "text-muted" : up ? "text-ok-fg" : "text-bad-fg";
  const arrow = zero ? "•" : up ? "▲" : "▼";
  return (
    <span
      className={`text-xs font-bold ${cls}`}
      title={dv.kind === "abs" ? `${title} — under ${DELTA_MIN_BASE} before, so the change is shown in pieces, not %` : title}
    >
      {arrow} {dv.kind === "pct" ? `${Math.abs(dv.pct)}%` : `${dv.diff > 0 ? "+" : "−"}${fmt(Math.abs(dv.diff))}${suffix || " pcs"}`}{" "}
      <span className="font-normal text-muted">vs {dv.kind === "abs" ? fmt(prev!) : "previous"}</span>
    </span>
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

const CARD_MIN = 176; // px — a card never gets narrower than its name and figure
const CARD_GAP = 12;

/** Equal cards that fill the row's whole width. When they need more than one
 *  row the rows are balanced (9 cards → 5 + 4, not 7 + 2), so no row is left
 *  with a long empty tail. */
function useBalancedColumns(n: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const max = Math.max(1, Math.floor((el.clientWidth + CARD_GAP) / (CARD_MIN + CARD_GAP)));
      const rows = Math.ceil(n / max);
      setCols(Math.ceil(n / rows));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n]);
  const style = cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined;
  return [ref, style] as const;
}

function ProductCards({ d, present, pal }: { d: OdooDashboardData; present: OdooSeries[]; pal: Palette }) {
  const [gridRef, gridStyle] = useBalancedColumns(present.length);
  return (
    <div ref={gridRef} className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))]" style={gridStyle}>
      {present.map((s) => {
        const t = d.totals.find((x) => x.series === s)!;
        const daily = d.days.map((p) => p.bySeries[s]);
        const best = Math.max(0, ...daily);
        return (
          <div key={s} className="min-w-0 bg-surface border rounded-xl px-4 py-3 border-t-4" style={{ borderTopColor: pal.color(s) }}>
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
  const top = Math.max(0, ...d.days.map((p) => present.reduce((a, s) => a + Number(p.bySeries[s] ?? 0), 0)));
  const y = niceScale(top);
  return (
    <ChartScroller minWidth={Math.max(560, n * 34)} height={340}>
      <BarChart data={data} margin={{ top: 18, right: 16, left: 0, bottom: 0 }} barCategoryGap="25%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} {...DAY_AXIS} tickLine={false} />
        <YAxis domain={[0, y.max]} ticks={y.ticks} allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={axisWidth(y.max)} />
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
  const y = niceScale(yMax);
  return (
    <ChartScroller minWidth={Math.max(420, n * 22)} height={240}>
      <BarChart data={data} margin={{ top: 14, right: 16, left: 0, bottom: 0 }} barCategoryGap="25%" barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} {...DAY_AXIS} tickLine={false} />
        <YAxis domain={[0, y.max]} ticks={y.ticks} allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={axisWidth(y.max)} />
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
              <td className="p-2 whitespace-nowrap tabnum ltr">{formatDate(p.dateISO)}</td>
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
  const pal = PAL;
  const title = periodLabel(d.period);
  // a narrowed dashboard must say so on the page, not only in the picker —
  // printed or screenshotted, the numbers are otherwise the whole plant's
  const bomLabel = d.bom === null ? null : d.bom === "" ? "rows with no known BOM" : d.bom;
  const prevTitle = d.previous ? periodLabel({ range: "custom", fromISO: d.previous.fromISO, toISO: d.previous.toISO }) : null;
  const closedBasis = d.basis === "closed";
  const word = closedBasis ? "closed" : "logged";

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
          {bomLabel && <span> · BOM <b className="text-brand-ink">{bomLabel}</b></span>}
          {prevTitle && <span className="text-muted"> · compared with {prevTitle}{d.compare !== "prev" ? ` (${ODOO_COMPARE_LABEL[d.compare].toLowerCase()})` : ""}</span>}
        </div>
        <ExportButton rows={exportRows} filename={`odoo-dashboard-${d.bom ? `${d.bom}-` : ""}${d.period.fromISO ?? "all"}-${d.period.toISO}.xlsx`} sheetName="By day" />
      </div>

      {/* the products first, centred across the page, then the day by day */}
      <section>
        <h2 className="font-bold mb-2 text-center">Per product <span className="text-muted font-normal text-sm">· {word}</span></h2>
        <ProductCards d={d} present={present} pal={pal} />
      </section>

      <Card title={`Quantity ${word} per day, by product`} sub={`Each column is a day (the day rows were ${word}); every segment carries its count, the cap the day's total. Hover a column for the full breakdown.`}>
        <DailyByProduct d={d} present={present} pal={pal} />
      </Card>

      <OdooInsightsSection
        ins={d.insights}
        colorOf={(product) => pal.color(product)}
        file={(name) => `odoo-${name}-${d.bom ? `${d.bom}-` : ""}${d.period.fromISO ?? "all"}-${d.period.toISO}.xlsx`}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Totals per product" sub={`Quantity ${word} and share of the period.`}>
          <ProductTotals d={d} />
        </Card>
        <Card title="Logged vs closed, per day" sub="Logged on entry · closed when Done">
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
