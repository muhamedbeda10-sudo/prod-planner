"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, LabelList, ReferenceLine,
} from "recharts";
import { Printer } from "lucide-react";
import { ITEMS } from "@/lib/domain/constants";

/* ATC brand chart palette */
const GREEN = "#1a8150"; // brand green
const GREEN_DARK = "#136041";
const GRAY = "#717171"; // brand gray
const GRAY_LIGHT = "#b8c1bc";

/** The report's single quantities chart: today's output per component and
 *  stage, values printed ON the bars, dashed line = the daily target. */
export function OutputByComponentChart({
  cut, welding, painting, target,
}: {
  cut: Record<string, number>;
  welding: Record<string, number>;
  painting: Record<string, number>;
  target: number;
}) {
  const data = ITEMS.map((it) => ({ item: it, Cut: cut[it] ?? 0, Welding: welding[it] ?? 0, Painting: painting[it] ?? 0 }));
  const maxVal = Math.max(target, ...data.flatMap((d) => [d.Cut, d.Welding, d.Painting]));
  const label = (v: unknown) => (typeof v === "number" && v > 0 ? v : "");

  // one chart definition, two sizes: the screen one is responsive (and
  // scrolls on phones), the paper one is rendered at a FIXED width matching
  // the A4-landscape printable area — no CSS scaling tricks that break SVGs.
  // The target line carries NO in-chart label (the card header shows it — a
  // fixed spot that can never collide with a bar), and the print copy skips
  // recharts' auto-measured Legend, which measures 0 in a hidden container
  // and then prints on top of the item names.
  const chart = (size?: { width: number; height: number }, withLegend = true) => (
    <BarChart {...(size ?? {})} data={data} margin={{ top: 28, right: 20, left: 20, bottom: 6 }} barCategoryGap="22%">
      <CartesianGrid strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="item" tick={{ fontSize: 16, fontWeight: 800 }} tickMargin={8} />
      <YAxis hide domain={[0, Math.ceil(maxVal * 1.15)]} />
      <Tooltip />
      {withLegend && <Legend wrapperStyle={{ fontSize: 14, fontWeight: 700, paddingTop: 8 }} iconSize={16} />}
      <ReferenceLine y={target} stroke={GRAY} strokeWidth={1.5} strokeDasharray="7 5" />
      {/* no animation: the values must be on the bars immediately (print!) */}
      <Bar dataKey="Cut" fill={GREEN} radius={[3, 3, 0, 0]} isAnimationActive={false}>
        <LabelList dataKey="Cut" position="top" fontSize={15} fontWeight={800} formatter={label} />
      </Bar>
      <Bar dataKey="Welding" fill={GRAY} radius={[3, 3, 0, 0]} isAnimationActive={false}>
        <LabelList dataKey="Welding" position="top" fontSize={15} fontWeight={800} formatter={label} />
      </Bar>
      <Bar dataKey="Painting" fill={GREEN_DARK} radius={[3, 3, 0, 0]} isAnimationActive={false}>
        <LabelList dataKey="Painting" position="top" fontSize={15} fontWeight={800} formatter={label} />
      </Bar>
    </BarChart>
  );

  const SERIES: [string, string][] = [["Cut", GREEN], ["Welding", GRAY], ["Painting", GREEN_DARK]];

  return (
    <>
      {/* screen: responsive, scrolls sideways inside the card on phones */}
      <div className="overflow-x-auto no-print">
        <div style={{ minWidth: 460, height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">{chart()}</ResponsiveContainer>
        </div>
      </div>
      {/* paper: fixed 1000px ≈ the full A4-landscape content width, with a
          static hand-made legend ABOVE the plot — deterministic, never
          overlapping the item names */}
      <div className="print-only">
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 18, fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
          {SERIES.map(([name, color]) => (
            <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 12, background: color, display: "inline-block", borderRadius: 2 }} />
              {name}
            </span>
          ))}
        </div>
        {chart({ width: 1000, height: 300 }, false)}
      </div>
    </>
  );
}

export function PlannedVsWeldedChart({
  data,
}: {
  data: { date: string; planned: number; welded: number }[];
}) {
  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Bar dataKey="planned" name="Planned" fill={GRAY_LIGHT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="welded" name="Welded" fill={GREEN} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="no-print btn btn-primary btn-sm">
      <Printer size={14} />
      Print / Save PDF
    </button>
  );
}
