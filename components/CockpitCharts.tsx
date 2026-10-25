"use client";

import {
  Area, Bar, CartesianGrid, ComposedChart, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { CAT, Legend, TipBox, fmt, pct } from "@/components/charts/kit";
import { formatDate } from "@/lib/domain/format";
import { OUTPUT_GROUPS, OUTPUT_GROUP_LABEL, efficiencyBand, type OutputDay } from "@/lib/domain/kpis";

// The cockpit's charts. One y-axis each (never two scales on one plot); the
// plan and the line against it in neutral ink and the accent; a category keeps
// its slot of the palette wherever it appears; the grid and the axes recede.
// Every chart has its numbers one click away under the card's Table switch.

const TICK = { fontSize: 11 };
const AXIS = { stroke: "var(--border-strong)" };
const PLAN = "var(--viz-other)";
const ACCENT = "var(--viz-1)";
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const h1 = (v: number) => `${fmt(v, 1)} h`;

type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] };
const rowOf = <T,>(p: TipProps): T | null => (p.active && p.payload?.length ? (p.payload[0].payload as T) : null);

// ---------------------------------------------------------------- the week's plan

export interface BurnPoint { iso: string; label: string; req: number; covered: number; planCum: number; doneCum: number; isToday: boolean }

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
                      { label: "Behind", value: `${Math.max(0, r.planCum - r.doneCum)} pcs` },
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
  const data = points.map((p) => ({ ...p, label: ddmm(p.dayISO) }));
  const measured = points.some((p) => p.canCum !== null);
  // the runs of short days, shaded as one band each
  const bands: { from: string; to: string }[] = [];
  for (const d of data) {
    if (d.tone !== "bad") continue;
    const last = bands.at(-1);
    const prev = data[data.indexOf(d) - 1];
    if (last && prev && last.to === prev.label) last.to = d.label;
    else bands.push({ from: d.label, to: d.label });
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
            <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => fmt(v, 0)} />
            {bands.map((b) => <ReferenceArea key={b.from} x1={b.from} x2={b.to} fill="var(--bad-bg)" fillOpacity={0.7} ifOverflow="extendDomain" />)}
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

const GROUP_COLOR = Object.fromEntries(OUTPUT_GROUPS.map((g, i) => [g, CAT[i]])) as Record<(typeof OUTPUT_GROUPS)[number], string>;

/** Each recorded day's output in standard hours, department by department,
 *  against the man-hours the shift log booked — one unit, one axis. */
export function OutputChart({ days }: { days: OutputDay[] }) {
  if (days.length === 0) return null;
  const data = days.map((d) => ({ ...d, label: ddmm(d.dateISO) }));
  return (
    <div className="space-y-2">
      <Legend items={[
        ...OUTPUT_GROUPS.map((g) => ({ label: OUTPUT_GROUP_LABEL[g], color: GROUP_COLOR[g] })),
        { label: "Man-hours booked", color: "var(--foreground)", line: true },
      ]} />
      <div className="viz w-full min-w-0" style={{ height: 260 }} role="group" aria-label={`Output over ${days.length} recorded days, in standard hours by department, against the man-hours booked; the numbers are under Table`}>
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
                      ...OUTPUT_GROUPS.map((g) => ({ label: OUTPUT_GROUP_LABEL[g], value: h1(r[g]), color: GROUP_COLOR[g] })),
                      { label: "Earned, all", value: h1(r.earnedH) },
                      { label: "Man-hours booked", value: h1(r.workedH), color: "var(--foreground)", line: true },
                      { label: "Efficiency", value: r.efficiency === null ? "—" : pct(r.efficiency) },
                    ]}
                  />
                );
              }}
            />
            {OUTPUT_GROUPS.map((g, i) => (
              <Bar key={g} dataKey={g} stackId="out" fill={GROUP_COLOR[g]} stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} radius={i === OUTPUT_GROUPS.length - 1 ? [4, 4, 0, 0] : undefined} />
            ))}
            <Line type="monotone" dataKey="workedH" stroke="var(--foreground)" strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)", fill: "var(--foreground)" }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- each centre's pace

export interface PacePanel { centre: string; recent: number | null; points: { dateISO: string; efficiency: number | null }[] }

const TONE_TEXT = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg" } as const;
const TONE_WORD = { ok: "at the standard", warn: "short of it", bad: "well short" } as const;

/** One small chart a centre — its efficiency each recorded day against the
 *  standard pace (100%) — so six trends read side by side without six lines
 *  tangled in one plot. */
export function PaceMultiples({ panels }: { panels: PacePanel[] }) {
  // one scale for all six, so a tall line is a fast centre and not a zoom
  const max = Math.max(1.2, ...panels.flatMap((p) => p.points.map((t) => t.efficiency ?? 0)));
  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3">
      {panels.map((p) => {
        const band = efficiencyBand(p.recent);
        const data = p.points.filter((t) => t.efficiency !== null).map((t) => ({ ...t, label: ddmm(t.dateISO) }));
        return (
          <figure key={p.centre} className="rounded-lg border px-3 pt-2 pb-1 min-w-0">
            <figcaption className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold">{p.centre}</span>
              <span className="tabnum">
                <b className={band ? TONE_TEXT[band] : "text-muted"}>{p.recent === null ? "—" : pct(p.recent)}</b>
                {band && <span className="text-muted"> · {TONE_WORD[band]}</span>}
              </span>
            </figcaption>
            {data.length < 2 ? (
              <p className="text-sm text-muted py-6 text-center">Not enough recorded days yet</p>
            ) : (
              <div className="viz w-full min-w-0" style={{ height: 96 }} role="group" aria-label={`${p.centre}: efficiency over ${data.length} recorded days; the numbers are under Table`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
                    <YAxis domain={[0, max]} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={34} ticks={[0, 0.5, 1]} tickFormatter={(v: number) => pct(v)} />
                    <ReferenceLine y={1} stroke="var(--border-strong)" />
                    <Tooltip
                      cursor={{ stroke: "var(--border-strong)" }}
                      content={(tp: TipProps) => {
                        const r = rowOf<(typeof data)[number]>(tp);
                        if (!r) return null;
                        return <TipBox title={`${p.centre} · ${formatDate(r.dateISO)}`} rows={[{ label: "Efficiency", value: r.efficiency === null ? "—" : pct(r.efficiency), color: ACCENT, line: true }]} />;
                      }}
                    />
                    <Line type="monotone" dataKey="efficiency" stroke={ACCENT} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 1.5, stroke: "var(--surface)", fill: ACCENT }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </figure>
        );
      })}
    </div>
  );
}
