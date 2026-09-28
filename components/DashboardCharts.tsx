"use client";

import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine,
  Funnel, FunnelChart, Cell, LabelList, RadialBarChart, RadialBar, PolarAngleAxis,
} from "recharts";
import type { BacklogPoint, PromiseDay, StageLoad } from "@/lib/domain/control";
import { LOAD_LABEL } from "@/lib/domain/control";
import { TipBox } from "@/components/charts/kit";
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

type TipEntry = { name?: unknown; value?: unknown; color?: string; dataKey?: unknown };
const n0 = (v: unknown) => Number(v ?? 0).toLocaleString("en");

/** A tooltip for the department series: each value beside its swatch, and
 *  how it stands against the target when there is one. */
function deptTip(target?: number, unit = "pcs") {
  const Tip = ({ active, label, payload }: { active?: boolean; label?: unknown; payload?: readonly TipEntry[] }) => {
    if (!active || !payload?.length) return null;
    return (
      <TipBox
        title={String(label)}
        rows={payload.map((p) => ({
          label: target ? `${String(p.name)} · ${Math.round((Number(p.value ?? 0) / target) * 100)}% of ${n0(target)}` : String(p.name),
          value: `${n0(p.value)} ${unit}`,
          color: p.color,
        }))}
      />
    );
  };
  return Tip;
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
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={deptTip(targetPerDeptDay)} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inPipelineOrder} formatter={legendText} />
        <ReferenceLine y={targetPerDeptDay} stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={1.5} />
        <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} {...BAR} />
        <Bar dataKey="Welding" name="Welding" fill={WELD} {...BAR} />
        <Bar dataKey="Painting" name={FINISHING_LABEL} fill={FIN} {...BAR} />
      </BarChart>
    </ChartScroller>
  );
}

/** Weekly history: dept totals vs the weekly target — a trend, so lines with
 *  a marker per week, the target as the dashed threshold. */
export function HistoryChart({ history, targetPerDeptWeek }: { history: { label: string; cutTotal: number; weldTotal: number; paintTotal: number }[]; targetPerDeptWeek: number }) {
  const data = [...history].reverse().map((h) => ({ week: h.label, Fabrication: h.cutTotal, Welding: h.weldTotal, Painting: h.paintTotal }));
  const dot = (color: string) => ({ r: 4, fill: color, stroke: "var(--surface)", strokeWidth: 2 });
  return (
    <ChartScroller minWidth={520} height={240}>
      <LineChart data={data} margin={{ top: 12, right: 16, left: -10, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="week" tick={{ fontSize: 10 }} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} padding={{ left: 12, right: 12 }} />
        <YAxis allowDecimals={false} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={deptTip(targetPerDeptWeek)} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={inPipelineOrder} formatter={legendText} />
        <ReferenceLine y={targetPerDeptWeek} stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={1.5} />
        <Line type="monotone" dataKey="Fabrication" name="Fabrication" stroke={FAB} strokeWidth={2} dot={dot(FAB)} activeDot={{ r: 6, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
        <Line type="monotone" dataKey="Welding" name="Welding" stroke={WELD} strokeWidth={2} dot={dot(WELD)} activeDot={{ r: 6, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
        <Line type="monotone" dataKey="Painting" name={FINISHING_LABEL} stroke={FIN} strokeWidth={2} dot={dot(FIN)} activeDot={{ r: 6, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
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
        <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={deptTip(undefined, "pcs waiting")} />
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
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={deptTip(undefined, "units")} />
        <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={(i) => order.indexOf(String(i.value))} formatter={legendText} />
        <Bar dataKey="On track" stackId="p" fill="var(--ok-fg)" maxBarSize={24} />
        <Bar dataKey="At risk" stackId="p" fill="var(--bad-fg)" maxBarSize={24} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartScroller>
  );
}

// ---- the pipeline, as a funnel ----

/** A funnel step's name, count and share of the required, one line to the
 *  right of the trapezoid. */
function StepLabel(p: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown }) {
  const x = Number(p.x ?? 0) + Number(p.width ?? 0) + 8;
  const y = Number(p.y ?? 0) + Number(p.height ?? 0) / 2;
  return <text x={x} y={y} dy={4} fontSize={12} fill="var(--foreground)">{String(p.value ?? "")}</text>;
}

/** The required pieces narrowing through the stages — each step keeps what
 *  has passed it, in the stage ramp (later = darker). */
export function PipelineFunnel({ need, steps }: { need: number; steps: { label: string; done: number }[] }) {
  // nothing required draws five equal bars that read as "all through" — say it instead
  if (need <= 0) return <p className="text-sm text-muted py-6">No open orders — nothing going through the stages.</p>;
  const ramp = ["var(--viz-other)", "var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)"];
  const data = [{ label: "Required", done: need }, ...steps].map((s) => ({
    ...s,
    // a funnel of zeros draws nothing — keep a sliver so the shape still reads
    value: Math.max(s.done, need * 0.02, 0.5),
    text: `${s.label} · ${n0(s.done)}${need > 0 && s.label !== "Required" ? ` (${Math.round((s.done / need) * 100)}%)` : ""}`,
  }));
  return (
    <div style={{ height: 210 }}>
      <ResponsiveContainer width="100%" height="100%">
        <FunnelChart margin={{ top: 2, right: 170, bottom: 2, left: 4 }}>
          <Tooltip content={({ active, payload }: { active?: boolean; payload?: readonly { payload?: (typeof data)[number] }[] }) => {
            const r = active ? payload?.[0]?.payload : undefined;
            return r ? <TipBox title={r.label} rows={[{ label: "Pieces", value: n0(r.done) }, ...(r.label !== "Required" && need > 0 ? [{ label: "Of required", value: `${Math.round((r.done / need) * 100)}%` }] : [])]} /> : null;
          }} />
          <Funnel dataKey="value" data={data} isAnimationActive={false} stroke="var(--surface)" strokeWidth={2} lastShapeType="rectangle">
            {data.map((d, i) => <Cell key={d.label} fill={ramp[i]} />)}
            <LabelList dataKey="text" content={StepLabel} />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- load against the days left, as rings ----

/** One ring per stage: the days of queued work as a share of the working
 *  days left (a full ring = exactly enough time; past it the ring is capped
 *  and the tone says so). Innermost = the first stage. */
export function LoadRings({ stages, daysLeft }: { stages: StageLoad[]; daysLeft: number }) {
  const tone = (r: number | null) => (r === null ? "var(--border-strong)" : r <= 1 ? "var(--ok-fg)" : r <= 1.25 ? "var(--warn-fg)" : "var(--bad-fg)");
  const data = stages.map((l) => {
    const ratio = l.daysOfWork === null ? null : daysLeft > 0 ? l.daysOfWork / daysLeft : Infinity;
    return { name: LOAD_LABEL[l.stage], ratio, value: ratio === null ? 0 : Math.min(100, ratio * 100), fill: tone(ratio), days: l.daysOfWork };
  });
  return (
    <div className="flex items-center gap-3">
      <div style={{ width: 150, height: 150 }} className="shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart data={data} innerRadius="32%" outerRadius="100%" startAngle={90} endAngle={-270} barSize={11}>
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
            <RadialBar dataKey="value" cornerRadius={6} background={{ fill: "var(--surface-2)" }} isAnimationActive={false} />
            <Tooltip content={({ active, payload }: { active?: boolean; payload?: readonly { payload?: (typeof data)[number] }[] }) => {
              const r = active ? payload?.[0]?.payload : undefined;
              return r ? <TipBox title={r.name} rows={[{ label: "Days of work", value: r.days === null ? "no pace" : r.days.toFixed(1), color: r.fill }, { label: "Days left", value: String(daysLeft) }]} /> : null;
            }} />
          </RadialBarChart>
        </ResponsiveContainer>
      </div>
      <ul className="text-xs space-y-1">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: d.fill }} aria-hidden />
            <span className="font-semibold">{d.name}</span>
            <span className="text-muted tabnum">{d.ratio === null ? "no pace" : d.ratio === Infinity ? "no days left" : `${Math.round(d.ratio * 100)}% of the days left`}</span>
          </li>
        ))}
        <li className="text-muted pt-1">Inner ring = first stage · a full ring = just enough time</li>
      </ul>
    </div>
  );
}
