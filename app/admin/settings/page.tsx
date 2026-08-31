import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { PageHeader } from "@/components/ui";
import { TankTrackingToggle } from "./TankTrackingToggle";

export const metadata = { title: "Settings — ATC" };
export const dynamic = "force-dynamic";

// Plant-wide switches. Today that is the master switch for per-piece tank
// tracking — the one thing that changes how several screens behave at once, so
// it lives here rather than being buried in one of them.
export default async function SettingsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const settings = await getSettings();

  return (
    <div className="max-w-4xl">
      <PageHeader title="⚙️ Settings" />
      <TankTrackingToggle initialOn={settings.tankTracking} />
    </div>
  );
}
