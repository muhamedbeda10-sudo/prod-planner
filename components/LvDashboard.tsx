import Link from "next/link";
import { LV_CHAIN, LV_STAGE_LABEL, LV_STAGE_SHORT } from "@/lib/domain/lv";
import type { LvDashboardData } from "@/lib/server/lvDashboard";
import { ViewTabs, DASHBOARD_VIEWS } from "@/components/ViewTabs";
import { PeriodFilter } from "@/components/controls";
import { PrintButton } from "@/components/PrintButton";

// The panels' Dashboard: where the open orders stand on the chain, what each
// stage moved this month, and the last two weeks day by day. A server
// component — nothing to click but the links.

const fmt = (n: number) => n.toLocaleString();
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-[9rem]">
      <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-extrabold tabnum leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function LvDashboard({ d }: { d: LvDashboardData }) {
  const o = d.open;
  const pct = (n: number) => (o.panels > 0 ? `${Math.round((n / o.panels) * 100)}%` : "—");
  return (
    <div className="space-y-6">
      {/* The report lives inside the dashboard, as it does for the transformers:
          pick a day (from = to) or a period and the table below is that
          period, ready to print. */}
      <div className="no-print flex flex-wrap items-center gap-3 bg-surface border rounded-xl px-3 py-2.5">
        <ViewTabs views={DASHBOARD_VIEWS.filter((v) => v.href === "/")} current="/" label="Dashboard view" />
        <span className="font-extrabold text-sm tabnum">
          {d.ranged ? `${ddmmyyyy(d.fromISO)} → ${ddmmyyyy(d.toISO)}` : `Last ${d.days.length} days`}
          {d.clamped && <span className="pill pill-warn ms-2">cut to {d.days.length} days</span>}
        </span>
        <PeriodFilter from={d.ranged ? d.fromISO : ""} to={d.ranged ? d.toISO : ""} active={d.ranged} />
        <span className="ms-auto inline-flex items-center gap-2">
          <PrintButton />
          <Link href="/tracker" className="btn btn-sm">Plan Tracker →</Link>
        </span>
      </div>
      <div className="print-only text-sm font-bold">LV Panels · {d.ranged ? `${ddmmyyyy(d.fromISO)} → ${ddmmyyyy(d.toISO)}` : `last ${d.days.length} days`}</div>

      {/* the open orders on the chain */}
      <div className="flex flex-wrap gap-3">
        <Stat label="Open orders" value={fmt(o.orders)} sub={o.urgent > 0 ? `${o.urgent} urgent` : "none urgent"} />
        <Stat label="Panels planned" value={fmt(o.panels)} sub="across the open orders" />
        {LV_CHAIN.map((s) => (
          <Stat key={s} label={LV_STAGE_LABEL[s]} value={fmt(o.byStage[s])} sub={`${pct(o.byStage[s])} of the planned panels`} />
        ))}
      </div>

      {/* this month and the last two weeks, per stage */}
      <section className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">Day</th>
              {LV_CHAIN.map((s) => <th key={s} className="p-2 text-center" title={LV_STAGE_LABEL[s]}>{LV_STAGE_SHORT[s]}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.days.map((day) => {
              const any = LV_CHAIN.some((s) => day.byStage[s] !== 0);
              return (
                <tr key={day.dateISO} className={`border-t ${any ? "" : "text-muted"}`}>
                  <td className="p-2 tabnum ltr whitespace-nowrap">{ddmm(day.dateISO)}</td>
                  {LV_CHAIN.map((s) => <td key={s} className={`p-2 text-center tabnum ${day.byStage[s] > 0 ? "font-bold" : ""}`}>{day.byStage[s] || "·"}</td>)}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-bold bg-surface-2/60">
              <td className="p-2">{d.ranged ? "Period" : `Last ${d.days.length} days`}</td>
              {LV_CHAIN.map((s) => <td key={s} className="p-2 text-center tabnum">{fmt(d.period[s])}</td>)}
            </tr>
            <tr className="font-bold">
              <td className="p-2">{d.monthLabel}</td>
              {LV_CHAIN.map((s) => <td key={s} className="p-2 text-center tabnum">{fmt(d.month[s])}</td>)}
            </tr>
          </tfoot>
        </table>
      </section>
      <p className="text-xs text-muted">
        Panels moved per stage, from the daily log. No daily target is set for the panels yet — when one is, it goes here as the line to beat.
      </p>
    </div>
  );
}
