"use client";

import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import type { BacklogPoint, PromiseDay } from "@/lib/domain/control";
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
// the swatch carries the identity; the legend's text stays in the text ink
const legendText = (value: unknown) => <span style={{ color: "var(--foreground)" }}>{String(value)}</span>;

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
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inPipelineOrder} formatter={legendText} />
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
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inPipelineOrder} formatter={legendText} />
        <ReferenceLine y={targetPerDeptWeek} stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={1.5} />
        <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} {...BAR} />
        <Bar dataKey="Welding" name="Welding" fill={WELD} {...BAR} />
        <Bar dataKey="Painting" name={FINISHING_LABEL} fill={FIN} {...BAR} />
      </BarChart>
    </ChartScroller>
  );
}

// ---- the backlog, day by day ----


const STAGE_LINES: { key: keyof Omit<BacklogPoint, "dateISO">; label: string; color: string }[] = [
  { key: "fab", label: "Waiting for fabrication", color: "var(--stage-1)" },
  { key: "weld", label: "Waiting for welding", color: "var(--stage-2)" },
  { key: "finish", label: "Waiting for finishing", color: "var(--stage-3)" },
  { key: "deliver", label: "Finished, not delivered", color: "var(--stage-4)" },
];
const STAGE_ORDER = STAGE_LINES.map((s) => s.label);
const inStageOrder = (item: { value?: unknown }) => STAGE_ORDER.indexOf(String(item.value));
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** The backlog at each stage over the last month, for the orders open today:
 *  the stage ramp in pipeline order, 2px lines, no dots. The lines converge,
 *  so no end labels — the legend and the tooltip carry the values, and the
 *  backlog card beside the chart states today's. */
export function BacklogChart({ history }: { history: BacklogPoint[] }) {
  const data = history.map((p) => ({ ...p, day: ddmm(p.dateISO) }));
  return (
    <ChartScroller minWidth={560} height={260}>
      <LineChart data={data} margin={{ top: 12, right: 16, left: -10, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="day" tick={{ fontSize: 10 }} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
        <YAxis allowDecimals={false} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ stroke: "var(--border-strong)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inStageOrder} formatter={legendText} />
        {STAGE_LINES.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartScroller>
  );
}

// ---- the promises ahead ----


/** Units promised per day over the next two weeks, the at-risk share stacked
 *  on top in the status colour — state, not identity, so it wears the status
 *  tokens and the legend names it. */
export function PromisesChart({ days }: { days: PromiseDay[] }) {
  const data = days.map((d) => ({ day: ddmm(d.dateISO), "On track": d.units - d.atRisk, "At risk": d.atRisk }));
  const order = ["On track", "At risk"];
  return (
    <ChartScroller minWidth={520} height={220}>
      <BarChart data={data} margin={{ top: 12, right: 10, left: -10, bottom: 0 }} barGap={2}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="day" tick={{ fontSize: 10 }} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} />
        <YAxis allowDecimals={false} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={(i) => order.indexOf(String(i.value))} formatter={legendText} />
        <Bar dataKey="On track" stackId="p" fill="var(--ok-fg)" maxBarSize={24} />
        <Bar dataKey="At risk" stackId="p" fill="var(--bad-fg)" maxBarSize={24} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartScroller>
  );
}
