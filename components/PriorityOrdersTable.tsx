"use client";

import type { PriorityLineDTO } from "@/lib/server/worklistExtras";
import type { SoiLookup } from "@/lib/server/soi";
import { Frac } from "@/components/Frac";
import { Soi } from "@/components/ui";
import { soiOf } from "@/lib/domain/soi";

/** ⭐ The admin's priority orders — a dedicated table on top of every dept
 *  worklist. Informational focus list: output is recorded on the normal
 *  tables below; a line leaves this table when the dept's work is done. */
export function PriorityOrdersTable({ rows, deptWord, soi }: { rows: PriorityLineDTO[]; deptWord: string; soi?: SoiLookup }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.remaining, 0);
  return (
    <section className="mb-6">
      <h2>
        ⭐ Priority orders — work these first ({total} pcs)
        <span className="pill pill-bad ml-2 normal-case">top priority</span>
      </h2>
      <div className="border-2 border-bad-fg/60 rounded-xl overflow-x-auto bg-surface">
        <table className="table-cards w-full text-sm border-collapse">
          <thead>
            <tr className="bg-bad-fg text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2" title="Sales order item">SOI</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center" title={`Whole order: ${deptWord} so far / in-house qty`}>Done / Order</th>
              <th className="p-2 text-center" title={`Still to ${deptWord} on this order`}>Remaining</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.mo}|${r.item}`}>
                <td className="p-2 text-xs font-bold whitespace-nowrap">⭐ {r.mo}</td>
                <td className="p-2 whitespace-nowrap"><Soi soi={soiOf(soi, r.mo, r.bom)} /></td>
                <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-center">
                  <Frac num={r.done} den={r.need} />
                </td>
                <td className="p-2 text-center font-extrabold tabnum" style={{ color: "var(--bad-fg)" }}>{r.remaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="explain text-[11px] text-muted mt-1">
        Flagged on the Plan Tracker (⭐). Record output on the tables below — a line leaves this list the moment its work is done.
      </p>
    </section>
  );
}
