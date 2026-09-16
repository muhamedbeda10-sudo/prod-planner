"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";

// The Plan Tracker's LV PANELS side.
//
// The transformer tracker is a grid of six components across four stages —
// cut, welded, painted, delivered — and none of that is an LV panel's. What
// a panel passes through on the floor has not been set yet, so this is the
// plan as planned: every open panel order with what its sheet says about it,
// searchable and exportable, and honest about the stages it does not have.
// When the panel's own stages are settled, they go here.

export interface LvOrderRow {
  mo: string;
  soi: string | null;
  urgent: boolean;
  customer: string | null;
  product: string | null;
  fgCode: string | null;
  bom: string;
  secItem: string | null;
  planQty: number;
  ospEncloser: number;
  remarks: string | null;
  materialsRemarks: string | null;
  status: string;
  months: string[];
}

export function LvOrdersTracker({ rows, viewTabs }: { rows: LvOrderRow[]; viewTabs?: React.ReactNode }) {
  const [q, setQ] = useSavedFilter("lvtracker.q");
  const [product, setProduct] = useSavedFilter("lvtracker.product");
  const [status, setStatus] = useSavedFilter("lvtracker.status");

  const products = useMemo(() => [...new Set(rows.map((r) => r.product ?? ""))].filter(Boolean).sort(), [rows]);
  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.fgCode ?? ""} ${r.secItem ?? ""} ${r.customer ?? ""}`.toUpperCase().includes(needle))) return false;
      if (product && r.product !== product) return false;
      if ((status || "open") !== "all" && r.status !== (status || "open")) return false;
      return true;
    });
  }, [rows, q, product, status]);

  const qty = filtered.reduce((s, r) => s + r.planQty, 0);
  const osp = filtered.reduce((s, r) => s + r.ospEncloser, 0);
  const exportRows = filtered.map((r) => ({
    MO: r.mo, SOI: r.soi ?? "", Urgent: r.urgent ? "Yes" : "", Customer: r.customer ?? "", Product: r.product ?? "",
    "FG Code": r.fgCode ?? "", BoM: r.bom, "SEC Item": r.secItem ?? "", "Planned Qty": r.planQty, "OSP Encloser": r.ospEncloser,
    Remarks: r.remarks ?? "", "Materials Remarks": r.materialsRemarks ?? "", Status: r.status, Months: r.months.join(", "),
  }));

  return (
    <div className="space-y-4">
      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setProduct(""); setStatus(""); }} hasActive={!!(q || product || (status && status !== "open"))}>
        {viewTabs}
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / FG / SEC…" />
        {products.length > 1 && <SelectFilter label="Product" value={product} onChange={setProduct} options={products.map((p) => ({ value: p, label: p }))} />}
        <SelectFilter label="Status" value={status || "open"} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }]} />
        <span className="text-xs text-muted">
          Panels (shown): <b className="text-foreground tabnum">{qty}</b>
          {osp > 0 && <> · enclosures outside: <b className="text-foreground tabnum">{osp}</b></>}
        </span>
        <ExportButton rows={exportRows} filename="lv-panels-plan.xlsx" sheetName="LV Panels" />
      </FilterBar>

      {/* Said on the page, not hidden in a tooltip: the stage columns a
          transformer has are missing here on purpose, not by accident. */}
      <p className="text-sm text-muted bg-surface border rounded-xl px-4 py-3">
        The LV panel&apos;s production stages are not set up yet, so this side of the tracker shows the plan as planned — nothing is
        recorded against a panel from here. Once the stages a panel passes through are agreed, they take the place of this note.
      </p>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2">SOI</th>
              <th className="p-2">Customer</th>
              <th className="p-2 text-center" title="The panel type on the plan: LSS or USS">Product</th>
              <th className="p-2">FG Code</th>
              <th className="p-2">BoM</th>
              <th className="p-2">SEC Item</th>
              <th className="p-2 text-center">Planned</th>
              <th className="p-2 text-center" title="Enclosures bought outside rather than made here">OSP Encl.</th>
              <th className="p-2">Remarks</th>
              <th className="p-2">Materials</th>
              <th className="p-2">Month</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={12} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No LV panel orders yet — import their monthly plan from Tools → Orders & plan imports." : "No rows match the filters."}
              </td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.mo} className={`border-t ${r.status === "closed" ? "opacity-60" : ""}`}>
                <td className="p-2 font-bold whitespace-nowrap text-xs">
                  {r.mo}
                  {r.urgent && <span className="pill pill-bad ms-1">URGENT</span>}
                </td>
                <td className="p-2 text-xs whitespace-nowrap">{r.soi ?? "—"}</td>
                <td className="p-2 text-xs whitespace-nowrap">{r.customer ?? "—"}</td>
                <td className="p-2 text-center"><span className="pill pill-muted">{r.product ?? "—"}</span></td>
                <td className="p-2 text-xs whitespace-nowrap text-muted ltr">{r.fgCode ?? "—"}</td>
                <td className="p-2 font-semibold whitespace-nowrap text-xs">
                  <Link href={`/trace?bom=${encodeURIComponent(r.bom)}`} className="text-accent hover:underline">{r.bom}</Link>
                </td>
                <td className="p-2 text-xs whitespace-nowrap tabnum text-muted">{r.secItem ?? "—"}</td>
                <td className="p-2 text-center font-extrabold tabnum">{r.planQty}</td>
                <td className="p-2 text-center tabnum">{r.ospEncloser > 0 ? r.ospEncloser : <span className="text-muted">—</span>}</td>
                <td className="p-2 text-xs max-w-[12rem]">{r.remarks ?? <span className="text-muted">—</span>}</td>
                <td className="p-2 text-xs max-w-[18rem]">{r.materialsRemarks ?? <span className="text-muted">—</span>}</td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.months.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
