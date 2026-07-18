"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importMonthlyAction } from "@/app/orders/actions";
import type { MonthlyImportResult } from "@/lib/server/importMonthly";

export function MonthlyImport() {
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
      if (r.ok) {
        router.refresh();
        inputRef.current?.form?.reset();
      }
    });
  }

  return (
    <details className="bg-surface border rounded-xl p-4" open>
      <summary className="font-bold cursor-pointer select-none">
        📥 Import monthly plan <span className="text-xs text-muted font-normal">(existing MOs are left untouched — only new MOs are added)</span>
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
        <button type="submit" disabled={pending} className="bg-brand hover:bg-brand-dark text-white font-bold rounded-md px-5 py-2 disabled:opacity-50 transition-colors">
          {pending ? "Importing…" : "Import orders"}
        </button>
        <span className="text-xs text-muted">New MOs are tagged with the plan month (e.g. “July 2026”). Columns are read by header name (MO., BoM Ref., SOI, PLAN QTY…) — any sheet layout month to month.</span>
      </form>

      {res && !res.ok && (
        <div className="mt-3 bg-bad-bg text-bad-fg rounded-md px-3 py-2 text-sm font-semibold">{res.error}</div>
      )}
      {res && res.ok && (
        <div className="mt-3 space-y-2">
          <div className="bg-ok-bg text-ok-fg rounded-md px-3 py-2 text-sm font-semibold">
            New orders added: <b>{res.added}</b> · already in the registry: <b>{res.existing}</b> · registry total: <b>{res.totalOrders}</b>
          </div>
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

          {/* comparison report — display only */}
          {res.comparison && (
            <div className="border rounded-lg p-3">
              <div className="text-sm font-bold mb-1">
                Comparison report — sheet vs system{" "}
                <span className="pill pill-muted ml-1">report only, nothing was changed</span>
              </div>
              {res.comparison.length === 0 ? (
                <p className="text-ok-fg text-sm font-semibold">
                  ✓ All {res.comparedCells} cells match — the sheet agrees with our logs.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted mb-2">
                    {res.comparison.length} of {res.comparedCells} cells differ (sheet − system). Positive = the sheet claims MORE done than our logs; negative = we logged more than the sheet.
                  </p>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="bg-brand text-white text-left sticky top-0">
                          <th className="p-1.5">MO</th>
                          <th className="p-1.5">BOM</th>
                          <th className="p-1.5 text-center">Item</th>
                          <th className="p-1.5">Stage</th>
                          <th className="p-1.5 text-center">Sheet</th>
                          <th className="p-1.5 text-center">System</th>
                          <th className="p-1.5 text-center">Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {res.comparison.map((c, i) => (
                          <tr key={i}>
                            <td className="p-1.5 whitespace-nowrap font-semibold">{c.mo}</td>
                            <td className="p-1.5 whitespace-nowrap">{c.bom}</td>
                            <td className="p-1.5 text-center font-bold">{c.item}</td>
                            <td className="p-1.5">{c.stage}</td>
                            <td className="p-1.5 text-center tabnum">{c.sheet}</td>
                            <td className="p-1.5 text-center tabnum">{c.system}</td>
                            <td className="p-1.5 text-center tabnum font-bold" style={{ color: c.diff > 0 ? "var(--warn-fg)" : "var(--bad-fg)" }}>
                              {c.diff > 0 ? `+${c.diff}` : c.diff}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
