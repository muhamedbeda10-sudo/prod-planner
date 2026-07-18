"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
  ReferenceLine, LabelList,
} from "recharts";
import { ITEMS } from "@/lib/domain/constants";
import type { DayRow } from "@/lib/server/dashboard";

/* ATC brand chart palette */
const GREEN = "#1a8150";
const GREEN_LIGHT = "#8fc9ab";
const GRAY = "#717171";
const PAINT = "#c59a3f";

/** Charts keep a readable minimum width and scroll sideways inside their card
 *  on narrow phones instead of being squeezed off-screen. chart-scroll makes
 *  the SVG rescale to the full page width when printing (paper can't scroll). */
function ChartScroller({ minWidth, height, children }: { minWidth: number; height: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto chart-scroll">
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
    Cut: d.cut.total,
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
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine
            y={targetPerDeptDay}
            stroke="var(--bad-fg)"
            strokeDasharray="6 4"
            strokeWidth={2}
            label={{ value: `Target ${targetPerDeptDay}/day`, position: "insideTopRight", dy: -9, fontSize: 11, fill: "var(--bad-fg)" }}
          />
          <Bar dataKey="Cut" fill={GREEN_LIGHT} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Cut" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Welding" fill={GREEN} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Welding" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Painting" fill={PAINT} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Painting" position="top" fontSize={10} />
          </Bar>
        </BarChart>
    </ChartScroller>
  );
}

/** Week totals per item, per dept, against the weekly per-item target. */
export function WeekItemChart({
  cut, weld, paint, targetPerItemWeek,
}: {
  cut: Record<string, number>;
  weld: Record<string, number>;
  paint: Record<string, number>;
  targetPerItemWeek: number;
}) {
  const data = ITEMS.map((it) => ({ item: it, Cut: cut[it] ?? 0, Welding: weld[it] ?? 0, Painting: paint[it] ?? 0 }));
  return (
    <ChartScroller minWidth={420} height={260}>
        <BarChart data={data} margin={{ top: 16, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="item" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine
            y={targetPerItemWeek}
            stroke="var(--bad-fg)"
            strokeDasharray="6 4"
            strokeWidth={2}
            label={{ value: `Week target ${targetPerItemWeek}/item`, position: "insideTopRight", dy: -9, fontSize: 11, fill: "var(--bad-fg)" }}
          />
          <Bar dataKey="Cut" fill={GREEN_LIGHT} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Cut" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Welding" fill={GREEN} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Welding" position="top" fontSize={10} />
          </Bar>
          <Bar dataKey="Painting" fill={PAINT} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="Painting" position="top" fontSize={10} />
          </Bar>
        </BarChart>
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
  const data = [...history].reverse().map((h) => ({ week: h.label, Cut: h.cutTotal, Welding: h.weldTotal, Painting: h.paintTotal }));
  return (
    <ChartScroller minWidth={560} height={240}>
        <BarChart data={data} margin={{ top: 16, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 10 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine
            y={targetPerDeptWeek}
            stroke={GRAY}
            strokeDasharray="6 4"
            label={{ value: `${targetPerDeptWeek}/week`, position: "insideTopRight", dy: -9, fontSize: 10, fill: GRAY }}
          />
          <Bar dataKey="Cut" fill={GREEN_LIGHT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Welding" fill={GREEN} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Painting" fill={PAINT} radius={[3, 3, 0, 0]} />
        </BarChart>
    </ChartScroller>
  );
}
