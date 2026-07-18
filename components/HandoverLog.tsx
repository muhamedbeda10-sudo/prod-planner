"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateHandover, deleteHandover } from "@/app/handover/actions";
import { toISODate } from "@/lib/domain/dates";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
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

export function HandoverLog({ rows, editableDepts = [] }: { rows: LogRow[]; editableDepts?: string[] }) {
  const canEditRow = (r: LogRow) => editableDepts.includes(r.dept);
  const router = useRouter();
  const [editing, setEditing] = useState<number | null>(null);
  const [qty, setQty] = useState("");
  const [date, setDate] = useState("");
  const [rowErr, setRowErr] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  // filters — survive navigating away and back (sessionStorage per tab)
  const [q, setQ] = useSavedFilter("log.q");
  const [dept, setDept] = useSavedFilter("log.dept");
  const [item, setItem] = useSavedFilter("log.item");
  const [from, setFrom] = useSavedFilter("log.from");
  const [to, setTo] = useSavedFilter("log.to");
  // default window: the log opens on the LAST 3 recorded days, not everything —
  // presets and the custom range below widen it
  const [period, setPeriod] = useSavedFilter("log.period", "3");

  // picking a preset clears the custom range; typing a date takes over from
  // the preset — one always clearly wins
  const pickPeriod = (v: string) => { setPeriod(v); setFrom(""); setTo(""); };
  const pickFrom = (v: string) => { setFrom(v); if (v || to) setPeriod(""); };
  const pickTo = (v: string) => { setTo(v); if (from || v) setPeriod(""); };

  // preset window anchored to the newest recorded day (not "today", so the
  // log never looks empty after a day off)
  const newestISO = useMemo(
    () => (rows.length ? rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date) : ""),
    [rows]
  );
  const cutoffISO = useMemo(() => {
    if (from || to || !period || !newestISO) return "";
    const d = new Date(`${newestISO}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (Number(period) - 1));
    return d.toISOString().slice(0, 10);
  }, [from, to, period, newestISO]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (needle && !r.bom.toUpperCase().includes(needle)) return false;
      if (dept && r.dept !== dept) return false;
      if (item && r.item !== item) return false;
      if (cutoffISO && r.date < cutoffISO) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      return true;
    });
  }, [rows, q, dept, item, from, to, cutoffISO]);

  const hasActive = !!(q || dept || item || from || to || period !== "3");
  const reset = () => { setQ(""); setDept(""); setItem(""); setFrom(""); setTo(""); setPeriod("3"); };

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
        <SelectFilter
          label="Show"
          value={period}
          onChange={pickPeriod}
          options={[
            { value: "3", label: "Last 3 days" },
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
          ]}
        />
        <SelectFilter label="Dept" value={dept} onChange={setDept} options={DEPTS.map((d) => ({ value: d, label: d }))} />
        <SelectFilter label="Item" value={item} onChange={setItem} options={ITEMS.map((i) => ({ value: i, label: i }))} />
        {/* custom range (or one exact day: same date in both) — one tidy row */}
        <div className="col-span-2 flex items-center gap-1.5 text-sm">
          <span className="text-muted text-[10px] sm:text-[11px] font-bold uppercase tracking-wide">Range</span>
          <input type="date" value={from} onChange={(e) => pickFrom(e.target.value)} className="min-w-0 flex-1 sm:flex-none sm:w-auto border rounded-md px-2 py-1.5 text-sm bg-surface" />
          <span className="text-muted text-xs shrink-0">→</span>
          <input type="date" value={to} onChange={(e) => pickTo(e.target.value)} className="min-w-0 flex-1 sm:flex-none sm:w-auto border rounded-md px-2 py-1.5 text-sm bg-surface" />
        </div>
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
                    ) : canEditRow(r) ? (
                      <>
                        <button onClick={() => { setEditing(r.id); setQty(String(r.qty)); setDate(r.date); }} className="text-accent text-xs px-2">Edit</button>
                        <button onClick={() => remove(r.id)} disabled={pending} className="text-bad-fg text-xs px-2">Delete</button>
                      </>
                    ) : null}
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
