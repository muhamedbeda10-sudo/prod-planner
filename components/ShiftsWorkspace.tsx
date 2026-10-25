"use client";

import { Activity, CalendarDays, ClipboardCheck, Clock3, Wrench } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { ShiftHistory } from "@/components/ShiftHistory";
import type { RosterDept } from "@/lib/domain/shifts";
import type { RosterFilter } from "@/lib/domain/roster";
import type { ShiftHistoryDay } from "@/lib/server/shifts";

export type WorkspaceTab = "attendance" | "downtime" | "productivity" | "history" | "hours";

export function ShiftsWorkspace({ attendance, downtime, downtimeCount, productivity, history, dayISO, filter, hours, editableDepts, today, initialView = "attendance" }: {
  editableDepts: RosterDept[];
  today: string;
  initialView?: WorkspaceTab;
  attendance: ReactNode;
  /** The day's machine stops. */
  downtime: ReactNode;
  downtimeCount: number;
  productivity: ReactNode;
  history: readonly ShiftHistoryDay[];
  dayISO: string;
  filter: RosterFilter;
  /** Supplied only for admins who may change the plant's shift hours. */
  hours?: ReactNode;
}) {
  const [tab, setTab] = useState<WorkspaceTab>(initialView);
  const [navigation, setNavigation] = useState({ dayISO, initialView });
  if (navigation.dayISO !== dayISO || navigation.initialView !== initialView) {
    setNavigation({ dayISO, initialView }); setTab(initialView);
  }
  // Remount cleared-day drafts only after refreshed server content arrives.
  const [reset, setReset] = useState<{ before: ReactNode; revision: number } | null>(null);
  const revision = reset ? reset.before === attendance ? reset.revision - 1 : reset.revision : 0;
  const id = useId();
  const tabs = [
    { key: "attendance", label: "Daily attendance", icon: ClipboardCheck },
    { key: "downtime", label: downtimeCount > 0 ? `Machine stops · ${downtimeCount}` : "Machine stops", icon: Wrench },
    { key: "productivity", label: "Productivity", icon: Activity },
    { key: "history", label: "Recorded days", icon: CalendarDays },
    ...(hours ? [{ key: "hours", label: "Shift hours", icon: Clock3 }] : []),
  ] as const;

  const selectTab = (view: WorkspaceTab) => {
    setTab(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    // Native history updates the URL without refetching the roster or discarding drafts.
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  return (
    <section className="shifts-workspace rounded-xl border bg-surface shadow-sm print:border-0 print:shadow-none">
      <nav className="tab-strip flex flex-wrap items-center gap-1 px-3 no-print" aria-label="Shift workspace" role="tablist">
        {tabs.map(({ key, label, icon: Icon }, index) => (
          <button key={key} id={`${id}-${key}-tab`} type="button" role="tab" aria-selected={tab === key} aria-controls={`${id}-${key}`} tabIndex={tab === key ? 0 : -1} className={`tab ${tab === key ? "tab-active" : ""}`} onClick={() => selectTab(key as WorkspaceTab)} onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            selectTab(tabs[next].key as WorkspaceTab);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
          }}><Icon size={16} aria-hidden />{label}</button>
        ))}
      </nav>
      {/* Keep every pane mounted: switching to history or hours must retain an unsaved roster. */}
      <div id={`${id}-attendance`} role="tabpanel" aria-labelledby={`${id}-attendance-tab`} hidden={tab !== "attendance"} className="p-3 md:p-4 print:p-0"><div key={revision}>{attendance}</div></div>
      <div id={`${id}-downtime`} role="tabpanel" aria-labelledby={`${id}-downtime-tab`} hidden={tab !== "downtime"} className="p-3 md:p-4 no-print"><div key={revision}>{downtime}</div></div>
      <div id={`${id}-productivity`} role="tabpanel" aria-labelledby={`${id}-productivity-tab`} hidden={tab !== "productivity"} className="p-3 md:p-4 print:p-0">{productivity}</div>
      <div id={`${id}-history`} role="tabpanel" aria-labelledby={`${id}-history-tab`} hidden={tab !== "history"} className="p-3 md:p-4 print:p-0"><ShiftHistory history={history} dayISO={dayISO} filter={filter} editableDepts={editableDepts} today={today} onOpenDay={(view = "attendance") => setTab(view)} onDeleted={(date) => { if (date === dayISO) setReset((r) => ({ before: attendance, revision: (r?.revision ?? 0) + 1 })); }} /></div>
      {hours && <div id={`${id}-hours`} role="tabpanel" aria-labelledby={`${id}-hours-tab`} hidden={tab !== "hours"} className="p-3 md:p-4 no-print">{hours}</div>}
    </section>
  );
}
