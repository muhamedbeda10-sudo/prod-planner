import { formatDate } from "@/lib/domain/format";
import { getMasterTracker } from "@/lib/server/masterTracker";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import { WeeklyPlanTrackerTable } from "@/components/WeeklyPlanTrackerTable";
import { PrintHeader } from "@/components/PrintHeader";
import { PlanCapacityCard } from "@/components/PlanCapacityCard";
import { getPlanCapacity } from "@/lib/server/planCapacity";
import { getOrderEtas } from "@/lib/server/eta";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { DEPTS, DELIVERED_STAGE, SHOTBLAST_STAGE } from "@/lib/domain/constants";
import { trackerPermKey } from "@/lib/domain/permissions";
import { factoryDayISO } from "@/lib/domain/dates";
import { ViewTabs, TRACKER_VIEWS, trackerViews } from "@/components/ViewTabs";
import { PageHead } from "@/components/ui";
import { LvTrackerTable } from "@/components/LvTrackerTable";
import { getActiveLine } from "@/lib/server/line";
import { loadSettingsRow } from "@/lib/server/loads";
import { getLvTracker } from "@/lib/server/lvTracker";
import { LV_CHAIN, lvPermKey } from "@/lib/domain/lv";
import { getUserPrefs } from "@/lib/server/userPrefs";
import { LV_TRACKER_PREF_KEYS, TRACKER_PREF_KEYS } from "@/lib/domain/userPrefs";

export const dynamic = "force-dynamic";

// A stage column is typed with its department's own key (the one that records
// its worklist); the order-level features each carry their own.
const FEATURE_KEYS = ["tracker.status", "tracker.components", "tracker.qty", "tracker.priority", "tracker.push"];

// No page header — how the plan is doing lives on the home page (the
// planner's cockpit), and the title lives in the nav tab. The filter bar's Plan toggle
// switches between the two readings of "the plan":
//   monthly — the order registry, one row per MO, capped at the order qty
//   weekly  — one weekly plan day by day, cumulative uncapped progress
export default async function TrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; plan?: string }>;
}) {
  await guardTab("/tracker");
  const sp = await searchParams;
  // the paper header is rendered here (a server component) so the issue date is
  // fixed at render time — a `new Date()` inside the client tables would put a
  // different day in the client HTML than the server's and trip hydration
  const issued = formatDate(factoryDayISO(new Date()));

  // The LV panels' side: one panel per row, its four stages and delivery,
  // recorded the way the transformer cells are — each stage behind the
  // panels' own tracker key for that column.
  if ((await getActiveLine()) === "LV") {
    const [rows, user] = await Promise.all([getLvTracker(), getCurrentUser()]);
    const lvPrefs = await getUserPrefs(user?.id, LV_TRACKER_PREF_KEYS);
    return (
      <>
        <PrintHeader title="Plan Tracker — LV Panels" date={issued} />
        <LvTrackerTable
          rows={rows}
          editableStages={user ? LV_CHAIN.filter((s) => hasPerm(user, lvPermKey(s))) : []}
          canStatus={!!user && hasPerm(user, "lv.status")}
          prefs={lvPrefs}
          head={<PageHead title="Plan Tracker" sub="LV Panels · one row per panel or meter box order, every stage" views={<ViewTabs views={trackerViews("LV")} current="/tracker" label="Tracker view" />} />}
        />
      </>
    );
  }

  if (sp.view === "weekly") {
    // an unknown ?plan= falls back to the newest plan inside the loader
    const [data, weeklyUser] = await Promise.all([getWeeklyPlanTracker(Number(sp.plan) || null), getCurrentUser()]);
    const capacity = await getPlanCapacity(data.planNo);
    return (
      <>
        <PrintHeader
          title="Plan Tracker — Weekly"
          subtitle={data.planNo === null ? undefined : `Weekly plan ${data.planNo}`}
          date={issued}
        />
        <PageHead title="Plan Tracker" sub={`Transformers · weekly plan${data.planNo === null ? "" : ` ${data.planNo}`}, day by day`} views={<ViewTabs views={TRACKER_VIEWS} current="/tracker" label="Tracker view" />} />
        <WeeklyPlanTrackerTable
          data={data}
          capacityCard={<PlanCapacityCard check={capacity} />}
          // ONE permission for the whole weekly sheet — deliberately separate
          // from the monthly tracker's per-column keys
          canRecord={!!weeklyUser && hasPerm(weeklyUser, "weekly.record")}
        />
      </>
    );
  }

  const [rows, user, { byMo, windowDays }, settings] = await Promise.all([getMasterTracker(), getCurrentUser(), getOrderEtas(), loadSettingsRow()]);
  // this person's own sheet: columns, folded and hidden components
  const prefs = await getUserPrefs(user?.id, TRACKER_PREF_KEYS);
  return (
    <>
      <PrintHeader title="Plan Tracker — Monthly" date={issued} />
      <MasterTrackerTable
        viewTabs={<ViewTabs views={TRACKER_VIEWS} current="/tracker" label="Tracker view" />}
        rows={rows}
        odooTrackingFrom={settings?.odooTrackingFrom ?? null}
        etas={Object.fromEntries(byMo)}
        etaWindowDays={windowDays}
        prefs={prefs}
        features={user ? [...FEATURE_KEYS.filter((k) => hasPerm(user, k)), ...(user.isAdmin ? ["admin"] : [])] : []}
        // stage columns (Fab/Weld/Paint/SHB/Dlvd) each need their own tracker permission
        editableDepts={user ? [...DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))) : []}
      />
    </>
  );
}
