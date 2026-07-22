"use client";

import { useMemo } from "react";
import type { CutTranche, CascadeRow } from "@/lib/domain/execution";
import { CutTrancheTable } from "@/components/CutTrancheTable";
import { CascadeTable } from "@/components/CascadeTable";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { PrintButton } from "@/components/PrintButton";
import { ReturnsTable } from "@/components/ReturnsTable";
import { PriorityOrdersTable } from "@/components/PriorityOrdersTable";
import { HiddenLinesPanel } from "@/components/HiddenLinesPanel";
import type { ReturnRowDTO } from "@/lib/server/returns";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import type { PriorityLineDTO, HiddenLineDTO } from "@/lib/server/worklistExtras";
import { ITEMS, DEFAULTS } from "@/lib/domain/constants";

/** The fabrication page, top to bottom: DATED work (due today + overdue from
 *  ANY weekly plan, under its promised date), admin-postponed lines, this
 *  week's REMARKED date-less lines, and the unscheduled+unremarked backlog in
 *  its own section. Admins can re-date any line (and revert). */
export function CutWorklistView({
  dueNow,
  overdue,
  postponed = [],
  remarked = [],
  unscheduled = [],
  pushed = [],
  priority = [],
  hidden = [],
  day,
  planNo,
  returns = [],
  notes = {},
  capacity = DEFAULTS.capacityPerItem,
  leadDays = DEFAULTS.leadCut,
  canEdit = false,
  isAdmin = false,
}: {
  dueNow: CutTranche[];
  overdue: CutTranche[];
  postponed?: CutTranche[]; // admin re-dated to the future — kept visible for revert
  remarked?: CascadeRow[]; // this week's remarked lines with no known date
  unscheduled?: CascadeRow[]; // open orders with no date and no remark
  pushed?: CascadeRow[]; // sent down from the Plan Tracker — schedule these
  priority?: PriorityLineDTO[]; // ⭐ flagged orders — dedicated table on top
  hidden?: HiddenLineDTO[]; // admin-hidden lines (restore panel)
  day: string;
  planNo: number | null;
  returns?: ReturnRowDTO[];
  notes?: Record<string, QueueNoteDTO[]>; // keyed by bom|mo|item
  capacity?: number; // pcs/item/working day — feeds the at-risk early warning
  leadDays?: number; // fabrication lead: the plan lands this many days ahead of delivery
  canEdit?: boolean; // user holds cut.edit — otherwise view-only
  isAdmin?: boolean; // admins may re-date lines / revert their overrides
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
  const postponedF = useMemo(() => postponed.filter(match), [postponed, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const remarkedF = useMemo(() => remarked.filter(match), [remarked, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const unscheduledF = useMemo(() => unscheduled.filter(match), [unscheduled, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const pushedF = useMemo(() => pushed.filter(match), [pushed, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = dueNow.length + overdue.length + postponed.length + remarked.length + unscheduled.length + pushed.length;
  const shown = dueF.length + overdueF.length + postponedF.length + remarkedF.length + unscheduledF.length + pushedF.length;
  const totalDue = dueF.reduce((s, r) => s + r.remaining, 0);
  const totalOverdue = overdueF.reduce((s, r) => s + r.remaining, 0);
  const totalPostponed = postponedF.reduce((s, r) => s + r.remaining, 0);
  const totalRemarked = remarkedF.reduce((s, r) => s + r.available, 0);
  const totalUnscheduled = unscheduledF.reduce((s, r) => s + r.available, 0);
  const totalPushed = pushedF.reduce((s, r) => s + r.available, 0);

  // per-item workload — the WHOLE dept load (unfiltered): what must still be cut
  const perItem = ITEMS.map((it) => {
    const due = dueNow.filter((r) => r.item === it).reduce((s, r) => s + r.remaining, 0);
    const late = overdue.filter((r) => r.item === it).reduce((s, r) => s + r.remaining, 0);
    return { it, due, late, total: due + late };
  });

  return (
    <>
      {/* search + per-component chips stay pinned below the nav on desktop
          while the worklist tables scroll under them */}
      <div className="md:sticky md:top-16 md:z-20 bg-background">
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
      </div>

      {/* ⭐ the admin's priority orders — a focus list above everything */}
      <PriorityOrdersTable rows={priority} deptWord="cut" />

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
          <CutTrancheTable rows={dueF} day={day} planNo={planNo} variant="due" hideFilter notes={notes} capacity={capacity} canEdit={canEdit} isAdmin={isAdmin} />
        )}
      </section>

      {/* 2 — overdue backlog from ANY week, each line stamped with its original delivery date */}
      <section className="mt-8">
        <h2>
          Overdue backlog — missed delivery dates ({totalOverdue} pcs)
          {totalOverdue > 0 && <span className="pill pill-bad ml-2 normal-case">catch up first</span>}
        </h2>
        <CutTrancheTable rows={overdueF} day={day} planNo={planNo ?? 0} variant="overdue" hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} />
      </section>

      {/* 3 — lines an admin re-dated into the FUTURE: they left today's list
          but stay visible here so the date can be changed back any time */}
      {postponed.length > 0 && (
        <section className="mt-8">
          <h2>
            Re-dated by admin — leaves this list on its new day ({totalPostponed} pcs)
          </h2>
          <CutTrancheTable rows={postponedF} day={day} planNo={planNo ?? 0} variant="due" hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} />
        </section>
      )}

      {/* 3.5 — orders the admin sent DOWN from the Plan Tracker with a chosen
          quantity: waiting to be scheduled here (📅✎ gives them a date) */}
      {pushed.length > 0 && (
        <section className="mt-8">
          <h2>
            📥 Sent from the Plan Tracker — to be scheduled ({totalPushed} pcs)
          </h2>
          <CascadeTable rows={pushedF} day={day} planNo={planNo ?? 0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} />
        </section>
      )}

      {/* 4 — this week's REMARKED lines with no known date: the weekly plan
          flags them (remark column) without scheduling, and no earlier plan
          holds an open date — they work date-less until a plan dates them */}
      {remarked.length > 0 && (
        <section className="mt-8">
          <h2>
            Remarked in this week&apos;s plan — no date yet ({totalRemarked} pcs)
          </h2>
          <CascadeTable rows={remarkedF} day={day} planNo={planNo ?? 0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} />
        </section>
      )}

      {/* 5 — every other OPEN ORDER: no date in any plan, no remark this week.
          Its own section so the scheduled work above stays the focus. */}
      <section className="mt-8">
        <h2 className="text-muted">
          Open orders — not scheduled, no remarks ({totalUnscheduled} pcs)
        </h2>
        <CascadeTable rows={unscheduledF} day={day} planNo={planNo ?? 0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} />
      </section>

      {/* admin-hidden lines — collapsed restore panel */}
      {isAdmin && <HiddenLinesPanel rows={hidden} />}
    </>
  );
}
