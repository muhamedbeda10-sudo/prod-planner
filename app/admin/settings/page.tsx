import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { PageHeader } from "@/components/ui";
import { TankTrackingToggle } from "./TankTrackingToggle";
import { MachinePlanningToggle } from "./MachinePlanningToggle";
import { ShiftHoursForm } from "@/components/ShiftHoursForm";

export const metadata = { title: "Settings — ATC" };
export const dynamic = "force-dynamic";

// Plant-wide switches: per-piece tank tracking, planning onto machines, and the
// hours the plant's shifts are worth — the things that change how several
// screens behave at once, so they live here rather than buried in one of them.
export default async function SettingsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const settings = await getSettings();

  return (
    <div className="max-w-4xl">
      <PageHeader title="⚙️ Settings" />
      <TankTrackingToggle initialOn={settings.tankTracking} />
      <MachinePlanningToggle initialOn={settings.machinePlanning} />
      <ShiftHoursForm short={settings.shiftShortH} long={settings.shiftLongH} overtime={settings.overtimeH} />
    </div>
  );
}
