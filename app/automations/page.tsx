import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { automationsData } from "@/lib/server/ai/panel";
import { PageHead } from "@/components/ui";
import { AutomationsView } from "@/components/AutomationsView";

export const metadata = { title: "Automations — ATC" };
export const dynamic = "force-dynamic";
// a test run of a report waits for the assistant
export const maxDuration = 300;

// A person's automations: what the assistant does by itself for them. What
// one does is made and changed by asking the assistant; here they are
// watched, timed, paused, tested and deleted.

export default async function AutomationsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const d = await automationsData(me);
  if (!d.allowed && d.automations.length === 0) redirect("/");

  return (
    <div className="max-w-4xl">
      <PageHead
        title="Automations"
        sub={d.hours}
        actions={
          d.paused ? (
            <span className="pill pill-warn">Paused by the owner</span>
          ) : (
            <span className={`pill ${d.inHours ? "pill-ok" : "pill-muted"}`}>{d.inHours ? "Running" : "Outside hours"}</span>
          )
        }
      />
      {!d.allowed && <p className="mb-3 text-sm text-warn-fg">Stopped — you no longer have automations.</p>}
      <AutomationsView automations={d.automations} canTime={d.allowed} />
    </div>
  );
}
