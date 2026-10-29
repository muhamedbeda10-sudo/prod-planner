"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { ChartCard, Legend, TipBox, fmt, type TableRow } from "@/components/charts/kit";
import { PlotText, textWidth } from "@/components/charts/labels";

export { PlotText, textWidth };
import { ExportButton } from "@/components/ExportButton";
import { ChartZoom } from "@/components/charts/zoom";
import type { AiTone } from "@/lib/domain/aiChart";

// The frame every chart in an AI answer sits in — the dashboards' card, its
// numbers with their export (and kept for a right-click's "Ask AI"), and a
// legend under it when it carries more than one series. The tooltips' shell, and the values written on the marks,
// shared by every form.

export const TICK = { fontSize: 11, fill: "var(--muted)" } as const;

/** " pcs" after a number, or nothing. */
export const unitOf = (unit: string) => (unit ? ` ${unit}` : "");

export const valueText = (v: number, unit: string) => `${fmt(v)}${unitOf(unit)}`;

/** Inside a page's own card (its title and its numbers already there), a
 *  chart draws without a frame of its own. */
export const FramelessChart = createContext(false);

const fileOf = (title: string) => title.replace(/[^\w؀-ۿ -]+/g, "").slice(0, 60) || "ai-chart";

export function ChartFrame({
  title,
  sub,
  rows,
  legend,
  children,
}: {
  title: string;
  sub?: ReactNode;
  /** The chart's numbers — its export. */
  rows: TableRow[];
  legend?: { label: string; color: string; line?: boolean }[];
  children: ReactNode;
}) {
  const frameless = useContext(FramelessChart);
  if (frameless) {
    return (
      <>
        <ChartZoom>{children}</ChartZoom>
        {legend && legend.length > 1 && <div className="mt-2"><Legend items={legend} /></div>}
      </>
    );
  }
  return (
    <ChartCard
      title={title || "Chart"} sub={sub ? <span dir="auto">{sub}</span> : undefined} className="my-3 not-prose ai-chart" data={rows}
      right={<ExportButton rows={rows} filename={fileOf(title)} sheetName="Data" label="Export" />}
    >
      <ChartZoom>{children}</ChartZoom>
      {legend && legend.length > 1 && (
        <div className="mt-2">
          <Legend items={legend} />
        </div>
      )}
    </ChartCard>
  );
}

/** A tooltip of one mark or one x: its title and its values, the value first. */
export function Tip({ title, rows }: { title: string; rows: { label: string; value: string; color?: string; line?: boolean }[] }) {
  return <TipBox title={title} rows={rows} />;
}

/** What a recharts tooltip hands its content. */
export type TipProps = {
  active?: boolean;
  payload?: readonly { name?: unknown; value?: unknown; color?: string; dataKey?: unknown; payload?: Record<string, unknown> }[];
  label?: unknown;
};

const TONE = {
  ok: { icon: CheckCircle2, cls: "text-ok-fg", label: "Good" },
  warn: { icon: AlertTriangle, cls: "text-warn-fg", label: "Watch" },
  bad: { icon: XCircle, cls: "text-bad-fg", label: "Problem" },
} as const;

/** A status, never by colour alone: its icon, and its name for a screen reader. */
export function ToneIcon({ tone, size = 13 }: { tone: AiTone | null; size?: number }) {
  if (!tone) return null;
  const t = TONE[tone];
  return <t.icon size={size} className={`${t.cls} shrink-0`} aria-label={t.label} />;
}

/** The rendered width of an element, kept up to date. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

// ---------------------------------------------------------------- values on the marks


/** The room each of `count` categories has across a plot `width` wide, less
 *  what its axis and margins take (`aside`); 600 before the width is measured. */
export const perSlot = (width: number, count: number, aside = 60) => Math.max(0, (width || 600) - aside) / Math.max(1, count);

/** Every one of `texts` fits over its own category, with `pad` to spare. */
export const fits = (width: number, texts: readonly string[], pad = 0) => perSlot(width, texts.length) >= Math.max(0, ...texts.map(textWidth)) + pad;

type Box = { x: number; y: number; width: number; height: number };
/** What recharts hands a label's content: the mark's box, its value and its index. */
type MarkLabelProps = { viewBox?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; value?: unknown; index?: number };

/** The mark's box, its width and height made positive. */
function boxOf(p: MarkLabelProps): Box {
  const v = (p.viewBox && typeof p.viewBox === "object" ? p.viewBox : p) as Record<string, unknown>;
  const n = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : Number(p[k as keyof MarkLabelProps]) || 0);
  const x = n("x");
  const y = n("y");
  const w = n("width");
  const h = n("height");
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), width: Math.abs(w), height: Math.abs(h) };
}

/** A label's words for the mark at `index` with `value` — or null for none. */
type LabelTextOf = (value: number, index: number) => string | null;

/** A value at a bar's tip: past its end on a bar, over its cap on a column —
 *  on the other side of the baseline for a value below zero (`signOf` gives
 *  the number whose side counts, e.g. a stack's total, when it is not the mark's own). */
export function tipLabel(horizontal: boolean, text: LabelTextOf, signOf?: (index: number) => number) {
  function TipLabel(p: MarkLabelProps) {
    const own = Number(p.value);
    const t = Number.isFinite(own) ? text(own, p.index ?? 0) : null;
    if (!t) return null;
    const neg = (signOf ? signOf(p.index ?? 0) : own) < 0;
    const b = boxOf(p);
    return horizontal
      ? <PlotText x={neg ? b.x - 5 : b.x + b.width + 5} y={b.y + b.height / 2} dy="0.35em" textAnchor={neg ? "end" : "start"} fontWeight={600}>{t}</PlotText>
      : <PlotText x={b.x + b.width / 2} y={neg ? b.y + b.height + 13 : b.y - 5} textAnchor="middle" fontWeight={600}>{t}</PlotText>;
  }
  return TipLabel;
}

/** A value inside its segment of a stack, in the ink that clears its fill —
 *  only where it fits whole; the legend, tooltip and table carry the rest. */
export function insideLabel(ink: string, text: LabelTextOf) {
  function InsideLabel(p: MarkLabelProps) {
    // a stack hands over a segment's [from, to] as its value
    const v = Array.isArray(p.value) ? Number(p.value[1]) - Number(p.value[0]) : Number(p.value);
    const t = text(v, p.index ?? 0);
    if (!t) return null;
    const b = boxOf(p);
    if (b.width < textWidth(t) + 6 || b.height < 15) return null;
    return <text x={b.x + b.width / 2} y={b.y + b.height / 2} dy="0.35em" textAnchor="middle" fontSize={11} fontWeight={600} fill={ink}>{t}</text>;
  }
  return InsideLabel;
}

/** A value over a point of a line — under it where another series runs
 *  above it there; the first and last points' values lean inwards, clear of
 *  the axis and the edge. */
export function pointLabel(below: (index: number) => boolean, text: LabelTextOf, count: number) {
  function PointLabel(p: MarkLabelProps) {
    const k = p.index ?? 0;
    const v = Number(Array.isArray(p.value) ? p.value[1] : p.value);
    const t = Number.isFinite(v) ? text(v, k) : null;
    if (!t) return null;
    const b = boxOf(p);
    const anchor = count > 1 && k === 0 ? "start" : count > 1 && k === count - 1 ? "end" : "middle";
    return (
      <PlotText x={b.x + b.width / 2 + (anchor === "start" ? -3 : anchor === "end" ? 3 : 0)} y={below(k) ? b.y + b.height + 16 : b.y - 8} textAnchor={anchor} fontWeight={600}>
        {t}
      </PlotText>
    );
  }
  return PointLabel;
}

/** A name beside a dot of a scatter. */
export function sideLabel(text: (index: number) => string | null) {
  function SideLabel(p: MarkLabelProps) {
    const t = text(p.index ?? 0);
    if (!t) return null;
    const b = boxOf(p);
    return <PlotText x={b.x + b.width + 4} y={b.y + b.height / 2} dy="0.35em" fill="var(--muted)">{t}</PlotText>;
  }
  return SideLabel;
}


