"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList, ReferenceLine, Pie, PieChart } from "recharts";
import type { DayPoint, ThicknessSlice } from "@/lib/domain/fabAnalytics";

// The two charts of the Fabrication analytics page. Both measure the same
// thing — sheets — so both are blue: the daily one a single mid step, the
// thickness one (a donut up to six thicknesses, ranked bars past that) a
// sequential ramp of that same hue, light to dark as the sheet gets thicker (brighter as it thickens on dark surfaces, where light reads as
// "more"). One hue for one measure; the ramp's lightness is monotone and every
// bar is direct-labelled, so the colour only reinforces what the labels say.

const SHEETS = "var(--viz-2)";

/** Six steps, thin → thick. The values live in the stylesheet so the ramp
 *  re-steps itself for dark mode instead of being flipped here. */
const RAMP = ["var(--ramp-1)", "var(--ramp-2)", "var(--ramp-3)", "var(--ramp-4)", "var(--ramp-5)", "var(--ramp-6)"];

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const n1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });

function TipBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-surface shadow-md px-3 py-2 text-xs space-y-0.5">{children}</div>
  );
}

// ---- sheets a day ----

export function SheetsPerDayChart({ days, avg }: { days: DayPoint[]; avg: number }) {
  if (days.length === 0) return null;
  const data = days.map((d) => ({ ...d, label: ddmm(d.dateISO), tons: d.kg / 1000 }));
  return (
    <div className="viz w-full min-w-0" style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={18} />
          <YAxis tick={{ fontSize: 10 }} width={38} />
          <Tooltip
            cursor={{ fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              const p = active && payload?.length ? (payload[0].payload as (typeof data)[number]) : null;
              if (!p) return null;
              return (
                <TipBox>
                  <b className="tabnum">{p.dateISO}</b>
                  <div className="tabnum"><b>{n1(p.sheets)}</b> sheets · {n1(p.tons)} t</div>
                  <div className="tabnum text-muted">{n1(p.pieces)} units closed</div>
                  {p.uncoveredPieces > 0 && (
                    <div className="tabnum text-muted">{n1(p.uncoveredPieces)} of them not on the material sheet — no sheets counted</div>
                  )}
                </TipBox>
              );
            }}
          />
          {/* The plant's own pace, so a day reads as above or below it. It
              carries no in-chart label: wherever the label sat it landed on a
              bar, and the section header names the figure anyway. */}
          {avg > 0 && <ReferenceLine y={avg} stroke="var(--muted)" strokeDasharray="5 4" />}
          <Bar dataKey="sheets" fill={SHEETS} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- where the sheets go, by thickness ----

export function ThicknessChart({ rows }: { rows: ThicknessSlice[] }) {
  if (rows.length === 0) return null;
  const data = rows.map((r, i) => ({
    ...r,
    label: `${r.thicknessMm} mm`,
    tons: r.kg / 1000,
    // spread whatever thicknesses exist across the ramp's six steps
    fill: RAMP[rows.length === 1 ? RAMP.length - 1 : Math.round((i / (rows.length - 1)) * (RAMP.length - 1))],
  }));
  // Up to six thicknesses the share of the whole is the point, so a donut —
  // shaded thin → thick on the same ramp, the legend in thickness order.
  // Past six the ramp would repeat a step, so the ranked bars stay.
  if (rows.length <= RAMP.length) return <ThicknessDonut data={data} />;
  return (
    <div className="viz w-full min-w-0" style={{ height: Math.max(150, rows.length * 34 + 24) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10 }} />
          <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={58} />
          <Tooltip
            cursor={{ fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              const p = active && payload?.length ? (payload[0].payload as (typeof data)[number]) : null;
              if (!p) return null;
              return (
                <TipBox>
                  <b>{p.label} sheets</b>
                  <div className="tabnum"><b>{n1(p.sheets)}</b> sheets · {(p.share * 100).toFixed(1)}% of the window</div>
                  <div className="tabnum text-muted">{n1(p.tons)} t of steel</div>
                </TipBox>
              );
            }}
          />
          <Bar dataKey="sheets" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.thicknessMm} fill={d.fill} />)}
            <LabelList
              dataKey="share"
              position="right"
              formatter={(v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(0)}%` : "")}
              style={{ fontSize: 11, fontWeight: 700, fill: "var(--foreground)" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

type ThicknessDatum = ThicknessSlice & { label: string; tons: number; fill: string };

function ThicknessDonut({ data }: { data: ThicknessDatum[] }) {
  const sheets = data.reduce((n, d) => n + d.sheets, 0);
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="relative shrink-0" style={{ width: 190, height: 190 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="sheets" nameKey="label" innerRadius={58} outerRadius={90} paddingAngle={data.length > 1 ? 1.5 : 0}
              stroke="var(--surface)" strokeWidth={2} startAngle={90} endAngle={-270} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.thicknessMm} fill={d.fill} />)}
            </Pie>
            <Tooltip content={({ active, payload }) => {
              const p = active && payload?.length ? (payload[0].payload as ThicknessDatum) : null;
              if (!p) return null;
              return (
                <TipBox>
                  <b>{p.label} sheets</b>
                  <div className="tabnum"><b>{n1(p.sheets)}</b> sheets · {(p.share * 100).toFixed(1)}% of the window</div>
                  <div className="tabnum text-muted">{n1(p.tons)} t of steel</div>
                </TipBox>
              );
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 grid place-items-center pointer-events-none text-center">
          <div><div className="text-2xl font-semibold leading-none">{n1(sheets)}</div><div className="text-[11px] text-muted">sheets</div></div>
        </div>
      </div>
      <ul className="space-y-1.5 text-sm w-full">
        {data.map((d) => (
          <li key={d.thicknessMm} className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.fill }} aria-hidden />
            <span className="flex-1 tabnum">{d.label}</span>
            <span className="tabnum text-muted">{n1(d.sheets)}</span>
            <span className="tabnum font-bold w-12 text-right">{(d.share * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
