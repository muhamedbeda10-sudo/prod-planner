"use client";

import { Fragment, useState } from "react";
import { pctStyle } from "@/components/ui";
import { deptLabel, FINISHING_LABEL } from "@/lib/domain/constants";
import { PVA_PLANNED, type PlanVsActual, type PvaCell, type PvaItem } from "@/lib/domain/planVsActual";

/* Plan vs actual — the weekly plan's promise against what was really recorded.
   Two tables (day by day, project by project); every row expands to the
   per-component split, which is where "how many of THIS item were due and how
   many did we make" is answered. */

const stageLabel = (dept: string) => (dept === "Painting" ? FINISHING_LABEL : deptLabel(dept));
const pct = (c: PvaCell) => (c.scheduled > 0 ? c.done / c.scheduled : null);

function Cells({ c, planned }: { c: PvaCell; planned: boolean }) {
  const p = pct(c);
  return (
    <>
      <td className="p-1.5 text-center tabnum text-xs text-muted">
        {planned ? c.scheduled || <span className="opacity-40">—</span> : <span className="opacity-40" title="delivery carries no plan date">—</span>}
      </td>
      <td className="p-1.5 text-center tabnum text-xs font-bold">{c.done || <span className="text-muted opacity-40">—</span>}</td>
      <td className="p-1.5 text-center tabnum text-xs font-bold" style={p === null ? undefined : pctStyle(p)}>
        {p === null ? <span className="text-muted opacity-40">—</span> : `${Math.round(p * 100)}%`}
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
            <th className="p-1 font-medium border-l border-border-strong" title="what the weekly plan promised">Plan</th>
            <th className="p-1 font-medium" title="what was actually recorded">Done</th>
            <th className="p-1 font-medium">%</th>
          </Fragment>
        ))}
      </tr>
    </thead>
  );
}

/** The per-component sub-rows under an expanded day / project. */
function ItemRows({ items, stages }: { items: PvaItem[]; stages: readonly string[] }) {
  if (items.length === 0) {
    return (
      <tr className="bg-brand-light/10">
        <td colSpan={1 + stages.length * 3} className="p-2 text-center text-xs text-muted">
          No component activity.
        </td>
      </tr>
    );
  }
  return (
    <>
      {items.map((it) => (
        <tr key={it.item} className="bg-brand-light/10 text-center">
          <td className="p-1.5 text-left font-bold text-xs pl-7">
            <span className="text-muted mr-1">↳</span>{it.item}
          </td>
          {stages.map((s) => (
            <Cells key={s} c={it.perStage[s]} planned={PVA_PLANNED.includes(s as never)} />
          ))}
        </tr>
      ))}
    </>
  );
}

function Expander({ open }: { open: boolean }) {
  return <span className={`inline-block mr-1 text-[10px] transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>;
}

export function PlanVsActualTables({ pva, stages }: { pva: PlanVsActual; stages: readonly string[] }) {
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [openBoms, setOpenBoms] = useState<Set<string>>(new Set());
  const [expandAll, setExpandAll] = useState(false);
  const toggle = (set: Set<string>, k: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    fn(n);
  };
  const dayOpen = (iso: string) => expandAll || openDays.has(iso);
  const bomOpen = (bom: string) => expandAll || openBoms.has(bom);

  const cols = 1 + stages.length * 3;
  const projects = pva.projects.filter((p) => p.scheduled > 0 || p.done > 0);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h3 className="font-bold text-sm">Day by day</h3>
        <button
          type="button"
          onClick={() => setExpandAll((v) => !v)}
          className="no-print btn btn-ghost btn-sm"
          title="Show every component split at once"
        >
          {expandAll ? "Collapse components" : "Expand components"}
        </button>
        <span className="text-[11px] text-muted">click a row to see how many of each component were due and made</span>
      </div>

      <div className="bg-surface border rounded-xl overflow-x-auto print-fit mb-4">
        <table className="w-full text-sm border-collapse">
          <Head first={<th rowSpan={2} className="p-2 text-left">Day</th>} stages={stages} />
          <tbody>
            {pva.days.length === 0 && <tr><td colSpan={cols} className="p-4 text-center text-muted">No days in this period.</td></tr>}
            {pva.days.map((d, i) => {
              const open = dayOpen(d.iso);
              return (
                <Fragment key={d.iso}>
                  <tr
                    className={`text-center cursor-pointer hover:bg-brand-light/30 transition-colors ${i % 2 ? "bg-zebra" : ""} ${d.isOff ? "opacity-70" : ""}`}
                    onClick={() => toggle(openDays, d.iso, setOpenDays)}
                    title={open ? "Hide the component split" : "Show the component split"}
                  >
                    <td className="p-2 text-left font-bold whitespace-nowrap">
                      <Expander open={open} />
                      {d.label}
                      {d.isOff && <span className="pill pill-muted ml-1">{d.offName ?? "off"}</span>}
                    </td>
                    {stages.map((s) => (
                      <Cells key={s} c={d.perStage[s]} planned={PVA_PLANNED.includes(s as never)} />
                    ))}
                  </tr>
                  {open && <ItemRows items={d.items} stages={stages} />}
                </Fragment>
              );
            })}
            <tr className="text-center font-extrabold border-t-2">
              <td className="p-2 text-left">Period total</td>
              {stages.map((s) => (
                <Cells key={s} c={pva.totals[s]} planned={PVA_PLANNED.includes(s as never)} />
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h3 className="font-bold text-sm">By project</h3>
        <span className="pill pill-ok normal-case">{projects.length} project{projects.length === 1 ? "" : "s"}</span>
      </div>
      <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
        <table className="w-full text-sm border-collapse">
          <Head first={<th rowSpan={2} className="p-2 text-left">BOM</th>} stages={stages} />
          <tbody>
            {projects.length === 0 && (
              <tr><td colSpan={cols} className="p-4 text-center text-muted">Nothing planned or recorded in this period.</td></tr>
            )}
            {projects.map((p, i) => {
              const open = bomOpen(p.bom);
              return (
                <Fragment key={p.bom}>
                  <tr
                    className={`text-center cursor-pointer hover:bg-brand-light/30 transition-colors ${i % 2 ? "bg-zebra" : ""}`}
                    onClick={() => toggle(openBoms, p.bom, setOpenBoms)}
                    title={open ? "Hide the component split" : "Show the component split"}
                  >
                    <td className="p-2 text-left font-bold whitespace-nowrap">
                      <Expander open={open} />
                      {p.bom}
                    </td>
                    {stages.map((s) => (
                      <Cells key={s} c={p.perStage[s]} planned={PVA_PLANNED.includes(s as never)} />
                    ))}
                  </tr>
                  {open && <ItemRows items={p.items} stages={stages} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
