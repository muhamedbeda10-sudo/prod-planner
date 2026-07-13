"use client";

import { useMemo, useState } from "react";
import type { CutTranche, CascadeRow } from "@/lib/domain/execution";
import { CutTrancheTable } from "@/components/CutTrancheTable";
import { CascadeTable } from "@/components/CascadeTable";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { PrintButton } from "@/components/PrintButton";
import { ITEMS } from "@/lib/domain/constants";

/** The cut page's three tables under ONE shared filter — typing once narrows
 *  due-today, overdue and the undated backlog together. */
export function CutWorklistView({
  dueNow,
  overdue,
  cascade,
  day,
  planNo,
}: {
  dueNow: CutTranche[];
  overdue: CutTranche[];
  cascade: CascadeRow[];
  day: string;
  planNo: number | null;
}) {
  const [q, setQ] = useState("");
  const [item, setItem] = useState("");

  const needle = q.trim().toUpperCase();
  const match = (r: { bom: string; mo: string; description: string; item: string }) =>
    (!needle || `${r.bom} ${r.mo} ${r.description}`.toUpperCase().includes(needle)) &&
    (!item || r.item === item);

  const dueF = useMemo(() => dueNow.filter(match), [dueNow, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const overdueF = useMemo(() => overdue.filter(match), [overdue, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const cascadeF = useMemo(() => cascade.filter(match), [cascade, needle, item]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = dueNow.length + overdue.length + cascade.length;
  const shown = dueF.length + overdueF.length + cascadeF.length;
  const totalDue = dueF.reduce((s, r) => s + r.remaining, 0);
  const totalOverdue = overdueF.reduce((s, r) => s + r.remaining, 0);
  const totalPool = cascadeF.reduce((s, r) => s + r.available, 0);

  return (
    <>
      <FilterBar count={shown} total={total} onReset={() => { setQ(""); setItem(""); }} hasActive={!!q || !!item}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / description — filters all tables…" />
        <SelectFilter
          label="Item"
          value={item}
          onChange={setItem}
          options={ITEMS.map((it) => ({ value: it, label: it }))}
        />
        <span className="text-xs text-muted">
          Due <b className="text-foreground tabnum">{totalDue}</b> · overdue{" "}
          <b className="text-foreground tabnum">{totalOverdue}</b> · backlog pool{" "}
          <b className="text-foreground tabnum">{totalPool}</b> pcs
        </span>
        <PrintButton />
      </FilterBar>

      {/* 1 — due today (delivery in 2 days) */}
      <section>
        <h2>Due today — deliver in 2 days ({totalDue} pcs)</h2>
        {planNo === null ? (
          <p className="text-warn-fg bg-warn-bg rounded-lg p-3 inline-block text-sm">
            No weekly plan covers today — import the new weekly schedule. The backlogs below still work.
          </p>
        ) : (
          <CutTrancheTable rows={dueF} day={day} planNo={planNo} variant="due" hideFilter />
        )}
      </section>

      {/* 2 — overdue backlog, each line stamped with its original delivery date */}
      <section className="mt-8">
        <h2>
          Overdue backlog — missed delivery dates ({totalOverdue} pcs)
          {totalOverdue > 0 && <span className="pill pill-bad ml-2 normal-case">catch up first</span>}
        </h2>
        <CutTrancheTable rows={overdueF} day={day} planNo={planNo ?? 0} variant="overdue" hideFilter />
      </section>

      {/* 3 — undated backlog from the monthly registry */}
      <section className="mt-8">
        <h2>Backlog without dates — monthly registry ({totalPool} pcs)</h2>
        <CascadeTable rows={cascadeF} day={day} planNo={planNo ?? 0} hideFilter />
      </section>
    </>
  );
}
