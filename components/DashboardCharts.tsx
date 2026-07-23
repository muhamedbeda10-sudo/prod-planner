"use client";

import { type ComponentProps } from "react";
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
  ReferenceLine, LabelList,
} from "recharts";
import { ITEMS, itemDailyTarget, STAGE_COLOR, FINISHING_LABEL } from "@/lib/domain/constants";
import type { DayRow } from "@/lib/server/dashboard";

type LegendItem = { value: string; type: "square"; id: string; color: string };
// recharts renders Legend items in the given payload order; its public prop
// types omit `payload`, so bridge through unknown (supported at runtime)
const orderedLegend = (payload: LegendItem[]) => ({ payload } as unknown as ComponentProps<typeof Legend>);

/* Canonical per-stage colours — shared with every other chart & the tracker:
   Fabrication green · Welding blue · Painting orange · Delivered purple. */
const FAB = STAGE_COLOR.Cut;
const WELD = STAGE_COLOR.Welding;
const PAINT = STAGE_COLOR.Painting;
const GRAY = "#717171"; // neutral reference lines only

/* fixed legend order (production pipeline) + display names — passed explicitly
   so every chart shows the SAME order regardless of recharts' internal sort */
const DEPT_LEGEND = [
  { value: "Fabrication", type: "square" as const, id: "Fabrication", color: FAB },
  { value: "Welding", type: "square" as const, id: "Welding", color: WELD },
  { value: FINISHING_LABEL, type: "square" as const, id: "Painting", color: PAINT },
];

/** Charts keep a readable minimum width and scroll sideways inside their card
 *  on narrow phones instead of being squeezed off-screen. */
function ChartScroller({ minWidth, height, children }: { minWidth: number; height: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth, height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

/** Daily totals per dept across the week, with the fixed daily target line. */
export function WeekTrendChart({ days, targetPerDeptDay }: { days: DayRow[]; targetPerDeptDay: number }) {
  const data = days.map((d) => ({
    day: d.label,
    Fabrication: d.cut.total,
    Welding: d.weld.total,
    Painting: d.paint.total,
  }));
  return (
    <ChartScroller minWidth={520} height={260}>
        <BarChart data={data} margin={{ top: 16, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} {...orderedLegend(DEPT_LEGEND)} />
          {/* no in-chart label — the card subtitle states the target, a fixed
              spot that can never collide with a bar */}
          <ReferenceLine y={targetPerDeptDay} stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={2} />
          <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Fabrication" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Welding" name="Welding" fill={WELD} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Welding" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Painting" name={FINISHING_LABEL} fill={PAINT} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Painting" position="top" fontSize={10} />
          </Bar>
        </BarChart>
    </ChartScroller>
  );
}

/** Week totals per item, per dept, against the weekly PER-ITEM target — a
 *  stepped dashed line: base ×days across CF/TC/TN/CB, dropping to the AR/MB
 *  target (20 ×days) over the last two items. */
export function WeekItemChart({
  cut, weld, paint, baseTargetDay, workingDays,
}: {
  cut: Record<string, number>;
  weld: Record<string, number>;
  paint: Record<string, number>;
  baseTargetDay: number; // per-item daily target for the base components (27)
  workingDays: number; // working days in the shown period
}) {
  // Painting is the finishing stage — the core (CF) shows its Shot Blast here
  const data = ITEMS.map((it) => ({
    item: it,
    Fabrication: cut[it] ?? 0,
    Welding: weld[it] ?? 0,
    Painting: paint[it] ?? 0,
    Target: itemDailyTarget(it, baseTargetDay) * workingDays,
  }));
  return (
    <ChartScroller minWidth={420} height={260}>
        <ComposedChart data={data} margin={{ top: 16, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="item" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} {...orderedLegend(DEPT_LEGEND)} />
          {/* mid-point step: the drop lands between CB and AR so AR & MB sit
              fully under their own lower target line */}
          <Line type="step" dataKey="Target" stroke="var(--bad-fg)" strokeDasharray="6 4" strokeWidth={2} dot={false} activeDot={false} legendType="none" isAnimationActive={false} />
          <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Fabrication" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Welding" name="Welding" fill={WELD} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Welding" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Painting" name={FINISHING_LABEL} fill={PAINT} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Painting" position="top" fontSize={10} />
          </Bar>
        </ComposedChart>
    </ChartScroller>
  );
}

/** Weekly history: dept totals vs the fixed weekly target. */
export function HistoryChart({
  history, targetPerDeptWeek,
}: {
  history: { label: string; cutTotal: number; weldTotal: number; paintTotal: number }[];
  targetPerDeptWeek: number;
}) {
  const data = [...history].reverse().map((h) => ({ week: h.label, Fabrication: h.cutTotal, Welding: h.weldTotal, Painting: h.paintTotal }));
  return (
    <ChartScroller minWidth={560} height={240}>
        <BarChart data={data} margin={{ top: 16, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 10 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} {...orderedLegend(DEPT_LEGEND)} />
          <ReferenceLine y={targetPerDeptWeek} stroke={GRAY} strokeDasharray="6 4" />
          <Bar dataKey="Fabrication" name="Fabrication" fill={FAB} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Welding" name="Welding" fill={WELD} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Painting" name={FINISHING_LABEL} fill={PAINT} radius={[3, 3, 0, 0]} />
        </BarChart>
    </ChartScroller>
  );
}
