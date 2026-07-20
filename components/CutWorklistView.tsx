"use client";

import { useMemo } from "react";
import type { CutTranche, CascadeRow } from "@/lib/domain/execution";
import { CutTrancheTable } from "@/components/CutTrancheTable";
import { CascadeTable } from "@/components/CascadeTable";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { PrintButton } from "@/components/PrintButton";
import { ReturnsTable } from "@/components/ReturnsTable";
import type { ReturnRowDTO } from "@/lib/server/returns";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import { ITEMS, DEFAULTS } from "@/lib/domain/constants";

/** The fabrication page shows work that is either DATED (scheduled in ANY
 *  weekly plan — due today + overdue under its promised date) or REMARKED in
 *  the current weekly plan with no known date (the date-less bucket). Lines
 *  the weekly plan carries unscheduled and unremarked live in the Plan Tracker
 *  and appear here the moment a plan schedules or remarks them. */
export function CutWorklistView({
  dueNow,
  overdue,
  remarked = [],
  day,
  planNo,
  returns = [],
  notes = {},
  capacity = DEFAULTS.capacityPerItem,
  leadDays = DEFAULTS.leadCut,
  canEdit = false,
}: {
  dueNow: CutTranche[];
  overdue: CutTranche[];
  remarked?: CascadeRow[]; // this week's remarked lines with no known date
  day: string;
  planNo: number | null;
  returns?: ReturnRowDTO[];
  notes?: Record<string, QueueNoteDTO[]>; // keyed by bom|mo|item
  capacity?: number; // pcs/item/working day — feeds the at-risk early warning
  leadDays?: number; // fabrication lead: the plan lands this many days ahead of delivery
  canEdit?: boolean; // user holds cut.edit — otherwise view-only
}) {
  // search + item card filter survive navigating away and back
  const [q, setQ] = useSavedFilter("queue.Cut.q");
  const [item, setItem] = useSavedFilter("queue.Cut.item");

  const needle = q.trim().toUpperCase();
  const match = (r: { bom: string; mo: string; description: string; item: string; remark?: string | null }) =>
    (!needle || `${r.bom} ${r.mo} ${r.description} ${r.remark ?? ""}`.toUpperCase().includes(needle)) &&
    (!item || r.item === item);

  const dueF = useMemo(() => dueNow.filter(match), [dueNow, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const overdueF = useMemo(() => overdue.filter(match), [overdue, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const remarkedF = useMemo(() => remarked.filter(match), [remarked, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = dueNow.length + overdue.length + remarked.length;
  const shown = dueF.length + overdueF.length + remarkedF.length;
  const totalDue = dueF.reduce((s, r) => s + r.remaining, 0);
  const totalOverdue = overdueF.reduce((s, r) => s + r.remaining, 0);
  const totalRemarked = remarkedF.reduce((s, r) => s + r.available, 0);

  // per-item workload — the WHOLE dept load (unfiltered): what must still be cut
  const perItem = ITEMS.map((it) => {
    const due = dueNow.filter((r) => r.item === it).reduce((s, r) => s + r.remaining, 0);
    const late = overdue.filter((r) => r.item === it).reduce((s, r) => s + r.remaining, 0);
    return { it, due, late, total: due + late };
  });

  return (
    <>
      <FilterBar count={shown} total={total} showCount={false} onReset={() => { setQ(""); setItem(""); }} hasActive={!!q || !!item}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / description — filters all tables…" />
        {/* what's left per component — tap a card to filter every table to it */}
        <div className="col-span-2 flex flex-wrap items-center gap-1.5">
          {perItem.map(({ it, due, late, total: t }) => (
            <button
              key={it}
              type="button"
              onClick={() => setItem(item === it ? "" : it)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-all hover:border-brand hover:shadow-sm ${item === it ? "border-brand bg-brand-light shadow-sm" : "bg-surface"}`}
              title={
                item === it
                  ? "Click to clear the filter"
                  : `${it}: due ${due} · late ${late} — show only ${it} in every table`
              }
            >
              <span className="text-muted">{it}</span>
              <b className="text-sm tabnum" style={{ color: late > 0 ? "var(--bad-fg)" : "var(--brand)" }}>{t}</b>
            </button>
          ))}
        </div>
        <PrintButton />
      </FilterBar>

      {/* 0 — pieces sent back by Welding: fix first, they re-enter the flow */}
      <ReturnsTable rows={returns} dept="Cut" canEdit={canEdit} />

      {/* 1 — due today (delivery in leadDays days) */}
      <section>
        <h2>Due today — deliver in {leadDays} days ({totalDue} pcs)</h2>
        {planNo === null ? (
          <p className="text-warn-fg bg-warn-bg rounded-lg p-3 inline-block text-sm">
            No weekly plan covers today — import the new weekly schedule. The backlogs below still work.
          </p>
        ) : (
          <CutTrancheTable rows={dueF} day={day} planNo={planNo} variant="due" hideFilter notes={notes} capacity={capacity} canEdit={canEdit} />
        )}
      </section>

      {/* 2 — overdue backlog from ANY week, each line stamped with its original delivery date */}
      <section className="mt-8">
        <h2>
          Overdue backlog — missed delivery dates ({totalOverdue} pcs)
          {totalOverdue > 0 && <span className="pill pill-bad ml-2 normal-case">catch up first</span>}
        </h2>
        <CutTrancheTable rows={overdueF} day={day} planNo={planNo ?? 0} variant="overdue" hideFilter notes={notes} canEdit={canEdit} />
      </section>

      {/* 3 — this week's REMARKED lines with no known date: the weekly plan
          flags them (remark column) without scheduling, and no earlier plan
          holds an open date — they work date-less until a plan dates them */}
      {remarked.length > 0 && (
        <section className="mt-8">
          <h2>
            Remarked in this week&apos;s plan — no date yet ({totalRemarked} pcs)
          </h2>
          <CascadeTable rows={remarkedF} day={day} planNo={planNo ?? 0} hideFilter notes={notes} canEdit={canEdit} />
        </section>
      )}

      {/* unscheduled + unremarked lines are NOT shown here — they live in the
          Plan Tracker (where ahead-of-plan output can be recorded) and appear
          on this screen the moment a weekly plan schedules or remarks them */}
    </>
  );
}
