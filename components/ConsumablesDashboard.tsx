"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Package, Target } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/primitives";
import { FilterSelect } from "@/components/FilterControls";
import { Bullet, CAT, ChartCard, Legend, TipBox, fmt, type TableRow } from "@/components/charts/kit";
import { PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import { ROW_STATUS_LABEL, limitBasisText, type DecisionRow, type RowLimit } from "@/lib/domain/consumablesDecisions";
import { useHrefWith } from "@/components/useSetParam";
import type { ConsumablesDecisionsClient } from "@/lib/server/consumables";

// The CONSUMABLES dashboard's charts — one per question, nothing twice:
//
//   how many hand-outs, over time .. columns per hour / day / week, the same
//                                    days of the period before as a line —
//                                    only when the log covers both;
//   against the limits ............. used against each row's limit (its own
//                                    unit, its own window), the fullest first;
//   which items .................... the most handed-out items, by number of
//                                    hand-outs or by quantity in ONE unit.
//
// A click opens the rows behind the figure in the table below, the filters
// kept; every chart's numbers go to "Ask AI" on a right-click.

const H = 300;
const PREV = "var(--viz-other)";

type TipProps<T> = { active?: boolean; payload?: readonly { payload?: T }[] };

/** The address with some parameters changed, landing on the detail table. */
function useHref() {
  const hrefWith = useHrefWith();
  return (set: Record<string, string | null>, hash = "detail") => hrefWith(set, hash);
}

function Box({ height, minWidth = 0, children }: { height: number; minWidth?: number; children: React.ReactElement }) {
  return (
    <div className="overflow-x-auto viz">
      <div style={{ height, minWidth }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

const nothing = (periodLabel: string) => <EmptyState icon={Package} title={`Nothing handed out ${periodLabel}`} hint="Pick a longer period, or clear the filters." compact />;

// ---------------------------------------------------------------- the trend

export function ConsumablesTrend({ d, periodLabel, prevLabel }: { d: ConsumablesDecisionsClient; periodLabel: string; prevLabel: string }) {
  const router = useRouter();
  const href = useHref();
  const t = d.trend;
  const compared = t.buckets.some((b) => b.prev !== null);
  const unit = t.unit;
  const rows: TableRow[] = t.buckets.map((b) => ({ [unit === "hour" ? "Hour" : unit === "day" ? "Day" : "Week of"]: unit === "hour" ? b.label : b.fromISO, "Hand-outs": b.issues, ...(compared ? { "Period before": b.prev ?? "" } : {}) }));
  const every = t.buckets.length > 16 ? Math.ceil(t.buckets.length / 16) - 1 : 0;
  const open = (b: (typeof t.buckets)[number]) => router.push(t.unit === "hour" ? href({}) : href({ from: b.fromISO, to: b.toISO }));

  return (
    <ChartCard className="h-full" title={`Hand-outs per ${unit}`} sub={compared ? `against the same ${unit === "hour" ? "hours" : "days"} of the period before (${prevLabel})` : d.kpis.noComparison ? `no comparison — ${d.kpis.noComparison.toLowerCase()}` : undefined}
      about={`Hand-outs (rows of the log) per ${unit} ${periodLabel}, the filters applied — a group hand-out counts once. ${compared ? `The line is the same place in the period just before (${prevLabel}), under the same filters.` : "No comparison is drawn where the log does not cover the period before or a limit status is filtered."} Click a column to open its rows.`}
      data={rows}>
      {d.kpis.handOuts === 0 ? nothing(periodLabel) : (
        <>
          <Box height={H} minWidth={Math.max(420, t.buckets.length * 22)}>
            <ComposedChart data={t.buckets} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={every} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<(typeof t.buckets)[number]>) => {
                const b = p.active ? p.payload?.[0]?.payload : undefined;
                return b ? <TipBox title={b.label} rows={[
                  { label: "Hand-outs", value: fmt(b.issues), color: CAT[0] },
                  ...(b.prev !== null ? [{ label: "Period before", value: fmt(b.prev), color: PREV, line: true }] : []),
                ]} /> : null;
              }} />
              <Bar dataKey="issues" fill={CAT[0]} maxBarSize={26} radius={[4, 4, 0, 0]} isAnimationActive={false} cursor="pointer"
                onClick={(_, i) => { const b = t.buckets[i]; if (b) open(b); }}>
                {t.buckets.length <= 31 && <LabelList dataKey="issues" position="top" fontSize={10} fontWeight={700} fill="var(--foreground)" formatter={(v: unknown) => (Number(v) ? fmt(Number(v)) : "")} />}
              </Bar>
              {compared && <Line dataKey="prev" stroke={PREV} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
            </ComposedChart>
          </Box>
          <div className="mt-2"><Legend items={[{ label: `Hand-outs per ${unit}`, color: CAT[0] }, ...(compared ? [{ label: "Period before", color: PREV, line: true }] : [])]} /></div>
        </>
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------- the limits and the items

const TOP = 10;

function limitTone(r: DecisionRow): "bad" | "warn" | null {
  return r.status === "over" ? "bad" : r.status === "near" ? "warn" : null;
}

export function ConsumablesBreakdown({ d, rank, periodLabel }: { d: ConsumablesDecisionsClient; rank: string; periodLabel: string }) {
  const router = useRouter();
  const href = useHref();
  // each row with the limit that reads worst
  const withLimit = d.rows.flatMap((r) => (r.limits[0] ? [{ r, l: r.limits[0] as RowLimit }] : []));
  const limited = [...withLimit].sort((a, b) => b.l.ratio - a.l.ratio || a.r.item.localeCompare(b.r.item)).slice(0, TOP);
  const limitRows: TableRow[] = withLimit.map(({ r, l }) => ({
    Item: r.item, Department: r.departmentLabel, Basis: limitBasisText(l, r.uom), Per: PERIOD_LABEL[l.period], Window: l.windowLabel,
    Used: l.used, Limit: l.limit, UOM: r.uom ?? "", Status: ROW_STATUS_LABEL[r.status],
  }));

  // one unit at a time, or the number of hand-outs — never a quantity across units
  const byUnit = rank !== "count" && d.units.includes(rank) ? rank : null;
  const inUnit = byUnit ? d.items.filter((i) => i.uom === byUnit).sort((a, b) => b.qty - a.qty || a.item.localeCompare(b.item)) : d.items;
  const itemData = inUnit.slice(0, TOP).map((i) => ({ key: i.itemKey, name: i.item, value: byUnit ? i.qty : i.handOuts }));
  const itemRows: TableRow[] = inUnit.map((i) => ({ Item: i.item, UOM: i.uom ?? "(typed, no unit)", "Hand-outs": i.handOuts, Qty: i.qty }));
  const longest = Math.min(22, Math.max(6, ...itemData.map((x) => x.name.length)));

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard title="Used against the limit" sub={limited.length ? `the fullest ${limited.length} item × department rows · each in its own unit and window` : undefined}
        about={`Each row's use against the limit that reads worst, at the period's end: everything the limit counts in its window (a shared limit, all its departments together; a per-worker one, the number times the headcount) up to ${d.toISO}. Rows with no limit are not here — see "No limit counts" and the table.`}
        data={limitRows}>
        {limited.length === 0 ? (
          <EmptyState icon={Target} compact title={d.kpis.handOuts === 0 ? `Nothing handed out ${periodLabel}` : "No row in the filters has a limit"}
            hint={d.kpis.handOuts === 0 ? undefined : "Typed items and departments no limit covers have nothing to be held against — they are listed under No limit counts."} />
        ) : (
          <ul className="space-y-3">
            {limited.map(({ r, l }) => (
              <li key={r.key}>
                <Link href={href({ item: r.itemKey, dept: r.department })} className="block rounded-lg hover:bg-surface-2 -mx-1 px-1">
                  <Bullet label={`${r.item} · ${r.departmentLabel}`} value={l.used} target={l.limit} max={Math.max(l.used, l.limit, 1e-9)} tone={limitTone(r)}
                    text={`${r.status === "over" ? "⚠ " : ""}${fmt(l.used)} of ${fmt(l.limit)}${r.uom ? ` ${r.uom}` : ""} · ${l.windowLabel}${l.toDate ? " to date" : ""}`} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ChartCard>

      <ChartCard
        title={byUnit ? `Most handed-out items · by quantity in ${byUnit}` : "Most handed-out items · by number of hand-outs"}
        sub={byUnit ? `catalogue items counted in ${byUnit} only — other units and typed items are left out` : "a hand-out is one row of the log, whatever its quantity"}
        about={byUnit ? `Items whose catalogue unit is ${byUnit}, by quantity handed out ${periodLabel}. A quantity is never added across units.` : `Items by the number of hand-outs ${periodLabel}. Pick a unit to rank them by quantity instead.`}
        data={itemRows}
        right={d.units.length > 0 ? (
          <FilterSelect label="Measure" value={byUnit ?? "count"} emptyValue="count" allLabel="Hand-outs"
            onChange={(v) => router.push(href({ rank: v === "count" ? null : v }, ""))}
            options={d.units.map((u) => ({ value: u, label: `Qty in ${u}` }))} />
        ) : undefined}>
        {itemData.length === 0 ? (byUnit ? <EmptyState icon={Package} compact title={`No item in ${byUnit} in the filters`} /> : nothing(periodLabel)) : (
          <Box height={Math.max(160, 24 + itemData.length * 28)} minWidth={320}>
            <BarChart data={itemData} layout="vertical" margin={{ top: 0, right: 48, left: 4, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={!!byUnit} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={16 + longest * 7.2} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} interval={0}
                tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)} />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p: TipProps<(typeof itemData)[number]>) => {
                const r = p.active ? p.payload?.[0]?.payload : undefined;
                return r ? <TipBox title={r.name} rows={[{ label: byUnit ? `Qty (${byUnit})` : "Hand-outs", value: fmt(r.value), color: CAT[0] }]} /> : null;
              }} />
              <Bar dataKey="value" fill={CAT[0]} maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false} cursor="pointer"
                onClick={(_, i) => { const x = itemData[i]; if (x) router.push(href({ item: x.key })); }}>
                <LabelList dataKey="value" position="right" fontSize={11} fontWeight={700} fill="var(--foreground)" formatter={(v: unknown) => fmt(Number(v))} />
              </Bar>
            </BarChart>
          </Box>
        )}
      </ChartCard>
    </div>
  );
}
