"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart,
  PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ChartCard, Legend, TipBox, fmt, pct, type TableRow } from "@/components/charts/kit";
import type { OdooInsights as Insights } from "@/lib/domain/odooInsights";

// "How the close-out is going" — the ODOO dashboard's second half, one form
// per question: a histogram of how long a close takes and the average per
// product, a gauge for the close rate beside a burn-up of logged against
// closed, and the quantity per BOM split by product. Products keep the colours the rest of the dashboard gives them.

type TipProps<T> = { active?: boolean; payload?: readonly { payload?: T }[] };

function Box({ height, minWidth = 0, children }: { height: number; minWidth?: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto viz">
      <div style={{ height, minWidth }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

function Gauge({ value, label, sub }: { value: number; label: string; sub: string }) {
  const data = [{ name: label, value: Math.round(value * 1000) / 10 }];
  return (
    <div className="relative mx-auto" style={{ width: 240, height: 150 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart data={data} cx="50%" cy="92%" innerRadius="120%" outerRadius="165%" startAngle={180} endAngle={0} barSize={18}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <RadialBar dataKey="value" cornerRadius={9} fill="var(--viz-1)" background={{ fill: "color-mix(in srgb, var(--viz-1) 14%, var(--surface))" }} isAnimationActive={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-x-0 bottom-1 text-center pointer-events-none">
        <div className="text-[34px] font-semibold leading-none">{pct(value)}</div>
        <div className="text-xs text-muted mt-1">{sub}</div>
      </div>
    </div>
  );
}

export function OdooInsightsSection({ ins, colorOf }: { ins: Insights; colorOf: (product: string) => string }) {
  const f = ins.funnel;
  const funnelData = [
    { name: "Logged", value: f.logged },
    { name: "With MO", value: f.withMo },
    { name: "Done", value: f.done },
  ];
  const lt = ins.leadTime;
  const burnEvery = ins.burnUp.length > 14 ? Math.ceil(ins.burnUp.length / 14) - 1 : 0;
  const lastBurn = ins.burnUp.at(-1);
  const bomData = ins.bomMix.rows.map((r) => ({ bom: r.bom, qty: r.qty, ...r.bySeries }));
  // each bar's total is written once, at the end of its last non-empty
  // segment. The row is read off the label's own entry — recharts leaves a
  // zero-width segment out of the label list, so an index would drift.
  const topSeries = (row: Record<string, unknown>) => [...ins.bomMix.series].reverse().find((s) => Number(row[s] ?? 0) > 0) ?? null;
  const bomTotal = (series: string) => (entry: { payload?: Record<string, unknown> }) =>
    entry.payload && topSeries(entry.payload) === series ? fmt(Number(entry.payload.qty ?? 0)) : "";

  const tables = {
    funnel: funnelData.map((d) => ({ Stage: d.name, Rows: d.value, "Of logged": f.logged ? pct(d.value / f.logged, 1) : "—" })) as TableRow[],
    lead: lt.buckets.map((b) => ({ "Logged → closed": b.label, Rows: b.rows })) as TableRow[],
    leadProduct: lt.byProduct.map((p) => ({ Product: p.product, "Average days": p.avgDays, Rows: p.rows })) as TableRow[],
    burn: ins.burnUp.map((b) => ({ Day: b.dateISO, "Logged (cumulative)": b.logged, "Closed (cumulative)": b.closed, "Open gap": b.open })) as TableRow[],
    bom: ins.bomMix.rows.map((r) => ({ BOM: r.bom, ...Object.fromEntries(ins.bomMix.series.map((s) => [s, r.bySeries[s] ?? 0])), Total: r.qty })) as TableRow[],
  };

  return (
    <section className="space-y-3">
      <h2 className="font-bold">How the close-out is going <span className="text-muted font-normal text-sm">· the rows logged in the period, and the closings in it</span></h2>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard title="How long a close takes" about={lt.rows ? `From the day a row was logged to the day it went Done — ${fmt(lt.rows)} row(s) closed in the period` : "No row closed in the period"}
          data={tables.lead}>
          <div className="flex flex-wrap gap-2 mb-2 text-xs">
            {[["Median", lt.medianDays], ["Average", lt.avgDays], ["9 in 10 within", lt.p90Days]].map(([label, v]) => (
              <span key={String(label)} className="pill pill-muted">{label} <b className="tabnum">{v === null ? "—" : `${fmt(Number(v), 1)} d`}</b></span>
            ))}
          </div>
          <Box height={230}>
            <BarChart data={lt.buckets} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<{ label: string; rows: number }>) => {
                const r = p.active ? p.payload?.[0]?.payload : undefined;
                return r ? <TipBox title={r.label} rows={[{ label: "Rows closed", value: fmt(r.rows), color: "var(--viz-2)" }, { label: "Share", value: lt.rows ? pct(r.rows / lt.rows) : "—" }]} /> : null;
              }} />
              <Bar dataKey="rows" fill="var(--viz-2)" maxBarSize={40} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                <LabelList dataKey="rows" position="top" fontSize={10} fontWeight={700} fill="var(--foreground)" formatter={(v: unknown) => (Number(v) ? fmt(Number(v)) : "")} />
              </Bar>
            </BarChart>
          </Box>
        </ChartCard>

        <ChartCard title="Average days to close, by product" about="The slower products first" data={tables.leadProduct}>
          {lt.byProduct.length === 0 ? <p className="text-sm text-muted">No row closed in the period.</p> : (
            <Box height={Math.max(140, 24 + lt.byProduct.length * 34)}>
              <BarChart data={lt.byProduct} layout="vertical" margin={{ top: 0, right: 56, left: 8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} unit=" d" />
                <YAxis type="category" dataKey="product" width={110} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<(typeof lt.byProduct)[number]>) => {
                  const r = p.active ? p.payload?.[0]?.payload : undefined;
                  return r ? <TipBox title={r.product} rows={[{ label: "Average", value: `${fmt(r.avgDays, 1)} days`, color: colorOf(r.product) }, { label: "Rows closed", value: fmt(r.rows) }]} /> : null;
                }} />
                <Bar dataKey="avgDays" maxBarSize={22} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {lt.byProduct.map((p) => <Cell key={p.product} fill={colorOf(p.product)} />)}
                  <LabelList dataKey="avgDays" position="right" fontSize={11} fontWeight={700} fill="var(--foreground)" formatter={(v: unknown) => `${fmt(Number(v), 1)} d`} />
                </Bar>
              </BarChart>
            </Box>
          )}
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard title="Close rate" about="Of the rows logged in the period, how many are Done by now" data={tables.funnel}>
          <Gauge value={ins.closeRate} label="Close rate" sub={`${fmt(f.done)} of ${fmt(f.logged)} rows Done`} />
          <div className="mt-3 grid grid-cols-3 text-center text-xs">
            <div><div className="text-lg font-semibold">{fmt(f.logged)}</div><div className="text-muted">logged</div></div>
            <div><div className="text-lg font-semibold">{fmt(f.logged - f.done)}</div><div className="text-muted">still open</div></div>
            <div><div className="text-lg font-semibold">{fmt(ins.aging.openQty)}</div><div className="text-muted">open qty</div></div>
          </div>
        </ChartCard>

        <ChartCard title="Burn-up: logged against closed"
          about={lastBurn ? `Running totals of rows · the gap is the open backlog — ${fmt(lastBurn.open)} at the end` : "Nothing in the period"}
          data={tables.burn}>
          <Box height={240} minWidth={Math.max(360, Math.min(ins.burnUp.length, 45) * 12)}>
            <LineChart data={ins.burnUp} margin={{ top: 10, right: 16, left: -4, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={burnEvery} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={(p: TipProps<(typeof ins.burnUp)[number]>) => {
                const r = p.active ? p.payload?.[0]?.payload : undefined;
                return r ? <TipBox title={r.label} rows={[
                  { label: "Logged so far", value: fmt(r.logged), color: "var(--viz-2)", line: true },
                  { label: "Closed so far", value: fmt(r.closed), color: "var(--viz-1)", line: true },
                  { label: "Open gap", value: fmt(r.open) },
                ]} /> : null;
              }} />
              <Line type="monotone" dataKey="logged" stroke="var(--viz-2)" strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="closed" stroke="var(--viz-1)" strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
            </LineChart>
          </Box>
          <div className="mt-2"><Legend items={[{ label: "Logged (running total)", color: "var(--viz-2)", line: true }, { label: "Closed (running total)", color: "var(--viz-1)", line: true }]} /></div>
        </ChartCard>
      </div>

      {bomData.length > 0 && (
        <ChartCard title="Quantity per BOM, by product" about={`The ${bomData.length} heaviest BOM(s) logged in the period — each bar split by product`}
          data={tables.bom}>
          <Box height={Math.max(160, 30 + bomData.length * 34)} minWidth={420}>
            <BarChart data={bomData} layout="vertical" margin={{ top: 0, right: 48, left: 8, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="bom" width={120} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<Record<string, number | string>>) => {
                const r = p.active ? p.payload?.[0]?.payload : undefined;
                return r ? <TipBox title={`${r.bom} · ${fmt(Number(r.qty))}`} rows={ins.bomMix.series.filter((s) => Number(r[s]) > 0).map((s) => ({ label: s, value: fmt(Number(r[s])), color: colorOf(s) }))} /> : null;
              }} />
              {ins.bomMix.series.map((s, i) => (
                <Bar key={s} dataKey={s} stackId="b" fill={colorOf(s)} stroke="var(--surface)" strokeWidth={1} maxBarSize={22}
                  radius={i === ins.bomMix.series.length - 1 ? [0, 4, 4, 0] : undefined} isAnimationActive={false}>
                  <LabelList valueAccessor={bomTotal(s)} position="right" offset={6} fontSize={11} fontWeight={700} fill="var(--foreground)" />
                </Bar>
              ))}
            </BarChart>
          </Box>
          <div className="mt-2"><Legend items={ins.bomMix.series.map((s) => ({ label: s, color: colorOf(s) }))} /></div>
        </ChartCard>
      )}
    </section>
  );
}
