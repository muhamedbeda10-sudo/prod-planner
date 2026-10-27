"use client";

import {
  Bar, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { CAT, Legend, TONE_COLOR, TRACK, TipBox, catInk, fmt, pct } from "@/components/charts/kit";
import { LABEL_HEADROOM, PlotText, fitsColumn, onColumn, segmentLabel, segmentValue, stackTotalValue, TotalLabel, type LabelBox } from "@/components/charts/labels";
import { formatDate } from "@/lib/domain/format";
import { OUTPUT_GROUP_LABEL, STAGES, STAGE_LABEL, efficiencyBand } from "@/lib/domain/kpis";
import type { StageDay } from "@/lib/domain/planningDashboard";
import type { ProductivityPoint } from "@/lib/domain/floorKpis";

// The cockpit's charts. One y-axis each (never two scales on one plot); the
// plan and the line against it in neutral ink and the accent; a category keeps
// its slot of the palette wherever it appears; the grid and the axes recede.
// Every chart's numbers go with the card to "Ask AI" on a right-click.

const TICK = { fontSize: 11 };
const AXIS = { stroke: "var(--border-strong)" };
const PLAN = "var(--viz-other)";
const ACCENT = "var(--viz-1)";
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const h1 = (v: number) => `${fmt(v, 1)} h`;

type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] };
const rowOf = <T,>(p: TipProps): T | null => (p.active && p.payload?.length ? (p.payload[0].payload as T) : null);

// ---------------------------------------------------------------- the week's plan

/** The weekly plan delivery day by delivery day: what each day owes, and what
 *  each stage has done of it — side by side, never stacked (a stage's pieces
 *  are not the next stage's, nor finished transformers). Today has its slot. */
export function StageByDayChart({ days }: { days: StageDay[] }) {
  if (days.length === 0) return null;
  const data = days.map((d) => ({ ...d, label: d.isToday ? "Today" : ddmm(d.dayISO) }));
  const owed = days.reduce((s, d) => s + d.owed, 0), finished = days.reduce((s, d) => s + d.finish, 0);
  const series = [
    { key: "owed", label: "Owed", color: PLAN },
    ...STAGES.map((s, i) => ({ key: s, label: STAGE_LABEL[s], color: CAT[i] })),
  ] as const;
  return (
    <div className="space-y-2">
      <Legend items={series.map((x) => ({ label: x.label, color: x.color }))} />
      <div className="viz w-full min-w-0" style={{ height: 300 }} role="group" aria-label={`Weekly plan by delivery day: ${finished} of ${owed} pieces finished; each stage's pieces beside what the day owes`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 16, right: 12, left: 0, bottom: 0 }} barGap={1} barCategoryGap="18%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={(p: TipProps) => {
                const r = rowOf<(typeof data)[number]>(p);
                if (!r) return null;
                return (
                  <TipBox
                    title={`${r.isToday ? "Today · " : "Due "}${formatDate(r.dayISO)}`}
                    rows={series.map((x) => ({ label: x.label, value: `${fmt(r[x.key])} pcs`, color: x.color }))}
                  />
                );
              }}
            />
            <ReferenceLine x="Today" stroke="var(--border-strong)" strokeDasharray="4 3" label={{ value: "today", position: "top", fontSize: 11, fill: "var(--muted)" }} />
            {series.map((x) => <Bar key={x.key} dataKey={x.key} fill={x.color} radius={[2, 2, 0, 0]} isAnimationActive={false} maxBarSize={18} />)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the panels' month

/** The panels' month stage by stage: each stage's panels done of the month's,
 *  the even pace of today marked across them. */
export function LvMonthChart({ stages, panels, expectedShare }: { stages: { stage: string; required: number; done: number }[]; panels: number; expectedShare: number }) {
  if (stages.length === 0 || panels <= 0) return null;
  const pace = Math.round(panels * expectedShare);
  const data = stages.map((s) => ({ ...s, left: Math.max(0, s.required - s.done) }));
  return (
    <div className="space-y-2">
      <Legend items={[{ label: "Done", color: ACCENT }, { label: "Still to do", color: TRACK }, { label: `Even pace today: ${fmt(pace)}`, color: "var(--foreground)", line: true }]} />
      <div className="viz w-full min-w-0" style={{ height: 280 }} role="group" aria-label={`The month's ${panels} panels by stage against an even pace of ${pace} today`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart className="viz-rows" data={data} layout="vertical" margin={{ top: 16, right: 16, left: 4, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid horizontal={false} />
            <XAxis type="number" domain={[0, panels]} tick={TICK} axisLine={AXIS} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="stage" tick={TICK} axisLine={false} tickLine={false} width={72} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={(p: TipProps) => {
                const r = rowOf<(typeof data)[number]>(p);
                if (!r) return null;
                return <TipBox title={r.stage} rows={[{ label: "Done", value: `${fmt(r.done)} of ${fmt(r.required)}`, color: ACCENT }, { label: "Even pace today", value: fmt(pace) }, { label: r.done >= pace ? "Ahead by" : "Behind by", value: fmt(Math.abs(r.done - pace)) }]} />;
              }}
            />
            <Bar dataKey="done" stackId="m" fill={ACCENT} isAnimationActive={false} />
            <Bar dataKey="left" stackId="m" fill={TRACK} isAnimationActive={false} />
            <ReferenceLine x={pace} stroke="var(--foreground)" strokeWidth={2} label={{ value: "even pace", position: "top", fontSize: 11, fill: "var(--muted)" }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- output a day

/** One recorded day's output as the chart draws it: the standard hours
 *  earned by each group (a department, a line) against the man-hours booked. */
export interface OutputPoint {
  dateISO: string;
  earnedH: number;
  workedH: number;
  efficiency: number | null;
  values: Record<string, number>;
}

/** The day axis under the output chart: the date, and under it a second
 *  row for the day's efficiency (EfficiencyLabel). */
const DAY_AXIS_H = 38;
const EFF_ROW = 31;

/** A day's efficiency under its column, in its status's ink — every column
 *  wide enough to hold it, whichever dates the axis keeps. */
function EfficiencyLabel(p: LabelBox) {
  const e = typeof p.value === "number" ? p.value : null;
  const band = efficiencyBand(e);
  const w = Number(p.width ?? 0);
  if (!band || !fitsColumn(w, pct(e!))) return null;
  // written by the column's lowest segment, so its foot is the axis
  const foot = Number(p.y) + Number(p.height ?? 0);
  return <PlotText x={Number(p.x) + w / 2} y={foot + EFF_ROW} textAnchor="middle" fontWeight={700} fill={TONE_COLOR[band]}>{pct(e!)}</PlotText>;
}

/** Each recorded day's output in standard hours, group by group (a
 *  department, or a line on the plant's dashboard), against the man-hours the
 *  shift log booked — one unit, one axis. A group keeps its slot of the palette.
 *  Each segment carries its hours, the column the day's earned total, and the
 *  day's efficiency sits under the column in its status colour. */
export function OutputChart({ days, groups, labels = OUTPUT_GROUP_LABEL, groupWord = "department", height = 260, onDay }: {
  days: readonly OutputPoint[]; groups: readonly string[]; labels?: Record<string, string>; groupWord?: string;
  height?: number;
  /** A click on a day opens its rows (the Production dashboard's drill-down). */
  onDay?: (dateISO: string) => void;
}) {
  if (days.length === 0) return null;
  const color = Object.fromEntries(groups.map((g, i) => [g, CAT[i % CAT.length]])) as Record<string, string>;
  const name = (g: string) => labels[g] ?? g;
  // the groups' hours flattened for the bars, the point itself kept for the tooltip
  const data = days.map((d) => ({ ...d.values, dateISO: d.dateISO, earnedH: d.earnedH, workedH: d.workedH, efficiency: d.efficiency, values: d.values }));
  const h0 = (v: number) => fmt(v, 0);
  return (
    <div className="space-y-2">
      <Legend items={[
        ...groups.map((g) => ({ label: name(g), color: color[g] })),
        { label: "Man-hours booked", color: "var(--foreground)", line: true },
      ]} />
      <div className={`viz w-full min-w-0 ${onDay ? "cursor-pointer" : ""}`} style={{ height }} role="group" aria-label={`Output over ${days.length} recorded days, in standard hours by ${groupWord}, against the man-hours booked, with each day's efficiency under it`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: LABEL_HEADROOM, right: 12, left: 0, bottom: 0 }} barCategoryGap="22%"
            onClick={onDay ? (st) => { const i = Number(st.activeTooltipIndex); if (Number.isInteger(i) && data[i]) onDay(data[i].dateISO); } : undefined}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="dateISO" tickFormatter={ddmm} tick={TICK} height={DAY_AXIS_H} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={4} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => fmt(v, 0)} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={(p: TipProps) => {
                const r = rowOf<(typeof data)[number]>(p);
                if (!r) return null;
                return (
                  <TipBox
                    title={formatDate(r.dateISO)}
                    rows={[
                      ...groups.map((g) => ({ label: name(g), value: h1(r.values[g] ?? 0), color: color[g] })),
                      { label: "Earned, total", value: h1(r.earnedH) },
                      { label: "Man-hours booked", value: h1(r.workedH), color: "var(--foreground)", line: true },
                      { label: "Efficiency", value: r.efficiency === null ? "—" : pct(r.efficiency) },
                    ]}
                  />
                );
              }}
            />
            {groups.map((g, i) => (
              <Bar key={g} dataKey={g} stackId="out" fill={color[g]} stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} radius={i === groups.length - 1 ? [4, 4, 0, 0] : undefined}>
                <LabelList valueAccessor={segmentValue(g, groups, { format: h0 })} content={segmentLabel(catInk(i % CAT.length), color[g])} />
                <LabelList valueAccessor={stackTotalValue(g, groups, h0)} content={TotalLabel} />
                <LabelList valueAccessor={onColumn(g, groups, (r) => (typeof r.efficiency === "number" ? r.efficiency : ""), "foot")} content={EfficiencyLabel} />
              </Bar>
            ))}
            <Line type="monotone" dataKey="workedH" stroke="var(--foreground)" strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)", fill: "var(--foreground)" }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the floor's productivity

/** The floor's efficiency day by day (dots, a day being noisy) and its rolling
 *  figure over the last recorded days (the line to read); 100% is the standard. */
export function ProductivityTrendChart({ points, window }: { points: ProductivityPoint[]; window: number }) {
  if (points.length === 0) return null;
  const data = points.map((p) => ({ ...p, label: ddmm(p.dateISO) }));
  const max = Math.max(1.2, ...points.map((p) => Math.max(p.efficiency ?? 0, p.rolling ?? 0)));
  return (
    <div className="space-y-2">
      <Legend items={[{ label: "Each day", color: PLAN }, { label: `Last ${window} recorded days together`, color: ACCENT, line: true }, { label: "The standard, 100%", color: "var(--border-strong)", line: true }]} />
      <div className="viz w-full min-w-0" style={{ height: 230 }} role="group" aria-label={`Floor efficiency over ${points.length} recorded days, against the standard; the numbers are under Table`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis domain={[0, max]} tick={TICK} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => pct(v)} />
            <ReferenceLine y={1} stroke="var(--border-strong)" strokeDasharray="4 3" />
            <Tooltip
              cursor={{ stroke: "var(--border-strong)" }}
              content={(tp: TipProps) => {
                const r = rowOf<(typeof data)[number]>(tp);
                if (!r) return null;
                return (
                  <TipBox
                    title={formatDate(r.dateISO)}
                    rows={[
                      { label: "That day", value: r.efficiency === null ? "—" : pct(r.efficiency), color: PLAN },
                      { label: `Last ${window} recorded days`, value: r.rolling === null ? "—" : pct(r.rolling), color: ACCENT, line: true },
                      { label: "Earned", value: h1(r.earnedH) },
                      { label: "Man-hours booked", value: h1(r.workedH) },
                      { label: "Std-h a person a day", value: r.stdPerPersonDay === null ? "—" : h1(r.stdPerPersonDay) },
                    ]}
                  />
                );
              }}
            />
            <Line type="monotone" dataKey="efficiency" stroke="none" dot={{ r: 3.5, strokeWidth: 1.5, stroke: "var(--surface)", fill: PLAN }} activeDot={{ r: 5 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="rolling" stroke={ACCENT} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
