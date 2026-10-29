"use client";

import { useMemo, useState } from "react";
import type { CutRow } from "@/lib/domain/worklist";
import { StatusPill, Num } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { ITEMS } from "@/lib/domain/constants";

export function CutWorklistTable({ rows, day }: { rows: CutRow[]; day: string }) {
  const [q, setQ] = useState("");
  const [item, setItem] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (needle && !(`${r.bom} ${r.kva}`.toUpperCase().includes(needle))) return false;
      if (item && r.item !== item) return false;
      if (type && (type === "Scheduled" ? r.type !== "Scheduled" : r.type === "Scheduled")) return false;
      if (status && r.status !== status) return false;
      return true;
    });
  }, [rows, q, item, type, status]);

  const hasActive = !!(q || item || type || status);
  const reset = () => { setQ(""); setItem(""); setType(""); setStatus(""); };

  const exportRows = filtered.map((r) => ({
    BOM: r.bom,
    KVA: r.kva,
    Item: r.item,
    Type: r.type,
    "Total Required": r.totalRequired,
    "Cut Due": r.cutDue,
    "Done Today": r.doneToday,
    "Still Due": r.stillDue,
    "Today Target": r.todayTarget,
    Status: r.status,
  }));

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={reset} hasActive={hasActive}>
        <SearchBox value={q} onChange={setQ} placeholder="Search BOM / KVA…" />
        <SelectFilter label="Item" value={item} onChange={setItem} options={ITEMS.map((i) => ({ value: i, label: i }))} />
        <SelectFilter label="Type" value={type} onChange={setType} options={[{ value: "Scheduled", label: "Scheduled" }, { value: "Fill-up", label: "Fill-up" }]} />
        <SelectFilter label="Status" value={status} onChange={setStatus} options={[{ value: "Pending", label: "Pending" }, { value: "In progress", label: "In progress" }, { value: "Done", label: "Done" }]} />
        <ExportButton rows={exportRows} filename={`cut-worklist-${day}.xlsx`} sheetName="Cut Worklist" />
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="table-cards w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2">BOM</th>
              <th className="p-2">KVA</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2">Type</th>
              <th className="p-2 text-center">Total Req.</th>
              <th className="p-2 text-center">Cut Due</th>
              <th className="p-2 text-center">Done Today</th>
              <th className="p-2 text-center">Still Due</th>
              <th className="p-2 text-center">Today Target</th>
              <th className="p-2 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="p-4 text-center text-muted"><div className="dt-note">
                {rows.length === 0 ? "Nothing due on this day." : "No rows match the filters."}
              </div></td></tr>
            )}
            {filtered.map((r, i) => (
              <tr key={i} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                <td className="p-2 text-xs text-muted whitespace-nowrap">{r.kva}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-xs">
                  {r.type === "Scheduled" ? "Scheduled" : <span className="pill pill-warn">Fill-up</span>}
                </td>
                <td className="p-2 text-center"><Num v={r.totalRequired} /></td>
                <td className="p-2 text-center"><Num v={r.cutDue} /></td>
                <td className="p-2 text-center"><Num v={r.doneToday} /></td>
                <td className="p-2 text-center font-semibold"><Num v={r.stillDue} /></td>
                <td className="p-2 text-center font-extrabold" style={{ background: "var(--cut-tint)" }}><Num v={r.todayTarget} /></td>
                <td className="p-2 text-center"><StatusPill status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
