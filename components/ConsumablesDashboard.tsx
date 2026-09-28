"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList,
} from "recharts";
import { ExportButton } from "@/components/ExportButton";
import { pctChange, type ConsumablesStats } from "@/lib/domain/consumablesStats";

// The CONSUMABLES dashboard — what the store handed out in the period on the
// slicer. Four headline numbers, hand-outs over time (per hour for a single
// day), the items and the departments that take the most, the workers who
// come most often, and where each item goes. Every chart is one series in one
// colour, its value written on the bar, and each has a table with an export
// beside it — the chart is never the only way to read a number.

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 3 }));
const INK = "var(--viz-1)";

/** Tick interval so at most `max` labels show — the rest stay in the tooltip. */
const tickEvery = (n: number, max: number) => (n > max ? Math.ceil(n / max) - 1 : 0);
/** A round step that gives at most five gridlines up to `max`, with room
 *  above the tallest column for its cap label. */
function niceTicks(max: number): number[] {
  const want = Math.max(1, max * 1.04);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((st) => want / st <= 5) ?? Math.ceil(want / 5);
  const top = Math.max(step, Math.ceil(want / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  return ticks;
}

/** A category name on one line — cut with "…" past `max` characters (the
 *  tooltip and the table carry it whole). */
function NameTick({ x, y, payload, max }: { x?: number; y?: number; payload?: { value?: unknown }; max: number }) {
  const full = String(payload?.value ?? "");
  const text = full.length > max ? `${full.slice(0, max - 1)}…` : full;
  return (
    <text x={x} y={y} dx={-6} dy={4} textAnchor="end" fontSize={12} fill="var(--muted)">
      <title>{full}</title>
      {text}
    </text>
  );
}

type LabelBox = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown };

function TopLabel(p: LabelBox) {
  const v = Number(p.value ?? 0);
  if (!v) return null;
  return (
    <text x={Number(p.x) + Number(p.width ?? 0) / 2} y={Number(p.y)} dy={-4} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--foreground)" pointerEvents="none">
      {fmt(v)}
    </text>
  );
}

type TipRow = { value?: number | string; payload?: Record<string, unknown> };

function Tip({ active, label, payload, unit, extra }: {
  active?: boolean; label?: string | number; payload?: TipRow[]; unit: string; extra?: (row: Record<string, unknown>) => string | null;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const v = Number(payload[0].value ?? 0);
  const more = extra && payload[0].payload ? extra(payload[0].payload) : null;
  return (
    <div className="bg-surface border rounded-lg shadow-md px-3 py-2 text-xs min-w-[9rem]">
      <div className="font-bold mb-1">{String(label)}</div>
      <div className="flex items-center gap-2">
        <span className="inline-block w-3 h-0.5 rounded" style={{ background: INK }} />
        <span className="font-extrabold tabnum ltr">{fmt(v)}</span>
        <span className="text-muted">{unit}</span>
      </div>
      {more && <div className="text-muted mt-0.5">{more}</div>}
    </div>
  );
}

function Card({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-surface border rounded-xl p-4 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div>
          <h2 className="font-bold leading-tight">{title}</h2>
          {sub && <p className="text-xs text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: React.ReactNode }) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-[9.5rem] flex-1">
      <div className="text-xs font-bold text-muted">{label}</div>
      <div className="text-[28px] font-semibold leading-tight ltr">{value}</div>
      <div className="flex flex-wrap items-baseline gap-x-2 min-h-[1rem]">
        {delta}
        {sub && <span className="text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  const pct = pctChange(cur, prev);
  if (pct === null) return <span className="text-xs text-muted">none in the period before</span>;
  // more hand-outs is neither good nor bad for the store — no green / red
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  return (
    <span className="text-xs font-bold" title={`Period before: ${fmt(prev)}`}>
      {arrow} {Math.abs(pct)}% <span className="font-normal text-muted">vs the period before ({fmt(prev)})</span>
    </span>
  );
}

function Scroller({ minWidth, height, children }: { minWidth: number; height: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto viz">
      <div style={{ minWidth, height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

function Timeline({ s }: { s: ConsumablesStats }) {
  const b = s.timeline.buckets;
  const n = b.length;
  const ticks = niceTicks(Math.max(0, ...b.map((x) => x.issues)));
  return (
    // day labels ("Tue 15 Sep") need their width — a phone scrolls sideways
    // instead of piling them on each other
    <Scroller minWidth={Math.max(480, n * (s.timeline.unit === "day" && n <= 14 ? 72 : 34))} height={260}>
      <BarChart data={b} margin={{ top: 18, right: 12, left: -14, bottom: 0 }} barCategoryGap="25%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={tickEvery(n, 16)} tickLine={false} />
        <YAxis domain={[0, ticks.at(-1)!]} ticks={ticks} allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<Tip unit="hand-outs" />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey="issues" name="Hand-outs" fill={INK} maxBarSize={28} radius={[4, 4, 0, 0]} isAnimationActive={false}>
          <LabelList dataKey="issues" content={TopLabel} />
        </Bar>
      </BarChart>
    </Scroller>
  );
}

/** A ranked horizontal bar chart: one row per name, the count at the bar's end. */
function Ranked({ data, unit, extra }: {
  data: { name: string; value: number; note: string }[]; unit: string; extra?: (row: Record<string, unknown>) => string | null;
}) {
  const MAX_CHARS = 24;
  const longest = Math.min(MAX_CHARS, Math.max(6, ...data.map((d) => d.name.length)));
  return (
    <Scroller minWidth={340} height={Math.max(120, 24 + data.length * 32)}>
      <BarChart data={data} layout="vertical" margin={{ top: 2, right: 48, left: 4, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" tick={<NameTick max={MAX_CHARS} />} width={16 + longest * 7.4} axisLine={false} tickLine={false} interval={0} />
        <Tooltip content={<Tip unit={unit} extra={extra} />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey="value" name={unit} fill={INK} maxBarSize={22} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList dataKey="value" position="right" fontSize={11} fontWeight={700} fill="var(--foreground)" />
        </Bar>
      </BarChart>
    </Scroller>
  );
}

const TH = "px-2 py-1.5 text-left text-xs font-bold text-muted whitespace-nowrap";
const TD = "px-2 py-1.5 text-sm";

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

  const topItems = s.items.slice(0, 10);
  const itemData = topItems.map((i) => ({ name: i.item, value: i.issues, note: `qty ${fmt(i.qty)} · ${i.workers} worker${i.workers === 1 ? "" : "s"}` }));
  const deptData = s.departments.slice(0, 10).map((d) => ({ name: d.label, value: d.issues, note: `${d.items} item${d.items === 1 ? "" : "s"} · ${d.workers} worker${d.workers === 1 ? "" : "s"}` }));
  const noteOf = (row: Record<string, unknown>) => (typeof row.note === "string" ? row.note : null);

  const itemRows = s.items.map((i) => ({ Item: i.item, "Hand-outs": i.issues, Qty: i.qty, Workers: i.workers }));
  const deptRows = s.departments.map((d) => ({ Department: d.label, "Hand-outs": d.issues, Items: d.items, Workers: d.workers }));
  const workerRows = s.workers.map((w) => ({ "Emp ID": w.empId, Worker: w.name, "Hand-outs": w.issues, Items: w.items, Departments: w.departments }));
  const matrixRows = s.matrix.items.map((item, i) => ({
    Item: item,
    ...Object.fromEntries(s.matrix.departments.map((d, j) => [d.label, s.matrix.qty[i][j]])),
  }));
  const cellMax = Math.max(0, ...s.matrix.qty.flat());
  const perDay = s.timeline.unit === "day" ? s.totals.issues / s.timeline.buckets.length : null;
  const busiest = [...s.timeline.buckets].sort((a, b) => b.issues - a.issues)[0];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Stat label="Hand-outs" value={fmt(s.totals.issues)} delta={<Delta cur={s.totals.issues} prev={s.previousIssues} />} />
        <Stat label="Items" value={fmt(s.totals.items)} sub={s.items[0] ? `most: ${s.items[0].item}` : undefined} />
        <Stat label="Workers served" value={fmt(s.totals.workers)} sub={s.workers[0] ? `most: ${s.workers[0].name}` : undefined} />
        <Stat label="Departments" value={fmt(s.totals.departments)} sub={s.departments[0] ? `most: ${s.departments[0].label}` : undefined} />
      </div>

      <Card
        title={s.timeline.unit === "hour" ? "Hand-outs by hour" : "Hand-outs per day"}
        sub={[
          perDay !== null ? `${fmt(Math.round(perDay * 10) / 10)} a day on average` : null,
          busiest && busiest.issues > 0 ? `busiest ${s.timeline.unit === "hour" ? "hour" : "day"}: ${busiest.label} (${fmt(busiest.issues)})` : null,
        ].filter(Boolean).join(" · ")}
      >
        <Timeline s={s} />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="Top items"
          sub={`By hand-outs${s.items.length > 10 ? ` — 10 of ${s.items.length}` : ""}; the quantity is in the tooltip and the table`}
          right={<ExportButton rows={itemRows} filename={`consumables-items-${period}.xlsx`} sheetName="Items" />}
        >
          <Ranked data={itemData} unit="hand-outs" extra={noteOf} />
        </Card>
        <Card
          title="By department"
          sub="Hand-outs per department"
          right={<ExportButton rows={deptRows} filename={`consumables-departments-${period}.xlsx`} sheetName="Departments" />}
        >
          <Ranked data={deptData} unit="hand-outs" extra={noteOf} />
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="Workers who take the most"
          sub={`Top ${s.workers.length} by hand-outs`}
          right={<ExportButton rows={workerRows} filename={`consumables-workers-${period}.xlsx`} sheetName="Workers" />}
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr><th className={TH}>#</th><th className={TH}>Worker</th><th className={`${TH} text-right`}>Hand-outs</th><th className={`${TH} text-right`}>Items</th><th className={TH}>Departments</th></tr>
              </thead>
              <tbody className="divide-y">
                {s.workers.map((w, i) => (
                  <tr key={w.workerId}>
                    <td className={`${TD} text-muted tabnum`}>{i + 1}</td>
                    <td className={TD}><b>{w.name}</b> <span className="text-xs text-muted ltr">{w.empId}</span></td>
                    <td className={`${TD} text-right tabnum font-bold`}>{fmt(w.issues)}</td>
                    <td className={`${TD} text-right tabnum`}>{fmt(w.items)}</td>
                    <td className={`${TD} text-xs text-muted`}>{w.departments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Where each item goes"
          sub="Quantity handed out, item by department — the darker, the more"
          right={<ExportButton rows={matrixRows} filename={`consumables-by-department-${period}.xlsx`} sheetName="Item x department" />}
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <th className={TH}>Item</th>
                  {s.matrix.departments.map((d) => (
                    <th key={d.department} className="px-2 py-1.5 text-right text-xs font-bold text-muted align-bottom leading-tight">{d.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.matrix.items.map((item, i) => (
                  <tr key={item}>
                    <td className={`${TD} font-semibold min-w-[9rem]`}>{item}</td>
                    {s.matrix.qty[i].map((q, j) => (
                      <td
                        key={j}
                        className={`${TD} text-right tabnum`}
                        style={q > 0 && cellMax > 0 ? { background: `color-mix(in srgb, var(--viz-1) ${Math.round(8 + (q / cellMax) * 34)}%, transparent)` } : undefined}
                      >
                        {q > 0 ? fmt(q) : <span className="text-muted">·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
