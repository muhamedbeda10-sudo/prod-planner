import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { PageHead, ReadingColumn } from "@/components/ui";
import { TankTrackingToggle } from "./TankTrackingToggle";
import { MachinePlanningToggle } from "./MachinePlanningToggle";
import { OdooTrackingStart } from "@/components/OdooTrackingStart";

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
    <ReadingColumn className="space-y-4">
      <PageHead title="Settings" sub="Plant-wide switches — what changes how several screens behave at once" />
      <TankTrackingToggle initialOn={settings.tankTracking} />
      <MachinePlanningToggle initialOn={settings.machinePlanning} />
      <section className="bg-surface border rounded-xl p-4 space-y-3">
        <h2 className="font-bold">Odoo monthly plan tracking</h2>
        <OdooTrackingStart initialDate={settings.odooTrackingFrom} />
      </section>
    </ReadingColumn>
  );
}
