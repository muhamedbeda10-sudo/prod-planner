"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decidePlanQty, importMonthlyAction } from "@/app/orders/actions";
import type { MonthlyImportResult, QtyProposal } from "@/lib/server/importMonthly";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";
import { LV_FAMILIES, LV_FAMILY_LABEL } from "@/lib/domain/lv";

/** The plan import for the product line the toggle is on. The two lines'
 *  sheets differ (a transformer sheet carries KVA and rating, a panel sheet
 *  its Product and OSP Encloser columns) but both are read by header name,
 *  so this one form serves either — it just has to say which it is. */
export function MonthlyImport({ line = "TR" }: { line?: ProductLine }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<MonthlyImportResult | null>(null);
  // "add and update only" by default — taking the month's other orders out
  // has to be chosen on purpose, every time
  const [keep, setKeep] = useState(true);

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
        setKeep(true);
      }
    });
  }

  return (
    <details className="bg-surface border rounded-xl p-4" open>
      <summary className="font-bold cursor-pointer select-none">
        📥 Import monthly plan — <span className="text-brand-ink">{LINE_LABEL[line]}</span> <span className="text-xs text-muted font-normal">(add and update only: new MOs are added, existing MOs get the revision&apos;s changes, nothing is removed{line === "TR" ? " — progress quantities are never read" : ""})</span>
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
            className="border rounded-md px-2 py-1.5 bg-surface text-sm"
          />
        </label>
        {/* the LV line plans two products, each on its own sheet — the
            import revises (and takes off the month) only the picked plan's
            orders, so importing one never touches the other */}
        {line === "LV" && (
          <label className="inline-flex items-center gap-1.5 text-sm">
            <span className="text-muted text-xs font-semibold">Plan</span>
            <select name="family" defaultValue="" className="border rounded-md px-2 py-1.5 bg-surface text-sm" title="Which sheet this is — each plan is revised on its own">
              {LV_FAMILIES.map((f) => <option key={f} value={f}>{LV_FAMILY_LABEL[f]}</option>)}
            </select>
          </label>
        )}
        {/* SAFE BY DEFAULT: the month's orders the sheet does not list are
            kept as they are; unticking is the old "take them out" */}
        <input type="hidden" name="missing" value={keep ? "keep" : "takeOut"} />
        <label className="inline-flex items-center gap-1.5 text-sm font-semibold cursor-pointer">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Keep orders not in the sheet
          {keep ? (
            <span className="text-xs text-muted font-normal">(nothing is ever removed)</span>
          ) : (
            <span className="text-xs text-bad-fg font-semibold">(the month&apos;s open orders missing from the sheet will be deleted, or closed when work was recorded)</span>
          )}
        </label>
        {/* SAFE BY DEFAULT: preview is pre-ticked — nothing is ever written
            until the user unticks it and imports again */}
        <label className="inline-flex items-center gap-1.5 text-sm font-semibold cursor-pointer">
          <input type="checkbox" name="preview" defaultChecked />
          Preview only
          <span className="text-xs text-muted font-normal">(review first — untick to actually apply)</span>
        </label>
        <button type="submit" disabled={pending} className="bg-brand-fill hover:bg-brand-dark text-white font-bold rounded-md px-5 py-2 disabled:opacity-50 transition-colors">
          {pending ? "Importing…" : `Import ${LINE_LABEL[line]} orders`}
        </button>
        <span className="text-xs text-muted">
          The sheet is filed under <b>{LINE_LABEL[line]}</b> — switch the toggle at the top of the page first if it is the other product&apos;s plan.
          New MOs are added; re-importing the SAME month applies the revision: raised quantities, urgency, BOMs… are updated and every change is listed below. Orders of the month that the sheet does not list are left exactly as they are. A quantity that differs from the registry&apos;s is never changed by the import — it is flagged with the old and the new figure, and you choose which one stays. Columns are read by header name — any sheet layout month to month.{line === "LV" ? " The meter boxes' sheet has no BOM column: its FG Code stands in, and its OSP column is the quantity bought outside." : ""}
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
            New MOs {res.preview ? "to add" : "added"}: <b>{res.added}</b> · {res.preview ? "to update" : "updated"}: <b>{res.updatedMos ?? 0}</b> · quantity changes held: <b>{res.qtyProposals?.length ?? 0}</b> · {res.preview ? "to remove" : "removed"}: <b>{res.removed?.length ?? 0}</b> · unchanged: <b>{(res.existing ?? 0) - (res.updatedMos ?? 0)}</b> · registry total: <b>{res.totalOrders}</b>
          </div>
          {res.keepMissing !== false && (res.notInSheet ?? 0) > 0 && (
            <div className="bg-info-bg text-info-fg rounded-md px-3 py-2 text-xs font-semibold">
              {res.notInSheet} open MO{res.notInSheet === 1 ? "" : "s"} of this month {res.notInSheet === 1 ? "is" : "are"} not in the sheet — kept exactly as {res.notInSheet === 1 ? "it is" : "they are"}: not deleted, not closed, not taken off the month.
            </div>
          )}

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
                    <tr className="bg-brand-fill text-white text-left sticky top-0">
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

          {/* a different qty on an order already in the registry — held, never
              applied by the import; the planner decides here or on the tracker */}
          {res.qtyProposals && res.qtyProposals.length > 0 && (
            <QtyDecisions proposals={res.qtyProposals} preview={!!res.preview} />
          )}

          {/* MOs that vanished from the revision — taken off the registry,
              only when "Keep orders not in the sheet" was unticked */}
          {res.removed && res.removed.length > 0 && (
            <div className="bg-warn-bg text-warn-fg rounded-md px-3 py-2 text-xs space-y-1">
              <b>⚠ Taken off this month’s plan ({res.removed.length}) — in the registry but missing from the sheet{res.preview ? " (will be applied)" : ""}:</b>
              <div>
                {res.removed.map((r) => (
                  <span key={r.mo} className="inline-block me-2">
                    <b>{r.mo}</b> <span className="opacity-80">{r.action === "deleted" ? "deleted" : "closed (has recorded work)"}</span>
                  </span>
                ))}
              </div>
              <div className="opacity-80">An order nothing was ever recorded on is deleted; one the daily log names is closed and keeps its history.</div>
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

/** The quantities the import held back: registry vs sheet, per MO, with a
 *  choice each — use the sheet's figure or keep the one the registry has.
 *  Undecided ones stay flagged (⚠) on the tracker. */
function QtyDecisions({ proposals, preview }: { proposals: QtyProposal[]; preview: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<Record<string, "use" | "keep">>({});
  const [err, setErr] = useState("");
  const open = proposals.filter((p) => !done[p.mo]);
  const decide = (mos: string[], decision: "use" | "keep") => {
    const fd = new FormData();
    fd.set("mos", mos.join(","));
    fd.set("decision", decision);
    setErr("");
    start(async () => {
      const r = await decidePlanQty(fd);
      if (!r.ok) { setErr(r.error ?? "Could not save."); return; }
      setDone((cur) => ({ ...cur, ...Object.fromEntries(mos.map((m) => [m, decision])) }));
      router.refresh();
    });
  };
  return (
    <div className="border-2 border-warn-fg/50 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <div className="text-sm font-bold text-warn-fg">
          ⚠ Quantity differs from the registry ({proposals.length}) — {preview ? "will be held for your decision" : "not changed, your call"}
        </div>
        {!preview && open.length > 1 && (
          <div className="ms-auto flex gap-2">
            <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => decide(open.map((p) => p.mo), "use")}>Use all new ({open.length})</button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={() => decide(open.map((p) => p.mo), "keep")}>Keep all old</button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-left text-muted border-b">
              <th className="p-1.5">MO</th>
              <th className="p-1.5">BOM</th>
              <th className="p-1.5 text-center">Old qty (registry)</th>
              <th className="p-1.5 text-center">New qty (sheet)</th>
              <th className="p-1.5 text-center">Already produced</th>
              <th className="p-1.5">{preview ? "" : "Decision"}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {proposals.map((p) => {
              const d = done[p.mo];
              return (
                <tr key={p.mo} className={d ? "opacity-60" : ""}>
                  <td className="p-1.5 font-semibold whitespace-nowrap">
                    {p.mo}
                    {p.carried && <span className="pill pill-warn ms-1 text-[10px]" title="In an earlier month's plan too — carried over">🔁 carried</span>}
                  </td>
                  <td className="p-1.5 whitespace-nowrap">{p.bom}</td>
                  <td className="p-1.5 text-center tabnum font-bold">{p.from}</td>
                  <td className="p-1.5 text-center tabnum font-bold text-warn-fg">
                    {p.to} <span className="text-muted font-normal">({p.to > p.from ? "+" : ""}{Math.round((p.to - p.from) * 1000) / 1000})</span>
                  </td>
                  <td className="p-1.5 text-center tabnum" style={{ color: p.produced > p.to ? "var(--bad-fg)" : "inherit" }}>
                    {p.produced}{p.produced > p.to ? " — above the new qty!" : ""}
                  </td>
                  <td className="p-1.5 whitespace-nowrap">
                    {preview ? null : d ? (
                      <span className="font-bold">{d === "use" ? `✓ now ${p.to}` : `✓ kept ${p.from}`}</span>
                    ) : (
                      <span className="inline-flex gap-1.5">
                        <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => decide([p.mo], "use")}>Use {p.to}</button>
                        <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={() => decide([p.mo], "keep")}>Keep {p.from}</button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {err && <p className="text-xs font-semibold text-bad-fg mt-1">{err}</p>}
      <div className="text-[11px] text-muted mt-1">
        The import never changes a quantity on its own. Until you choose, the order keeps its old quantity and shows ⚠ on the Plan Tracker, where you can decide too.
      </div>
    </div>
  );
}
