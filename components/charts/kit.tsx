"use client";

import Link from "next/link";
import { Badge } from "@/components/Badge";
import { ChartAbout } from "@/components/ChartAbout";
import { TableFrame, Th } from "@/components/DataTable";
import { aiTargetRef } from "@/lib/aiTarget";
import { formatFigure, formatShare } from "@/lib/domain/format";

// The dashboards' shared parts, so every dashboard reads the same way:
//
//  - colours: the palette's first SIX categorical slots (validated light and
//    dark — slots 7 and 8 are too close to 6 for a legend to separate), then
//    "Other" in the neutral. A series keeps its slot for the whole view.
//  - a card that carries only its title and its chart: what it means and
//    how it is counted (`about`) opens from its title (ChartAbout), and with
//    its numbers (`data`) goes to the assistant on "Ask AI" (lib/aiTarget);
//  - stat tiles with a sparkline or a meter; a legend; a tooltip shell;
//    a heatmap in one hue, light → dark; data bars for tables.

export const CAT = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"] as const;
export const OTHER = "var(--viz-other)";
/** Ink that clears contrast INSIDE each categorical fill (slot order), then
 *  Other — the theme's own (--viz-N-ink), since the dark series are mid-tones
 *  that white no longer clears. */
export const INK_ON = ["var(--viz-1-ink)", "var(--viz-2-ink)", "var(--viz-3-ink)", "var(--viz-4-ink)", "var(--viz-5-ink)", "var(--viz-6-ink)"] as const;
export const INK_ON_OTHER = "var(--viz-other-ink)";

/** The lighter track of the accent a meter, progress bar or dial fills. */
export const TRACK = "color-mix(in srgb, var(--viz-1) 16%, var(--surface))";

/** Text in a status's own ink — always beside a word that says the same. */
export const TONE_TEXT = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg" } as const;
/** A cell filled in a status's own colours — a heatmap's band, with its number on it. */
export const TONE_CELL = { ok: "bg-ok-bg text-ok-fg", warn: "bg-warn-bg text-warn-fg", bad: "bg-bad-bg text-bad-fg" } as const;

export const catColor = (i: number) => (i >= 0 && i < CAT.length ? CAT[i] : OTHER);
export const catInk = (i: number) => (i >= 0 && i < INK_ON.length ? INK_ON[i] : INK_ON_OTHER);

export const fmt = formatFigure;
export const pct = formatShare;
/** A rate, or a dash where there is none. */
export const pctOrDash = (v: number | null | undefined) => (v === null || v === undefined ? "—" : pct(v));
/** A difference with its sign: "+2.5" or "−1" (a plain minus is the number's own). */
export const signed = (v: number, digits = 1) => (v > 0 ? `+${fmt(v, digits)}` : fmt(v, digits));
/** 1,284 · 12.9K · 4.2M — for big standalone numbers. */
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const compact = (n: number) => (Math.abs(n) < 10_000 ? fmt(Math.round(n * 10) / 10, 1) : COMPACT.format(n));

// ---------------------------------------------------------------- cards

export type TableRow = Record<string, string | number>;

export function ChartCard({
  title,
  sub,
  about,
  data,
  right,
  table = false,
  className = "",
  children,
}: {
  title: string;
  /** A short caption under the title — an AI answer's chart's own. The
   *  dashboards say nothing more on screen: what they would say is `about`. */
  sub?: React.ReactNode;
  /** What the card shows and how it is counted, for the assistant's "Ask AI". */
  about?: string;
  /** The chart's numbers, for the assistant's "Ask AI". */
  data?: TableRow[];
  right?: React.ReactNode;
  /** The chart's numbers (`data`) as a table under it, a click away — the
   *  same rows the chart draws, so the two cannot disagree. */
  table?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = aiTargetRef({ kind: "chart", title, about, rows: data });
  return (
    <section ref={ref} className={`bg-surface border rounded-xl p-4 min-w-0 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 className="font-bold leading-tight"><ChartAbout title={title} about={about} /></h2>
          {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
        </div>
        {right && <div className="flex items-center gap-2 no-print">{right}</div>}
      </div>
      {children}
      {table && data && data.length > 0 && <ChartTable title={title} rows={data} />}
    </section>
  );
}

/** A chart's rows as a plain table, folded under the chart. */
export function ChartTable({ title, rows }: { title: string; rows: TableRow[] }) {
  const cols = Object.keys(rows[0] ?? {});
  // a column is numeric when every filled cell is a number
  const num = new Set(cols.filter((c) => rows.every((r) => typeof r[c] === "number" || r[c] === "")));
  return (
    <details className="mt-3 group">
      <summary className="text-xs font-semibold text-muted cursor-pointer select-none hover:text-foreground w-fit">Table · {rows.length} row{rows.length === 1 ? "" : "s"}</summary>
      <TableFrame className="mt-2 max-h-80 border rounded-lg">
        <table className="w-full text-sm" aria-label={`${title} — table`}>
          <thead>
            <tr>{cols.map((c) => <Th key={c} label={c} num={num.has(c)} />)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => <td key={c} className={`px-2 ${num.has(c) ? "text-right tabnum" : ""}`}>{typeof r[c] === "number" ? fmt(r[c] as number, 2) : r[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </details>
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

/** A tile: its name with the change beside it, the figure, then at most one
 *  short line. What it means and how it is counted (`about`) is the
 *  assistant's to say — right-click, "Ask AI". */
export function StatTile({
  label,
  value,
  sub,
  delta,
  spark,
  meter,
  hero,
  compact,
  about,
  href,
  onClick,
}: {
  label: string;
  value: string;
  /** One short line — cut to the tile's width, the whole of it on hover. */
  sub?: React.ReactNode;
  /** A <DeltaChip>, beside the name. */
  delta?: React.ReactNode;
  spark?: number[];
  meter?: number;
  /** The one number the dashboard leads with. */
  hero?: boolean;
  /** A small figure inside a card, not a tile of the page's own row. */
  compact?: boolean;
  /** What the figure means and how it is counted, for "Ask AI". */
  about?: string;
  /** Where the rows behind the figure open — the tile becomes a link to them. */
  href?: string;
  /** With `href`: run instead of navigating when it calls preventDefault (a popup opened in place). */
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const ref = aiTargetRef({ kind: "figure", title: label, about });
  const cls = `bg-surface border ${compact ? "rounded-lg px-3 py-2 min-w-[8rem] gap-1" : "rounded-xl px-4 py-3 min-w-[10.5rem] gap-2"} flex-1 flex flex-col ${hero ? "sm:min-w-[15rem]" : ""}`;
  const body = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="text-xs font-bold text-muted leading-tight">{label}</div>
        {delta && <div className="shrink-0 -mt-0.5">{delta}</div>}
      </div>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <div className={`${compact ? "text-xl leading-tight" : hero ? "text-[length:calc(var(--fs-kpi)*1.45)] leading-none" : "text-[length:var(--fs-kpi)] leading-none"} min-w-0 [overflow-wrap:anywhere] font-semibold tabnum ltr`}>{value}</div>
        {spark && <Sparkline values={spark} />}
      </div>
      {meter !== undefined && <Meter value={meter} />}
      {sub && <div className="text-xs text-muted truncate" title={typeof sub === "string" ? sub : undefined}>{sub}</div>}
    </>
  );
  return href
    ? <Link ref={ref} href={href} onClick={onClick} scroll={false} className={`${cls} text-foreground hover:border-brand transition-colors`}>{body}</Link>
    : <div ref={ref} className={cls}>{body}</div>;
}

/** A change against an earlier reading, as a share of it ("▲ 12%") — "N/A"
 *  where there is no earlier reading or it was zero: nothing to read it on. */
export function RelativeChip({ value, up, title }: { value: number | null; up?: "good" | "bad"; title: string }) {
  if (value === null) return <Badge tone="neutral" title={title}>N/A</Badge>;
  return <DeltaChip value={Math.round(value * 100)} unit="%" up={up} title={title} />;
}

/** The change chip of a figure no earlier reading is kept of: "N/A", never a guessed trend. */
export const NO_BASE = <RelativeChip value={null} title="No earlier reading of this figure is kept to compare with" />;


/** A change as a badge — "▲ 3 pts", "▼ 12%", "• 0" — green where it is
 *  good news, red where bad, grey where `up` does not say (or nothing moved);
 *  what it is measured against on hover. */
export function DeltaChip({ value, unit = "", up, title }: { value: number; unit?: string; up?: "good" | "bad"; title?: string }) {
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "•";
  const tone = !up || value === 0 ? "neutral" : (value > 0) === (up === "good") ? "success" : "danger";
  return <Badge tone={tone} title={title} className="tabnum">{arrow} {fmt(Math.abs(value), 1)}{unit}</Badge>;
}

/** "▲ 12%" against the period before — direction only; whether up is good
 *  depends on the measure, so the caller picks `tone`. Nothing where there
 *  was nothing before. */
export function Delta({ pct: p, before, tone = "neutral" }: { pct: number | null; before: number; tone?: "neutral" | "upGood" | "upBad" }) {
  if (p === null) return null;
  return <DeltaChip value={p} unit="%" up={tone === "upGood" ? "good" : tone === "upBad" ? "bad" : undefined} title={`Against the period before: ${fmt(before)}`} />;
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

/** One row of a bullet chart: the bar is what there is, the tick is where it should be. */
export function Bullet({ label, value, target, max, text, tone }: { label: string; value: number; target: number | null; max: number; text: React.ReactNode; tone?: "ok" | "warn" | "bad" | null }) {
  const w = (v: number) => `${Math.max(0, Math.min(1, max > 0 ? v / max : 0)) * 100}%`;
  return (
    <div>
      <div className="flex flex-wrap justify-between gap-x-3 text-sm mb-1">
        <span className="font-semibold">{label}</span>
        <span className={`tabnum ${tone ? TONE_TEXT[tone] : ""}`}>{text}</span>
      </div>
      <div className="relative h-3 rounded-full" style={{ background: TRACK }} role="img" aria-label={`${label}: ${typeof text === "string" ? text : ""}`}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: w(value), background: "var(--viz-1)" }} />
        {target !== null && <div className="absolute -inset-y-1 w-0.5 rounded bg-foreground" style={{ left: `calc(${w(target)} - 1px)` }} aria-hidden />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- data quality

/** A current reading — what the figure says right now, not over the period. */
export function NowBadge({ title = "As it stands now, not over the period picked" }: { title?: string }) {
  return <Badge tone="info" icon="●" title={title} className="shrink-0">Now</Badge>;
}

export interface QualityItem {
  label: string;
  value: React.ReactNode;
  /** A status word goes with its colour: "partial" marks what is missing. */
  tone?: "ok" | "warn" | "bad";
  title?: string;
}

/**
 * The dashboard's data-quality strip, under the filters: what the figures
 * are read from and how much of it is there — how many records, how many of
 * them can be counted, which rules were used, when it was read. A gap marks
 * the strip "Partial data"; nothing is ever filled in to hide one.
 */
export function DataQualityBar({ items, partial, about }: { items: QualityItem[]; partial: boolean; about?: string }) {
  const ref = aiTargetRef({ kind: "figure", title: "Data quality", about: [about, ...items.map((i) => `${i.label}: ${typeof i.value === "string" || typeof i.value === "number" ? i.value : i.title ?? ""}`)].filter(Boolean).join(" · ") });
  return (
    <section ref={ref} aria-label="Data quality" className="bg-surface border rounded-xl px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <Badge tone={partial ? "warning" : "success"} icon={partial ? "⚠" : "✓"} className="shrink-0">{partial ? "Partial data" : "Complete"}</Badge>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-baseline gap-1 min-w-0" title={i.title}>
          <span className="text-muted">{i.label}</span>
          <b className={`tabnum ${i.tone ? TONE_TEXT[i.tone] : ""}`}>{i.value}</b>
        </span>
      ))}
    </section>
  );
}

/** Under a row of tiles, shut until opened: what each figure is, how it is
 *  counted and what it is read from — the tiles themselves say one line. */
export function MetricNotes({ items, title = "How these are counted" }: { items: { label: string; definition: string; source: string; coverage?: string }[]; title?: string }) {
  return (
    <details className="bg-surface border rounded-xl px-4 py-2 text-sm no-print">
      <summary className="cursor-pointer font-semibold text-muted">{title}</summary>
      <dl className="mt-2 grid gap-x-6 gap-y-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <div key={i.label} className="min-w-0">
            <dt className="font-bold">{i.label}</dt>
            <dd>{i.definition}</dd>
            <dd className="text-muted">Source: {i.source}{i.coverage ? ` · ${i.coverage}` : ""}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
