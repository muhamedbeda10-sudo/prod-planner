"use client";

import {
  Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { CAT, Legend, TipBox, fmt, pct } from "@/components/charts/kit";
import { formatDate } from "@/lib/domain/format";
import { OUTPUT_GROUPS, OUTPUT_GROUP_LABEL, type OutputDay, type OutputGroup } from "@/lib/domain/kpis";
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

export interface BurnPoint { iso: string; label: string; req: number; covered: number; planCum: number; doneCum: number; isToday: boolean; isPast: boolean }

/** The weekly plan delivery day by delivery day: what it asks, summed, against what is finished, summed. */
export function BurnUpChart({ points }: { points: BurnPoint[] }) {
  if (points.length === 0) return null;
  const today = points.find((p) => p.isToday);
  return (
    <div className="space-y-2">
      <Legend items={[{ label: "Asked for (summed)", color: PLAN, line: true }, { label: "Finished (summed)", color: ACCENT, line: true }]} />
      <div className="viz w-full min-w-0" style={{ height: 230 }} role="group" aria-label={`Weekly plan: ${points.at(-1)!.doneCum} of ${points.at(-1)!.planCum} pieces finished; the numbers are under Table`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
            <Tooltip
              cursor={{ stroke: "var(--border-strong)" }}
              content={(p: TipProps) => {
                const r = rowOf<BurnPoint>(p);
                if (!r) return null;
                return (
                  <TipBox
                    title={`${r.label} · ${formatDate(r.iso)}`}
                    rows={[
                      { label: "Asked that day", value: `${r.req} pcs` },
                      { label: "Finished of them", value: `${r.covered} pcs` },
                      { label: "Asked, summed", value: `${r.planCum} pcs`, color: PLAN, line: true },
                      { label: "Finished, summed", value: `${r.doneCum} pcs`, color: ACCENT, line: true },
                      // a day still to come is not late — what it lacks is still to make
                      { label: r.isPast || r.isToday ? "Behind" : "Still to make", value: `${Math.max(0, r.planCum - r.doneCum)} pcs` },
                    ]}
                  />
                );
              }}
            />
            {today && <ReferenceLine x={today.label} stroke="var(--border-strong)" label={{ value: "today", position: "insideTopRight", fontSize: 11, fill: "var(--muted)" }} />}
            <Area type="monotone" dataKey="doneCum" stroke={ACCENT} strokeWidth={2} fill={ACCENT} fillOpacity={0.12} isAnimationActive={false} dot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)", fill: ACCENT }} />
            <Line type="monotone" dataKey="planCum" stroke={PLAN} strokeWidth={2} isAnimationActive={false} dot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)", fill: PLAN }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the load ahead

export interface LoadPoint { dayISO: string; dueH: number; owedCum: number; canCum: number | null; tone: "bad" | "warn" | null }

/** One centre's next working days as running totals: what it owes so far
 *  against what it can work so far. The days it is short are shaded. */
export function LoadChart({ points, centre }: { points: LoadPoint[]; centre: string }) {
  if (points.length === 0) return null;
  // the days by their place in the horizon, so a day is a slot a band can cover
  const data = points.map((p, i) => ({ ...p, i, label: ddmm(p.dayISO) }));
  const measured = points.some((p) => p.canCum !== null);
  // the runs of short days, each shaded across its days' whole slots
  const bands: { from: number; to: number }[] = [];
  for (const d of data) {
    if (d.tone !== "bad") continue;
    const last = bands.at(-1);
    if (last && last.to === d.i - 1) last.to = d.i;
    else bands.push({ from: d.i, to: d.i });
  }
  return (
    <div className="space-y-2">
      <Legend items={[
        { label: `${centre} owes, summed`, color: ACCENT, line: true },
        ...(measured ? [{ label: "It can work, summed", color: PLAN, line: true }] : []),
        ...(bands.length ? [{ label: "Short", color: "var(--bad-bg)" }] : []),
      ]} />
      <div className="viz w-full min-w-0" style={{ height: 240 }} role="group" aria-label={`${centre}: owes ${fmt(points.at(-1)!.owedCum, 1)} h over the horizon${points.at(-1)!.canCum === null ? "" : ` against ${fmt(points.at(-1)!.canCum!, 1)} h it can work`}; the numbers are under Table`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis type="number" dataKey="i" domain={[-0.5, data.length - 0.5]} ticks={data.map((d) => d.i)} tickFormatter={(i: number) => data[i]?.label ?? ""}
              tick={TICK} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => fmt(v, 0)} />
            {bands.map((b) => <ReferenceArea key={b.from} x1={b.from - 0.5} x2={b.to + 0.5} fill="var(--bad-bg)" fillOpacity={0.7} />)}
            <Tooltip
              cursor={{ stroke: "var(--border-strong)" }}
              content={(p: TipProps) => {
                const r = rowOf<(typeof data)[number]>(p);
                if (!r) return null;
                return (
                  <TipBox
                    title={`${centre} · ${formatDate(r.dayISO)}`}
                    rows={[
                      { label: "Due that day", value: h1(r.dueH) },
                      { label: "Owes, summed", value: h1(r.owedCum), color: ACCENT, line: true },
                      ...(r.canCum !== null ? [
                        { label: "Can work, summed", value: h1(r.canCum), color: PLAN, line: true },
                        { label: r.owedCum > r.canCum ? "Short by" : "Room left", value: h1(Math.abs(r.owedCum - r.canCum)) },
                      ] : [{ label: "Can work", value: "not measured" }]),
                    ]}
                  />
                );
              }}
            />
            {/* a line, not a filled area: a fill over the short band would muddy both */}
            <Line type="stepAfter" dataKey="owedCum" stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
            {measured && <Line type="linear" dataKey="canCum" stroke={PLAN} strokeWidth={2} dot={false} isAnimationActive={false} />}
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

/** The transformers' days as the chart's points. */
export const outputPoints = (days: readonly OutputDay[], groups: readonly OutputGroup[] = OUTPUT_GROUPS): OutputPoint[] =>
  days.map((d) => ({ dateISO: d.dateISO, earnedH: d.earnedH, workedH: d.workedH, efficiency: d.efficiency, values: Object.fromEntries(groups.map((g) => [g, d[g]])) }));

/** Each recorded day's output in standard hours, group by group (a
 *  department, or a line on the plant's dashboard), against the man-hours the
 *  shift log booked — one unit, one axis. A group keeps its slot of the palette. */
export function OutputChart({ days, groups, labels = OUTPUT_GROUP_LABEL, groupWord = "department" }: { days: readonly OutputPoint[]; groups: readonly string[]; labels?: Record<string, string>; groupWord?: string }) {
  if (days.length === 0) return null;
  const color = Object.fromEntries(groups.map((g, i) => [g, CAT[i % CAT.length]])) as Record<string, string>;
  const name = (g: string) => labels[g] ?? g;
  // the groups' hours flattened for the bars, the point itself kept for the tooltip
  const data = days.map((d) => ({ ...d.values, dateISO: d.dateISO, earnedH: d.earnedH, workedH: d.workedH, efficiency: d.efficiency, values: d.values, label: ddmm(d.dateISO) }));
  return (
    <div className="space-y-2">
      <Legend items={[
        ...groups.map((g) => ({ label: name(g), color: color[g] })),
        { label: "Man-hours booked", color: "var(--foreground)", line: true },
      ]} />
      <div className="viz w-full min-w-0" style={{ height: 260 }} role="group" aria-label={`Output over ${days.length} recorded days, in standard hours by ${groupWord}, against the man-hours booked; the numbers are under Table`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
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
              <Bar key={g} dataKey={g} stackId="out" fill={color[g]} stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} radius={i === groups.length - 1 ? [4, 4, 0, 0] : undefined} />
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
