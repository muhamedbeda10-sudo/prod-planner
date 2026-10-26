// The Orders Registry as its screen reads it — an order's row and the
// screen's filters — shared with the assistant's sheet of the same registry.

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
  /** When the row was last written (ISO) — the edit form posts it back, so a
   *  save from a row someone else changed meanwhile is refused, not written. */
  updatedAt: string;
  /** The LV panels' own columns — empty on a transformer. */
  product: string | null;
  secItem: string | null;
  ospEncloser: number;
  materialsRemarks: string | null;
}

/** An order as the database keeps it — the registry's columns, its times as dates. */
export type RegistryOrder = Omit<OrderRow, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };

export function orderRowOf(o: RegistryOrder): OrderRow {
  return {
    id: o.id, mo: o.mo, soi: o.soi, urgent: o.urgent, customer: o.customer, fgCode: o.fgCode, bom: o.bom, kva: o.kva, rating: o.rating,
    planQty: o.planQty, colorRal: o.colorRal, remarks: o.remarks, source: o.source,
    createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
    product: o.product, secItem: o.secItem, ospEncloser: o.ospEncloser, materialsRemarks: o.materialsRemarks,
  };
}

export interface RegistryFilters {
  /** Matched against the MO, BOM, SOI, FG code, KVA, product and SEC item. */
  q?: string;
  urgent?: string; // "yes" | "no"
  source?: string;
}

/** The orders the registry shows under its filters. */
export function filterOrderRows<T extends OrderRow>(rows: readonly T[], f: RegistryFilters): T[] {
  const needle = (f.q ?? "").trim().toUpperCase();
  return rows.filter((r) => {
    if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.fgCode ?? ""} ${r.kva ?? ""} ${r.product ?? ""} ${r.secItem ?? ""}`.toUpperCase().includes(needle))) return false;
    if (f.urgent === "yes" && !r.urgent) return false;
    if (f.urgent === "no" && r.urgent) return false;
    return !f.source || r.source === f.source;
  });
}
