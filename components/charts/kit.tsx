"use client";

import { Table2 } from "lucide-react";
import { EmptyState } from "@/components/primitives";

import { useState } from "react";
import { ExportButton } from "@/components/ExportButton";

// The dashboards' shared parts, so every dashboard reads the same way:
//
//  - colours: the palette's first SIX categorical slots (validated light and
//    dark — slots 7 and 8 are too close to 6 for a legend to separate), then
//    "Other" in the neutral. A series keeps its slot for the whole view.
//  - a card whose chart has a Table twin one click away, with its export —
//    the chart is never the only way to read a number;
//  - stat tiles with a sparkline or a meter; a legend; a tooltip shell;
//    a heatmap in one hue, light → dark; data bars for tables.

export const CAT = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"] as const;
export const OTHER = "var(--viz-other)";
/** Ink that clears contrast INSIDE each categorical fill (slot order), then Other. */
export const INK_ON = ["#ffffff", "#ffffff", "#14201a", "#ffffff", "#14201a", "#14201a"] as const;
export const INK_ON_OTHER = "#14201a";

/** The lighter track of the accent a meter, progress bar or dial fills. */
export const TRACK = "color-mix(in srgb, var(--viz-1) 16%, var(--surface))";

export const catColor = (i: number) => (i >= 0 && i < CAT.length ? CAT[i] : OTHER);
export const catInk = (i: number) => (i >= 0 && i < INK_ON.length ? INK_ON[i] : INK_ON_OTHER);

export const fmt = (n: number, digits = 3) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: digits }));
export const pct = (f: number, digits = 0) => `${(f * 100).toFixed(digits)}%`;
/** 1,284 · 12.9K · 4.2M — for big standalone numbers. */
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const compact = (n: number) => (Math.abs(n) < 10_000 ? fmt(Math.round(n * 10) / 10, 1) : COMPACT.format(n));

// ---------------------------------------------------------------- cards

export type TableRow = Record<string, string | number>;

export function ChartCard({
  title,
  sub,
  right,
  table,
  className = "",
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  /** The chart's numbers as a table — a Chart | Table switch and an export. */
  table?: { rows: TableRow[]; filename: string; sheet?: string };
  className?: string;
  children: React.ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`bg-surface border rounded-xl p-4 min-w-0 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 className="font-bold leading-tight">{title}</h2>
          {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
        </div>
        <div className="flex items-center gap-2 no-print">
          {right}
          {table && (
            <>
              <nav className="seg" aria-label={`${title}: chart or table`}>
                <button type="button" className={asTable ? "" : "on"} onClick={() => setAsTable(false)}>Chart</button>
                <button type="button" className={asTable ? "on" : ""} onClick={() => setAsTable(true)}>Table</button>
              </nav>
              {asTable && <ExportButton rows={table.rows} filename={table.filename} sheetName={table.sheet ?? "Sheet1"} label="Export" />}
            </>
          )}
        </div>
      </div>
      {table && asTable ? <DataTable rows={table.rows} /> : children}
    </section>
  );
}

/** A plain table of records: numbers right-aligned in tabular figures. */
export function DataTable({ rows, max = 400 }: { rows: TableRow[]; max?: number }) {
  if (rows.length === 0) return <EmptyState compact icon={Table2} title="Nothing to show" />;
  const cols = Object.keys(rows[0]);
  const numeric = cols.map((c) => rows.every((r) => typeof r[c] === "number"));
  return (
    <div className="overflow-auto max-h-[420px]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface border-b">
          <tr>{cols.map((c, i) => <th key={c} className={`px-2 py-1.5 text-xs font-bold text-muted whitespace-nowrap ${numeric[i] ? "text-right" : "text-left"}`}>{c}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.slice(0, max).map((r, k) => (
            <tr key={k}>
              {cols.map((c, i) => (
                <td key={c} className={`px-2 py-1.5 ${numeric[i] ? "text-right tabnum" : ""}`}>{typeof r[c] === "number" ? fmt(r[c] as number) : r[c]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <p className="text-xs text-muted mt-1">First {max} of {rows.length} rows — the export has them all.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- figures

/** A 12-ish point trend in the de-emphasis ink, the last point in the accent. */
export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lastX = (values.length - 1) * step;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--viz-other)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={y(values.at(-1)!)} r={3} fill="var(--viz-1)" stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  );
}

/** A single ratio against its whole: the fill in the accent on a lighter
 *  track of the same hue. */
export function Meter({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="w-full" title={label}>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: "var(--viz-1)" }} />
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  delta,
  spark,
  meter,
  hero,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  spark?: number[];
  meter?: number;
  /** The one number the dashboard leads with. */
  hero?: boolean;
}) {
  return (
    <div className={`bg-surface border rounded-xl px-4 py-3 min-w-[10.5rem] flex-1 flex flex-col gap-1 ${hero ? "sm:min-w-[15rem]" : ""}`}>
      <div className="text-xs font-bold text-muted">{label}</div>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <div className={`${hero ? "text-[44px]" : "text-[28px]"} min-w-0 [overflow-wrap:anywhere] font-semibold leading-none ltr`}>{value}</div>
        {spark && <Sparkline values={spark} />}
      </div>
      {meter !== undefined && <Meter value={meter} />}
      <div className="flex flex-wrap items-baseline gap-x-2 min-h-[1rem]">
        {delta}
        {sub && <span className="text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/** "▲ 12% vs the period before (40)" — direction only; whether up is good
 *  depends on the measure, so the caller picks `tone`. */
export function Delta({ pct: p, before, tone = "neutral" }: { pct: number | null; before: number; tone?: "neutral" | "upGood" | "upBad" }) {
  if (p === null) return <span className="text-xs text-muted">none in the period before</span>;
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "•";
  const good = tone === "neutral" || p === 0 ? null : (p > 0) === (tone === "upGood");
  const cls = good === null ? "" : good ? "text-ok-fg" : "text-bad-fg";
  return (
    <span className={`text-xs font-bold ${cls}`} title={`Period before: ${fmt(before)}`}>
      {arrow} {Math.abs(p)}% <span className="font-normal text-muted">vs the period before ({fmt(before)})</span>
    </span>
  );
}

// ---------------------------------------------------------------- legend & tooltip

export function Legend({ items }: { items: { label: string; color: string; value?: string; line?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className={it.line ? "inline-block w-4 h-0.5 rounded" : "inline-block w-2.5 h-2.5 rounded-sm"}
            style={{ background: it.color }}
            aria-hidden
          />
          <span>{it.label}</span>
          {it.value && <span className="font-bold tabnum">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export function TipBox({ title, rows }: { title: React.ReactNode; rows: { label: string; value: string; color?: string; line?: boolean }[] }) {
  return (
    <div className="bg-surface border rounded-lg shadow-md px-3 py-2 text-xs min-w-[10rem] max-w-[18rem]">
      <div className="font-bold mb-1">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          {r.color && <span className={r.line ? "inline-block w-3 h-0.5 rounded" : "inline-block w-2 h-2 rounded-sm"} style={{ background: r.color }} />}
          <span className="text-muted flex-1">{r.label}</span>
          <span className="font-extrabold tabnum ltr">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- heatmap & data bars

/** Background for a value on the one-hue scale: light (little) → dark (much). */
export function heat(v: number, max: number): { background?: string; color?: string } {
  if (v <= 0 || max <= 0) return {};
  const f = v / max;
  const mix = Math.round(10 + f * 80);
  return { background: `color-mix(in srgb, var(--viz-1) ${mix}%, var(--surface))`, color: mix > 55 ? "#ffffff" : undefined };
}

/**
 * A grid of cells in one hue — how much, where two dimensions cross. Every
 * cell carries its number (or a dot for none) and a tooltip; `totals` adds a
 * row and a column of sums.
 */
export function Heatmap({
  rows,
  cols,
  values,
  format = (v) => fmt(v),
  totals = false,
  cellTitle,
  rowHead = "",
  compactCells = false,
  scale = "all",
}: {
  rows: string[];
  cols: string[];
  values: number[][];
  format?: (v: number) => string;
  /** true: a Total column AND row; "rows": the Total column only — for a grid
   *  whose columns must not be added across (different units per row). */
  totals?: boolean | "rows";
  cellTitle?: (r: number, c: number, v: number) => string;
  rowHead?: string;
  /** Narrow cells with no number — for a wide grid like weekday × hour. */
  compactCells?: boolean;
  /** "row": each row shaded against its own largest cell — for rows in
   *  different units, where one grid-wide scale would drown the small ones. */
  scale?: "all" | "row";
}) {
  const max = Math.max(0, ...values.flat());
  const rowMax = values.map((r) => Math.max(0, ...r));
  const rowSum = values.map((r) => r.reduce((a, b) => a + b, 0));
  const colSum = cols.map((_, j) => values.reduce((a, r) => a + (r[j] ?? 0), 0));
  const cellCls = compactCells ? "h-8 min-w-[1.6rem] text-[10px]" : "px-2 py-1.5 text-sm";
  return (
    <div className="overflow-x-auto">
      <table className={`border-separate ${compactCells ? "w-full" : ""}`} style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th className="px-2 text-left text-xs font-bold text-muted">{rowHead}</th>
            {cols.map((c) => <th key={c} className="px-1 text-xs font-bold text-muted text-center align-bottom leading-tight whitespace-nowrap">{c}</th>)}
            {totals && <th className="px-2 text-xs font-bold text-muted text-right">Total</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r}>
              <th scope="row" className="px-2 text-left text-xs font-semibold whitespace-nowrap max-w-[14rem] truncate" title={r}>{r}</th>
              {values[i].map((v, j) => (
                <td
                  key={j}
                  className={`${cellCls} rounded text-center tabnum hover:outline hover:outline-2 hover:outline-[var(--foreground)]`}
                  style={v > 0 ? heat(v, scale === "row" ? rowMax[i] : max) : { background: "var(--surface-2)" }}
                  title={cellTitle ? cellTitle(i, j, v) : `${r} · ${cols[j]}: ${format(v)}`}
                >
                  {compactCells ? "" : v > 0 ? format(v) : <span className="text-muted">·</span>}
                </td>
              ))}
              {totals && <td className="px-2 text-sm text-right tabnum font-bold">{format(rowSum[i])}</td>}
            </tr>
          ))}
          {totals === true && (
            <tr>
              <th scope="row" className="px-2 text-left text-xs font-bold text-muted">Total</th>
              {colSum.map((v, j) => <td key={j} className="px-2 text-sm text-center tabnum font-bold">{format(v)}</td>)}
              <td className="px-2 text-sm text-right tabnum font-extrabold">{format(rowSum.reduce((a, b) => a + b, 0))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A number with a thin bar behind it, for ranking columns in a table. */
export function DataBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 min-w-[7rem]">
      <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: "var(--viz-1)" }} />
      </div>
      <span className="tabnum font-bold text-sm w-10 text-right">{label ?? fmt(value)}</span>
    </div>
  );
}

/** Scale legend for a heatmap: "less ▭▭▭▭▭ more". */
export function HeatScale({ max, format = (v: number) => fmt(v) }: { max: number; format?: (v: number) => string }) {
  const steps = [0.2, 0.4, 0.6, 0.8, 1];
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted">
      <span>less</span>
      {steps.map((s) => <span key={s} className="inline-block w-5 h-2.5 rounded-sm" style={heat(s * max, max)} />)}
      <span>more{max > 0 ? ` (max ${format(max)})` : ""}</span>
    </div>
  );
}
