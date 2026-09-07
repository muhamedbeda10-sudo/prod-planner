"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, type ComponentProps } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, LabelList,
} from "recharts";
import { ODOO_RANGES, ODOO_RANGE_LABEL, ODOO_SERIES, type OdooDashboardData, type OdooSeries } from "@/lib/domain/odooStats";

// The Odoo dashboard — what was logged each day, by product. One filter row
// scopes everything: a KPI strip, the stacked columns per day, a bar per
// product for the range, closed-vs-open per day, and the same numbers as a
// table (the chart is never the only way to read a value).

const SERIES_VAR: Record<OdooSeries, string> = {
  Tank: "var(--viz-1)",
  "Top Cover": "var(--viz-2)",
  "Core Frame": "var(--viz-3)",
  Encloser: "var(--viz-4)",
  "Cable Box": "var(--viz-5)",
  Conservator: "var(--viz-6)",
  Other: "var(--viz-other)",
};

/** A legend in OUR series order, with text in the text colour — recharts would
 *  sort it alphabetically and paint each name in its series colour. */
type LegendItem = { value: string; type: "square"; id: string; color: string };
function legendProps(items: LegendItem[]): ComponentProps<typeof Legend> {
  const order = items.map((i) => i.value);
  return {
    wrapperStyle: { fontSize: 12 },
    iconType: "square",
    iconSize: 10,
    formatter: (value: unknown) => <span style={{ color: "var(--foreground)" }}>{String(value)}</span>,
    // recharts sorts legend items by name unless told otherwise
    itemSorter: (item: { value?: unknown }) => order.indexOf(String(item.value)),
  } as ComponentProps<typeof Legend>;
}

/** Tick interval so at most `max` day labels show — the rest stay in the tooltip and table. */
const tickEvery = (n: number, max: number) => (n > max ? Math.ceil(n / max) - 1 : 0);

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 1 }));

// ---- filter row ----

export function OdooRangePicker({ range }: { range: OdooDashboardData["range"] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (v: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("range", v);
    router.push(`${pathname}?${p}`);
  };
  return (
    <div className="seg" role="tablist" aria-label="Date range">
      {ODOO_RANGES.map((r) => (
        <button key={r} type="button" role="tab" aria-selected={r === range} className={r === range ? "on" : ""} onClick={() => go(r)}>
          {ODOO_RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );
}

// ---- KPI strip ----

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-[9rem]">
      <div className="text-xs font-bold text-muted">{label}</div>
      <div className="text-[28px] font-semibold leading-tight ltr">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
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

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface border rounded-xl p-4">
      <h2 className="font-bold leading-tight">{title}</h2>
      {sub && <p className="text-xs text-muted mb-2">{sub}</p>}
      {children}
    </section>
  );
}

function DailyByProduct({ d, present }: { d: OdooDashboardData; present: OdooSeries[] }) {
  const data = d.days.map((p) => ({ label: p.label, ...p.bySeries }));
  const n = d.days.length;
  return (
    <ChartScroller minWidth={Math.max(560, n * 28)} height={300}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: -12, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={tickEvery(n, 16)} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<Tip total />} cursor={{ fill: "var(--surface-2)" }} />
        <Legend {...legendProps(present.map((s) => ({ value: s, type: "square" as const, id: s, color: SERIES_VAR[s] })))} />
        {present.map((s, i) => (
          <Bar
            key={s} dataKey={s} name={s} stackId="qty" fill={SERIES_VAR[s]}
            stroke="var(--surface)" strokeWidth={2} maxBarSize={24}
            radius={i === present.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartScroller>
  );
}

function ProductTotals({ d }: { d: OdooDashboardData }) {
  const data = d.totals.map((t) => ({ series: t.series, qty: t.qty, rows: t.rows }));
  return (
    <ChartScroller minWidth={360} height={Math.max(160, 30 + data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 48, left: 8, bottom: 0 }} barCategoryGap="35%">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="series" tick={{ fontSize: 12 }} width={100} axisLine={false} tickLine={false} />
        <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey="qty" name="Qty" maxBarSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false} fill="var(--brand)">
          <LabelList dataKey="qty" position="right" fontSize={11} formatter={(v: unknown) => fmt(Number(v))} className="fill-foreground" />
        </Bar>
      </BarChart>
    </ChartScroller>
  );
}

function ClosedPerDay({ d }: { d: OdooDashboardData }) {
  const data = d.days.map((p) => ({ label: p.label, Done: p.doneQty, "Not closed": Math.max(0, p.qty - p.doneQty) }));
  const n = d.days.length;
  return (
    <ChartScroller minWidth={Math.max(420, n * 16)} height={220}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: -12, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={tickEvery(n, 10)} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<Tip total />} cursor={{ fill: "var(--surface-2)" }} />
        <Legend {...legendProps([{ value: "Done", type: "square", id: "Done", color: "var(--brand)" }, { value: "Not closed", type: "square", id: "Not closed", color: "var(--viz-other)" }])} />
        <Bar dataKey="Done" stackId="q" fill="var(--brand)" stroke="var(--surface)" strokeWidth={2} maxBarSize={24} isAnimationActive={false} />
        <Bar dataKey="Not closed" stackId="q" fill="var(--viz-other)" stroke="var(--surface)" strokeWidth={2} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartScroller>
  );
}

// ---- table view: the same numbers, readable without the chart ----

function DayTable({ d, present }: { d: OdooDashboardData; present: OdooSeries[] }) {
  const days = [...d.days].filter((p) => p.rows > 0).reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 text-left">
            <th className="p-2">Day</th>
            {present.map((s) => (
              <th key={s} className="p-2 text-center whitespace-nowrap">
                <span className="inline-block w-2.5 h-2.5 rounded-sm align-middle me-1" style={{ background: SERIES_VAR[s] }} />
                {s}
              </th>
            ))}
            <th className="p-2 text-center">Total qty</th>
            <th className="p-2 text-center">Rows</th>
            <th className="p-2 text-center">Done qty</th>
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
              <td className="p-2 text-center tabnum text-ok-fg font-bold">{p.doneQty > 0 ? fmt(p.doneQty) : <span className="text-muted font-normal">—</span>}</td>
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
              <td className="p-2 text-center tabnum text-ok-fg">{fmt(d.kpi.doneQty)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- the page body ----

export function OdooDashboard({ data: d }: { data: OdooDashboardData }) {
  const [showTable, setShowTable] = useState(false);
  const present = ODOO_SERIES.filter((s) => d.totals.some((t) => t.series === s));
  const span = d.fromISO ? `${d.fromISO} → ${d.toISO}` : `up to ${d.toISO}`;
  const donePct = d.kpi.rows > 0 ? Math.round((d.kpi.doneRows / d.kpi.rows) * 100) : 0;

  if (d.kpi.rows === 0) {
    return <p className="text-sm text-muted bg-surface border rounded-xl p-4">Nothing logged {d.fromISO ? `between ${d.fromISO} and ${d.toISO}` : "yet"}. Pick a wider range, or log the day&apos;s rows first.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-3">
        <Stat label="Quantity logged" value={fmt(d.kpi.qty)} sub={span} />
        <Stat label="Rows" value={fmt(d.kpi.rows)} sub={`${d.kpi.activeDays} day(s) with entries`} />
        <Stat label="Done" value={`${donePct}%`} sub={`${d.kpi.doneRows} of ${d.kpi.rows} rows · ${fmt(d.kpi.doneQty)} qty`} />
        <Stat label="Per active day" value={fmt(d.kpi.qtyPerActiveDay)} sub="qty on the days that had rows" />
      </div>

      <Card title="Quantity per day, by product" sub="Each column is a day; the segments are the products logged that day. Hover a column for the numbers.">
        <DailyByProduct d={d} present={present} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Totals per product" sub={`Quantity over ${ODOO_RANGE_LABEL[d.range].toLowerCase()}.`}>
          <ProductTotals d={d} />
        </Card>
        <Card title="Closed vs not closed, per day" sub="Quantity on rows whose status is Done, against the rest.">
          <ClosedPerDay d={d} />
        </Card>
      </div>

      <section className="bg-surface border rounded-xl overflow-hidden">
        <button type="button" className="w-full text-left px-4 py-3 font-bold flex items-center justify-between" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
          <span>The numbers as a table</span>
          <span className="text-muted text-sm">{showTable ? "Hide" : "Show"}</span>
        </button>
        {showTable && <DayTable d={d} present={present} />}
      </section>
    </div>
  );
}
