"use client";

import { useSyncExternalStore } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis, ZAxis } from "recharts";
import { HeatScale, Heatmap, OTHER, catColor, catInk, compact, fmt, pct } from "@/components/charts/kit";
import { ChartFrame, TICK, Tip, ToneIcon, unitOf, useWidth, valueText, type TipProps } from "@/components/AiChartFrame";
import {
  OTHER_NAME, type AiDumbbellSpec, type AiFunnelSpec, type AiGanttSpec, type AiHeatmapSpec, type AiProgressSpec, type AiScatterSpec, type AiTreemapSpec, type AiWaterfallSpec,
} from "@/lib/domain/aiChart";

// The forms of an AI chart beyond bars, lines and pies (components/AiChart.tsx):
// two measures per item, a grid, progress against target, a pipeline, what
// moved a total, a schedule, before → after, and many parts of a whole. Each
// keeps the same rules — the palette's slots in order and gray for "Other",
// one value scale, a tooltip on every mark, and the numbers as a table twin.
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
            {spec.groups.map((g) => (
              <Scatter key={g || "all"} name={g || spec.title} data={spec.points.filter((p) => p.group === g)} fill={g ? groupColor(named, g) : catColor(0)}
                stroke="var(--surface)" strokeWidth={2} isAnimationActive={false} />
            ))}
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
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.items.map((it) => ({ Item: it.label, Done: it.value, ...(it.target !== null ? { Target: it.target } : {}), Reached: pct(it.target !== null ? it.value / it.target : it.value / 100) }))}
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
              <div className="relative h-2.5 mt-1 rounded-full" style={{ background: "color-mix(in srgb, var(--viz-1) 16%, var(--surface))" }}
                role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label={it.label}>
                <div className="absolute inset-y-0 start-0 rounded-full" style={{ width: `${Math.max(0, Math.min(1, ratio / scale)) * 100}%`, background: "var(--viz-1)" }} />
                {ratio > 1 && <div className="absolute -top-1 -bottom-1 w-0.5 rounded bg-[var(--foreground)]" style={{ insetInlineStart: `${(1 / scale) * 100}%` }} title="Target" />}
              </div>
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
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.data.map((d) => ({ Step: d.name, Change: d.total ? "" : d.value, Total: d.end }))}
      legend={[{ label: "Total", color: TOTAL }, { label: "Up", color: RISE }, { label: "Down", color: FALL }]}
    >
      <div style={{ height: 280 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 12, right: 12, left: -6, bottom: 0 }}>
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
const wallNow = () => {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
};

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
              const ink = t.group === OTHER_NAME ? "#14201a" : catInk(t.group ? Math.max(0, named.indexOf(t.group)) : 0);
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
  const pad = (hi0 - lo0) * 0.06 || 1;
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
const treeInk = (named: readonly string[], g: string) => (g === OTHER_NAME ? "#14201a" : catInk(g ? Math.max(0, named.indexOf(g)) : 0));

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
