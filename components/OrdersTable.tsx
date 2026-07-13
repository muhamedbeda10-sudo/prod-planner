"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";

export interface OrderRow {
  id: number;
  mo: string;
  soi: string | null;
  urgent: boolean;
  customer: string | null;
  fgCode: string | null;
  bom: string;
  kva: string | null;
  rating: string | null;
  planQty: number;
  colorRal: string | null;
  remarks: string | null;
  source: string | null;
  createdAt: string; // ISO
}

export function OrdersTable({ rows }: { rows: OrderRow[] }) {
  const [q, setQ] = useState("");
  const [urgent, setUrgent] = useState("");
  const [source, setSource] = useState("");

  const sources = useMemo(() => [...new Set(rows.map((r) => r.source ?? ""))].filter(Boolean).sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.fgCode ?? ""} ${r.kva ?? ""}`.toUpperCase().includes(needle))) return false;
      if (urgent === "yes" && !r.urgent) return false;
      if (urgent === "no" && r.urgent) return false;
      if (source && r.source !== source) return false;
      return true;
    });
  }, [rows, q, urgent, source]);

  const hasActive = !!(q || urgent || source);
  const totalQty = filtered.reduce((s, r) => s + r.planQty, 0);

  const exportRows = filtered.map((r) => ({
    MO: r.mo, SOI: r.soi ?? "", Urgent: r.urgent ? "Yes" : "", Customer: r.customer ?? "",
    "FG Code": r.fgCode ?? "", BOM: r.bom, KVA: r.kva ?? "", Rating: r.rating ?? "",
    "Plan Qty": r.planQty, "Color RAL": r.colorRal ?? "", Remarks: r.remarks ?? "",
    Source: r.source ?? "", Added: r.createdAt.slice(0, 10),
  }));

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setUrgent(""); setSource(""); }} hasActive={hasActive}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / FG…" />
        <SelectFilter label="Urgent" value={urgent} onChange={setUrgent} options={[{ value: "yes", label: "Urgent only" }, { value: "no", label: "Not urgent" }]} />
        {sources.length > 1 && (
          <SelectFilter label="Source" value={source} onChange={setSource} options={sources.map((s) => ({ value: s, label: s }))} />
        )}
        <span className="text-xs text-muted">Total qty (shown): <b className="text-foreground tabnum">{totalQty}</b></span>
        <ExportButton rows={exportRows} filename="master-orders.xlsx" sheetName="Orders" />
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">SOI</th>
              <th className="p-2 text-center">Urgent</th>
              <th className="p-2">FG Code</th>
              <th className="p-2 text-center">KVA</th>
              <th className="p-2">Rating</th>
              <th className="p-2 text-center">Plan Qty</th>
              <th className="p-2">RAL</th>
              <th className="p-2">Added</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No orders yet — import a monthly plan." : "No rows match the filters."}
              </td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className="p-2 font-bold whitespace-nowrap text-xs">{r.mo}</td>
                <td className="p-2 font-bold whitespace-nowrap">
                  <Link href={`/trace?bom=${encodeURIComponent(r.bom)}`} className="text-accent hover:underline">{r.bom}</Link>
                </td>
                <td className="p-2 text-xs whitespace-nowrap">{r.soi ?? "—"}</td>
                <td className="p-2 text-center">{r.urgent && <span className="pill pill-bad">URGENT</span>}</td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.fgCode ?? "—"}</td>
                <td className="p-2 text-center tabnum">{r.kva ?? "—"}</td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.rating ?? "—"}</td>
                <td className="p-2 text-center font-extrabold tabnum">{r.planQty}</td>
                <td className="p-2 text-xs whitespace-nowrap">{r.colorRal ?? "—"}</td>
                <td className="p-2 text-xs whitespace-nowrap text-muted" title={r.source ?? ""}>{r.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
