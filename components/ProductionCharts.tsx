"use client";

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CAT, INK_ON_OTHER, Legend, OTHER, TipBox, catInk, fmt, pct } from "@/components/charts/kit";
import { LABEL_HEADROOM, segmentLabel, segmentValue, stackTotalValue, TotalLabel } from "@/components/charts/labels";
import { formatDate } from "@/lib/domain/format";

// The Production dashboard's own chart: what one stage recorded each day,
// component by component, in the stage's unit (pieces, or panels). One stage
// at a time — a piece that passes four stages is not four products, so the
// stages are never stacked together. The five biggest components keep their
// own colour; the rest are "Other". Each segment carries its count and its
// share of the day, the column the day's total.

const TICK = { fontSize: 11 };
const AXIS = { stroke: "var(--border-strong)" };
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const SLOTS = 5;

type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] };

export function VolumeChart({ days, components, unit, stage, height = 260 }: {
  days: readonly { dateISO: string; byComponent: Record<string, number>; total: number }[];
  /** The stage's components, the most first. */
  components: readonly string[];
  unit: string;
  stage: string;
  height?: number;
}) {
  if (days.length === 0) return null;
  const own = components.slice(0, SLOTS);
  const rest = components.length > SLOTS;
  const keys = rest ? [...own, "Other"] : own;
  const color = (k: string, i: number) => (k === "Other" ? OTHER : CAT[i % CAT.length]);
  const ink = (k: string, i: number) => (k === "Other" ? INK_ON_OTHER : catInk(i % CAT.length));
  const data = days.map((d) => {
    const row: Record<string, number | string> = { dateISO: d.dateISO, label: ddmm(d.dateISO), total: d.total };
    let other = 0;
    for (const [c, q] of Object.entries(d.byComponent)) {
      if (own.includes(c)) row[c] = q;
      else other += q;
    }
    if (rest) row.Other = other;
    return row;
  });
  return (
    <div className="space-y-2">
      <Legend items={keys.map((k, i) => ({ label: k, color: color(k, i) }))} />
      <div className="viz w-full min-w-0" style={{ height }} role="group" aria-label={`${stage}: ${unit} recorded each day by component, over ${days.length} days`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: LABEL_HEADROOM, right: 12, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => fmt(v, 0)} label={{ value: unit, angle: -90, position: "insideLeft", fontSize: 11, fill: "var(--muted)" }} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={(p: TipProps) => {
                const r = p.active && p.payload?.length ? (p.payload[0].payload as Record<string, number | string>) : null;
                if (!r) return null;
                return (
                  <TipBox
                    title={`${formatDate(String(r.dateISO))} · ${stage}`}
                    rows={[
                      ...keys.filter((k) => Number(r[k] ?? 0) > 0).map((k) => ({ label: k, value: `${fmt(Number(r[k]))} ${unit} · ${pct(Number(r[k]) / Number(r.total))}`, color: color(k, keys.indexOf(k)) })),
                      { label: "Total", value: `${fmt(Number(r.total))} ${unit}` },
                    ]}
                  />
                );
              }}
            />
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="v" fill={color(k, i)} stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} radius={i === keys.length - 1 ? [4, 4, 0, 0] : undefined}>
                <LabelList valueAccessor={segmentValue(k, keys, { share: true })} content={segmentLabel(ink(k, i))} />
                <LabelList valueAccessor={stackTotalValue(k, keys)} content={TotalLabel} />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
