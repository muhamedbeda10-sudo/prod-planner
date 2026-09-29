"use client";

import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis, ZAxis, LabelList,
} from "recharts";
import {
  CAT, OTHER, ChartCard, DataBar, Delta, HeatScale, Heatmap, Legend, StatTile, TipBox,
  catColor, catInk, compact, fmt, pct, type TableRow,
} from "@/components/charts/kit";
import { OTHER_KEY, REPEAT_THRESHOLD, WEEKDAYS, pctChange, type ConsumablesStats } from "@/lib/domain/consumablesStats";

// The CONSUMABLES dashboard — what the store handed out in the period on the
// slicer, read the way a Power BI page reads: headline tiles with their
// trend, then one chart per question, each in the form that question needs —
//
//   how much, over time ........ area + 7-day average (hours for one day)
//   when is the store busy ..... weekday × hour heatmap
//   who takes it, by share ..... department donut (top five + Other)
//   …and how that moves ........ stacked columns per day / week
//   which items matter ......... Pareto (share + running total, the 80% line)
//   the whole range at once .... treemap, each item in its main department's colour
//   how departments draw on it . scatter: how often × how varied, and
//                                hand-outs per worker of each department
//   where each item goes ....... item × department heatmap with totals
//   what to look at ............ repeat hand-outs, the same department and item 3+ times
//
// A hand-out is recorded to a department — no worker is named — so every
// "who" here is a department.
//
// Every chart has a Table view with its export. Departments keep one colour
// across every chart on the page (slot by their rank in the period).

const H = { trend: 280, donut: 260, stack: 280, pareto: 320, tree: 320, scatter: 300 };
/** Factory week order: Saturday first. */
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

type TipProps<T> = { active?: boolean; payload?: readonly { payload?: T; value?: unknown; name?: unknown; color?: string; dataKey?: unknown }[]; label?: unknown };

/** A category tick cut to `max` characters, optionally slanted — the full
 *  name is its tooltip and in the table. */
function NameTick({ x, y, payload, max, slant }: { x?: number; y?: number; payload?: { value?: unknown }; max: number; slant?: boolean }) {
  const full = String(payload?.value ?? "");
  const text = full.length > max ? `${full.slice(0, max - 1)}…` : full;
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text dy={slant ? 10 : 4} dx={slant ? 0 : -6} textAnchor="end" fontSize={11} fill="var(--muted)" transform={slant ? "rotate(-35)" : undefined}>
        <title>{full}</title>
        {text}
      </text>
    </g>
  );
}

function Box({ height, minWidth = 0, children }: { height: number; minWidth?: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto viz">
      <div style={{ height, minWidth }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- charts

/** A period: hand-outs per day as an area, the trailing 7-day average over
 *  it. A single day: hand-outs per hour as columns. */
function TrendChart({ s }: { s: ConsumablesStats }) {
  if (s.timeline.unit === "hour") {
    const b = s.timeline.buckets;
    return (
      <Box height={H.trend} minWidth={Math.max(420, b.length * 34)}>
        <BarChart data={b} margin={{ top: 18, right: 8, left: -18, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip content={(p: TipProps<{ label: string; issues: number }>) => p.active && p.payload?.[0]?.payload ? <TipBox title={p.payload[0].payload.label} rows={[{ label: "Hand-outs", value: fmt(p.payload[0].payload.issues), color: CAT[0] }]} /> : null} />
          <Bar dataKey="issues" fill={CAT[0]} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <LabelList dataKey="issues" position="top" fontSize={10} fontWeight={700} fill="var(--foreground)" formatter={(v: unknown) => (Number(v) ? fmt(Number(v)) : "")} />
          </Bar>
        </BarChart>
      </Box>
    );
  }
  const data = s.daily;
  const every = data.length > 16 ? Math.ceil(data.length / 16) - 1 : 0;
  const peak = data.reduce((m, d) => (d.issues > m.issues ? d : m), data[0]);
  return (
    <>
      <Box height={H.trend} minWidth={Math.max(420, Math.min(data.length, 40) * 22)}>
        <ComposedChart data={data} margin={{ top: 18, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="cons-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--viz-1)" stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={every} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)" }}
            content={(p: TipProps<{ label: string; issues: number; avg7: number | null }>) => {
              const r = p.active ? p.payload?.[0]?.payload : undefined;
              return r ? <TipBox title={r.label} rows={[
                { label: "Hand-outs", value: fmt(r.issues), color: CAT[0] },
                ...(r.avg7 !== null ? [{ label: "7-day average", value: fmt(r.avg7, 1), color: "var(--muted)", line: true }] : []),
              ]} /> : null;
            }}
          />
          <Area type="monotone" dataKey="issues" stroke="var(--viz-1)" strokeWidth={2} fill="url(#cons-area)" isAnimationActive={false}
            dot={false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} />
          <Line type="monotone" dataKey="avg7" stroke="var(--muted)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          {peak && peak.issues > 0 && <ReferenceLine x={peak.label} stroke="transparent" label={{ value: `peak ${fmt(peak.issues)}`, position: "top", fontSize: 10, fill: "var(--foreground)" }} />}
        </ComposedChart>
      </Box>
      <div className="mt-2"><Legend items={[{ label: "Hand-outs per day", color: CAT[0] }, ...(data.length >= 7 ? [{ label: "7-day average", color: "var(--muted)", line: true }] : [])]} /></div>
    </>
  );
}

/** Part-to-whole by department: a donut, total in the hole, share in the legend. */
function DepartmentDonut({ s, colorOf }: { s: ConsumablesStats; colorOf: (key: string) => string }) {
  const data = s.departmentShare;
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative shrink-0" style={{ width: 210, height: 210 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="issues" nameKey="label" innerRadius={64} outerRadius={100} paddingAngle={data.length > 1 ? 1.5 : 0}
              stroke="var(--surface)" strokeWidth={2} startAngle={90} endAngle={-270} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.key} fill={colorOf(d.key)} />)}
            </Pie>
            <Tooltip content={(p: TipProps<{ label: string; issues: number; share: number; key: string }>) => {
              const r = p.active ? p.payload?.[0]?.payload : undefined;
              return r ? <TipBox title={r.label} rows={[{ label: "Hand-outs", value: fmt(r.issues), color: colorOf(r.key) }, { label: "Share", value: pct(r.share, 1) }]} /> : null;
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 grid place-items-center pointer-events-none text-center">
          <div>
            <div className="text-2xl font-semibold leading-none">{compact(s.totals.issues)}</div>
            <div className="text-[11px] text-muted">hand-outs</div>
          </div>
        </div>
      </div>
      <ul className="space-y-1.5 text-sm w-full">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorOf(d.key) }} aria-hidden />
            <span className="flex-1 truncate" title={d.label}>{d.label}</span>
            <span className="tabnum text-muted">{fmt(d.issues)}</span>
            <span className="tabnum font-bold w-12 text-right">{pct(d.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same departments over time, stacked — per day, or per week. */
function DepartmentStack({ s, colorOf }: { s: ConsumablesStats; colorOf: (key: string) => string }) {
  const t = s.departmentTrend;
  const data = t.buckets.map((b) => ({ label: b.label, total: b.total, ...b.values }));
  const every = data.length > 14 ? Math.ceil(data.length / 14) - 1 : 0;
  return (
    <>
      <Box height={H.stack} minWidth={Math.max(420, data.length * 26)}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={every} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<Record<string, number | string>>) => {
            const r = p.active ? p.payload?.[0]?.payload : undefined;
            if (!r) return null;
            return <TipBox title={`${r.label} · ${fmt(Number(r.total))}`} rows={[...t.series].reverse().filter((x) => Number(r[x.key]) > 0).map((x) => ({ label: x.label, value: fmt(Number(r[x.key])), color: colorOf(x.key) }))} />;
          }} />
          {t.series.map((x, i) => (
            <Bar key={x.key} dataKey={x.key} name={x.label} stackId="d" fill={colorOf(x.key)} stroke="var(--surface)" strokeWidth={1}
              maxBarSize={28} radius={i === t.series.length - 1 ? [4, 4, 0, 0] : undefined} isAnimationActive={false} />
          ))}
        </BarChart>
      </Box>
      <div className="mt-2"><Legend items={t.series.map((x) => ({ label: x.label, color: colorOf(x.key) }))} /></div>
    </>
  );
}

/** The 80/20 view: each item's share of hand-outs as a column, the running
 *  total as a line — both in % on the one axis — and the 80% mark. */
function ParetoChart({ s }: { s: ConsumablesStats }) {
  const rows = s.pareto.rows.slice(0, 15).map((r, i) => ({
    item: r.item, share: Math.round(r.share * 1000) / 10, cumulative: Math.round(r.cumulative * 1000) / 10, issues: r.issues, vital: i < s.pareto.vitalFew,
  }));
  return (
    <>
      <Box height={H.pareto} minWidth={Math.max(420, rows.length * 38)}>
        <ComposedChart data={rows} margin={{ top: 14, right: 12, left: 24, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="item" interval={0} height={78} tickLine={false} tick={<NameTick max={14} slant />} />
          <YAxis domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} unit="%" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<(typeof rows)[number]>) => {
            const r = p.active ? p.payload?.[0]?.payload : undefined;
            return r ? <TipBox title={r.item} rows={[
              { label: "Hand-outs", value: fmt(r.issues) },
              { label: "Share", value: `${r.share}%`, color: r.vital ? CAT[0] : OTHER },
              { label: "Running total", value: `${r.cumulative}%`, color: "var(--viz-3)", line: true },
            ]} /> : null;
          }} />
          <ReferenceLine y={80} stroke="var(--border-strong)" label={{ value: "80%", position: "insideTopRight", fontSize: 10, fill: "var(--muted)" }} />
          <Bar dataKey="share" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.item} fill={r.vital ? CAT[0] : OTHER} />)}
          </Bar>
          <Line type="monotone" dataKey="cumulative" stroke="var(--viz-3)" strokeWidth={2} isAnimationActive={false}
            dot={{ r: 3.5, fill: "var(--viz-3)", stroke: "var(--surface)", strokeWidth: 2 }} />
        </ComposedChart>
      </Box>
      <div className="mt-2">
        <Legend items={[
          { label: `The vital few (${s.pareto.vitalFew})`, color: CAT[0] },
          { label: "The rest", color: OTHER },
          { label: "Running total", color: "var(--viz-3)", line: true },
        ]} />
      </div>
    </>
  );
}

type Tile = { item: string; issues: number; qty: number; department: string; departmentLabel: string };

/** Every item at once: area = hand-outs, colour = the department that takes it most. */
function ItemTreemap({ s, colorOf, inkOf }: { s: ConsumablesStats; colorOf: (key: string) => string; inkOf: (key: string) => string }) {
  const data: (Tile & Record<string, unknown>)[] = s.itemTiles.slice(0, 40).map((t) => ({ ...t }));
  const depts = [...new Map(data.map((d) => [colorOf(d.department) === OTHER ? OTHER_KEY : d.department, colorOf(d.department) === OTHER ? "Other departments" : d.departmentLabel])).entries()];
  return (
    <>
      <Box height={H.tree}>
        <Treemap data={data} dataKey="issues" nameKey="item" isAnimationActive={false} aspectRatio={4 / 3}
          content={(n) => {
            const t = n as unknown as Tile & { x: number; y: number; width: number; height: number; depth: number };
            if (t.depth !== 1) return <g />;
            const fits = t.width > 56 && t.height > 30;
            const name = t.item.length * 6.2 > t.width - 10 ? `${t.item.slice(0, Math.max(1, Math.floor((t.width - 14) / 6.2)))}…` : t.item;
            return (
              <g>
                <rect x={t.x} y={t.y} width={t.width} height={t.height} rx={4} fill={colorOf(t.department)} stroke="var(--surface)" strokeWidth={2} />
                {fits && (
                  <>
                    <text x={t.x + 7} y={t.y + 16} fontSize={11} fontWeight={700} fill={inkOf(t.department)}>{name}</text>
                    <text x={t.x + 7} y={t.y + 29} fontSize={10} fill={inkOf(t.department)} opacity={0.85}>{fmt(t.issues)}</text>
                  </>
                )}
              </g>
            );
          }}
        >
          <Tooltip content={(p: TipProps<Tile>) => {
            const r = p.active ? p.payload?.[0]?.payload : undefined;
            return r ? <TipBox title={r.item} rows={[
              { label: "Hand-outs", value: fmt(r.issues), color: colorOf(r.department) },
              { label: "Quantity", value: fmt(r.qty) },
              { label: "Mostly to", value: r.departmentLabel },
            ]} /> : null;
          }} />
        </Treemap>
      </Box>
      <div className="mt-2"><Legend items={depts.map(([k, label]) => ({ label, color: k === OTHER_KEY ? OTHER : colorOf(k) }))} /></div>
    </>
  );
}

/** Departments: how often (x) × how many different items (y). Departments
 *  on the same spot share one bubble, sized by how many they are. */
function WorkerScatter({ s }: { s: ConsumablesStats }) {
  const spots = new Map<string, { x: number; y: number; n: number; names: string[] }>();
  for (const w of s.workerPoints) {
    const k = `${w.issues}|${w.items}`;
    const spot = spots.get(k) ?? { x: w.issues, y: w.items, n: 0, names: [] };
    spot.n += 1;
    spot.names.push(w.name);
    spots.set(k, spot);
  }
  const data = [...spots.values()];
  return (
    <Box height={H.scatter}>
      <ScatterChart margin={{ top: 12, right: 16, left: -8, bottom: 8 }}>
        <CartesianGrid />
        <XAxis type="number" dataKey="x" name="Hand-outs" allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false}
          label={{ value: "hand-outs →", position: "insideBottomRight", offset: -4, fontSize: 11, fill: "var(--muted)" }} />
        <YAxis type="number" dataKey="y" name="Items" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40}
          label={{ value: "different items", angle: -90, position: "insideLeft", offset: 18, fontSize: 11, fill: "var(--muted)" }} />
        <ZAxis type="number" dataKey="n" range={[70, 420]} />
        <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={(p: TipProps<(typeof data)[number]>) => {
          const r = p.active ? p.payload?.[0]?.payload : undefined;
          return r ? <TipBox title={r.n === 1 ? r.names[0] : `${r.n} departments`} rows={[
            { label: "Hand-outs", value: fmt(r.x) },
            { label: "Different items", value: fmt(r.y) },
            ...(r.n > 1 ? r.names.slice(0, 6).map((nm, i) => ({ label: i === 5 && r.names.length > 6 ? `…and ${r.names.length - 5} more` : nm, value: "" })) : []),
          ]} /> : null;
        }} />
        <Scatter data={data} fill="var(--viz-2)" fillOpacity={0.75} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false} />
      </ScatterChart>
    </Box>
  );
}

/** A ranked horizontal bar chart — the count at the bar's end. */
function RankedBars({ data, unit, color = CAT[0] }: { data: { name: string; value: number; note?: string }[]; unit: string; color?: string }) {
  const MAX = 22;
  const longest = Math.min(MAX, Math.max(6, ...data.map((d) => d.name.length)));
  return (
    <Box height={Math.max(120, 20 + data.length * 30)} minWidth={320}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 44, left: 4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" tick={<NameTick max={MAX} />} width={16 + longest * 7.2} axisLine={false} tickLine={false} interval={0} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<{ name: string; value: number; note?: string }>) => {
          const r = p.active ? p.payload?.[0]?.payload : undefined;
          return r ? <TipBox title={r.name} rows={[{ label: unit, value: fmt(r.value), color }, ...(r.note ? [{ label: r.note, value: "" }] : [])]} /> : null;
        }} />
        <Bar dataKey="value" fill={color} maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList dataKey="value" position="right" fontSize={11} fontWeight={700} fill="var(--foreground)" />
        </Bar>
      </BarChart>
    </Box>
  );
}

// ---------------------------------------------------------------- page

export function ConsumablesDashboard({ s, periodLabel, period }: { s: ConsumablesStats; periodLabel: string; period: string }) {
  if (s.totals.issues === 0) {
    return (
      <div className="bg-surface border rounded-xl p-10 text-center">
        <div className="text-3xl mb-2">📦</div>
        <div className="font-bold">Nothing handed out {periodLabel}</div>
        <p className="text-sm text-muted mt-1">
          Pick a longer period on the slicer above{s.previousIssues > 0 ? ` — the period before had ${fmt(s.previousIssues)} hand-out${s.previousIssues === 1 ? "" : "s"}` : ""}.
        </p>
      </div>
    );
  }

  // one colour per department for the whole page, by its rank in the period
  const slot = new Map(s.departmentShare.filter((d) => d.key !== OTHER_KEY).map((d, i) => [d.key, i]));
  const colorOf = (key: string) => catColor(slot.get(key) ?? -1);
  const inkOf = (key: string) => catInk(slot.get(key) ?? -1);

  const k = s.kpis;
  const singleDay = s.timeline.unit === "hour";
  const days = s.daily.length;
  const file = (name: string) => `consumables-${name}-${period}.xlsx`;

  // ---- table twins
  const trendRows: TableRow[] = singleDay
    ? s.timeline.buckets.map((b) => ({ Hour: b.label, "Hand-outs": b.issues }))
    : s.daily.map((d) => ({ Day: d.dayISO, "Hand-outs": d.issues, "7-day average": d.avg7 ?? "" }));
  const shareRows: TableRow[] = s.departments.map((d) => ({ Department: d.label, "Hand-outs": d.issues, Share: pct(d.issues / s.totals.issues, 1), Items: d.items, Workers: d.workers }));
  const stackRows: TableRow[] = s.departmentTrend.buckets.map((b) => ({ [s.departmentTrend.unit === "week" ? "Week of" : "Day"]: b.key, ...Object.fromEntries(s.departmentTrend.series.map((x) => [x.label, b.values[x.key] ?? 0])), Total: b.total }));
  const weekRows: TableRow[] = WEEK_ORDER.map((d) => ({ Weekday: WEEKDAYS[d], ...Object.fromEntries(s.weekHour.hours.map((h, j) => [hh(h), s.weekHour.counts[d][j]])) }));
  const paretoRows: TableRow[] = s.pareto.rows.map((r, i) => ({ "#": i + 1, Item: r.item, "Hand-outs": r.issues, Share: pct(r.share, 1), "Running total": pct(r.cumulative, 1) }));
  const itemRows: TableRow[] = s.itemTiles.map((t) => ({ Item: t.item, "Hand-outs": t.issues, Qty: t.qty, "Qty per hand-out": Math.round((t.qty / t.issues) * 1000) / 1000, "Mostly to": t.departmentLabel }));
  const workerRows: TableRow[] = s.workerPoints.map((w) => ({ Department: w.name, "Hand-outs": w.issues, "Different items": w.items }));
  const perHeadRows: TableRow[] = s.departments.map((d) => ({ Department: d.label, "Hand-outs": d.issues, "Workers on the list": d.people || "", "Hand-outs per worker": d.perPerson ?? "" }));
  const perHead = s.departments.filter((d) => d.perPerson !== null).sort((a, b) => b.perPerson! - a.perPerson!).slice(0, 12);
  const matrixRows: TableRow[] = s.matrix.items.map((item, i) => ({ Item: item, ...Object.fromEntries(s.matrix.departments.map((d, j) => [d.label, s.matrix.qty[i][j]])) }));
  const repeatRows: TableRow[] = s.repeats.map((r) => ({ Department: r.name, Item: r.item, Times: r.times, Qty: r.qty, First: r.firstDay, Last: r.lastDay }));

  const weekMax = Math.max(0, ...s.weekHour.counts.flat());
  const repeatMax = Math.max(0, ...s.repeats.map((r) => r.times));

  return (
    <div className="space-y-3">
      {/* ---- headline tiles */}
      <div className="flex flex-wrap gap-3">
        <StatTile hero label="Hand-outs" value={compact(s.totals.issues)} spark={days > 1 ? s.daily.map((d) => d.issues) : undefined}
          delta={<Delta pct={pctChange(s.totals.issues, s.previousIssues)} before={s.previousIssues} />} />
        <StatTile label="Per working day" value={fmt(k.perActiveDay, 1)} sub={singleDay ? "one day on the slicer" : `${k.activeDays} of ${days} days with hand-outs`} meter={singleDay ? undefined : k.activeDays / days} />
        <StatTile label="Items" value={fmt(s.totals.items)} sub={`${k.vitalFew} make up 80% of hand-outs`} meter={s.totals.items ? k.vitalFew / s.totals.items : 0} />
        <StatTile label="Departments" value={fmt(s.totals.departments)} sub={`${fmt(k.perWorker, 1)} hand-outs each on average`} />
        <StatTile label="Top department" value={pct(k.topDepartmentShare)} sub={s.departments[0]?.label} meter={k.topDepartmentShare} />
        <StatTile label="Busiest" value={k.busiestHour !== null ? hh(k.busiestHour) : "—"} sub={k.busiestWeekday !== null && !singleDay ? `on ${WEEKDAYS[k.busiestWeekday]}s` : "hour of the day"} />
        <StatTile label="Repeat hand-outs" value={fmt(k.repeatPairs)} sub={`same department & item ×${REPEAT_THRESHOLD}+`} />
      </div>

      {/* ---- how much, over time · who, by share */}
      <div className="grid gap-3 xl:grid-cols-3">
        <ChartCard className="xl:col-span-2"
          title={singleDay ? "Hand-outs by hour" : "Hand-outs per day"}
          sub={singleDay ? "When in the day the store was busy" : `Area = the day's hand-outs · line = the trailing 7-day average${days < 7 ? " (from a week on)" : ""}`}
          table={{ rows: trendRows, filename: file("trend"), sheet: "Trend" }}>
          <TrendChart s={s} />
        </ChartCard>
        <ChartCard title="Share by department" sub={s.departments.length > 5 ? "The top five; the rest folded into Other" : "Of all hand-outs in the period"}
          table={{ rows: shareRows, filename: file("departments"), sheet: "Departments" }}>
          <DepartmentDonut s={s} colorOf={colorOf} />
        </ChartCard>
      </div>

      {/* ---- when · how departments move (a period only: one day has one
          column to stack, and the donut already splits it by department) */}
      {!singleDay && (
        <div className="grid gap-3 xl:grid-cols-2">
          <ChartCard title="When the store is busy" sub="Hand-outs by weekday and hour — the darker, the busier"
            table={{ rows: weekRows, filename: file("weekday-hour"), sheet: "Weekday x hour" }}>
            <Heatmap compactCells rowHead="" rows={WEEK_ORDER.map((d) => WEEKDAYS[d])} cols={s.weekHour.hours.map((h) => String(h).padStart(2, "0"))}
              values={WEEK_ORDER.map((d) => s.weekHour.counts[d])}
              cellTitle={(i, j, v) => `${WEEKDAYS[WEEK_ORDER[i]]} ${hh(s.weekHour.hours[j])}: ${fmt(v)} hand-out${v === 1 ? "" : "s"}`} />
            <div className="mt-2"><HeatScale max={weekMax} /></div>
          </ChartCard>
          <ChartCard title={`Departments ${s.departmentTrend.unit === "week" ? "week by week" : "day by day"}`}
            sub="Hand-outs, stacked by department"
            table={{ rows: stackRows, filename: file("departments-over-time"), sheet: "Departments over time" }}>
            <DepartmentStack s={s} colorOf={colorOf} />
          </ChartCard>
        </div>
      )}

      {/* ---- which items matter · the whole range */}
      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard title="Items — the 80/20 view"
          sub={`${k.vitalFew} of ${s.totals.items} item${s.totals.items === 1 ? "" : "s"} make up 80% of hand-outs${s.pareto.rows.length > 15 ? " · top 15 shown" : ""}`}
          table={{ rows: paretoRows, filename: file("pareto"), sheet: "Pareto" }}>
          <ParetoChart s={s} />
        </ChartCard>
        <ChartCard title="Every item at a glance" sub={`Tile size = hand-outs · colour = the department that takes it most${s.itemTiles.length > 40 ? " · top 40" : ""}`}
          table={{ rows: itemRows, filename: file("items"), sheet: "Items" }}>
          <ItemTreemap s={s} colorOf={colorOf} inkOf={inkOf} />
        </ChartCard>
      </div>

      {/* ---- departments: how they draw on it, and for their size */}
      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard title="How departments draw on the store" sub="Each bubble: how often × how many different items"
          table={{ rows: workerRows, filename: file("departments-draw"), sheet: "Departments" }}>
          <WorkerScatter s={s} />
        </ChartCard>
        <ChartCard title="Hand-outs per worker, by department"
          sub={perHead.length ? "A department's hand-outs over its workers on the workers list — a big crew is not a big spender" : "No department on the workers list took anything in the period"}
          table={{ rows: perHeadRows, filename: file("per-worker"), sheet: "Per worker" }}>
          <RankedBars unit="Hand-outs per worker" color="var(--viz-2)" data={perHead.map((d) => ({ name: d.label, value: d.perPerson!, note: `${fmt(d.issues)} hand-outs · ${d.people} worker${d.people === 1 ? "" : "s"}` }))} />
        </ChartCard>
      </div>

      {/* ---- where each item goes */}
      <ChartCard title="Where each item goes" sub="Quantity handed out, item by department · each row is shaded on its own (its darkest cell = where most of it went) and totalled in its own unit"
        table={{ rows: matrixRows, filename: file("item-by-department"), sheet: "Item x department" }}>
        <Heatmap totals="rows" scale="row" rowHead="Item" rows={s.matrix.items} cols={s.matrix.departments.map((d) => d.label)} values={s.matrix.qty} />
      </ChartCard>

      {/* ---- the watch list */}
      <ChartCard title="Repeat hand-outs"
        sub={s.repeats.length ? `The same department took the same item ${REPEAT_THRESHOLD} times or more ${periodLabel} — worth a look` : `No department took the same item ${REPEAT_THRESHOLD} times or more ${periodLabel}`}
        table={s.repeats.length ? { rows: repeatRows, filename: file("repeats"), sheet: "Repeats" } : undefined}>
        {s.repeats.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr className="text-xs text-muted">
                  <th className="px-2 py-1.5 text-left">Department</th><th className="px-2 py-1.5 text-left">Item</th>
                  <th className="px-2 py-1.5 text-left">Times</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-left">First → last</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.repeats.slice(0, 25).map((r) => (
                  <tr key={`${r.workerId}|${r.item}`}>
                    <td className="px-2 py-1.5"><b>{r.name}</b></td>
                    <td className="px-2 py-1.5">{r.item}</td>
                    <td className="px-2 py-1.5"><DataBar value={r.times} max={repeatMax} label={`×${r.times}`} /></td>
                    <td className="px-2 py-1.5 text-right tabnum">{fmt(r.qty)}</td>
                    <td className="px-2 py-1.5 text-xs text-muted ltr whitespace-nowrap">{r.firstDay} → {r.lastDay}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">✓ Nothing to look at.</p>
        )}
      </ChartCard>
    </div>
  );
}
