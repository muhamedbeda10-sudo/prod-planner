"use client";

import { formatDate, formatDayShort } from "@/lib/domain/format";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, LabelList } from "recharts";
import { ResponsiveContainer } from "@/components/charts/zoom";
import { signedTonnes, tonnes, type Breakdown, type DayPoint, type Overrun, type PartCompare } from "@/lib/domain/materialDashboard";
import { CAT, Legend, OTHER, TipBox, catInk, fmt } from "@/components/charts/kit";
import { LABEL_HEADROOM, segmentLabel, segmentValue, stackTotalValue, TotalLabel } from "@/components/charts/labels";

// The Material dashboard's charts. Each one is clickable — a bar narrows the
// whole page to what it stands for (a day, a part, a thickness, an MO) — and
// each shows only figures the domain worked out (lib/domain/materialDashboard).
// One measure per chart; the colour only reinforces what the labels say.

/** Every chart of the page is this tall (the dashboards' 280–320 band). */
const H = 300;
const ACTUAL = CAT[0];
const ESTIMATE = CAT[1];
/** The day's column, bottom up: at the actual nesting rate, then the BOM estimate. */
const DAY_STACK = ["actualT", "estT"] as const;
/** Tonnes written on a mark. */
const tOf = (t: number) => tonnes(t * 1000);
const BOM = OTHER;
const OVER = "var(--bad-fg)";

const t2 = tonnes;
const AXIS = { fontSize: 11 } as const;

// ---- calculated consumption per closing day ----

export function ConsumedPerDayChart({ days, onPick }: { days: DayPoint[]; onPick?: (dateISO: string) => void }) {
  if (days.length === 0) return null;
  const data = days.map((d) => ({ ...d, label: formatDayShort(d.dateISO), actualT: (d.kg - d.bomRateKg) / 1000, estT: d.bomRateKg / 1000 }));
  return (
    <div className="space-y-2">
      <Legend items={[{ label: "At the actual nesting rate", color: ACTUAL }, { label: "Estimated from BOM", color: ESTIMATE }]} />
      <div className="viz w-full min-w-0" style={{ height: H }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: LABEL_HEADROOM, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%"
            onClick={(s: { activeLabel?: unknown; activeTooltipIndex?: unknown }) => {
              const i = typeof s?.activeTooltipIndex === "number" ? s.activeTooltipIndex : Number(s?.activeTooltipIndex);
              if (onPick && Number.isInteger(i) && data[i]) onPick(data[i].dateISO);
            }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" minTickGap={18} />
            <YAxis tick={AXIS} width={40} unit=" t" />
            <Tooltip
              cursor={{ fillOpacity: 0.35 }}
              content={({ active, payload }) => {
                const p = active && payload?.length ? (payload[0].payload as (typeof data)[number]) : null;
                if (!p) return null;
                const rows = [
                  { label: "Consumed (calculated)", value: `${t2(p.kg)} t` },
                  { label: "Estimated from BOM", value: `${t2(p.bomRateKg)} t`, color: ESTIMATE },
                  { label: "Sheets", value: fmt(p.sheets, 1) },
                  { label: "Units closed", value: fmt(p.units, 1) },
                  { label: "Closings", value: String(p.closings) },
                ];
                if (p.unknownWeightSheets > 0) rows.push({ label: "Sheets of unknown weight", value: fmt(p.unknownWeightSheets, 1) });
                return <TipBox title={formatDate(p.dateISO)} rows={rows} />;
              }}
            />
            {DAY_STACK.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="t" fill={i === 0 ? ACTUAL : ESTIMATE} radius={i === 1 ? [4, 4, 0, 0] : undefined} isAnimationActive={false} cursor={onPick ? "pointer" : undefined}>
                <LabelList valueAccessor={segmentValue(k, DAY_STACK, { format: tOf })} content={segmentLabel(catInk(i))} />
                <LabelList valueAccessor={stackTotalValue(k, DAY_STACK, tOf)} content={TotalLabel} />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---- actual nesting against the BOM, per part, on the nested lines ----

export function PartCompareChart({ parts, onPick }: { parts: PartCompare[]; onPick?: (part: string) => void }) {
  if (parts.length === 0) return null;
  const data = parts.slice(0, 10).map((p) => ({ ...p, label: p.part.length > 16 ? `${p.part.slice(0, 15)}…` : p.part, pick: p.partCode || p.part }));
  return (
    <div className="space-y-2">
      <Legend items={[{ label: "BOM sheets", color: BOM }, { label: "Actual nesting sheets", color: ACTUAL }]} />
      <div className="viz w-full min-w-0" style={{ height: H }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} interval={0} angle={data.length > 5 ? -20 : 0} textAnchor={data.length > 5 ? "end" : "middle"} height={data.length > 5 ? 48 : 24} />
            <YAxis tick={AXIS} width={44} />
            <Tooltip
              cursor={{ fillOpacity: 0.35 }}
              content={({ active, payload }) => {
                const p = active && payload?.length ? (payload[0].payload as (typeof data)[number]) : null;
                if (!p) return null;
                return <TipBox title={`${p.part}${p.partCode ? ` · ${p.partCode}` : ""}`} rows={[
                  { label: "BOM sheets", value: fmt(p.bomSheets, 1), color: BOM },
                  { label: "Actual sheets", value: fmt(p.actualSheets, 1), color: ACTUAL },
                  { label: "Difference", value: `${p.actualSheets - p.bomSheets > 0 ? "+" : ""}${fmt(p.actualSheets - p.bomSheets, 1)}` },
                  { label: "Lines compared", value: String(p.lines) },
                ]} />;
              }}
            />
            <Bar dataKey="bomSheets" fill={BOM} radius={[3, 3, 0, 0]} isAnimationActive={false} cursor={onPick ? "pointer" : undefined} onClick={(d: { payload?: { pick?: string } }) => d?.payload?.pick && onPick?.(d.payload.pick)} />
            <Bar dataKey="actualSheets" fill={ACTUAL} radius={[3, 3, 0, 0]} isAnimationActive={false} cursor={onPick ? "pointer" : undefined} onClick={(d: { payload?: { pick?: string } }) => d?.payload?.pick && onPick?.(d.payload.pick)} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---- where the steel goes: a breakdown, ranked bars ----

export function BreakdownChart({ rows, measure, onPick }: { rows: Breakdown[]; measure: "consumed" | "nested" | "bom"; onPick?: (key: string, row: Breakdown) => void }) {
  const all = rows.map((r) => ({ ...r, t: r[measure].kg / 1000, sheets: r[measure].sheets })).filter((r) => r.sheets > 0);
  if (all.length === 0) return null;
  // the shares are of the whole; past twelve groups the heaviest twelve stay, in the breakdown's own order
  const total = all.reduce((n, d) => n + d.t, 0);
  const keep = new Set([...all].sort((a, b) => b.t - a.t || b.sheets - a.sheets).slice(0, 12).map((d) => d.key));
  const data = all.filter((d) => keep.has(d.key));
  return (
    <div className="viz w-full min-w-0" style={{ height: H }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={AXIS} unit=" t" />
          <YAxis type="category" dataKey="key" tick={AXIS} width={84} />
          <Tooltip
            cursor={{ fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              const p = active && payload?.length ? (payload[0].payload as (typeof data)[number]) : null;
              if (!p) return null;
              const rows = [
                { label: "Tonnes", value: fmt(p.t, 2) },
                { label: "Sheets", value: fmt(p.sheets, 1) },
              ];
              if (p[measure].unknownWeightSheets > 0) rows.push({ label: "Sheets of unknown weight", value: fmt(p[measure].unknownWeightSheets, 1) });
              if (measure === "consumed" && p.scrapKg > 0) rows.push({ label: "Estimated scrap (known coverage)", value: `${t2(p.scrapKg)} t` });
              return <TipBox title={p.key} rows={rows} />;
            }}
          />
          <Bar dataKey="t" radius={[0, 4, 4, 0]} isAnimationActive={false} fill={ACTUAL} cursor={onPick ? "pointer" : undefined}
            onClick={(d: { payload?: Breakdown }) => d?.payload && onPick?.(d.payload.key, d.payload)}>
            <LabelList dataKey="t" position="right" formatter={(v: unknown) => (typeof v === "number" && total > 0 ? `${Math.round((v / total) * 100)}%` : "")}
              style={{ fontSize: 11, fontWeight: 700, fill: "var(--foreground)" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- the MOs whose nesting took most over the BOM ----

export function OverrunChart({ rows, onPick }: { rows: Overrun[]; onPick?: (mo: string) => void }) {
  if (rows.length === 0) return null;
  const data = rows.map((r) => ({ ...r, label: r.mo.replace(/^.*\/MO\//i, "MO/") }));
  return (
    <div className="viz w-full min-w-0" style={{ height: H }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={AXIS} />
          <YAxis type="category" dataKey="label" tick={AXIS} width={84} />
          <Tooltip
            cursor={{ fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              const p = active && payload?.length ? (payload[0].payload as (typeof data)[number]) : null;
              if (!p) return null;
              return <TipBox title={`${p.mo}${p.part ? ` · ${p.part}` : ""}`} rows={[
                { label: "Over the BOM, sheets", value: `+${fmt(p.deltaSheets, 1)}`, color: OVER },
                { label: "Over the BOM, tonnes", value: p.deltaKg === null ? "unknown weight" : signedTonnes(p.deltaKg) },
                { label: "BOM / actual sheets", value: `${fmt(p.bomSheets, 1)} / ${fmt(p.actualSheets, 1)}` },
                { label: "Units", value: fmt(p.units, 1) },
              ]} />;
            }}
          />
          <Bar dataKey="deltaSheets" radius={[0, 4, 4, 0]} isAnimationActive={false} cursor={onPick ? "pointer" : undefined}
            onClick={(d: { payload?: Overrun }) => d?.payload && onPick?.(d.payload.mo)}>
            {data.map((d) => <Cell key={d.mo} fill={OVER} />)}
            <LabelList dataKey="deltaSheets" position="right" formatter={(v: unknown) => (typeof v === "number" ? `+${fmt(v, 1)}` : "")}
              style={{ fontSize: 11, fontWeight: 700, fill: "var(--foreground)" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
