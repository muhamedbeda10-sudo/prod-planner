"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMachinePlanning } from "./actions";

// One switch for the worklists, the shift log, the machines and planning work
// onto them — they all serve one job, so they are turned on together and off
// together. Off, their tabs and pages are gone and the Floor tab opens the
// what-if simulator; nothing is deleted.

export function MachinePlanningToggle({ initialOn }: { initialOn: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initialOn);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function flip(next: boolean) {
    const fd = new FormData();
    fd.set("on", String(next));
    setMsg(null);
    startTransition(async () => {
      const res = await setMachinePlanning(fd);
      if (res.ok) {
        setOn(next);
        setMsg({ ok: true, text: next ? "Worklists, shifts and machine planning are on." : "Worklists, shifts and machine planning are off." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Failed to save." });
      }
    });
  }

  return (
    <div className="border rounded-xl p-5 space-y-4 mt-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-[260px]">
          <h2 className="text-sm font-extrabold flex items-center gap-2">
            🏭 Worklists, shifts & machine planning
            <span className={`pill ${on ? "pill-ok" : "pill-muted"}`}>{on ? "ON" : "OFF"}</span>
          </h2>
          <p className="text-sm text-muted mt-1">
            The department worklists, the shift log, the machines with their times per piece, and the spread of the work over
            them: which machine each line is on, its place in that machine&apos;s queue, and the Floor view of every bay. One
            switch turns them all on or off.
          </p>
        </div>
        <button
          type="button"
          onClick={() => flip(!on)}
          disabled={pending}
          className={`rounded-md px-4 py-2 text-sm font-bold text-white disabled:opacity-50 ${on ? "bg-bad-fg hover:opacity-90" : "bg-brand hover:bg-brand-dark"}`}
        >
          {pending ? "Saving…" : on ? "Turn OFF" : "Turn ON"}
        </button>
      </div>

      {msg && <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>}

      <div className="grid gap-3 sm:grid-cols-2 border-t pt-3 text-sm">
        <div>
          <div className="font-bold mb-1">While it is ON</div>
          <ul className="text-muted space-y-0.5 list-disc pl-4">
            <li>The Worklist and Shifts tabs are in the bar</li>
            <li>Admin Tools lists Machines &amp; Lines and Times per Machine</li>
            <li>The Fabrication, Welding and Painting worklists show the machine board</li>
            <li>Every line carries a Machine picker and the on-machine / to-place filter</li>
            <li>The Floor tab opens the bay drawings with what each machine is on</li>
            <li>The printable machine sheets are available</li>
          </ul>
        </div>
        <div>
          <div className="font-bold mb-1">While it is OFF</div>
          <ul className="text-muted space-y-0.5 list-disc pl-4">
            <li>The Worklist and Shifts tabs are gone, and so are Machines &amp; Lines and Times per Machine</li>
            <li>The dashboard drops attendance, downtime and the shift-log line</li>
            <li>The Floor tab opens the what-if simulator</li>
            <li>Assignments already made stay saved and come back when you turn it on</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
