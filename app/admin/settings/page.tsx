import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { backupLoginState } from "@/lib/server/backupLogin";
import { backupLinks } from "@/lib/domain/backup";
import { formatDateTime } from "@/lib/domain/format";
import { PageHead } from "@/components/ui";
import { TankTrackingToggle } from "./TankTrackingToggle";
import { MachinePlanningToggle } from "./MachinePlanningToggle";
import { BackupLogin } from "./BackupLogin";

export const metadata = { title: "Settings — ATC" };
export const dynamic = "force-dynamic";
// making the backup's password logs in with it once, a few tries
export const maxDuration = 60;

// Plant-wide switches: per-piece tank tracking and planning onto machines —
// the things that change how several screens behave at once. What a shift is
// worth is set where the shifts are recorded: the shift log's "Shift hours".
// The owner also finds the nightly backup's own login here.
export default async function SettingsPage() {
  await guardTab("/admin/settings");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const settings = await getSettings();
  const backup = me.isOwner ? await backupLoginState() : null;

  return (
    <div className="max-w-4xl space-y-4">
      <PageHead title="Settings" sub="Plant-wide switches — what changes how several screens behave at once" />
      <TankTrackingToggle initialOn={settings.tankTracking} />
      <MachinePlanningToggle initialOn={settings.machinePlanning} />
      {backup && (
        <BackupLogin
          exists={backup.exists}
          on={backup.on}
          changed={backup.changedAt ? `${formatDateTime(backup.changedAt)}${backup.changedBy ? ` by ${backup.changedBy}` : ""}` : null}
          links={backupLinks({ provider: process.env.VERCEL_GIT_PROVIDER, owner: process.env.VERCEL_GIT_REPO_OWNER, slug: process.env.VERCEL_GIT_REPO_SLUG })}
        />
      )}
    </div>
  );
}
