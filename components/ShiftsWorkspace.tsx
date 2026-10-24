"use client";

import { Activity, ClipboardCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

type WorkspaceTab = "attendance" | "productivity";

export function ShiftsWorkspace({
  attendance,
  productivity,
}: {
  attendance: ReactNode;
  productivity: ReactNode;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("attendance");

  return (
    <section className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-surface shadow-sm print:overflow-visible print:border-0 print:shadow-none">
      <div className="flex h-full min-h-0 flex-col print:h-auto">
        <nav className="tab-strip no-scrollbar flex shrink-0 items-center gap-1 px-3 no-print" aria-label="Shift workspace">
          <button type="button" className={`tab ${tab === "attendance" ? "tab-active" : ""}`} onClick={() => setTab("attendance")}>
            <ClipboardCheck size={16} aria-hidden />
            Daily attendance
          </button>
          <button type="button" className={`tab ${tab === "productivity" ? "tab-active" : ""}`} onClick={() => setTab("productivity")}>
            <Activity size={16} aria-hidden />
            Productivity
          </button>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pb-24 p-3 md:p-4 print:overflow-visible print:p-0">
          {tab === "attendance" ? attendance : productivity}
        </div>
      </div>
    </section>
  );
}
