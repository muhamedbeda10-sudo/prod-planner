import { getMasterTracker } from "@/lib/server/masterTracker";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { DEPTS, DELIVERED_STAGE } from "@/lib/domain/constants";
import { trackerPermKey } from "@/lib/domain/permissions";

export const dynamic = "force-dynamic";

// Tracker features each carry their OWN permission key — deliberately separate
// from the worklist permissions (a Cut-worklist user can't touch the tracker's
// Fab column unless given tracker.cut explicitly).
const FEATURE_KEYS = ["tracker.status", "tracker.components", "tracker.qty", "tracker.priority", "tracker.push"];

// No page header — the plan-level KPI cards (progress + OTD) live on the
// Dashboard, and the title lives in the nav tab.
export default async function TrackerPage() {
  const [rows, user] = await Promise.all([getMasterTracker(), getCurrentUser()]);
  return (
    <MasterTrackerTable
      rows={rows}
      features={user ? FEATURE_KEYS.filter((k) => hasPerm(user, k)) : []}
      // stage columns (Fab/Weld/Paint/Dlvd) each need their own tracker permission
      editableDepts={user ? [...DEPTS, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))) : []}
    />
  );
}
