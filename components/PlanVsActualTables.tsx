"use client";

import { Fragment, useState } from "react";
import { pctStyle } from "@/components/ui";
import { deptLabel, FINISHING_LABEL } from "@/lib/domain/constants";
import type { PlanVsActual, PvaCell, PvaItem } from "@/lib/domain/planVsActual";

/* Plan vs actual — for the work DUE in the period, how much of it is done.
   Every row expands to its per-component split, which answers "how many of
   THIS item were due and how many are done". */

const stageLabel = (dept: string) => (dept === "Painting" ? FINISHING_LABEL : deptLabel(dept));
const ratio = (c: PvaCell) => (c.due > 0 ? c.done / c.due : null);

/** Due | Done | % for one stage. `Extra` (output beyond the promise) rides on
 *  the Done cell so the table stays three columns per stage. */
function Cells({ c }: { c: PvaCell }) {
  const r = ratio(c);
  const extra = Math.max(0, c.output - c.done); // unplanned or ahead-of-plan work
  return (
    <>
      <td className="p-1.5 text-center tabnum text-xs text-muted">{c.due || <span className="opacity-40">—</span>}</td>
      <td className="p-1.5 text-center tabnum text-xs font-bold whitespace-nowrap">
        {c.done || <span className="text-muted opacity-40">—</span>}
        {extra > 0 && (
          <span className="text-[9px] font-bold text-accent ml-0.5" title={`${extra} pcs recorded beyond what was due`}>
            +{extra}
          </span>
        )}
      </td>
      <td className="p-1.5 text-center tabnum text-xs font-bold" style={r === null ? undefined : pctStyle(r)}>
        {r === null ? <span className="text-muted opacity-40">—</span> : `${Math.round(r * 100)}%`}
      </td>
    </>
  );
}

/** The two-row header shared by both tables: a stage group per column trio. */
function Head({ first, stages }: { first: React.ReactNode; stages: readonly string[] }) {
  return (
    <thead>
      <tr className="bg-brand text-white text-center">
        {first}
        {stages.map((s) => (
          <th key={s} colSpan={3} className="p-2 border-l border-border-strong">{stageLabel(s)}</th>
        ))}
      </tr>
      <tr className="bg-brand-dark text-white text-[10px]">
        {stages.map((s) => (
          <Fragment key={s}>
            <th className="p-1 font-medium border-l border-border-strong" title="pcs the weekly plan promised for this stage">Due</th>
            <th className="p-1 font-medium" title="how many of those pcs are actually done (+N = extra work beyond the promise)">Done</th>
            <th className="p-1 font-medium">%</th>
          </Fragment>
        ))}
      </tr>
    </thead>
  );
}

function ItemRows({ items, stages }: { items: PvaItem[]; stages: readonly string[] }) {
  if (items.length === 0) {
    return (
      <tr className="bg-brand-light/10">
        <td colSpan={1 + stages.length * 3} className="p-2 text-center text-xs text-muted">No component activity.</td>
      </tr>
    );
  }
  return (
    <>
      {items.map((it) => (
        <tr key={it.item} className="bg-brand-light/10 text-center">
          <td className="p-1.5 text-left font-bold text-xs pl-7"><span className="text-muted mr-1">↳</span>{it.item}</td>
          {stages.map((s) => <Cells key={s} c={it.perStage[s]} />)}
        </tr>
      ))}
    </>
  );
}

function Expander({ open }: { open: boolean }) {
  return <span className={`inline-block mr-1 text-[10px] transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>;
}

/** Projects with what was due of each component and how much is done. */
export function PlanVsActualProjects({ pva, stages }: { pva: PlanVsActual; stages: readonly string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const cols = 1 + stages.length * 3;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h2 className="text-lg font-bold">Projects — due vs done</h2>
        <span className="pill pill-ok normal-case">{pva.projects.length} project{pva.projects.length === 1 ? "" : "s"}</span>
        <button type="button" onClick={() => setAll((v) => !v)} className="no-print btn btn-ghost btn-sm">
          {all ? "Collapse components" : "Expand components"}
        </button>
        <span className="text-[11px] text-muted">click a project to see each component · +N = work done beyond the promise</span>
      </div>
      <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
        <table className="w-full text-sm border-collapse">
          <Head first={<th rowSpan={2} className="p-2 text-left">Project (BOM)</th>} stages={stages} />
          <tbody>
            {pva.projects.length === 0 && (
              <tr><td colSpan={cols} className="p-4 text-center text-muted">Nothing was due or recorded in this period.</td></tr>
            )}
            {pva.projects.map((p, i) => {
              const isOpen = all || open.has(p.bom);
              return (
                <Fragment key={p.bom}>
                  <tr
                    className={`text-center cursor-pointer hover:bg-brand-light/30 transition-colors ${i % 2 ? "bg-zebra" : ""}`}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(p.bom)) n.delete(p.bom); else n.add(p.bom); return n; })}
                  >
                    <td className="p-2 text-left font-bold whitespace-nowrap"><Expander open={isOpen} />{p.bom}</td>
                    {stages.map((s) => <Cells key={s} c={p.perStage[s]} />)}
                  </tr>
                  {isOpen && <ItemRows items={p.items} stages={stages} />}
                </Fragment>
              );
            })}
            <tr className="text-center font-extrabold border-t-2">
              <td className="p-2 text-left">Total</td>
              {stages.map((s) => <Cells key={s} c={pva.totals[s]} />)}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Day-by-day: what each day promised and how much of it is done. Only worth
 *  showing when the report spans more than one day. */
export function PlanVsActualDays({ pva, stages }: { pva: PlanVsActual; stages: readonly string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const cols = 1 + stages.length * 3;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h2 className="text-lg font-bold">Day by day</h2>
        <button type="button" onClick={() => setAll((v) => !v)} className="no-print btn btn-ghost btn-sm">
          {all ? "Collapse components" : "Expand components"}
        </button>
        <span className="text-[11px] text-muted">what each day promised, and how much of that promise is covered</span>
      </div>
      <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
        <table className="w-full text-sm border-collapse">
          <Head first={<th rowSpan={2} className="p-2 text-left">Day</th>} stages={stages} />
          <tbody>
            {pva.days.length === 0 && <tr><td colSpan={cols} className="p-4 text-center text-muted">No days in this period.</td></tr>}
            {pva.days.map((d, i) => {
              const isOpen = all || open.has(d.iso);
              return (
                <Fragment key={d.iso}>
                  <tr
                    className={`text-center cursor-pointer hover:bg-brand-light/30 transition-colors ${i % 2 ? "bg-zebra" : ""} ${d.isOff ? "opacity-70" : ""}`}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(d.iso)) n.delete(d.iso); else n.add(d.iso); return n; })}
                  >
                    <td className="p-2 text-left font-bold whitespace-nowrap">
                      <Expander open={isOpen} />
                      {d.label}
                      {d.isOff && <span className="pill pill-muted ml-1">{d.offName ?? "off"}</span>}
                    </td>
                    {stages.map((s) => <Cells key={s} c={d.perStage[s]} />)}
                  </tr>
                  {isOpen && <ItemRows items={d.items} stages={stages} />}
                </Fragment>
              );
            })}
            <tr className="text-center font-extrabold border-t-2">
              <td className="p-2 text-left">Period total</td>
              {stages.map((s) => <Cells key={s} c={pva.totals[s]} />)}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
