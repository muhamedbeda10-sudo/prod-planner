"use client";

import { trackerHref } from "@/lib/domain/links";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importPlanAction } from "@/app/import/actions";
import type { ImportResult } from "@/lib/server/import";

export function ImportForm({ defaultDate }: { defaultDate: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<ImportResult | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setRes(null);
    startTransition(async () => {
      const r = await importPlanAction(fd);
      setRes(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="bg-surface border rounded-xl p-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className="block text-xs font-semibold text-muted mb-1">Plan file (Excel)</span>
          <input name="file" type="file" accept=".xlsx,.xlsm,.xls" required className="w-full border rounded-md px-2 py-2 bg-surface" />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-muted mb-1">Plan number</span>
          <input name="planNo" type="number" min={1} required className="ctl w-full font-bold" />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-muted mb-1">Real week start date</span>
          <input name="startDate" type="date" defaultValue={defaultDate} required className="ctl w-full font-bold" />
        </label>
        <label className="block md:col-span-2">
          <span className="block text-xs font-semibold text-muted mb-1">
            Sheet name <span className="font-normal">(optional)</span>
          </span>
          <input name="sheet" type="text" placeholder="auto" className="ctl w-full" />
        </label>
        <div className="md:col-span-2">
          <button type="submit" disabled={pending} className="bg-brand-fill text-white font-extrabold rounded-md px-6 py-2.5 disabled:opacity-50">
            {pending ? "Importing…" : "Import plan"}
          </button>
          <span className="explain text-xs text-muted ml-3">Re-importing the same number replaces that plan&apos;s rows (idempotent).</span>
        </div>
      </form>

      {res && !res.ok && (
        <div className="bg-bad-bg text-bad-fg rounded-md px-3 py-2 font-semibold text-sm">{res.error}</div>
      )}
      {res && res.ok && (
        <div className="space-y-3">
          <div className="bg-ok-bg text-ok-fg rounded-md px-3 py-2 font-semibold text-sm">
            Imported plan {res.planNo}{res.sheetName ? ` from sheet “${res.sheetName}”` : ""}: {res.orderCount} order rows, {res.scheduleCount} schedule rows.
          </div>
          {res.warnings && res.warnings.length > 0 && (
            <div className="bg-warn-bg text-warn-fg rounded-md p-3">
              <div className="font-bold mb-1">Warnings ({res.warnings.length}):</div>
              <ul className="text-xs list-disc ml-5 space-y-0.5">
                {res.warnings.slice(0, 40).map((w, i) => (
                  <li key={i}>Row {w.row}{w.mo ? ` — ${w.mo}` : ""}: {w.message}</li>
                ))}
              </ul>
            </div>
          )}
          <a href={trackerHref(res.planNo, undefined, "TR")} className="text-brand-ink font-semibold text-sm">→ View tracker for plan {res.planNo}</a>
        </div>
      )}
    </div>
  );
}
