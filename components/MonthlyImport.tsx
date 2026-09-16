"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importMonthlyAction } from "@/app/orders/actions";
import type { MonthlyImportResult } from "@/lib/server/importMonthly";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";

/** The plan import for the product line the toggle is on. The two lines'
 *  sheets differ (a transformer sheet carries KVA and rating, a panel sheet
 *  its Product and OSP Encloser columns) but both are read by header name,
 *  so this one form serves either — it just has to say which it is. */
export function MonthlyImport({ line = "TR" }: { line?: ProductLine }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<MonthlyImportResult | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setRes(null);
    startTransition(async () => {
      const r = await importMonthlyAction(fd);
      setRes(r);
      // after a real APPLY refresh and clear the form; after a PREVIEW keep
      // the chosen file and month so "untick → import again" applies it
      if (r.ok && !r.preview) {
        router.refresh();
        inputRef.current?.form?.reset();
      }
    });
  }

  return (
    <details className="bg-surface border rounded-xl p-4" open>
      <summary className="font-bold cursor-pointer select-none">
        📥 Import monthly plan — <span className="text-accent">{LINE_LABEL[line]}</span> <span className="text-xs text-muted font-normal">(order data only: new MOs are added, existing MOs get the revision&apos;s changes{line === "TR" ? " — progress quantities are never read" : ""})</span>
      </summary>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-3">
        <input ref={inputRef} name="file" type="file" accept=".xlsx,.xlsm,.xls" required
          className="border rounded-md px-2 py-2 bg-surface text-sm w-full max-w-full sm:w-auto" />
        <label className="inline-flex items-center gap-1.5 text-sm">
          <span className="text-muted text-xs font-semibold">Plan month</span>
          <input
            name="month"
            type="month"
            required
            defaultValue={new Date().toISOString().slice(0, 7)}
            className="border rounded-md px-2 py-1.5 bg-surface text-sm"
          />
        </label>
        {/* SAFE BY DEFAULT: preview is pre-ticked — nothing is ever written
            until the user unticks it and imports again */}
        <label className="inline-flex items-center gap-1.5 text-sm font-semibold cursor-pointer">
          <input type="checkbox" name="preview" defaultChecked className="accent-[var(--brand)]" />
          Preview only
          <span className="text-xs text-muted font-normal">(review first — untick to actually apply)</span>
        </label>
        <button type="submit" disabled={pending} className="bg-brand hover:bg-brand-dark text-white font-bold rounded-md px-5 py-2 disabled:opacity-50 transition-colors">
          {pending ? "Importing…" : `Import ${LINE_LABEL[line]} orders`}
        </button>
        <span className="text-xs text-muted">
          The sheet is filed under <b>{LINE_LABEL[line]}</b> — switch the toggle at the top of the page first if it is the other product&apos;s plan.
          New MOs are added; re-importing the SAME month applies the revision: raised quantities, urgency, BOMs… are updated and every change is listed below. A LOWERED quantity is never applied automatically — it is flagged and you change it manually on the tracker. Columns are read by header name — any sheet layout month to month.
        </span>
      </form>

      {res && !res.ok && (
        <div className="mt-3 bg-bad-bg text-bad-fg rounded-md px-3 py-2 text-sm font-semibold">{res.error}</div>
      )}
      {res && res.ok && (
        <div className="mt-3 space-y-2">
          {res.preview && (
            <div className="bg-warn-bg text-warn-fg rounded-md px-3 py-2 text-sm font-bold">
              👁 PREVIEW ONLY — nothing was saved. Untick “Preview only” and import again to apply.
            </div>
          )}
          <div className="bg-ok-bg text-ok-fg rounded-md px-3 py-2 text-sm font-semibold">
            New orders {res.preview ? "to add" : "added"}: <b>{res.added}</b> · revised MOs {res.preview ? "to update" : "updated"}: <b>{res.updatedMos ?? 0}</b> · unchanged: <b>{(res.existing ?? 0) - (res.updatedMos ?? 0)}</b> · registry total: <b>{res.totalOrders}</b>
          </div>

          {/* the revision diff — every field that changed, old → new */}
          {res.changes && res.changes.length > 0 && (
            <div className="border rounded-lg p-3">
              <div className="text-sm font-bold mb-1">
                Revision changes ({res.changes.length})
                {!res.preview && <span className="pill pill-ok ml-2 normal-case">applied</span>}
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-brand text-white text-left sticky top-0">
                      <th className="p-1.5">MO</th>
                      <th className="p-1.5">Field</th>
                      <th className="p-1.5">Old</th>
                      <th className="p-1.5">New</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.changes.map((c, i) => (
                      <tr key={i}>
                        <td className="p-1.5 whitespace-nowrap font-semibold">{c.mo}</td>
                        <td className="p-1.5 whitespace-nowrap font-bold">{c.field}</td>
                        <td className="p-1.5 text-muted line-through decoration-[var(--bad-fg)]/60">{c.from}</td>
                        <td className="p-1.5 font-bold text-ok-fg">{c.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* qty DECREASES — never applied automatically, the planner confirms
              them on the tracker (Required cell) */}
          {res.qtyReductions && res.qtyReductions.length > 0 && (
            <div className="border border-warn-fg/40 rounded-lg p-3">
              <div className="text-sm font-bold mb-1 text-warn-fg">
                ⚠ Quantity DECREASED in the sheet ({res.qtyReductions.length}) — NOT applied
              </div>
              <table className="w-full text-xs border-collapse max-w-xl">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="p-1">MO</th>
                    <th className="p-1 text-center">Registry qty</th>
                    <th className="p-1 text-center">Sheet qty</th>
                    <th className="p-1 text-center">Already produced</th>
                  </tr>
                </thead>
                <tbody>
                  {res.qtyReductions.map((d) => (
                    <tr key={d.mo}>
                      <td className="p-1 font-semibold whitespace-nowrap">{d.mo}</td>
                      <td className="p-1 text-center tabnum">{d.from}</td>
                      <td className="p-1 text-center tabnum font-bold text-warn-fg">{d.to}</td>
                      <td className="p-1 text-center tabnum" style={{ color: d.produced > d.to ? "var(--bad-fg)" : "inherit" }}>
                        {d.produced}{d.produced > d.to ? " — above the new qty!" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[11px] text-muted mt-1">
                Confirm with planning, then change the Required quantity manually on the Plan Tracker (click the number).
              </div>
            </div>
          )}

          {/* MOs that vanished from the revision — flagged, never auto-closed */}
          {res.missingFromSheet && res.missingFromSheet.length > 0 && (
            <div className="bg-warn-bg text-warn-fg rounded-md px-3 py-2 text-xs">
              <b>⚠ In the registry but MISSING from this sheet ({res.missingFromSheet.length}):</b>{" "}
              {res.missingFromSheet.join(", ")} — possibly cancelled by planning. Nothing was changed for them; close them from the Plan Tracker if confirmed.
            </div>
          )}
          {res.addedMos && res.addedMos.length > 0 && (
            <details className="text-xs text-muted">
              <summary>New MOs ({res.added})</summary>
              <ul className="list-disc ml-5 mt-1">{res.addedMos.map((m) => <li key={m}>{m}</li>)}</ul>
            </details>
          )}
          {res.issues && res.issues.length > 0 && (
            <div className="bg-warn-bg text-warn-fg rounded-md px-3 py-2 text-xs">
              <b>Notes:</b>
              <ul className="list-disc ml-5 mt-0.5">{res.issues.slice(0, 10).map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
          )}

        </div>
      )}
    </details>
  );
}
