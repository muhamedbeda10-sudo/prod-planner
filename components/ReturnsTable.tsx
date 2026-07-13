"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReturnRowDTO } from "@/lib/server/returns";
import { setReturnStatus } from "@/app/worklist/actions";

/** Pieces sent BACK to this department — fix them, record the output again
 *  (normal worklist entry), then mark the return re-delivered. */
export function ReturnsTable({ rows, dept }: { rows: ReturnRowDTO[]; dept: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const open = rows.filter((r) => r.status === "open");

  function setStatus(id: number, status: "open" | "resolved") {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("status", status);
    startTransition(async () => {
      await setReturnStatus(fd);
      router.refresh();
    });
  }

  if (rows.length === 0) return null;

  return (
    <section className="mb-6">
      <h2>
        ↩ Returned to {dept} — fix &amp; re-deliver ({open.reduce((s, r) => s + r.qty, 0)} pcs open)
        {open.length > 0 && <span className="pill pill-bad ml-2 normal-case">action needed</span>}
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
              <th className="p-2 text-center no-print">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === "resolved" ? "opacity-55" : ""}>
                <td className="p-2 whitespace-nowrap tabnum">{r.dateISO}</td>
                <td className="p-2 whitespace-nowrap text-xs font-semibold">{r.fromDept}</td>
                <td className="p-2 text-xs font-semibold whitespace-nowrap">{r.mo || "—"}</td>
                <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-center font-extrabold tabnum text-bad-fg">{r.qty}</td>
                <td className="p-2 text-xs">{r.reason}</td>
                <td className="p-2 text-center whitespace-nowrap no-print">
                  {r.status === "open" ? (
                    <button
                      onClick={() => setStatus(r.id, "resolved")}
                      disabled={pending}
                      className="rounded-md px-2 py-0.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
                      title="The piece was fixed and its output recorded again"
                    >
                      ✓ Re-delivered
                    </button>
                  ) : (
                    <>
                      <span className="pill pill-ok">✓ done</span>
                      <button onClick={() => setStatus(r.id, "open")} disabled={pending} className="text-accent text-xs px-1.5 hover:underline">Reopen</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">
        The returned qty was already deducted from {dept}&apos;s delivered totals — fix the pieces, record them again in the worklist as usual, then mark the row re-delivered.
      </p>
    </section>
  );
}
