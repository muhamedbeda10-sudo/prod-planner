import { getMasterTracker } from "@/lib/server/masterTracker";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// No page header — the plan-level KPI cards (progress + OTD) live on the
// Dashboard, and the title lives in the nav tab.
export default async function TrackerPage() {
  const [rows, user] = await Promise.all([getMasterTracker(), getCurrentUser()]);
  return <MasterTrackerTable rows={rows} canEdit={!!user && hasPerm(user, "tracker.edit")} />;
}
