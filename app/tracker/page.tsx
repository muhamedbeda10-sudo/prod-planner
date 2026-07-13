import { getMasterTracker } from "@/lib/server/masterTracker";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";

export const dynamic = "force-dynamic";

// No page header — the plan-level KPI cards (progress + OTD) live on the
// Dashboard, and the title lives in the nav tab.
export default async function TrackerPage() {
  const rows = await getMasterTracker();
  return <MasterTrackerTable rows={rows} />;
}
