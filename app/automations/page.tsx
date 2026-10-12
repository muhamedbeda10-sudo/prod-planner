import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { aiVisibleFor } from "@/lib/server/ai/access";
import { AUTOMATIONS_KEY } from "@/lib/server/automations/store";
import { automationsClock } from "@/lib/server/automations/scheduler";
import { automationViews } from "@/lib/server/automations/views";
import { PageHead } from "@/components/ui";
import { AutomationsView } from "@/components/AutomationsView";

export const metadata = { title: "Automations — ATC" };
export const dynamic = "force-dynamic";
// a test run of a report waits for the assistant
export const maxDuration = 300;

// A person's automations: what the assistant does by itself for them. They
// are made and changed by asking the assistant; here they are watched,
// paused, tested and deleted.

export default async function AutomationsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const [views, ai, clock] = await Promise.all([automationViews({ ownerId: me.id }), aiVisibleFor(me), automationsClock()]);
  const allowed = hasPerm(me, AUTOMATIONS_KEY);
  if (!allowed && views.length === 0) redirect("/");

  return (
    <div>
      <PageHead title="Automations" sub="What the assistant does by itself for you — made by asking it" />
      {clock.paused && <p className="mb-3 text-sm font-semibold text-warn-fg">The owner has paused every automation — none runs until they turn them back on.</p>}
      {!clock.paused && clock.stale && (
        <p className="mb-3 text-sm text-muted">
          Automations run on time only once the owner sets up the scheduler (AI assistant settings → Automations); until then they run while the app is open somewhere.
        </p>
      )}
      {!allowed && <p className="mb-3 text-sm text-warn-fg">You no longer have automations — the ones below are stopped. The owner can give them back on Users &amp; Permissions.</p>}
      <AutomationsView automations={views} ai={ai && allowed} />
      {me.isOwner && (
        <p className="mt-4 text-xs text-muted">Everyone&apos;s automations are on <Link href="/admin/ai" className="underline">AI assistant settings</Link>.</p>
      )}
    </div>
  );
}
