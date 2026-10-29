"use client";

import {
  type PieLabelRenderProps,
  Area, Bar, CartesianGrid, Cell, ComposedChart, LabelList, Line, Pie, PieChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ReferenceLine, Tooltip, XAxis, YAxis,
} from "recharts";
import { ResponsiveContainer } from "@/components/charts/zoom";
import { INK_ON_OTHER, OTHER, Sparkline, catColor, catInk, compact, fmt, pct } from "@/components/charts/kit";
import { Meter } from "@/components/Meter";
import {
  ChartFrame, PlotText, TICK, Tip, ToneIcon, fits, insideLabel, perSlot, pointLabel, textWidth, tipLabel, unitOf, useWidth, valueText, type TipProps,
} from "@/components/AiChartFrame";
import {
  BoxplotFigure, CalendarFigure, ControlFigure, DumbbellFigure, FunnelFigure, GanttFigure, GaugeFigure, HeatmapFigure, ProgressFigure, SankeyFigure, ScatterFigure, TreemapFigure, WaterfallFigure,
} from "@/components/AiChartForms";
import {
  OTHER_NAME, parseAiChart, pointsToLabel, type AiHistogramSpec, type AiKpiSpec, type AiParetoSpec, type AiPieSpec, type AiRadarSpec, type AiXYSpec,
} from "@/lib/domain/aiChart";

// A chart the assistant put in its answer (a ```chart block) — in the chat,
// in the inbox's reports and on their printout. Drawn the way the dashboards
// draw theirs: the palette's categorical slots in order (a series keeps its
// slot), gray for what is not the point, one value scale per chart, thin
// marks, a tooltip on every mark, and a legend from two series up.

export function AiChart({ source, streaming }: { source: string; streaming: boolean }) {
  const spec = parseAiChart(source);
  if ("error" in spec) {
    // still being written: the block is not whole yet
    if (streaming) return <div className="my-3 h-24 rounded-xl border border-dashed grid place-items-center text-sm text-muted">Drawing a chart…</div>;
    return (
      <details className="text-xs text-muted my-2">
        <summary>A chart could not be drawn — {spec.error}</summary>
        <pre className="whitespace-pre-wrap ltr mt-1">{source}</pre>
      </details>
    );
  }
  switch (spec.type) {
    case "kpi":
      return <KpiRow spec={spec} />;
    case "pie":
      return <PieFigure spec={spec} />;
    case "pareto":
      return <ParetoFigure spec={spec} />;
    case "histogram":
      return <HistogramFigure spec={spec} />;
    case "radar":
      return <RadarFigure spec={spec} />;
    case "scatter":
      return <ScatterFigure spec={spec} />;
    case "heatmap":
      return <HeatmapFigure spec={spec} />;
    case "progress":
      return <ProgressFigure spec={spec} />;
    case "funnel":
      return <FunnelFigure spec={spec} />;
    case "waterfall":
      return <WaterfallFigure spec={spec} />;
    case "gantt":
      return <GanttFigure spec={spec} />;
    case "dumbbell":
      return <DumbbellFigure spec={spec} />;
    case "treemap":
      return <TreemapFigure spec={spec} />;
    case "gauge":
      return <GaugeFigure spec={spec} />;
    case "boxplot":
      return <BoxplotFigure spec={spec} />;
    case "sankey":
      return <SankeyFigure spec={spec} />;
    case "calendar":
      return <CalendarFigure spec={spec} />;
    case "control":
      return <ControlFigure spec={spec} />;
    default:
      return <XYFigure spec={spec} />;
  }
}

// ---------------------------------------------------------------- figures

function KpiRow({ spec }: { spec: AiKpiSpec }) {
  return (
    <div className="my-3 not-prose">
      {spec.title && <div className="text-xs font-bold text-muted mb-1.5">{spec.title}</div>}
      <div className="flex flex-wrap gap-2">
        {spec.items.map((it, i) => (
          <div key={i} className="bg-surface border rounded-xl px-3.5 py-2.5 min-w-[9rem] flex-1 flex flex-col gap-1">
            <div className="text-xs font-bold text-muted flex items-center gap-1" dir="auto">
              <ToneIcon tone={it.tone} />
              {it.label}
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="text-2xl font-semibold leading-tight ltr">{it.value}</div>
              {it.trend.length >= 2 && <Sparkline values={it.trend} />}
            </div>
            {it.progress !== null && (
              <div className="flex items-center gap-2" title={`${Math.round(it.progress)}% of its target`}>
                <Meter value={it.progress / 100} />
                <span className="text-[11px] text-muted tabnum shrink-0">{Math.round(it.progress)}%</span>
              </div>
            )}
            {it.note && <div className="text-xs text-muted" dir="auto">{it.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function XYFigure({ spec }: { spec: AiXYSpec }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const percent = spec.stacked === "percent";
  const one = spec.series.length === 1;
  const hl = new Set(spec.highlight);
  // what the chart is about keeps its colour; the rest steps back to gray
  const dim = (s: string) => !one && hl.size > 0 && !hl.has(s);
  const seriesColor = (s: string, i: number) => (dim(s) ? OTHER : catColor(i));
  const seriesInk = (s: string, i: number) => (dim(s) ? INK_ON_OTHER : catInk(i));
  const rows = spec.data.map((d) => ({ name: d.name, ...d.values }));
  const totals = new Map(spec.data.map((d) => [d.name, spec.series.reduce((t, s) => t + (d.values[s] ?? 0), 0)]));
  const lastBar = spec.series.reduce((k, s, i) => (spec.kinds[s] === "bar" ? i : k), -1);
  const h = spec.horizontal;

  const tip = ({ active, payload, label }: TipProps) => {
    if (!active || !payload?.length) return null;
    const name = String(label ?? payload[0]?.payload?.name ?? "");
    const total = totals.get(name) ?? 0;
    return (
      <Tip
        title={name}
        rows={payload.map((p) => {
          const v = Number(p.value ?? 0);
          return { label: String(p.name ?? ""), value: `${valueText(v, spec.unit)}${percent && total ? ` · ${pct(v / total)}` : ""}`, color: p.color, line: spec.kinds[String(p.dataKey)] === "line" };
        })}
      />
    );
  };

  const longest = Math.max(...spec.data.map((d) => d.name.length));
  const nameWidth = Math.min(180, Math.max(48, longest * 7));
  const barSeries = spec.series.filter((s) => spec.kinds[s] === "bar");
  const bars = barSeries.length;
  const lines = spec.series.filter((s) => spec.kinds[s] !== "bar");
  const height = h ? Math.max(140, spec.data.length * (bars > 1 && !spec.stacked ? 14 * bars + 12 : 28) + 40) : 280;

  // the values on the marks — each where it has the room, never clipped
  const shareOf = (v: number, i: number) => {
    const t = totals.get(spec.data[i]?.name ?? "") ?? 0;
    return t ? pct(v / t) : "";
  };
  // a stack's height: its bars only — a combo's lines stand beside it
  const stackOf = (k: number) => barSeries.reduce((t, s) => t + (spec.data[k]?.values[s] ?? 0), 0);
  const onTip = spec.stacked ? spec.data.map((_, k) => stackOf(k)) : spec.data.flatMap((d) => barSeries.map((s) => d.values[s] ?? 0));
  const below0 = spec.labels && onTip.some((v) => v < 0);
  const widest = Math.max(0, ...onTip.map((v) => textWidth(compact(v))));
  const perCategory = perSlot(width, spec.data.length, h ? nameWidth + 20 + widest : 60);
  const barRoom = h || perCategory / (spec.stacked ? 1 : Math.max(1, bars)) >= widest + 2;
  const tipLabels = spec.labels && bars > 0 && !percent && barRoom;
  const lineRoom = perCategory >= Math.max(0, ...spec.data.flatMap((d) => lines.map((s) => textWidth(compact(d.values[s] ?? 0))))) + 4;
  const marked = (s: string) => (lines.length > 2 || (spec.stacked && spec.kinds[s] === "area") ? new Set([spec.data.length - 1]) : pointsToLabel(spec.data.map((d) => d.values[s] ?? 0), lineRoom));
  const curve = spec.curve === "step" ? "stepAfter" : spec.curve === "linear" ? "linear" : "monotone";
  const valueAxis = {
    tick: TICK,
    axisLine: false,
    tickLine: false,
    // room past the lowest bar for its value, clear of the category names
    ...(below0 && !percent ? { domain: [(m: number) => (m < 0 ? m * 1.15 : m), "auto"] as [(m: number) => number, "auto"] } : {}),
    tickFormatter: percent ? (v: number) => `${Math.round(v * 100)}%` : (v: number) => compact(v),
  };

  return (
    <ChartFrame
      title={spec.title}
      sub={[spec.unit && `In ${spec.unit}`, percent && "shares of each total", hl.size > 0 && one && `${spec.highlight.join(", ")} picked out`].filter(Boolean).join(" · ") || undefined}
      rows={spec.data.map((d) => ({ " ": d.name, ...d.values }))}
      legend={spec.series.map((s, i) => ({ label: s, color: seriesColor(s, i), line: spec.kinds[s] === "line" }))}
    >
      <div ref={box} style={{ height }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} layout={h ? "vertical" : "horizontal"} stackOffset={percent ? "expand" : undefined}
            margin={{ top: spec.labels ? 22 : 12, right: h && tipLabels ? 16 + widest : 16, left: (h ? 4 : -6) + (h && below0 ? widest : 0), bottom: spec.labels && (lines.length > 1 || (!h && below0)) ? 14 : 0 }} barGap={2}>
            <CartesianGrid stroke="var(--border)" vertical={h} horizontal={!h} />
            {h ? (
              <>
                <XAxis type="number" {...valueAxis} />
                <YAxis type="category" dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} width={nameWidth} />
              </>
            ) : (
              <>
                <XAxis dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis {...valueAxis} />
              </>
            )}
            <Tooltip content={tip} cursor={bars > 0 ? { fill: "var(--surface-2)" } : { stroke: "var(--border-strong)" }} />
            {spec.series.map((s, i) => {
              const kind = spec.kinds[s];
              const color = seriesColor(s, i);
              if (kind === "bar") {
                const end = !spec.stacked || i === lastBar;
                return (
                  <Bar key={s} dataKey={s} name={s} fill={color} stackId={spec.stacked ? "bars" : undefined} maxBarSize={spec.stacked ? 40 : 24} isAnimationActive={false}
                    radius={end ? (h ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}>
                    {one && hl.size > 0 ? spec.data.map((d) => <Cell key={d.name} fill={hl.has(d.name) ? catColor(0) : OTHER} />) : null}
                    {/* a stack: each part inside it where it fits, the whole at its tip */}
                    {spec.labels && spec.stacked && <LabelList dataKey={s} content={insideLabel(seriesInk(s, i), (_, k) => {
                      const v = spec.data[k]?.values[s] ?? 0;
                      return v === 0 ? null : percent ? shareOf(v, k) : compact(v);
                    })} />}
                    {tipLabels && (!spec.stacked || i === lastBar) && (
                      <LabelList dataKey={s} content={spec.stacked ? tipLabel(h, (_, k) => compact(onTip[k]), (k) => onTip[k]) : tipLabel(h, (v) => compact(v))} />
                    )}
                  </Bar>
                );
              }
              const shown = spec.labels ? marked(s) : new Set<number>();
              // under the point where another series runs above it there
              const below = (k: number) => {
                const d = spec.data[k];
                const v = d?.values[s] ?? 0;
                return !spec.stacked && !!d && spec.series.some((o) => o !== s && (d.values[o] ?? 0) > v);
              };
              const label = shown.size > 0
                ? <LabelList dataKey={s} content={pointLabel(below, (_, k) => (shown.has(k) ? compact(spec.data[k]?.values[s] ?? 0) : null), spec.data.length)} />
                : null;
              if (kind === "line") {
                return (
                  <Line key={s} type={curve} dataKey={s} name={s} stroke={color} strokeWidth={2} isAnimationActive={false}
                    dot={spec.data.length <= 24 ? { r: 4, fill: color, stroke: "var(--surface)", strokeWidth: 2 } : false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}>
                    {label}
                  </Line>
                );
              }
              return (
                <Area key={s} type={curve} dataKey={s} name={s} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.12} stackId={spec.stacked ? "areas" : undefined} isAnimationActive={false}>
                  {percent ? null : label}
                </Area>
              );
            })}
            {!percent && spec.targets.map((t, k) => (
              <ReferenceLine
                key={k}
                {...(h ? { x: t.value } : { y: t.value })}
                stroke="var(--foreground)"
                strokeOpacity={0.7}
                strokeDasharray="4 3"
                label={{ value: t.label ? `${t.label} ${compact(t.value)}` : compact(t.value), position: "insideTopRight", fill: "var(--muted)", fontSize: 11 }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

function PieFigure({ spec }: { spec: AiPieSpec }) {
  const s = spec.series[0];
  const rows = spec.data.map((d) => ({ name: d.name, ...d.values }));
  const total = spec.data.reduce((t, d) => t + d.values[s], 0);
  const isOther = (d: { name: string } | undefined, i: number) => d?.name === OTHER_NAME && i === spec.data.length - 1 && i > 0;
  const sliceColor = (d: { name: string }, i: number) => (isOther(d, i) ? OTHER : catColor(i));
  const sliceInk = (d: { name: string } | undefined, i: number) => (isOther(d, i) ? INK_ON_OTHER : catInk(i));
  return (
    <ChartFrame title={spec.title} sub={spec.unit ? `In ${spec.unit}` : undefined} rows={spec.data.map((d) => ({ Name: d.name, [s]: d.values[s], Share: `${total > 0 ? Math.round((d.values[s] / total) * 100) : 0}%` }))}>
      <div className="flex flex-wrap items-center gap-4">
        <div style={{ width: 200, height: 200 }} className="shrink-0 relative" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip content={({ active, payload }: TipProps) => {
                const r = active ? payload?.[0]?.payload : undefined;
                if (!r) return null;
                const v = Number(r[s] ?? 0);
                return <Tip title={String(r.name ?? "")} rows={[{ label: s, value: valueText(v, spec.unit) }, { label: "Share", value: total > 0 ? `${Math.round((v / total) * 100)}%` : "—" }]} />;
              }} />
              <Pie data={rows} dataKey={s} nameKey="name" innerRadius="58%" outerRadius="100%" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}
                labelLine={false} label={(p: PieLabelRenderProps) => <SliceShare {...p} ink={sliceInk(spec.data[p.index ?? 0], p.index ?? 0)} />}>
                {spec.data.map((d, i) => <Cell key={d.name} fill={sliceColor(d, i)} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {/* the whole, in the hole */}
          <div className="absolute inset-0 grid place-items-center pointer-events-none text-center">
            <div>
              <div className="text-lg font-semibold leading-none">{compact(total)}</div>
              <div className="text-[11px] text-muted mt-0.5">{spec.unit || "total"}</div>
            </div>
          </div>
        </div>
        <ul className="text-sm space-y-1 min-w-0">
          {spec.data.map((d, i) => (
            <li key={d.name} className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: sliceColor(d, i) }} aria-hidden />
              <span className="truncate" dir="auto">{d.name}</span>
              <span className="font-bold tabnum ltr">{fmt(d.values[s])}{unitOf(spec.unit)}</span>
              <span className="text-xs text-muted tabnum">{total > 0 ? `${Math.round((d.values[s] / total) * 100)}%` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}

/** A slice's share, written across its middle where the slice is wide enough. */
function SliceShare({ cx, cy, midAngle, innerRadius, outerRadius, percent, ink }: PieLabelRenderProps & { ink: string }) {
  const share = Number(percent ?? 0);
  if (share < 0.07) return null;
  const r = (Number(innerRadius) + Number(outerRadius)) / 2;
  const a = (-Number(midAngle ?? 0) * Math.PI) / 180;
  return (
    <text x={Number(cx) + r * Math.cos(a)} y={Number(cy) + r * Math.sin(a)} dy="0.35em" textAnchor="middle" fontSize={11} fontWeight={700} fill={ink}>
      {pct(share)}
    </text>
  );
}

/** Causes ranked: the vital few that make the first 80% in the accent, the
 *  rest in gray — on one scale, the running share in the tooltip and table. */
function ParetoFigure({ spec }: { spec: AiParetoSpec }) {
  const total = spec.data.reduce((t, d) => t + d.value, 0);
  const longest = Math.max(...spec.data.map((d) => d.name.length));
  const text = (v: number, k: number) => `${compact(v)} · ${pct(spec.data[k]?.share ?? 0)}`;
  const widest = Math.max(...spec.data.map((d, k) => textWidth(text(d.value, k))));
  return (
    <ChartFrame
      title={spec.title}
      sub={`${spec.vital} of ${spec.data.length} make 80% of the ${compact(total)}${unitOf(spec.unit)}`}
      rows={spec.data.map((d) => ({ Cause: d.name, [spec.unit || "Count"]: d.value, Share: pct(d.share, 1), Cumulative: pct(d.cumulative, 1) }))}
      legend={[{ label: "The vital few (80%)", color: catColor(0) }, { label: "The rest", color: OTHER }]}
    >
      <div style={{ height: Math.max(140, spec.data.length * 28 + 40) }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={spec.data} layout="vertical" margin={{ top: 4, right: 16 + widest, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tick={TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => compact(v)} />
            <YAxis type="category" dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} width={Math.min(180, Math.max(48, longest * 7))} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }: TipProps) => {
              const d = active ? (payload?.[0]?.payload as AiParetoSpec["data"][number] | undefined) : undefined;
              if (!d) return null;
              return <Tip title={d.name} rows={[{ label: spec.unit || "Count", value: fmt(d.value) }, { label: "Share", value: pct(d.share, 1) }, { label: "Running share", value: pct(d.cumulative, 1) }]} />;
            }} />
            <Bar dataKey="value" maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {spec.data.map((d) => <Cell key={d.name} fill={d.vital ? catColor(0) : OTHER} />)}
              <LabelList dataKey="value" content={tipLabel(true, text)} />
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

/** How values spread: a count per bin, one hue. */
function HistogramFigure({ spec }: { spec: AiHistogramSpec }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const rows = spec.bins.map((b) => ({ name: `${fmt(b.from)}–${fmt(b.to)}`, count: b.count }));
  const room = fits(width, spec.bins.map((b) => fmt(b.count)));
  return (
    <ChartFrame
      title={spec.title}
      sub={`${fmt(spec.n)} values · median ${fmt(spec.median)}${unitOf(spec.unit)} · mean ${fmt(spec.mean)}${unitOf(spec.unit)}`}
      rows={spec.bins.map((b) => ({ From: b.from, To: b.to, Count: b.count }))}
    >
      <div ref={box} style={{ height: 260 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 22, right: 12, left: -6, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }: TipProps) => {
              const r = active ? payload?.[0]?.payload : undefined;
              if (!r) return null;
              return <Tip title={`${String(r.name)}${unitOf(spec.unit)}`} rows={[{ label: "Count", value: fmt(Number(r.count)) }]} />;
            }} />
            <Bar dataKey="count" fill={catColor(0)} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {room && <LabelList dataKey="count" content={tipLabel(false, (v) => (v > 0 ? fmt(v) : null))} />}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

/** A few things scored on the same measures — at most three, so every pair
 *  of shapes stays apart. */
function RadarFigure({ spec }: { spec: AiRadarSpec }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const rows = spec.data.map((d) => ({ name: d.name, ...d.values }));
  // the measures' names sit outside the web: it shrinks to leave them room
  const longest = Math.max(...spec.data.map((d) => d.name.length));
  const radius = Math.max(50, Math.min(120, (width || 600) / 2 - longest * 6.4 - 14));
  return (
    <ChartFrame
      title={spec.title}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      rows={spec.data.map((d) => ({ Measure: d.name, ...d.values }))}
      legend={spec.series.map((s, i) => ({ label: s, color: catColor(i), line: true }))}
    >
      <div ref={box} style={{ height: 300 }} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={rows} outerRadius={radius}>
            <PolarGrid stroke="var(--border)" />
            <PolarAngleAxis dataKey="name" tick={TICK} />
            {/* the scale between the first two spokes, clear of their names */}
            <PolarRadiusAxis tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickFormatter={(v: number) => compact(v)} angle={90 - 180 / spec.data.length} />
            <Tooltip content={({ active, payload, label }: TipProps) => (active && payload?.length ? <Tip title={String(label ?? "")} rows={payload.map((p) => ({ label: String(p.name ?? ""), value: valueText(Number(p.value ?? 0), spec.unit), color: p.color, line: true }))} /> : null)} />
            {spec.series.map((s, i) => (
              <Radar key={s} dataKey={s} name={s} stroke={catColor(i)} strokeWidth={2} fill={catColor(i)} fillOpacity={0.1} isAnimationActive={false}
                dot={(d: RadarDot) => <RadarPoint key={d.index} {...d} color={catColor(i)} labelled={spec.series.length <= 2} below={i === 1} />} />
            ))}
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

type RadarDot = { cx?: number; cy?: number; value?: unknown; index?: number };

/** A point of a radar's shape, its value beside it while there are two shapes at most. */
function RadarPoint({ cx = 0, cy = 0, value, color, labelled, below }: RadarDot & { color: string; labelled: boolean; below: boolean }) {
  const v = Number(Array.isArray(value) ? value[1] : value);
  return (
    <g>
      <circle cx={cx} cy={cy} r={3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
      {labelled && Number.isFinite(v) && <PlotText x={cx} y={below ? cy + 15 : cy - 7} textAnchor="middle" fontWeight={600}>{compact(v)}</PlotText>}
    </g>
  );
}
