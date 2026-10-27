"use client";

import type { SVGProps } from "react";
import { fmt, pct } from "@/components/charts/kit";

// The numbers written on a stacked column's marks, the same on every chart:
// each segment's figure inside it where it fits — with its share of the
// column under it when `share` asks and the segment is tall enough — and the
// column's total on its cap. Recharts' LabelList draws them: a `*Value`
// accessor says what each label reads, a `*Label` content draws it.
//
// The column is read off the label's own entry, never its index: recharts
// leaves a zero-height segment out of the label list, so an index would drift
// onto the wrong column.
//
// Also the halo and the width rule every value written on a plot shares (the
// assistant's charts too, components/AiChartFrame).

type Row = Record<string, unknown>;
type Entry = { payload?: Row };
export type LabelBox = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown };

/** Room a chart gives over its columns for the totals on their caps. */
export const LABEL_HEADROOM = 20;

/** About how wide a value written at 11px is. */
export const textWidth = (text: string) => text.length * 6.4 + 2;
/** The same in bold — the figures on the marks. */
const boldWidth = (text: string) => textWidth(text) * 1.1;

/** A value written on the plot: the surface's colour drawn under the
 *  letters keeps it readable over grid lines, lines and other marks. */
export const HALO = { stroke: "var(--surface)", strokeWidth: 3, paintOrder: "stroke", strokeLinejoin: "round" } as const;

/** Text drawn on a plot (or an SVG of our own: a dial, a flow), with the halo. */
export function PlotText({ children, ...rest }: SVGProps<SVGTextElement>) {
  return <text fontSize={11} fill="var(--foreground)" pointerEvents="none" {...HALO} {...rest}>{children}</text>;
}

/** Between a segment's figure and its share, inside the label's value. */
const SEP = "\n";
const num = (r: Row, k: string) => Number(r[k] ?? 0) || 0;

/** What a segment's label reads: its figure, and with `share` its part of the column. */
export function segmentValue(key: string, keys: readonly string[], { format = fmt, share = false }: { format?: (v: number) => string; share?: boolean } = {}) {
  return (entry: Entry) => {
    const r = entry.payload;
    const v = r ? num(r, key) : 0;
    if (!r || v <= 0) return "";
    const total = share ? keys.reduce((s, k) => s + num(r, k), 0) : 0;
    return total > 0 ? `${format(v)}${SEP}${pct(v / total)}` : format(v);
  };
}

/** The figure inside a segment, in the ink that clears its fill — only where
 *  it fits, with a little air; its share on a second line where that fits too.
 *  `fill` (the segment's own) rings the figure, so a line drawn across the
 *  column passes behind it. */
export function segmentLabel(ink: string, fill?: string) {
  const SegmentLabel = (p: LabelBox) => {
    const [fig, share] = String(p.value ?? "").split(SEP);
    const w = Number(p.width ?? 0), h = Number(p.height ?? 0);
    if (!fig || h < 14 || w < boldWidth(fig) + 4) return null;
    const x = Number(p.x) + w / 2, mid = Number(p.y) + h / 2;
    const two = !!share && h >= 30 && w >= boldWidth(share) + 4;
    return (
      <text x={x} textAnchor="middle" fontSize={11} fontWeight={700} fill={ink} pointerEvents="none" {...(fill ? { ...HALO, stroke: fill } : {})}>
        {two ? (
          <>
            <tspan x={x} y={mid - 1.5}>{fig}</tspan>
            <tspan x={x} y={mid + 10} fontSize={10} fontWeight={600}>{share}</tspan>
          </>
        ) : <tspan x={x} y={mid + 4}>{fig}</tspan>}
      </text>
    );
  };
  return SegmentLabel;
}

/** A label written once per column, by whichever segment is on top that day
 *  (or, `at: "foot"`, at its foot — standing on the axis): `read` says what
 *  it reads from the column's row. */
export function onColumn(key: string, keys: readonly string[], read: (row: Row) => string | number, at: "top" | "foot" = "top") {
  const order = at === "top" ? [...keys].reverse() : keys;
  return (entry: Entry) => {
    const r = entry.payload;
    if (!r) return "";
    const end = order.find((k) => num(r, k) > 0);
    return end === key ? read(r) : "";
  };
}

/** What the column's total reads. */
export function stackTotalValue(key: string, keys: readonly string[], format: (v: number) => string = fmt) {
  return onColumn(key, keys, (r) => format(keys.reduce((s, k) => s + num(r, k), 0)));
}

/** Whether a figure fits over a column `w` wide: its slot is the bar and the
 *  gaps beside it, at least 1.3 times the bar. */
export const fitsColumn = (w: number, text: string) => w * 1.3 >= boldWidth(text);

/** The column's total on its cap, haloed so a line drawn across it does not
 *  hide it; left off a column too narrow to hold it. */
export function TotalLabel(p: LabelBox) {
  const t = String(p.value ?? "");
  const w = Number(p.width ?? 0);
  if (!t || !fitsColumn(w, t)) return null;
  return <PlotText x={Number(p.x) + w / 2} y={Number(p.y) - 5} textAnchor="middle" fontWeight={700}>{t}</PlotText>;
}
