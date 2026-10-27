"use client";

import { Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TipBox, fmt, pct } from "@/components/charts/kit";
import { LABEL_HEADROOM, segmentLabel, segmentValue, stackTotalValue, TotalLabel } from "@/components/charts/labels";
import { MONTH_STATUS_LABEL, monthLong, monthShort } from "@/lib/domain/consumableMonthly";
import type { PowderFigures } from "@/lib/domain/powderScrap";

// The consumables pages' charts, apart from the pages so Recharts loads only
// when a chart draws (LazyCharts) — the tiles and tables paint first.

type Counted = "over" | "near" | "under" | "unused";
/** The statuses the six-month chart stacks, bottom up. */
const STACKED = ["under", "near", "over"] as const;

/** CONSUMABLES monthly review: items over / close / under their limit, by month. */
export function MonthStatusChart({ rows, color }: { rows: ({ month: string } & Record<Counted, number>)[]; color: Record<Counted, string> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows.map((c) => ({ ...c, label: monthShort(c.month) }))} margin={{ top: LABEL_HEADROOM, right: 8, left: -4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
          const p = active ? (payload?.[0]?.payload as (typeof rows)[number] | undefined) : undefined;
          return p ? <TipBox title={monthLong(p.month)} rows={(["over", "near", "under", "unused"] as const).map((s) => ({ label: MONTH_STATUS_LABEL[s], value: fmt(p[s]), color: color[s] }))} /> : null;
        }} />
        {STACKED.map((s, i) => (
          // the status inks are text colours on the card, so the card's own colour clears them as a fill
          <Bar key={s} dataKey={s} stackId="s" fill={color[s]} stroke="var(--surface)" strokeWidth={1} maxBarSize={36} radius={i === 2 ? [4, 4, 0, 0] : undefined} isAnimationActive={false}>
            <LabelList valueAccessor={segmentValue(s, STACKED)} content={segmentLabel("var(--surface)")} />
            <LabelList valueAccessor={stackTotalValue(s, STACKED)} content={TotalLabel} />
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Powder drawn and scrapped (kg, bars) and the scrap rate (line), by month. */
export function PowderTrendChart({ series, color }: { series: ({ month: string } & PowderFigures)[]; color: { withdrawn: string; scrap: string; rate: string } }) {
  const data = series.map((t) => ({ ...t, label: monthShort(t.month), ratePct: t.rate === null ? null : Math.round(t.rate * 1000) / 10 }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 12, right: 4, left: -4, bottom: 0 }} barCategoryGap="24%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
        <YAxis yAxisId="kg" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
        <YAxis yAxisId="rate" orientation="right" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} unit="%" allowDecimals={false} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
          const p = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
          return p ? <TipBox title={monthLong(p.month)} rows={[
            { label: "Drawn", value: `${fmt(p.withdrawn)} kg`, color: color.withdrawn },
            { label: "Scrap", value: `${fmt(p.scrap)} kg`, color: color.scrap },
            { label: "Net used", value: `${fmt(p.net)} kg` },
            { label: "Scrap rate", value: p.rate === null ? "—" : pct(p.rate, 1), color: color.rate, line: true },
          ]} /> : null;
        }} />
        <Bar yAxisId="kg" dataKey="withdrawn" fill={color.withdrawn} maxBarSize={34} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar yAxisId="kg" dataKey="scrap" fill={color.scrap} maxBarSize={34} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Line yAxisId="rate" type="monotone" dataKey="ratePct" stroke={color.rate} strokeWidth={2} connectNulls dot={{ r: 3, fill: color.rate }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
