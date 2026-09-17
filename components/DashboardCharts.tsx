"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { FINISHING_LABEL } from "@/lib/domain/constants";
import type { DayRow } from "@/lib/server/dashboard";

/* The three departments are the three series everywhere: Fabrication green,
   Welding blue, Finishing orange — the same identity as the tracker, stepped
   per theme in globals.css (--series-*), validated for CVD separation. */
const FAB = "var(--series-fab)";
const WELD = "var(--series-weld)";
const FIN = "var(--series-fin)";

// the legend reads in pipeline order — recharts sorts it alphabetically unless told
const DEPT_ORDER = ["Fabrication", "Welding", FINISHING_LABEL];
const inPipelineOrder = (item: { value?: unknown }) => DEPT_ORDER.indexOf(String(item.value));

// thin marks on a recessive hairline grid; the values live in the tooltip and
// the axis, the target as a dashed threshold line named in the card's subtitle
const GRID = { stroke: "var(--border)", vertical: false } as const;
const TICK = { fontSize: 11 } as const;
const BAR = { maxBarSize: 24, radius: [4, 4, 0, 0] as [number, number, number, number] };

/** Charts keep a readable minimum width and scroll sideways inside their card
 *  on narrow phones instead of being squeezed off-screen. */
function ChartScroller({ minWidth, height, children }: { minWidth: number; height: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth, height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

/** Daily totals per dept across the period, with the daily target line. */
export function WeekTrendChart({ days, targetPerDeptDay }: { days: DayRow[]; targetPerDeptDay: number }) {
  const data = days.map((d) => ({ day: d.label, Fabrication: d.cut.total, Welding: d.weld.total, Painting: d.paint.total }));
  return (
    <ChartScroller minWidth={520} height={260}>
      <BarChart data={data} margin={{ top: 12, right: 10, left: -10, bottom: 0 }} barGap={2}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="day" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} />
        <YAxis allowDecimals={false} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inPipelineOrder} />
        <ReferenceLine y={targetPerDeptDay} stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={1.5} />
        <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} {...BAR} />
        <Bar dataKey="Welding" name="Welding" fill={WELD} {...BAR} />
        <Bar dataKey="Painting" name={FINISHING_LABEL} fill={FIN} {...BAR} />
      </BarChart>
    </ChartScroller>
  );
}

/** Weekly history: dept totals vs the weekly target. */
export function HistoryChart({ history, targetPerDeptWeek }: { history: { label: string; cutTotal: number; weldTotal: number; paintTotal: number }[]; targetPerDeptWeek: number }) {
  const data = [...history].reverse().map((h) => ({ week: h.label, Fabrication: h.cutTotal, Welding: h.weldTotal, Painting: h.paintTotal }));
  return (
    <ChartScroller minWidth={560} height={240}>
      <BarChart data={data} margin={{ top: 12, right: 10, left: -10, bottom: 0 }} barGap={2}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="week" tick={{ fontSize: 10 }} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} />
        <YAxis allowDecimals={false} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inPipelineOrder} />
        <ReferenceLine y={targetPerDeptWeek} stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={1.5} />
        <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} {...BAR} />
        <Bar dataKey="Welding" name="Welding" fill={WELD} {...BAR} />
        <Bar dataKey="Painting" name={FINISHING_LABEL} fill={FIN} {...BAR} />
      </BarChart>
    </ChartScroller>
  );
}
