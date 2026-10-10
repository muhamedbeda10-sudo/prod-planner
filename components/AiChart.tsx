"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { ChartCard, Legend, OTHER, TipBox, catColor, compact, fmt } from "@/components/charts/kit";
import { parseAiChart, type AiChartSpec, type AiKpiSpec } from "@/lib/domain/aiChart";

// A chart the assistant put in its answer (a ```chart block). Drawn the way
// the dashboards draw theirs: the palette's categorical slots in order, a
// legend from two series up, a tooltip on every mark, and the numbers one
// click away as a table with its export.

const GRID = { stroke: "var(--border)", vertical: false } as const;
const TICK = { fontSize: 11, fill: "var(--muted)" } as const;

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
  return spec.type === "kpi" ? <KpiRow spec={spec} /> : <Figure spec={spec} />;
}

const TONE = {
  ok: { icon: CheckCircle2, cls: "text-ok-fg", label: "Good" },
  warn: { icon: AlertTriangle, cls: "text-warn-fg", label: "Watch" },
  bad: { icon: XCircle, cls: "text-bad-fg", label: "Problem" },
} as const;

function KpiRow({ spec }: { spec: AiKpiSpec }) {
  return (
    <div className="my-3">
      {spec.title && <div className="text-xs font-bold text-muted mb-1.5">{spec.title}</div>}
      <div className="flex flex-wrap gap-2">
        {spec.items.map((it, i) => {
          const t = it.tone ? TONE[it.tone] : null;
          return (
            <div key={i} className="bg-surface border rounded-xl px-3.5 py-2.5 min-w-[9rem] flex-1">
              <div className="text-xs font-bold text-muted flex items-center gap-1" dir="auto">
                {t && <t.icon size={13} className={t.cls} aria-label={t.label} />}
                {it.label}
              </div>
              <div className="text-2xl font-semibold leading-tight ltr mt-0.5">{it.value}</div>
              {it.note && <div className="text-xs text-muted mt-0.5" dir="auto">{it.note}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Figure({ spec }: { spec: AiChartSpec }) {
  const unit = spec.unit ? ` ${spec.unit}` : "";
  const rows = spec.data.map((d) => ({ name: d.name, ...d.values }));
  const table = spec.data.map((d) => ({ [spec.type === "pie" ? "Name" : " "]: d.name, ...d.values }));
  const color = (i: number) => catColor(i);
  const many = spec.series.length > 1;
  const tip = ({ active, payload, label }: { active?: boolean; payload?: readonly { name?: unknown; value?: unknown; color?: string; payload?: { name?: string } }[]; label?: unknown }) => {
    if (!active || !payload?.length) return null;
    return (
      <TipBox
        title={String(label ?? payload[0]?.payload?.name ?? "")}
        rows={payload.map((p) => ({ label: String(p.name ?? ""), value: `${fmt(Number(p.value ?? 0))}${unit}`, color: p.color, line: spec.type === "line" }))}
      />
    );
  };

  let chart: React.ReactNode;
  if (spec.type === "pie") {
    const s = spec.series[0];
    const total = spec.data.reduce((t, d) => t + d.values[s], 0);
    const sliceColor = (d: { name: string }, i: number) => (d.name === "Other" && i === spec.data.length - 1 && i > 0 ? OTHER : color(i));
    chart = (
      <div className="flex flex-wrap items-center gap-4">
        <div style={{ width: 200, height: 200 }} className="shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip content={({ active, payload }: { active?: boolean; payload?: readonly { payload?: { name?: string; [k: string]: unknown } }[] }) => {
                const r = active ? payload?.[0]?.payload : undefined;
                if (!r) return null;
                const v = Number(r[s] ?? 0);
                return <TipBox title={String(r.name ?? "")} rows={[{ label: s, value: `${fmt(v)}${unit}` }, { label: "Share", value: total > 0 ? `${Math.round((v / total) * 100)}%` : "—" }]} />;
              }} />
              <Pie data={rows} dataKey={s} nameKey="name" innerRadius="58%" outerRadius="100%" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
                {spec.data.map((d, i) => <Cell key={d.name} fill={sliceColor(d, i)} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="text-sm space-y-1 min-w-0">
          {spec.data.map((d, i) => (
            <li key={d.name} className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: sliceColor(d, i) }} aria-hidden />
              <span className="truncate" dir="auto">{d.name}</span>
              <span className="font-bold tabnum ltr">{fmt(d.values[s])}{unit}</span>
              <span className="text-xs text-muted tabnum">{total > 0 ? `${Math.round((d.values[s] / total) * 100)}%` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (spec.type === "bar" && spec.horizontal) {
    const longest = Math.max(...spec.data.map((d) => d.name.length));
    chart = (
      <div style={{ height: Math.max(120, spec.data.length * (many && !spec.stacked ? 14 * spec.series.length + 10 : 26) + 30) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barGap={2}>
            <CartesianGrid stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tick={TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => compact(v)} />
            <YAxis type="category" dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} width={Math.min(180, Math.max(48, longest * 7))} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={tip} />
            {spec.series.map((s, i) => (
              <Bar key={s} dataKey={s} name={s} fill={color(i)} stackId={spec.stacked ? "a" : undefined} maxBarSize={18} isAnimationActive={false}
                radius={!spec.stacked || i === spec.series.length - 1 ? [0, 4, 4, 0] : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  } else {
    const Chart = spec.type === "bar" ? BarChart : spec.type === "line" ? LineChart : AreaChart;
    chart = (
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <Chart data={rows} margin={{ top: 12, right: 12, left: -6, bottom: 0 }} barGap={2}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="name" tick={TICK} axisLine={{ stroke: "var(--border-strong)" }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => compact(v)} />
            <Tooltip cursor={spec.type === "bar" ? { fill: "var(--surface-2)" } : { stroke: "var(--border-strong)" }} content={tip} />
            {spec.series.map((s, i) =>
              spec.type === "bar" ? (
                <Bar key={s} dataKey={s} name={s} fill={color(i)} stackId={spec.stacked ? "a" : undefined} maxBarSize={28} isAnimationActive={false}
                  radius={!spec.stacked || i === spec.series.length - 1 ? [4, 4, 0, 0] : 0} />
              ) : spec.type === "line" ? (
                <Line key={s} type="monotone" dataKey={s} name={s} stroke={color(i)} strokeWidth={2} isAnimationActive={false}
                  dot={spec.data.length <= 24 ? { r: 3, fill: color(i), stroke: "var(--surface)", strokeWidth: 1.5 } : false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} />
              ) : (
                <Area key={s} type="monotone" dataKey={s} name={s} stroke={color(i)} strokeWidth={2} fill={color(i)} fillOpacity={0.18}
                  stackId={spec.stacked ? "a" : undefined} isAnimationActive={false} />
              ),
            )}
          </Chart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <ChartCard
      title={spec.title || "Chart"}
      sub={spec.unit ? `In ${spec.unit}` : undefined}
      className="my-3 not-prose"
      table={{ rows: table, filename: (spec.title || "ai-chart").replace(/[^\w؀-ۿ -]+/g, "").slice(0, 60) || "ai-chart", sheet: "Data" }}
    >
      {chart}
      {many && spec.type !== "pie" && (
        <div className="mt-2">
          <Legend items={spec.series.map((s, i) => ({ label: s, color: color(i), line: spec.type === "line" }))} />
        </div>
      )}
    </ChartCard>
  );
}
