import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { Boxes } from "lucide-react";
import { PageHead } from "@/components/ui";
import { SectionCard } from "@/components/primitives";
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
    <div className="space-y-3">
      <PageHead title="Settings" sub="Plant-wide switches — what changes how several screens behave at once" />
      {/* side by side on a wide screen, one under the other on a narrow one */}
      <div className="grid gap-4 xl:grid-cols-2 items-start">
        <TankTrackingToggle initialOn={settings.tankTracking} />
        <MachinePlanningToggle initialOn={settings.machinePlanning} />
        <SectionCard icon={<Boxes size={16} aria-hidden />} title="Odoo monthly plan tracking" description="Where the tracker starts reading Odoo's closings into the monthly plan">
          <OdooTrackingStart initialDate={settings.odooTrackingFrom} />
        </SectionCard>
      </div>
    </div>
  );
}
