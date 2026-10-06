import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { PageHeader } from "@/components/ui";
import { TankTrackingToggle } from "./TankTrackingToggle";
import { MachinePlanningToggle } from "./MachinePlanningToggle";

export const metadata = { title: "Settings — ATC" };
export const dynamic = "force-dynamic";

// Plant-wide switches: per-piece tank tracking and planning onto machines —
// the things that change how several screens behave at once. What a shift is
// worth is set where the shifts are recorded: the shift log's "Shift hours".
export default async function SettingsPage() {
  await guardTab("/admin/settings");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const settings = await getSettings();

  return (
    <div className="max-w-4xl">
      <PageHeader title="⚙️ Settings" />
      <TankTrackingToggle initialOn={settings.tankTracking} />
      <MachinePlanningToggle initialOn={settings.machinePlanning} />
    </div>
  );
}
