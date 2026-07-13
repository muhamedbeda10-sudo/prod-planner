"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateHandover, deleteHandover } from "@/app/handover/actions";
import { toISODate } from "@/lib/domain/dates";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { ITEMS, DEPTS } from "@/lib/domain/constants";

export interface LogRow {
  id: number;
  date: string; // ISO
  dept: string;
  bom: string;
  bomRaw: string | null;
  mo: string | null;
  item: string;
  qty: number;
  source: string;
}

export function HandoverLog({ rows }: { rows: LogRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<number | null>(null);
  const [qty, setQty] = useState("");
  const [date, setDate] = useState("");
  const [rowErr, setRowErr] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  // filters
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [item, setItem] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (needle && !r.bom.toUpperCase().includes(needle)) return false;
      if (dept && r.dept !== dept) return false;
      if (item && r.item !== item) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      return true;
    });
  }, [rows, q, dept, item, from, to]);

  const hasActive = !!(q || dept || item || from || to);
  const reset = () => { setQ(""); setDept(""); setItem(""); setFrom(""); setTo(""); };

  const exportRows = filtered.map((r) => ({
    Date: r.date,
    DEPT: r.dept,
    BOM: r.bom,
    MO: r.mo ?? "",
    Item: r.item,
    QTY: r.qty,
    Source: r.source,
    "Corrected From": r.bomRaw && r.bomRaw !== r.bom ? r.bomRaw : "",
  }));

  function save(id: number) {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("qty", qty);
    fd.set("date", date);
    startTransition(async () => {
      const r = await updateHandover(fd);
      if (r.ok) {
        setEditing(null);
        setRowErr((s) => ({ ...s, [id]: "" }));
        router.refresh();
      } else {
        setRowErr((s) => ({ ...s, [id]: r.error ?? "Failed" }));
      }
    });
  }
  function remove(id: number) {
    if (!confirm("Delete this record permanently? Its quantity will return to the pending balance on every screen.")) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(async () => {
      const r = await deleteHandover(fd);
      if (r.ok) {
        setRowErr((s) => ({ ...s, [id]: "" }));
        router.refresh();
      } else {
        setRowErr((s) => ({ ...s, [id]: r.error ?? "Failed" }));
      }
    });
  }

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={reset} hasActive={hasActive}>
        <SearchBox value={q} onChange={setQ} placeholder="Search BOM…" />
        <SelectFilter label="Dept" value={dept} onChange={setDept} options={DEPTS.map((d) => ({ value: d, label: d }))} />
        <SelectFilter label="Item" value={item} onChange={setItem} options={ITEMS.map((i) => ({ value: i, label: i }))} />
        <label className="inline-flex items-center gap-1.5 text-sm">
          <span className="text-muted text-xs font-semibold">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded-md px-2 py-1 text-sm bg-surface" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-sm">
          <span className="text-muted text-xs font-semibold">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded-md px-2 py-1 text-sm bg-surface" />
        </label>
        <ExportButton rows={exportRows} filename={`daily-handover.xlsx`} sheetName="Daily HandOver" />
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">Date</th>
              <th className="p-2">Dept</th>
              <th className="p-2">BOM</th>
              <th className="p-2">MO</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2">Source</th>
              <th className="p-2 no-print"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No records." : "No rows match the filters."}
              </td></tr>
            )}
            {filtered.map((r, i) => (
              <tr key={r.id} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-2 whitespace-nowrap">
                  {editing === r.id ? (
                    <input type="date" defaultValue={r.date} onChange={(e) => setDate(e.target.value)} className="border rounded px-1 py-0.5 text-xs" />
                  ) : (
                    r.date
                  )}
                </td>
                <td className="p-2">{r.dept}</td>
                <td className="p-2 font-bold whitespace-nowrap">
                  {r.bom}
                  {r.bomRaw && r.bomRaw !== r.bom && (
                    <span className="pill pill-ok ml-1" title={`corrected from ${r.bomRaw}`}>fixed</span>
                  )}
                </td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.mo ?? "—"}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-center font-bold tabnum">
                  {editing === r.id ? (
                    <input type="number" min={0} defaultValue={r.qty} onChange={(e) => setQty(e.target.value)} className="w-16 border rounded px-1 py-0.5" autoFocus />
                  ) : (
                    r.qty
                  )}
                </td>
                <td className="p-2 text-xs text-muted">{r.source}</td>
                <td className="p-2 no-print text-right">
                  <span className="whitespace-nowrap">
                    {editing === r.id ? (
                      <>
                        <button onClick={() => save(r.id)} disabled={pending} className="text-ok-fg font-bold text-xs px-2">Save</button>
                        <button onClick={() => { setEditing(null); setRowErr((s) => ({ ...s, [r.id]: "" })); }} className="text-muted text-xs px-2">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setEditing(r.id); setQty(String(r.qty)); setDate(r.date); }} className="text-accent text-xs px-2">Edit</button>
                        <button onClick={() => remove(r.id)} disabled={pending} className="text-bad-fg text-xs px-2">Delete</button>
                      </>
                    )}
                  </span>
                  {rowErr[r.id] && <div className="text-[11px] text-bad-fg mt-0.5 max-w-72 whitespace-normal text-left">{rowErr[r.id]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export { toISODate };
