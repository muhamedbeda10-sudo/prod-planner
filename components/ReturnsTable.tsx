"use client";

import { formatDate } from "@/lib/domain/format";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReturnRowDTO } from "@/lib/server/returns";
import { redeliverReturn } from "@/app/worklist/actions";
import { deptLabel } from "@/lib/domain/constants";

/** Pieces sent BACK to this department. Fix them, then hit "Fixed &
 *  re-delivered" — the qty goes straight back on this dept's ledger, the line
 *  reappears downstream, and the row leaves this screen (audit stays in the
 *  daily logs). */
export function ReturnsTable({ rows, dept, canEdit = false }: { rows: ReturnRowDTO[]; dept: string; canEdit?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function redeliver(r: ReturnRowDTO) {
    if (!confirm(`${r.mo || r.bom} ${r.item} ×${r.qty} is fixed and handed over again? It goes straight back to the ${deptLabel(r.fromDept)} queue.`)) return;
    const fd = new FormData();
    fd.set("id", String(r.id));
    setErr("");
    startTransition(async () => {
      const res = await redeliverReturn(fd);
      if (res.ok) router.refresh();
      else setErr(res.error ?? "Failed");
    });
  }

  if (rows.length === 0) return null;

  return (
    <section className="mb-6">
      <h2>
        ↩ Returned to {deptLabel(dept)} — fix &amp; re-deliver ({rows.reduce((s, r) => s + r.qty, 0)} pcs)
        <span className="pill pill-bad ml-2 normal-case">action needed</span>
      </h2>
      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-bad-fg text-white text-left">
              <th className="p-2">Returned on</th>
              <th className="p-2">From</th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2">Reason</th>
              <th className="p-2 text-center no-print w-44"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="p-2 whitespace-nowrap tabnum">{formatDate(r.dateISO)}</td>
                <td className="p-2 whitespace-nowrap text-xs font-semibold">{deptLabel(r.fromDept)}</td>
                <td className="p-2 text-xs font-semibold whitespace-nowrap">{r.mo || "—"}</td>
                <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-center font-extrabold tabnum text-bad-fg">{r.qty}</td>
                <td className="p-2 text-xs">{r.reason}</td>
                <td className="p-2 text-center whitespace-nowrap no-print">
                  {canEdit ? (
                    <button
                      onClick={() => redeliver(r)}
                      disabled={pending}
                      className="rounded-md px-2.5 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50 transition-colors"
                      title={`Adds ${r.qty} back to ${deptLabel(dept)}'s total — it reappears in the ${deptLabel(r.fromDept)} queue immediately`}
                    >
                      ✓ Fixed &amp; re-delivered
                    </button>
                  ) : (
                    <span className="text-muted text-xs" title="View only — you don't have this department's edit permission">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p className="text-xs text-bad-fg mt-1 font-semibold">{err}</p>}
    </section>
  );
}
