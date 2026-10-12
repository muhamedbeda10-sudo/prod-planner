"use client";

import { useState, useTransition } from "react";
import { Clock } from "lucide-react";
import { removeAutomationClock, setupAutomationClock } from "@/app/admin/ai/actions";
import { AutomationsView } from "@/components/AutomationsView";
import { formatDateTime } from "@/lib/domain/format";
import type { AutomationView } from "@/lib/server/automations/views";
import type { SchedulerStatus } from "@/lib/server/automations/scheduler";

// The owner's view of the automations: the clock that runs them on time
// (the database's scheduler), and every automation in the plant — each can be
// paused, tested or deleted here; changed only by its owner.

export function AutomationsAdmin({ clock, automations }: { clock: SchedulerStatus; automations: AutomationView[] }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setMsg(null);
    start(async () => {
      try {
        const r = await fn();
        setMsg(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error ?? "It did not go through." });
      } catch {
        setMsg({ ok: false, text: "The request failed — refresh the page and try again." });
      }
    });
  };
  const failing = clock.lastJobRuns.find((r) => r.status !== "succeeded");
  return (
    <section className="card p-4 mt-4 space-y-3">
      <h2 className="flex items-center gap-2"><Clock size={18} aria-hidden /> Automations</h2>
      <div className="text-sm space-y-1">
        {clock.scheduled ? (
          <p><span className="pill pill-ok text-[11px]">On time</span> The database&apos;s scheduler calls the app every minute{clock.lastTickAt ? ` — last tick ${formatDateTime(clock.lastTickAt)}` : ""}.</p>
        ) : (
          <p>
            <span className="pill pill-warn text-[11px]">No scheduler</span> Automations run only while the app is open somewhere{clock.lastTickAt ? ` (last tick ${formatDateTime(clock.lastTickAt)})` : ""}. Set up the database&apos;s own scheduler
            (Supabase pg_cron, free) so they run on time, day and night.
          </p>
        )}
        {failing && <p className="text-bad-fg">The scheduler&apos;s last run: {failing.status}{failing.message ? ` — ${failing.message}` : ""}</p>}
        {clock.error && <p className="text-bad-fg">{clock.error}</p>}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => run(setupAutomationClock, clock.scheduled ? "Set the scheduler up again? It gets a new secret; the old one stops working at once." : undefined)}>
          {clock.scheduled ? "Set it up again" : "Set up the scheduler"}
        </button>
        {clock.scheduled && (
          <button type="button" className="btn btn-sm" disabled={pending} onClick={() => run(removeAutomationClock, "Remove the scheduler? Automations will then run only while the app is open somewhere.")}>Remove</button>
        )}
        {msg && <span className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
      </div>
      <h3 className="pt-2">Everyone&apos;s automations</h3>
      <AutomationsView automations={automations} showOwner ai={false} />
    </section>
  );
}
