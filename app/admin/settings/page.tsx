import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { countTanksByStatus } from "@/lib/server/tanks";
import { PageHeader } from "@/components/ui";
import { TankTrackingToggle } from "./TankTrackingToggle";
import { ClearTankRecords } from "./ClearTankRecords";

export const metadata = { title: "Settings — ATC" };
export const dynamic = "force-dynamic";

// Plant-wide switches. Today that is per-piece tank tracking: the master switch
// that decides whether tanks are followed piece by piece at all, and the way to
// wipe what a trial run left behind.
export default async function SettingsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const [settings, tanks] = await Promise.all([getSettings(), countTanksByStatus()]);

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="⚙️ Settings" />
      <TankTrackingToggle initialOn={settings.tankTracking} />
      <ClearTankRecords total={tanks.total} byStatus={tanks.byStatus} />
    </div>
  );
}
