import { getMasterTracker } from "@/lib/server/masterTracker";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import { WeeklyPlanTrackerTable } from "@/components/WeeklyPlanTrackerTable";
import { PrintHeader } from "@/components/PrintHeader";
import { PlanCapacityCard } from "@/components/PlanCapacityCard";
import { getPlanCapacity } from "@/lib/server/planCapacity";
import { getOrderEtas } from "@/lib/server/eta";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { DEPTS, DELIVERED_STAGE, SHOTBLAST_STAGE } from "@/lib/domain/constants";
import { trackerPermKey } from "@/lib/domain/permissions";
import { toDisplayDate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

// Tracker features each carry their OWN permission key — deliberately separate
// from the worklist permissions (a Cut-worklist user can't touch the tracker's
// Fab column unless given tracker.cut explicitly).
const FEATURE_KEYS = ["tracker.status", "tracker.components", "tracker.qty", "tracker.priority", "tracker.push"];

// No page header — the plan-level KPI cards (progress + OTD) live on the
// Dashboard, and the title lives in the nav tab. The filter bar's Plan toggle
// switches between the two readings of "the plan":
//   monthly — the order registry, one row per MO, capped at the order qty
//   weekly  — one weekly plan day by day, cumulative uncapped progress
export default async function TrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; plan?: string }>;
}) {
  const sp = await searchParams;
  // the paper header is rendered here (a server component) so the issue date is
  // fixed at render time — a `new Date()` inside the client tables would put a
  // different day in the client HTML than the server's and trip hydration
  const issued = toDisplayDate(new Date());

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

  const [rows, user, { byMo, windowDays }] = await Promise.all([getMasterTracker(), getCurrentUser(), getOrderEtas()]);
  return (
    <>
      <PrintHeader title="Plan Tracker — Monthly" date={issued} />
      <MasterTrackerTable
        rows={rows}
        etas={Object.fromEntries(byMo)}
        etaWindowDays={windowDays}
        features={user ? [...FEATURE_KEYS.filter((k) => hasPerm(user, k)), ...(user.isAdmin ? ["admin"] : [])] : []}
        // stage columns (Fab/Weld/Paint/SHB/Dlvd) each need their own tracker permission
        editableDepts={user ? [...DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))) : []}
      />
    </>
  );
}
