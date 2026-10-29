"use client";

import { useSyncExternalStore } from "react";
import { factoryWallClockMs } from "@/lib/domain/dates";
import { formatDate } from "@/lib/domain/format";
import {
  Bar, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceLine, Sankey, Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis, ZAxis,
} from "recharts";
import { ResponsiveContainer } from "@/components/charts/zoom";
import { HeatScale, Heatmap, INK_ON_OTHER, OTHER, TRACK, catColor, catInk, compact, fmt, heat, pct } from "@/components/charts/kit";
import { Meter } from "@/components/Meter";
import {
  ChartFrame, PlotText, TICK, Tip, ToneIcon, fits, pointLabel, sideLabel, tipLabel, unitOf, useWidth, valueText, type TipProps,
} from "@/components/AiChartFrame";
import {
  OTHER_NAME, pointsToLabel, type AiBoxplotSpec, type AiCalendarSpec, type AiControlSpec, type AiGaugeSpec, type AiSankeySpec, type AiDumbbellSpec, type AiFunnelSpec, type AiGanttSpec, type AiHeatmapSpec, type AiProgressSpec, type AiScatterSpec, type AiTreemapSpec, type AiWaterfallSpec,
} from "@/lib/domain/aiChart";

// The forms of an AI chart beyond bars, lines and pies (components/AiChart.tsx):
// two measures per item, a grid, progress against target, a pipeline, what
// moved a total, a schedule, before → after, many parts of a whole, a dial,
// spread group by group, a flow, a month of days and a process in control. Each
// keeps the same rules — the palette's slots in order and gray for "Other",
// one value scale, a tooltip on every mark, and the numbers kept with the card.
// A plot on an axis runs left to right whatever the answer's language, as the
// axes do; bars with no axis (progress, a funnel) start where the text does.

/** A group's colour: its slot in order, "Other" in the neutral. */
const groupColor = (groups: readonly string[], g: string) => {
  if (g === OTHER_NAME) return OTHER;
  const i = groups.indexOf(g);
  return catColor(i < 0 ? 0 : i);
};

/** Round ticks across a range: 0, 5, 10 … */
function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  // || 0: a tick at nothing reads 0, never -0
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6 || 0);
  return out;
}

// ----------------------------------------------------------------- scatter

export function ScatterFigure({ spec }: { spec: AiScatterSpec }) {
  const named = spec.groups.filter(Boolean);
  return (
    <ChartFrame
      title={spec.title}
      sub={[spec.xLabel && `across: ${spec.xLabel}`, spec.yLabel && `up: ${spec.yLabel}`, spec.sized && "size: the third measure"].filter(Boolean).join(" · ") || undefined}
      rows={spec.points.map((p) => ({ Name: p.name, ...(named.length ? { Group: p.group } : {}), [spec.xLabel || "x"]: p.x, [spec.yLabel || "y"]: p.y, ...(spec.sized ? { Size: p.size ?? 0 } : {}) }))}
      legend={named.map((g) => ({ label: g, color: groupColor(named, g) }))}
    >
      <div style={{ height: 300 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 16, left: -2, bottom: spec.xLabel ? 14 : 0 }}>
            <CartesianGrid stroke="var(--border)" />
            <XAxis type="number" dataKey="x" name={spec.xLabel || "x"} tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} tickFormatter={(v: number) => compact(v)}
              label={spec.xLabel ? { value: spec.xLabel, position: "insideBottom", offset: -10, fill: "var(--muted)", fontSize: 11 } : undefined} />
            <YAxis type="number" dataKey="y" name={spec.yLabel || "y"} tick={TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => compact(v)}
              label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: "insideLeft", offset: 18, fill: "var(--muted)", fontSize: 11 } : undefined} />
            {spec.sized && <ZAxis type="number" dataKey="size" range={[40, 420]} />}
            <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={({ active, payload }: TipProps) => {
              const p = active ? (payload?.[0]?.payload as AiScatterSpec["points"][number] | undefined) : undefined;
              if (!p) return null;
              return (
                <Tip
                  title={p.name || p.group || "Point"}
                  rows={[
                    { label: spec.xLabel || "x", value: fmt(p.x) },
                    { label: spec.yLabel || "y", value: fmt(p.y) },
                    ...(spec.sized ? [{ label: "Size", value: fmt(p.size ?? 0) }] : []),
                    ...(p.group ? [{ label: "Group", value: p.group }] : []),
                  ]}
                />
              );
            }} />
            {spec.groups.map((g) => {
              const pts = spec.points.filter((p) => p.group === g);
              return (
                <Scatter key={g || "all"} name={g || spec.title} data={pts} fill={g ? groupColor(named, g) : catColor(0)}
                  stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
                  {/* a name beside each dot while there are few enough to read */}
                  {spec.points.length <= 30 && <LabelList dataKey="name" content={sideLabel((k) => pts[k]?.name || null)} />}
                </Scatter>
              );
            })}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

// ----------------------------------------------------------------- heatmap

export function HeatmapFigure({ spec }: { spec: AiHeatmapSpec }) {
  const max = Math.max(0, ...spec.values.flat());
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit} · darker is more` : "Darker is more"}
      rows={spec.rows.map((r, i) => ({ " ": r, ...Object.fromEntries(spec.cols.map((c, j) => [c, spec.values[i][j]])) }))}
    >
      <div dir="ltr">
        <Heatmap rows={spec.rows} cols={spec.cols} values={spec.values} totals={spec.totals} format={(v) => compact(v)}
          cellTitle={(i, j, v) => `${spec.rows[i]} · ${spec.cols[j]}: ${valueText(v, spec.unit)}`} />
        <div className="mt-2">
          <HeatScale max={max} format={(v) => compact(v)} />
        </div>
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------- progress

/** Done against target: the fill in the accent on a lighter track of its
 *  own hue, the target a tick across it — the track runs past the target
 *  when the work did. */
export function ProgressFigure({ spec }: { spec: AiProgressSpec }) {
  const anyTarget = spec.items.some((it) => it.target !== null);
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.items.map((it) => ({ Item: it.label, Done: it.value, ...(anyTarget ? { Target: it.target ?? "" } : {}), Reached: pct(it.target !== null ? it.value / it.target : it.value / 100) }))}
    >
      <ul className="space-y-3">
        {spec.items.map((it, k) => {
          const ratio = it.target !== null ? it.value / it.target : it.value / 100;
          const scale = Math.max(1, ratio);
          return (
            <li key={k}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold flex items-center gap-1 min-w-0" dir="auto">
                  <ToneIcon tone={it.tone} />
                  <span className="truncate">{it.label}</span>
                </span>
                <span className="text-xs whitespace-nowrap ltr">
                  <b className="text-sm">{pct(ratio)}</b>
                  <span className="text-muted"> · {fmt(it.value)}{it.target !== null ? ` / ${fmt(it.target)}` : ""}{unitOf(spec.unit)}</span>
                </span>
              </div>
              <Meter value={ratio / scale} mark={ratio > 1 ? 1 / scale : null} size="lg" label={it.label} valueText={pct(ratio)} className="mt-1" />
              {it.note && <div className="text-xs text-muted mt-0.5" dir="auto">{it.note}</div>}
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}

// ------------------------------------------------------------------ funnel

/** A pipeline of stages, in order: one hue, darker first, each bar against
 *  the first stage, and what carried on from the stage before. */
export function FunnelFigure({ spec }: { spec: AiFunnelSpec }) {
  const first = spec.data[0].value || 1;
  const steps = spec.data.length - 1;
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.data.map((d, k) => ({ Stage: d.name, [spec.unit || "Value"]: d.value, "Of the first": pct(d.value / first), "From the stage before": k === 0 ? "—" : pct(spec.data[k - 1].value ? d.value / spec.data[k - 1].value : 0) }))}
    >
      <ol className="space-y-1.5">
        {spec.data.map((d, k) => (
          <li key={k}>
            {k > 0 && (
              <div className="text-[11px] text-muted ps-1 -mt-0.5 mb-0.5 ltr">↓ {pct(spec.data[k - 1].value ? d.value / spec.data[k - 1].value : 0)} carried on</div>
            )}
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold truncate" dir="auto">{d.name}</span>
              <span className="text-xs whitespace-nowrap ltr"><b className="text-sm">{fmt(d.value)}</b>{unitOf(spec.unit)} <span className="text-muted">· {pct(d.value / first)}</span></span>
            </div>
            <div className="h-3 mt-1 rounded">
              <div className="h-full rounded" title={`${d.name}: ${valueText(d.value, spec.unit)}`}
                style={{ width: `${Math.max(1, Math.min(1, d.value / first) * 100)}%`, background: `color-mix(in srgb, var(--ramp-5) ${steps ? Math.round(100 - (k / steps) * 100) : 100}%, var(--ramp-2))` }} />
            </div>
          </li>
        ))}
      </ol>
    </ChartFrame>
  );
}

// --------------------------------------------------------------- waterfall

const RISE = catColor(1);
const FALL = catColor(2);
const TOTAL = catColor(0);

/** What moved a total: each step floats from the running total before it to
 *  the one after — rises and falls in two opposite hues, totals standing on zero. */
export function WaterfallFigure({ spec }: { spec: AiWaterfallSpec }) {
  const rows = spec.data.map((d) => ({ ...d, range: [Math.min(d.start, d.end), Math.max(d.start, d.end)] as [number, number] }));
  const colorOf = (d: AiWaterfallSpec["data"][number]) => (d.total ? TOTAL : d.value >= 0 ? RISE : FALL);
  // a step says how much it moved, a total what it came to
  const stepText = (d: AiWaterfallSpec["data"][number] | undefined) => (!d ? null : d.total ? compact(d.end) : `${d.value >= 0 ? "+" : "−"}${compact(Math.abs(d.value))}`);
  const [box, width] = useWidth<HTMLDivElement>();
  const room = fits(width, spec.data.map((d) => stepText(d) ?? ""));
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.data.map((d) => ({ Step: d.name, Change: d.total ? "" : d.value, Total: d.end }))}
      legend={[{ label: "Total", color: TOTAL }, { label: "Up", color: RISE }, { label: "Down", color: FALL }]}
    >
      <div ref={box} style={{ height: 280 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 22, right: 12, left: -6, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => compact(v)} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }: TipProps) => {
              const d = active ? (payload?.[0]?.payload as AiWaterfallSpec["data"][number] | undefined) : undefined;
              if (!d) return null;
              return (
                <Tip
                  title={d.name}
                  rows={d.total ? [{ label: "Total", value: valueText(d.end, spec.unit) }] : [{ label: d.value >= 0 ? "Up" : "Down", value: valueText(d.value, spec.unit) }, { label: "Running total", value: valueText(d.end, spec.unit) }]}
                />
              );
            }} />
            <Bar dataKey="range" maxBarSize={28} radius={2} isAnimationActive={false}>
              {spec.data.map((d, k) => <Cell key={k} fill={colorOf(d)} />)}
              {room && <LabelList dataKey="end" content={tipLabel(false, (_, k) => stepText(spec.data[k]))} />}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

// ------------------------------------------------------------------- gantt

const DAY = 86_400_000;
const HOUR = 3_600_000;
const noSubscribe = () => () => {};
/** Now on the wall clock the times are written in (the factory's), to the
 *  minute — stable between renders, and none on the server. */
const wallNow = () => factoryWallClockMs(new Date());

const dayLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const hourLabel = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

/** The time axis: hours across a short timed span, days otherwise — about eight ticks. */
function timeTicks(from: number, to: number, withTime: boolean): { at: number; label: string }[] {
  const span = to - from;
  if (withTime && span <= 3 * DAY) {
    const step = [1, 2, 3, 4, 6, 12].map((h) => h * HOUR).find((s) => span / s <= 9) ?? 12 * HOUR;
    const out: { at: number; label: string }[] = [];
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push({ at: t, label: t % DAY === 0 ? dayLabel.format(t) : hourLabel.format(t) });
    return out;
  }
  const step = [1, 2, 7, 14, 30].map((d) => d * DAY).find((s) => span / s <= 10) ?? 30 * DAY;
  const out: { at: number; label: string }[] = [];
  for (let t = Math.ceil(from / DAY) * DAY; t <= to; t += step) out.push({ at: t, label: dayLabel.format(t) });
  return out;
}

/** A schedule: a row per machine, line or order, a bar per job from its start
 *  to its end, in its group's colour, and today marked. */
export function GanttFigure({ spec }: { spec: AiGanttSpec }) {
  const [track, width] = useWidth<HTMLDivElement>();
  const now = useSyncExternalStore(noSubscribe, wallNow, () => null);
  const span = Math.max(1, spec.to - spec.from);
  const at = (ms: number) => ((ms - spec.from) / span) * 100;
  const ticks = timeTicks(spec.from, spec.to, spec.withTime);
  const named = spec.groups.filter(Boolean);
  const showNow = now !== null && now >= spec.from && now <= spec.to;
  const ROW = 30;
  return (
    <ChartFrame
      title={spec.title}
      sub={`${dayLabel.format(spec.from)} → ${dayLabel.format(spec.to - 1)}`}
      rows={spec.tasks.map((t) => ({ Row: t.row, Job: t.label, ...(named.length ? { Group: t.group } : {}), Start: t.startText, End: t.endText }))}
      legend={named.map((g) => ({ label: g, color: groupColor(named, g) }))}
    >
      <div className="flex text-xs" dir="ltr">
        <div className="w-32 shrink-0 pt-6">
          {spec.rows.map((r) => (
            <div key={r} className="truncate font-semibold pe-2 flex items-center" style={{ height: ROW }} dir="auto" title={r}>{r}</div>
          ))}
        </div>
        <div ref={track} className="relative flex-1 min-w-0">
          {/* the time axis, and its hairlines through the rows */}
          <div className="relative h-6">
            {ticks.map((t) => (
              <span key={t.at} className={`absolute top-1 text-[11px] text-muted whitespace-nowrap ${at(t.at) > 94 ? "-translate-x-full" : at(t.at) < 6 ? "" : "-translate-x-1/2"}`} style={{ left: `${at(t.at)}%` }}>{t.label}</span>
            ))}
          </div>
          <div className="relative" style={{ height: spec.rows.length * ROW }}>
            {ticks.map((t) => <div key={t.at} className="absolute top-0 bottom-0 border-l border-[var(--border)]" style={{ left: `${at(t.at)}%` }} />)}
            {spec.rows.map((r, i) => <div key={r} className="absolute inset-x-0 border-b border-[var(--border)]" style={{ top: (i + 1) * ROW - 1 }} />)}
            {showNow && (
              <div className="absolute top-0 bottom-0 border-l-2 border-[var(--foreground)] z-10" style={{ left: `${at(now)}%` }} title="Now">
                <span className="absolute -top-5 -translate-x-1/2 text-[10px] font-bold">now</span>
              </div>
            )}
            {spec.tasks.map((t, k) => {
              const left = at(t.start);
              const w = Math.max(0.4, at(t.end) - left);
              const px = (w / 100) * width;
              const color = t.group ? groupColor(named, t.group) : catColor(0);
              const ink = t.group === OTHER_NAME ? INK_ON_OTHER : catInk(t.group ? Math.max(0, named.indexOf(t.group)) : 0);
              const text = t.label || t.row;
              // a label goes inside its bar only where it fits whole
              const fits = px >= text.length * 6.4 + 12;
              return (
                <div
                  key={k}
                  tabIndex={0}
                  className="absolute rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--foreground)] hover:brightness-110 overflow-visible"
                  // a 2px gap in the surface keeps bars that touch apart
                  style={{ top: spec.rows.indexOf(t.row) * ROW + 6, height: ROW - 12, left: `calc(${left}% + 1px)`, width: `max(3px, calc(${w}% - 2px))`, background: color }}
                  title={`${text}${t.group ? ` · ${t.group}` : ""}: ${t.startText} → ${t.endText}`}
                  aria-label={`${t.row}: ${text}, ${t.startText} to ${t.endText}`}
                >
                  {fits && <span className="absolute inset-0 px-1.5 text-[11px] font-semibold leading-[18px] whitespace-nowrap" style={{ color: ink }} dir="auto">{text}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------- dumbbell

/** Before → after per item: the two on one scale, joined by a hairline. */
export function DumbbellFigure({ spec }: { spec: AiDumbbellSpec }) {
  const all = spec.data.flatMap((d) => [d.a, d.b]);
  const lo0 = Math.min(...all);
  const hi0 = Math.max(...all);
  // room either side for the values beside the outer dots
  const pad = (hi0 - lo0) * 0.14 || 1;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const at = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const ticks = niceTicks(lo, hi);
  const [a, b] = spec.series;
  const A = catColor(0);
  const B = catColor(1);
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.data.map((d) => ({ " ": d.name, [a]: d.a, [b]: d.b, Change: Math.round((d.b - d.a) * 1000) / 1000 }))}
      legend={[{ label: a, color: A }, { label: b, color: B }]}
    >
      <div className="flex text-xs" dir="ltr">
        <div className="w-32 shrink-0">
          {spec.data.map((d) => <div key={d.name} className="h-7 flex items-center truncate font-semibold pe-2" dir="auto" title={d.name}>{d.name}</div>)}
          <div className="h-5" />
        </div>
        <div className="relative flex-1 min-w-0">
          {ticks.map((t) => <div key={t} className="absolute top-0 border-l border-[var(--border)]" style={{ left: `${at(t)}%`, bottom: 20 }} />)}
          {spec.data.map((d) => (
            <div key={d.name} className="relative h-7" title={`${d.name}: ${a} ${valueText(d.a, spec.unit)} → ${b} ${valueText(d.b, spec.unit)}`}>
              <div className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-[var(--viz-other)]" style={{ left: `${at(Math.min(d.a, d.b))}%`, width: `${Math.abs(at(d.b) - at(d.a))}%` }} />
              <span className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--surface)]" style={{ left: `${at(d.a)}%`, background: A }} aria-label={`${a} ${fmt(d.a)}`} />
              <span className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--surface)]" style={{ left: `${at(d.b)}%`, background: B }} aria-label={`${b} ${fmt(d.b)}`} />
              {/* each value outside its own dot: the smaller to the left, the larger to the right */}
              {[Math.min(d.a, d.b), Math.max(d.a, d.b)].filter((v, k, two) => k === 0 || v !== two[0]).map((v, k) => (
                <span key={k} className={`absolute top-1/2 -translate-y-1/2 text-[11px] font-semibold tabnum whitespace-nowrap ${k === 0 ? "-translate-x-full pe-2.5" : "ps-2.5"}`} style={{ left: `${at(v)}%` }} aria-hidden>{compact(v)}</span>
              ))}
            </div>
          ))}
          <div className="relative h-5">
            {ticks.map((t) => <span key={t} className="absolute top-1 -translate-x-1/2 text-[11px] text-muted tabnum" style={{ left: `${at(t)}%` }}>{compact(t)}</span>)}
          </div>
        </div>
      </div>
    </ChartFrame>
  );
}

// ----------------------------------------------------------------- treemap

type TreeNode = { x?: number; y?: number; width?: number; height?: number; name?: string; size?: number; group?: string; depth?: number };

const treeColor = (named: readonly string[], g: string) => (g ? groupColor(named, g) : catColor(0));
const treeInk = (named: readonly string[], g: string) => (g === OTHER_NAME ? INK_ON_OTHER : catInk(g ? Math.max(0, named.indexOf(g)) : 0));

/** One block of a treemap — recharts hands it the node; `named` are the groups in slot order. */
function TreeBlock(n: TreeNode & { named?: readonly string[] }) {
  const { x = 0, y = 0, width = 0, height = 0, name = "", group = "", depth = 1, named = [] } = n;
  if (depth === 0) return <g />;
  const chars = Math.floor((width - 12) / 6.4);
  // a name too long for its block is shortened with an ellipsis, whole in the tooltip and the table
  const label = name.length > chars ? `${name.slice(0, Math.max(0, chars - 1))}…` : name;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={treeColor(named, group)} stroke="var(--surface)" strokeWidth={2} />
      {width > 48 && height > 26 && chars >= 3 && (
        <text x={x + 6} y={y + 16} fill={treeInk(named, group)} fontSize={11} fontWeight={600}>{label}</text>
      )}
      {width > 48 && height > 42 && (
        <text x={x + 6} y={y + 31} fill={treeInk(named, group)} fontSize={11} opacity={0.85}>{compact(n.size ?? 0)}</text>
      )}
    </g>
  );
}

/** Many parts of a whole: each a block sized by its share, coloured by its
 *  group, named inside where the name fits. */
export function TreemapFigure({ spec }: { spec: AiTreemapSpec }) {
  const named = spec.groups.filter(Boolean);
  const total = spec.data.reduce((t, d) => t + d.value, 0);
  return (
    <ChartFrame
      title={spec.title}
      sub={`${compact(total)}${unitOf(spec.unit)} in all`}
      rows={spec.data.map((d) => ({ Name: d.name, ...(named.length ? { Group: d.group } : {}), [spec.unit || "Value"]: d.value, Share: pct(total ? d.value / total : 0, 1) }))}
      legend={named.map((g) => ({ label: g, color: treeColor(named, g) }))}
    >
      <div style={{ height: 300 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <Treemap data={spec.data.map((d) => ({ name: d.name, size: d.value, group: d.group }))} dataKey="size" aspectRatio={4 / 3} isAnimationActive={false} content={<TreeBlock named={named} />}>
            <Tooltip content={({ active, payload }: TipProps) => {
              const d = active ? (payload?.[0]?.payload as TreeNode | undefined) : undefined;
              if (!d?.name) return null;
              return <Tip title={d.name} rows={[{ label: spec.unit || "Value", value: fmt(d.size ?? 0) }, { label: "Share", value: pct(total ? (d.size ?? 0) / total : 0, 1) }, ...(d.group ? [{ label: "Group", value: d.group }] : [])]} />;
            }} />
          </Treemap>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

// ------------------------------------------------------------------- gauge

/** A point on the dial's arc: 0 at the left end, 1 at the right. */
const onArc = (f: number, r: number) => {
  const a = Math.PI * (1 - Math.max(0, Math.min(1, f)));
  return { x: 100 + r * Math.cos(a), y: 100 - r * Math.sin(a) };
};
const arcPath = (from: number, to: number, r: number) => {
  const a = onArc(from, r);
  const b = onArc(to, r);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
};

/** One reading on a half dial: the fill in the accent on a lighter track of
 *  its own hue, the target a tick across it, the reading in the middle. */
export function GaugeFigure({ spec }: { spec: AiGaugeSpec }) {
  const anyTarget = spec.items.some((it) => it.target !== null);
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.items.map((it) => ({ Item: it.label || spec.title || "Value", Value: it.value, ...(anyTarget ? { Target: it.target ?? "" } : {}), Min: it.min, Max: it.max }))}
    >
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))]">
        {spec.items.map((it, k) => {
          const f = (it.value - it.min) / (it.max - it.min);
          const t = it.target === null ? null : (it.target - it.min) / (it.max - it.min);
          const tick = t === null ? null : [onArc(t, 66), onArc(t, 94)];
          const reached = it.target !== null ? it.value / it.target : null;
          return (
            <figure key={k} className="flex flex-col items-center min-w-0" role="meter" aria-valuemin={it.min} aria-valuemax={it.max} aria-valuenow={it.value}
              aria-label={`${it.label || spec.title}: ${valueText(it.value, spec.unit)}${it.target !== null ? ` of ${fmt(it.target)}` : ""}`}>
              <svg viewBox="0 0 200 116" className="w-full max-w-[15rem]" aria-hidden>
                <path d={arcPath(0, 1, 80)} fill="none" stroke={TRACK} strokeWidth={18} strokeLinecap="round" />
                {f > 0 && <path d={arcPath(0, f, 80)} fill="none" stroke="var(--viz-1)" strokeWidth={18} strokeLinecap="round" />}
                {tick && <line x1={tick[0].x} y1={tick[0].y} x2={tick[1].x} y2={tick[1].y} stroke="var(--foreground)" strokeWidth={2.5} strokeLinecap="round" />}
                <text x={100} y={92} textAnchor="middle" fontSize={26} fontWeight={700} fill="var(--foreground)">{compact(it.value)}</text>
                <text x={100} y={110} textAnchor="middle" fontSize={11} fill="var(--muted)">{reached !== null ? `${pct(reached)} of ${compact(it.target!)}` : spec.unit || ""}</text>
                <text x={20} y={114} textAnchor="middle" fontSize={11} fill="var(--muted)">{compact(it.min)}</text>
                <text x={180} y={114} textAnchor="middle" fontSize={11} fill="var(--muted)">{compact(it.max)}</text>
              </svg>
              {(it.label || it.note) && (
                <figcaption className="text-center mt-1 min-w-0">
                  {it.label && <div className="text-sm font-semibold flex items-center justify-center gap-1" dir="auto"><ToneIcon tone={it.tone} /><span className="truncate">{it.label}</span></div>}
                  {it.note && <div className="text-xs text-muted" dir="auto">{it.note}</div>}
                </figcaption>
              )}
            </figure>
          );
        })}
      </div>
    </ChartFrame>
  );
}

// ----------------------------------------------------------------- boxplot

/** How values spread, group beside group on one scale: the box holds the
 *  middle half, the line in it the median, the whiskers the rest within
 *  reach, and the strays as dots past them. */
export function BoxplotFigure({ spec }: { spec: AiBoxplotSpec }) {
  const lo0 = Math.min(...spec.data.map((d) => Math.min(d.lo, ...d.outliers)));
  const hi0 = Math.max(...spec.data.map((d) => Math.max(d.hi, ...d.outliers)));
  const pad = (hi0 - lo0) * 0.04 || 1;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const at = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const ticks = niceTicks(lo, hi);
  return (
    <ChartFrame
      title={spec.title}
      sub={`${spec.unit ? `In ${spec.unit} · ` : ""}the box holds the middle half, the line in it the median`}
      rows={spec.data.map((d) => ({ " ": d.name, Count: d.n, Min: d.min, Q1: d.q1, Median: d.median, Q3: d.q3, Max: d.max, Mean: d.mean, Outliers: d.outliers.length }))}
    >
      <div className="flex text-xs" dir="ltr">
        <div className="w-24 sm:w-32 shrink-0">
          {spec.data.map((d) => <div key={d.name} className="h-9 flex items-center truncate font-semibold pe-2" dir="auto" title={d.name}>{d.name}</div>)}
          <div className="h-5" />
        </div>
        <div className="relative flex-1 min-w-0">
          {ticks.map((t) => <div key={t} className="absolute top-0 border-l border-[var(--border)]" style={{ left: `${at(t)}%`, bottom: 20 }} />)}
          {spec.data.map((d) => (
            <div key={d.name} className="relative h-9" tabIndex={0}
              title={`${d.name}: median ${valueText(d.median, spec.unit)} · middle half ${fmt(d.q1)}–${fmt(d.q3)} · range ${fmt(d.min)}–${fmt(d.max)} · ${d.n} values`}>
              <div className="absolute top-1/2 h-px bg-[var(--viz-other)]" style={{ left: `${at(d.lo)}%`, width: `${at(d.hi) - at(d.lo)}%` }} />
              {[d.lo, d.hi].map((v, k) => <div key={k} className="absolute top-1/2 h-3 -translate-y-1/2 border-l border-[var(--viz-other)]" style={{ left: `${at(v)}%` }} />)}
              <div className="absolute top-1/2 h-4 -translate-y-1/2 rounded-[3px] border border-[var(--viz-1)]"
                style={{ left: `${at(d.q1)}%`, width: `max(2px, ${at(d.q3) - at(d.q1)}%)`, background: TRACK }} />
              <div className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-[var(--foreground)]" style={{ left: `${at(d.median)}%` }} />
              {d.outliers.map((v, k) => <span key={k} className="absolute top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--viz-other)]" style={{ left: `${at(v)}%` }} />)}
              {/* the median over its line */}
              <span className="absolute top-0 -translate-x-1/2 text-[11px] font-semibold tabnum leading-none" style={{ left: `${at(d.median)}%` }}>{compact(d.median)}</span>
            </div>
          ))}
          <div className="relative h-5">
            {ticks.map((t) => <span key={t} className="absolute top-1 -translate-x-1/2 text-[11px] text-muted tabnum" style={{ left: `${at(t)}%` }}>{compact(t)}</span>)}
          </div>
        </div>
      </div>
    </ChartFrame>
  );
}

// ------------------------------------------------------------------ sankey

type FlowNode = { x: number; y: number; width: number; height: number; index: number; payload: { name?: string; value?: number } };

/** A stage of a flow: its block, and its name and size beside it — to the
 *  right on the left half of the chart, to the left on the right half. */
function FlowBlock({ x, y, width, height, payload, chartWidth }: FlowNode & { chartWidth: number }) {
  const right = x + width / 2 > chartWidth / 2;
  return (
    <g>
      <rect x={x} y={y} width={width} height={Math.max(1, height)} rx={2} fill="var(--viz-1)" />
      <PlotText x={right ? x - 6 : x + width + 6} y={y + height / 2} dy="0.35em" textAnchor={right ? "end" : "start"} fontWeight={600}>
        {`${payload.name ?? ""} · ${compact(payload.value ?? 0)}`}
      </PlotText>
    </g>
  );
}

/** Where a quantity went, stage to stage: a block per stage in the accent,
 *  sized by what passed through it, and a gray band per flow. */
export function SankeyFigure({ spec }: { spec: AiSankeySpec }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const w = width || 600;
  const height = Math.max(220, Math.min(460, spec.nodes.length * 34));
  // each column of stages needs room for its names: a narrow screen
  // scrolls the flow inside its card rather than piling them up
  const minWidth = spec.columns * 150;
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit} · each band's width is how much flowed` : "Each band's width is how much flowed"}
      rows={spec.links.map((l) => ({ From: spec.nodes[l.source], To: spec.nodes[l.target], [spec.unit || "Value"]: l.value }))}
    >
      <div className="overflow-x-auto" dir="ltr">
        <div ref={box} style={{ height, minWidth }}>
          <ResponsiveContainer width="100%" height="100%">
            <Sankey data={{ nodes: spec.nodes.map((name) => ({ name })), links: spec.links }} nodeWidth={12} nodePadding={18} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
              node={(p: FlowNode) => <FlowBlock key={p.index} {...p} chartWidth={w} />} link={{ stroke: "var(--viz-other)", strokeOpacity: 0.35 }}>
              <Tooltip content={({ active, payload }: TipProps) => {
                const d = active ? (payload?.[0]?.payload as { payload?: { source?: { name?: string }; target?: { name?: string }; value?: number; name?: string } } | undefined)?.payload : undefined;
                if (!d) return null;
                return d.source && d.target
                  ? <Tip title={`${d.source.name} → ${d.target.name}`} rows={[{ label: spec.unit || "Value", value: fmt(d.value ?? 0) }]} />
                  : <Tip title={d.name ?? ""} rows={[{ label: spec.unit || "Value", value: fmt(d.value ?? 0) }]} />;
              }} />
            </Sankey>
          </ResponsiveContainer>
        </div>
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------- calendar

const WEEK_HEAD = ["Sa", "Su", "Mo", "Tu", "We", "Th", "Fr"];

/** A value per day laid out as the month, weeks Saturday to Friday: one hue,
 *  light → dark, each day's number in its cell. */
export function CalendarFigure({ spec }: { spec: AiCalendarSpec }) {
  return (
    <ChartFrame
      title={spec.title}
      sub={`${spec.unit ? `In ${spec.unit} · ` : ""}${spec.days} days · ${compact(spec.total)}${unitOf(spec.unit)} in all · darker is more`}
      rows={spec.months.flatMap((m) => m.weeks.flat().filter((d): d is NonNullable<typeof d> => !!d && d.value !== null).map((d) => ({ Date: d.date, [spec.unit || "Value"]: d.value! })))}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-4" dir="ltr">
        {spec.months.map((m) => (
          <table key={m.key} className="border-separate border-spacing-0.5">
            <caption className="text-xs font-bold text-start pb-1">{m.label}</caption>
            <thead>
              <tr>{WEEK_HEAD.map((d) => <th key={d} className="text-[11px] font-semibold text-muted">{d}</th>)}</tr>
            </thead>
            <tbody>
              {m.weeks.map((w, i) => (
                <tr key={i}>
                  {w.map((d, j) => d === null ? <td key={j} /> : (
                    <td key={j} className={`w-11 h-10 rounded align-top p-0.5 tabnum hover:outline hover:outline-2 hover:outline-[var(--foreground)] ${d.value !== null && d.value > 0 ? "" : "bg-surface-2"}`}
                      style={d.value !== null && d.value > 0 ? heat(d.value, spec.max) : undefined}
                      title={`${formatDate(d.date)}: ${d.value === null ? "no figure" : valueText(d.value, spec.unit)}`}>
                      <div className="text-[11px] leading-none opacity-70">{d.day}</div>
                      <div className="text-[11px] font-bold text-center leading-tight mt-0.5">{d.value === null ? "" : compact(d.value)}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      <div className="mt-2">
        <HeatScale max={spec.max} format={(v) => compact(v)} />
      </div>
    </ChartFrame>
  );
}

// ----------------------------------------------------------------- control

const OUT = "var(--bad-fg)";

/** A measure in order inside its control limits: the centre line, the
 *  limits dashed, and a point outside them marked as a problem. */
export function ControlFigure({ spec }: { spec: AiControlSpec }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const outs = spec.data.filter((d) => d.out).length;
  const room = fits(width, spec.data.map((d) => compact(d.value)), 4);
  const shown = pointsToLabel(spec.data.map((d) => d.value), room);
  const line = (y: number, label: string, solid = false) => (
    <ReferenceLine y={y} ifOverflow="extendDomain" stroke="var(--foreground)" strokeOpacity={solid ? 0.45 : 0.7} strokeDasharray={solid ? undefined : "4 3"}
      label={{ value: `${label} ${compact(y)}`, position: "insideBottomRight", fill: "var(--muted)", fontSize: 11 }} />
  );
  return (
    <ChartFrame
      title={spec.title}
      sub={[spec.unit && `In ${spec.unit}`, spec.given ? "limits as given" : "limits at 3 sigma unless given", outs ? `${outs} outside the limits` : "all inside the limits"].filter(Boolean).join(" · ")}
      rows={spec.data.map((d) => ({ " ": d.name, [spec.unit || "Value"]: d.value, "Outside": d.out ? "yes" : "" }))}
      legend={[{ label: "Inside the limits", color: catColor(0) }, { label: "Outside the limits", color: OUT }]}
    >
      <div ref={box} style={{ height: 280 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={spec.data} margin={{ top: 22, right: 16, left: -6, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => compact(v)} />
            <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={({ active, payload }: TipProps) => {
              const d = active ? (payload?.[0]?.payload as AiControlSpec["data"][number] | undefined) : undefined;
              if (!d) return null;
              return <Tip title={d.name} rows={[{ label: spec.unit || "Value", value: fmt(d.value) }, ...(d.out ? [{ label: "Status", value: "Outside the limits" }] : [])]} />;
            }} />
            {line(spec.ucl, "UCL")}
            {line(spec.center, "Mean", true)}
            {line(spec.lcl, "LCL")}
            <Line type="linear" dataKey="value" stroke={catColor(0)} strokeWidth={2} isAnimationActive={false}
              dot={(p: { cx?: number; cy?: number; index?: number }) => {
                const d = spec.data[p.index ?? 0];
                return <circle key={p.index} cx={p.cx} cy={p.cy} r={d?.out ? 5 : 3.5} fill={d?.out ? OUT : catColor(0)} stroke="var(--surface)" strokeWidth={2} />;
              }}>
              <LabelList dataKey="value" content={pointLabel(() => false, (v, k) => (shown.has(k) || spec.data[k]?.out ? compact(v) : null), spec.data.length)} />
            </Line>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
