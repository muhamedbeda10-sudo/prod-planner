import "server-only";
import { loadMasterOrders } from "./loads";

// The SOI (sales order item) lives on the MASTER ORDER, and the shop floor
// reads it off every screen that names an order. Rather than thread it through
// a dozen domain row types — most of which are pure functions with their own
// tests — screens take this lookup and render it beside the MO they already
// carry.
//
// Plain objects, not Maps: these cross the server/client boundary.

export type SoiMap = Record<string, string>;

export interface SoiLookup {
  byMo: SoiMap;
  /** A BOM's SOIs, joined — a BOM-level row can cover several orders, and
   *  hiding that behind one of them would be a lie. */
  byBom: SoiMap;
}

/** Every order's SOI, keyed by MO and by BOM. One query; every screen shares it. */
export async function getSoiLookup(): Promise<SoiLookup> {
  const orders = [...(await loadMasterOrders())].filter((o) => o.soi !== null).sort((a, b) => a.mo.localeCompare(b.mo));

  const byMo: SoiMap = {};
  const perBom = new Map<string, Set<string>>();
  for (const o of orders) {
    const soi = (o.soi ?? "").trim();
    if (!soi) continue;
    byMo[o.mo] = soi;
    if (!perBom.has(o.bom)) perBom.set(o.bom, new Set());
    perBom.get(o.bom)!.add(soi);
  }

  const byBom: SoiMap = {};
  for (const [bom, sois] of perBom) byBom[bom] = [...sois].sort().join(" · ");

  return { byMo, byBom };
}
