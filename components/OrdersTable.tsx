"use client";

import { traceHref } from "@/lib/domain/links";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { deleteOrders, previewOrderDelete, updateOrder } from "@/app/orders/actions";
import type { OrderDeletePreview } from "@/lib/server/orderDelete";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";
import { filterOrderRows, type OrderRow } from "@/lib/domain/registryView";

export type { OrderRow };

/** The registry of ONE product line. A transformer reads by its KVA, rating
 *  and colour; an LV panel by its type (LSS / USS), its SEC item, the
 *  enclosures bought outside and what the sheet said about its parts — so
 *  the middle of the table is the line's, and the rest is shared. */
export function OrdersTable({ rows, line = "TR", lineSwitch }: {
  rows: OrderRow[];
  line?: ProductLine;
  /** The page's Transformers | LV Panels switch, first in the filter bar. */
  lineSwitch?: React.ReactNode;
}) {
  const lv = line === "LV";
  // filters survive navigating away and back (sessionStorage per tab)
  const [q, setQ] = useSavedFilter("orders.q");
  const [urgent, setUrgent] = useSavedFilter("orders.urgent");
  const [source, setSource] = useSavedFilter("orders.source");

  // Taking an import back out. Picking rows is free; what they carry is only
  // counted when the planner asks to delete, and the answer is shown before
  // anything is removed.
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<OrderDeletePreview[] | null>(null);
  const [force, setForce] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  // one row at a time turns into inputs; Save writes every field of it at once
  const [editing, setEditing] = useState<string | null>(null);
  const [editErr, setEditErr] = useState("");

  function saveRow(form: HTMLFormElement, mo: string) {
    const fd = new FormData(form);
    fd.set("mo", mo);
    setEditErr("");
    startTransition(async () => {
      const res = await updateOrder(fd);
      if (res.ok) { setEditing(null); router.refresh(); }
      else setEditErr(res.error ?? "Failed");
    });
  }

  const sources = useMemo(() => [...new Set(rows.map((r) => r.source ?? ""))].filter(Boolean).sort(), [rows]);

  const filtered = useMemo(() => filterOrderRows(rows, { q, urgent, source }), [rows, q, urgent, source]);

  const hasActive = !!(q || urgent || source);
  const totalQty = filtered.reduce((s, r) => s + r.planQty, 0);

  const shown = filtered.map((r) => r.mo);
  const allShownPicked = shown.length > 0 && shown.every((mo) => picked.has(mo));
  const toggle = (mo: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(mo)) next.delete(mo); else next.add(mo);
      return next;
    });
  const toggleAllShown = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (allShownPicked) shown.forEach((mo) => next.delete(mo));
      else shown.forEach((mo) => next.add(mo));
      return next;
    });
  const clearPicked = () => { setPicked(new Set()); setConfirm(null); setForce(false); setErr(""); };

  function askDelete() {
    const fd = new FormData();
    fd.set("mos", [...picked].join(","));
    setErr(""); setMsg("");
    startTransition(async () => {
      const res = await previewOrderDelete(fd);
      if (res.ok && res.rows) { setConfirm(res.rows); setForce(false); }
      else setErr(res.error ?? "Failed");
    });
  }

  function doDelete() {
    const fd = new FormData();
    fd.set("mos", [...picked].join(","));
    if (force) fd.set("force", "true");
    setErr("");
    startTransition(async () => {
      const res = await deleteOrders(fd);
      if (res.ok) {
        setMsg(
          `${res.deleted} order(s) removed from the registry` +
          (res.keptLedgerRows ? ` — ${res.keptLedgerRows} daily-log entr${res.keptLedgerRows === 1 ? "y" : "ies"} kept as history.` : ".")
        );
        clearPicked();
        router.refresh();
      } else setErr(res.error ?? "Failed");
    });
  }

  const withHistory = (confirm ?? []).filter((c) => c.loggedRows > 0 || c.tanks > 0);

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setUrgent(""); setSource(""); }} hasActive={hasActive} head={lineSwitch}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / FG…" />
        <SelectFilter label="Urgent" value={urgent} onChange={setUrgent} options={[{ value: "yes", label: "Urgent only" }, { value: "no", label: "Not urgent" }]} />
        {sources.length > 1 && (
          <SelectFilter label="Source" value={source} onChange={setSource} options={sources.map((s) => ({ value: s, label: s }))} />
        )}
        <span className="text-xs text-muted">Total qty (shown): <b className="text-foreground tabnum">{totalQty}</b></span>
        {picked.size > 0 && (
          <span className="inline-flex items-center gap-2">
            <b className="text-xs tabnum">{picked.size} picked</b>
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearPicked} disabled={pending}>clear</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={askDelete} disabled={pending}>🗑 Delete…</button>
          </span>
        )}
      </FilterBar>

      {msg && <p className="text-sm font-semibold text-ok-fg">{msg}</p>}
      {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}

      {/* What the delete would take, said out loud before it happens. */}
      {confirm && (
        <div className="bg-surface border-2 border-bad-fg rounded-xl p-3 space-y-2">
          <b className="text-bad-fg">Remove {confirm.length} order(s) from the registry?</b>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-muted">
                  <th className="p-1">MO</th>
                  <th className="p-1">BOM</th>
                  <th className="p-1 text-center">Plan qty</th>
                  <th className="p-1 text-center" title="Pieces already recorded in the daily log against this MO — they STAY">Logged</th>
                  <th className="p-1 text-center" title="Serial-tracked tanks born from this order — they STAY">Tanks</th>
                  <th className="p-1 text-center" title="Worklist dates, hidden lines, pushes, machine placements, run order and queue notes — these GO with the order">Planning rows</th>
                </tr>
              </thead>
              <tbody>
                {confirm.map((c) => (
                  <tr key={c.mo} className={c.loggedRows > 0 || c.tanks > 0 ? "text-bad-fg font-semibold" : ""}>
                    <td className="p-1 font-bold whitespace-nowrap">{c.mo}</td>
                    <td className="p-1 whitespace-nowrap">{c.bom}</td>
                    <td className="p-1 text-center tabnum">{c.planQty}</td>
                    <td className="p-1 text-center tabnum">{c.loggedRows > 0 ? `${c.loggedQty} pcs · ${c.loggedRows} row(s)` : "—"}</td>
                    <td className="p-1 text-center tabnum">{c.tanks || "—"}</td>
                    <td className="p-1 text-center tabnum">{c.planningRows || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            The order and its planning rows go. Daily-log entries, returns, tracked tanks, material lines and Odoo rows are
            history and stay exactly as recorded — they simply stop naming an order the registry knows.
          </p>
          {withHistory.length > 0 && (
            <label className="flex items-center gap-2 text-sm font-semibold text-bad-fg">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              {withHistory.length} of them already have work recorded — delete anyway
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={doDelete}
              disabled={pending || (withHistory.length > 0 && !force)}
            >
              {pending ? "Deleting…" : `Delete ${confirm.length} order(s)`}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)} disabled={pending}>Cancel</button>
          </div>
        </div>
      )}

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2 w-8 text-center">
                <input
                  type="checkbox"
                  checked={allShownPicked}
                  onChange={toggleAllShown}
                  aria-label="Pick every order shown"
                  title={allShownPicked ? "Unpick the rows shown" : "Pick every row the filters show"}
                />
              </th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">SOI</th>
              <th className="p-2">Customer</th>
              <th className="p-2 text-center">Urgent</th>
              <th className="p-2">FG Code</th>
              {lv ? (
                <>
                  <th className="p-2 text-center" title="The panel type on the plan: LSS or USS">Product</th>
                  <th className="p-2">SEC Item</th>
                  <th className="p-2 text-center">Planned Qty</th>
                  <th className="p-2 text-center" title="Enclosures bought outside rather than made here">OSP Encl.</th>
                  <th className="p-2">Remarks</th>
                  <th className="p-2">Materials</th>
                </>
              ) : (
                <>
                  <th className="p-2 text-center">KVA</th>
                  <th className="p-2">Rating</th>
                  <th className="p-2 text-center">Plan Qty</th>
                  <th className="p-2">RAL</th>
                </>
              )}
              <th className="p-2">Added</th>
              <th className="p-2 w-16 no-print" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={lv ? 15 : 13} className="p-4 text-center text-muted">
                {rows.length === 0 ? `No ${LINE_LABEL[line]} orders yet — import their monthly plan above.` : "No rows match the filters."}
              </td></tr>
            )}
            {filtered.map((r) => (editing === r.mo ? (
              <EditRow key={r.id} r={r} lv={lv} pending={pending} err={editErr} onSave={(form) => saveRow(form, r.mo)} onCancel={() => { setEditing(null); setEditErr(""); }} />
            ) : (
              <tr key={r.id} className={picked.has(r.mo) ? "bg-brand-light/40" : ""}>
                <td className="p-2 text-center">
                  <input
                    type="checkbox"
                    checked={picked.has(r.mo)}
                    onChange={() => toggle(r.mo)}
                    aria-label={`Pick ${r.mo}`}
                  />
                </td>
                <td className="p-2 font-bold whitespace-nowrap text-xs">{r.mo}</td>
                <td className="p-2 font-bold whitespace-nowrap">
                  <Link href={traceHref({ bom: r.bom, line })} className="text-brand-ink hover:underline">{r.bom}</Link>
                </td>
                <td className="p-2 text-xs whitespace-nowrap">{r.soi ?? "—"}</td>
                <td className="p-2 text-xs whitespace-nowrap">{r.customer ?? <span className="text-muted">—</span>}</td>
                <td className="p-2 text-center">{r.urgent && <span className="pill pill-bad">URGENT</span>}</td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.fgCode ?? "—"}</td>
                {lv ? (
                  <>
                    <td className="p-2 text-center"><span className="pill pill-muted">{r.product ?? "—"}</span></td>
                    <td className="p-2 text-xs whitespace-nowrap tabnum text-muted">{r.secItem ?? "—"}</td>
                    <td className="p-2 text-center font-extrabold tabnum">{r.planQty}</td>
                    <td className="p-2 text-center tabnum">{r.ospEncloser > 0 ? r.ospEncloser : <span className="text-muted">—</span>}</td>
                    <td className="p-2 text-xs max-w-[12rem]">{r.remarks ?? <span className="text-muted">—</span>}</td>
                    <td className="p-2 text-xs max-w-[16rem]">{r.materialsRemarks ?? <span className="text-muted">—</span>}</td>
                  </>
                ) : (
                  <>
                    <td className="p-2 text-center tabnum">{r.kva ?? "—"}</td>
                    <td className="p-2 text-xs whitespace-nowrap text-muted">{r.rating ?? "—"}</td>
                    <td className="p-2 text-center font-extrabold tabnum">{r.planQty}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{r.colorRal ?? "—"}</td>
                  </>
                )}
                <td className="p-2 text-xs whitespace-nowrap text-muted" title={r.source ?? ""}>{r.createdAt.slice(0, 10)}</td>
                <td className="p-1 text-center no-print">
                  <button type="button" className="btn btn-sm btn-ghost" title="Edit this order" disabled={pending} onClick={() => { setEditing(r.mo); setEditErr(""); }}>✎</button>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const cell = "w-full min-w-[5rem] border rounded-md px-1.5 py-1 bg-surface text-xs";

/** The row as inputs. A plain form: Enter saves, Escape cancels, and the
 *  fields travel by name so the action reads them without a mapping. */
function EditRow({ r, lv, pending, err, onSave, onCancel }: { r: OrderRow; lv: boolean; pending: boolean; err: string; onSave: (form: HTMLFormElement) => void; onCancel: () => void }) {
  const formId = `edit-${r.id}`;
  const keys = (e: React.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
  return (
    <tr className="bg-brand-light/30 align-top" onKeyDown={keys}>
      <td className="p-2 text-center">
        <form id={formId} onSubmit={(e) => { e.preventDefault(); onSave(e.currentTarget); }}>
          <input type="hidden" name="updatedAt" value={r.updatedAt} />
        </form>
      </td>
      <td className="p-2 font-bold whitespace-nowrap text-xs">{r.mo}</td>
      <td className="p-1"><input form={formId} name="bom" defaultValue={r.bom} required aria-label="BOM" className={`${cell} font-bold uppercase ltr`} autoFocus /></td>
      <td className="p-1"><input form={formId} name="soi" defaultValue={r.soi ?? ""} aria-label="SOI" className={`${cell} ltr`} /></td>
      <td className="p-1"><input form={formId} name="customer" defaultValue={r.customer ?? ""} aria-label="Customer" className={cell} /></td>
      <td className="p-1 text-center"><input form={formId} type="checkbox" name="urgent" value="true" defaultChecked={r.urgent} aria-label="Urgent" className="mt-1.5" /></td>
      <td className="p-1"><input form={formId} name="fgCode" defaultValue={r.fgCode ?? ""} aria-label="FG Code" className={`${cell} ltr`} /></td>
      {lv ? (
        <>
          <td className="p-1"><input form={formId} name="product" defaultValue={r.product ?? ""} aria-label="Product" className={`${cell} text-center`} /></td>
          <td className="p-1"><input form={formId} name="secItem" defaultValue={r.secItem ?? ""} aria-label="SEC Item" className={`${cell} ltr`} /></td>
          <td className="p-1"><input form={formId} name="planQty" type="number" min={0} step={1} defaultValue={r.planQty} required aria-label="Planned Qty" className={`${cell} text-center font-extrabold tabnum`} /></td>
          <td className="p-1"><input form={formId} name="ospEncloser" type="number" min={0} step={1} defaultValue={r.ospEncloser} aria-label="OSP Encloser" className={`${cell} text-center tabnum`} /></td>
          <td className="p-1"><input form={formId} name="remarks" defaultValue={r.remarks ?? ""} aria-label="Remarks" className={cell} /></td>
          <td className="p-1"><input form={formId} name="materialsRemarks" defaultValue={r.materialsRemarks ?? ""} aria-label="Materials remarks" className={cell} /></td>
        </>
      ) : (
        <>
          <td className="p-1"><input form={formId} name="kva" defaultValue={r.kva ?? ""} aria-label="KVA" className={`${cell} text-center tabnum`} /></td>
          <td className="p-1"><input form={formId} name="rating" defaultValue={r.rating ?? ""} aria-label="Rating" className={`${cell} ltr`} /></td>
          <td className="p-1"><input form={formId} name="planQty" type="number" min={0} step={1} defaultValue={r.planQty} required aria-label="Plan Qty" className={`${cell} text-center font-extrabold tabnum`} /></td>
          <td className="p-1">
            <input form={formId} name="colorRal" defaultValue={r.colorRal ?? ""} aria-label="RAL" className={`${cell} ltr`} />
            <input form={formId} type="hidden" name="remarks" value={r.remarks ?? ""} />
          </td>
        </>
      )}
      <td className="p-2 text-xs whitespace-nowrap text-muted">{r.createdAt.slice(0, 10)}</td>
      <td className="p-1 whitespace-nowrap no-print">
        <button type="submit" form={formId} className="btn btn-sm btn-primary" disabled={pending}>Save</button>
        <button type="button" className="btn btn-sm btn-ghost ms-1" disabled={pending} onClick={onCancel} aria-label="Cancel editing">✕</button>
        {err && <div className="text-[11px] text-bad-fg mt-1 max-w-[12rem]">{err}</div>}
      </td>
    </tr>
  );
}
