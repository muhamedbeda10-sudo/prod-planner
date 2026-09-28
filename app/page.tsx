import { getTargetDashboard } from "@/lib/server/dashboard";
import { getControlDashboard } from "@/lib/server/controlDashboard";
import { getSmartInsights } from "@/lib/server/insights";
import { getActiveLine } from "@/lib/server/line";
import { getLvDashboard } from "@/lib/server/lvDashboard";
import { LvDashboard } from "@/components/LvDashboard";
import { ControlDashboard } from "@/components/ControlDashboard";
import { SmartInsights } from "@/components/SmartInsights";
import { DashboardPeriodMemory } from "@/components/controls";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { addDaysISO, presetRange } from "@/lib/domain/dateSlicer";
import { factoryDayISO } from "@/lib/domain/dates";
import { ViewTabs, DASHBOARD_VIEWS } from "@/components/ViewTabs";
import { parseISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

// The Dashboard is the production-control screen (components/ControlDashboard):
// this page fetches, and hands it the week / period controls that scope the
// two throughput charts.

export default async function Home({ searchParams }: { searchParams: Promise<{ w?: string; from?: string; to?: string }> }) {
  // the panels have their own dashboard — one thing through four stages,
  // not six components against a target
  const sp = await searchParams;
  if ((await getActiveLine()) === "LV") {
    return <LvDashboard today={factoryDayISO(new Date())} d={await getLvDashboard({ from: sp.from ? parseISODate(sp.from) : null, to: sp.to ? parseISODate(sp.to) : null })} />;
  }

  const [c, d, ai] = await Promise.all([
    getControlDashboard(),
    getTargetDashboard({ weekOf: sp.w ? parseISODate(sp.w) : null, from: sp.from ? parseISODate(sp.from) : null, to: sp.to ? parseISODate(sp.to) : null }),
    getSmartInsights(),
  ]);
  // the week the dashboard opens on: Saturday to Thursday, the current one
  const today = factoryDayISO(new Date());
  const weekFrom = presetRange("thisWeek", today).from;
  const thisWeek = { label: "This week", from: weekFrom, to: addDaysISO(weekFrom, 5) };

  const controls = (
    <div className="no-print space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ViewTabs views={DASHBOARD_VIEWS} current="/" label="Dashboard view" />
        <div className="flex items-center gap-2">
          {d.clamped && <span className="pill pill-warn">cut to 31 days</span>}
          <SmartInsights data={ai} />
        </div>
      </div>
      <UrlDateSlicer
        encoding="fromTo" from={d.fromISO} to={d.toISO} min={addDaysISO(today, -90)} max={[today, thisWeek.to].sort().reverse()[0]} today={today}
        presets={["last7", "last14", "thisMonth", "lastMonth", "last30"]} defaultRange={thisWeek}
      />
    </div>
  );

  return (
    <>
      <DashboardPeriodMemory />
      <ControlDashboard c={c} d={d} controls={controls} />
    </>
  );
}
