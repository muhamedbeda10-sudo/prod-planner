"use client";

import { formatDateTime } from "@/lib/domain/format";
import type { RunOrderLineDTO } from "@/lib/server/worklistExtras";

/** 🎯 The approved run order — the sequence an admin committed through the
 *  assistant (apply_run_order). Informational: output is recorded on the normal tables below;
 *  a line leaves this list when this dept's work on it is done. */
export function RunOrderTable({ rows, deptWord }: { rows: RunOrderLineDTO[]; deptWord: string }) {
  if (rows.length === 0) return null;
  const applied = formatDateTime(rows[0].appliedAtISO);
  return (
    <section className="mb-6">
      <h2>
        🎯 Approved run order — work top-down
        <span className="pill pill-muted ml-2 normal-case tabnum">set {`${applied.slice(8, 10)}/${applied.slice(5, 7)}`}</span>
      </h2>
      <div className="border-2 rounded-xl overflow-x-auto bg-surface" style={{ borderColor: "color-mix(in srgb, var(--brand) 45%, transparent)" }}>
        <table className="table-cards w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2 w-12 text-center">#</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center" title={`Still to ${deptWord} on this line`}>Remaining</th>
              <th className="p-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.rank}`}>
                <td className="p-2 text-center font-extrabold tabnum text-brand-ink">{r.rank}</td>
                <td className="p-2 font-bold whitespace-nowrap" title={r.mo}>{r.bom}</td>
                <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-center font-extrabold tabnum">{r.remaining}</td>
                <td className="p-2 text-xs text-muted">
                  {r.batchQty !== null && (
                    <span className="pill pill-warn tabnum" title="a split batch rushed ahead in the run order">
                      {r.batchNo !== null && r.batchNo > 1 ? `✂ batch ${r.batchNo} — ${r.batchQty} pcs` : `✂ first ${r.batchQty} ahead`}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="explain text-[11px] text-muted mt-1">
        Set as the run order through the assistant. Record output on the tables below — a line leaves this list the moment this department&apos;s work on it is done.
      </p>
    </section>
  );
}
