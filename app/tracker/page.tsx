import { getMasterTracker } from "@/lib/server/masterTracker";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import { WeeklyPlanTrackerTable } from "@/components/WeeklyPlanTrackerTable";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { DEPTS, DELIVERED_STAGE, SHOTBLAST_STAGE } from "@/lib/domain/constants";
import { trackerPermKey } from "@/lib/domain/permissions";

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

  if (sp.view === "weekly") {
    // an unknown ?plan= falls back to the newest plan inside the loader
    const data = await getWeeklyPlanTracker(Number(sp.plan) || null);
    return <WeeklyPlanTrackerTable data={data} />;
  }

  const [rows, user] = await Promise.all([getMasterTracker(), getCurrentUser()]);
  return (
    <MasterTrackerTable
      rows={rows}
      features={user ? [...FEATURE_KEYS.filter((k) => hasPerm(user, k)), ...(user.isAdmin ? ["admin"] : [])] : []}
      // stage columns (Fab/Weld/Paint/SHB/Dlvd) each need their own tracker permission
      editableDepts={user ? [...DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))) : []}
    />
  );
}
