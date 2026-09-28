"use client";

import { useMemo, useState } from "react";
import type { ConsumableEditView, ConsumableRevisionAction } from "@/lib/server/consumables";
import { RevisionItem } from "@/components/consumablesUi";

// The admin's EDITS view of the CONSUMABLES tab: every change made in the
// period — corrections by the recorders, the admin's own edits, deletes and
// restores — newest first, each with the row as it reads now and a Restore
// that puts the row back the way it read before that change.

const F = "px-2 py-1.5 text-sm font-semibold";
type Filter = "all" | ConsumableRevisionAction;
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "edit", label: "Edits" },
  { key: "delete", label: "Deletes" },
  { key: "restore", label: "Restores" },
];

export function ConsumableEdits({ edits, periodLabel }: { edits: ConsumableEditView[]; periodLabel: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: edits.length, edit: 0, delete: 0, restore: 0 };
    for (const e of edits) c[e.action] += 1;
    return c;
  }, [edits]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return edits.filter((e) =>
      (filter === "all" || e.action === filter) &&
      (!needle || [e.by, e.before, e.after ?? "", e.issue.now, e.issue.recordedBy, ...e.changes].some((v) => v.toLowerCase().includes(needle)))
    );
  }, [edits, filter, q]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 no-print">
        <nav className="seg" aria-label="Kind of change">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
              {f.label} <span className="tabnum">{counts[f.key]}</span>
            </button>
          ))}
        </nav>
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search who, item, worker…"
          aria-label="Search the changes" className={`${F} w-full sm:w-72`}
        />
      </div>

      <section className="bg-surface border rounded-xl overflow-hidden">
        {edits.length === 0 ? (
          <p className="text-sm text-muted p-4">No hand-out was changed {periodLabel}.</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted p-4">No change {periodLabel} matches.</p>
        ) : (
          <ul className="divide-y">
            {shown.map((e) => (
              <li key={e.id} className="p-3 space-y-1">
                <div className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-bold">{e.issue.now}</span>
                  {e.issue.deleted && (
                    <span className="pill pill-bad" title={`Deleted by ${e.issue.deleted.by ?? "?"} at ${e.issue.deleted.atLabel}`}>deleted — off the log</span>
                  )}
                  <span className="text-xs text-muted">handed out {e.issue.issuedAtLabel}, recorded by {e.issue.recordedBy}</span>
                </div>
                <ul className="text-xs">
                  <RevisionItem r={e} version={e.issue.version} deleted={!!e.issue.deleted} />
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
      {edits.length >= 1000 && <p className="text-xs text-muted">Showing the latest 1,000 changes — narrow the period to see the rest.</p>}
    </div>
  );
}
