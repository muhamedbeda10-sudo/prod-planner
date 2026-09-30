import type { Item } from "@/lib/domain/constants";

// The plan's child MOs — Odoo's MO for each component of a plan order.
//
// The monthly plan sheet may come as one row per plan MO × component, with
// the component's child MO beside it (Component_Type, Child_MO, Child_Qty,
// State …). They never show on the tracker: when a component's closing is
// born on the ODOO tab, the row takes its child MO from here, so it lands
// ready to close instead of waiting for someone to type Odoo's number.

/** The sheet's component names → the tracker's items; fins have none. */
export const COMPONENT_ITEM: Record<string, Item | null> = {
  TANK: "TN",
  FINS: null,
  TOP_COVER: "TC",
  CORE_FRAME: "CF",
  CABLE_BOX: "CB",
  ARRESTER: "AR",
  MONOBLOC_BOX: "MB",
};

export interface ChildMoRow {
  rowNum: number;
  planMo: string;
  component: string;
  item: Item | null;
  childMo: string;
  parentMo: string | null;
  productCode: string | null;
  qty: number | null;
  state: string | null;
  linkMethod: string | null;
  remarks: string | null;
  planMonth: string | null;
}

export interface ParsedChildMos {
  /** False when the sheet has no child-MO columns at all — a plain plan. */
  present: boolean;
  rows: ChildMoRow[];
  /** Plan MO × component the sheet flags (NOT_IN_BOM, UNRESOLVED …) — counted, not stored. */
  flagged: Record<string, number>;
}

const S = (v: unknown): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const key = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(S(v));
  return Number.isFinite(n) ? n : null;
};

/** Read the child-MO columns of a plan grid (sheet_to_json, header:1). */
export function parseChildMos(grid: unknown[][]): ParsedChildMos {
  let hr = -1;
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const cells = (grid[r] ?? []).map((c) => key(S(c)));
    if (cells.includes("COMPONENTTYPE") && cells.includes("CHILDMO")) { hr = r; break; }
  }
  if (hr < 0) return { present: false, rows: [], flagged: {} };
  const header = (grid[hr] ?? []).map((c) => key(S(c)));
  const col = (name: string) => header.indexOf(name);
  const c = {
    mo: col("MO"), component: col("COMPONENTTYPE"), child: col("CHILDMO"), parent: col("PARENTMO"), product: col("PRODUCTCODE"),
    qty: col("CHILDQTY"), state: col("STATE"), link: col("LINKMETHOD"), flag: col("FLAG"), remarks: col("CHILDREMARKS"), month: col("PLANMONTH"),
  };
  if (c.mo < 0) return { present: false, rows: [], flagged: {} };

  const rows: ChildMoRow[] = [];
  const flagged: Record<string, number> = {};
  const seen = new Set<string>();
  const at = (row: unknown[], i: number) => (i >= 0 ? S(row[i]) : "");
  for (let r = hr + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const planMo = at(row, c.mo).toUpperCase();
    const component = at(row, c.component).toUpperCase().replace(/\s+/g, "_");
    if (!planMo || !component) continue;
    const childMo = at(row, c.child).toUpperCase();
    const flag = at(row, c.flag).toUpperCase();
    if (!childMo) {
      if (flag) flagged[flag] = (flagged[flag] ?? 0) + 1;
      continue;
    }
    const k = `${planMo}|${component}|${childMo}`;
    if (seen.has(k)) continue; // the same child twice under one plan MO
    seen.add(k);
    const opt = (i: number) => at(row, i) || null;
    rows.push({
      rowNum: r + 1,
      planMo,
      component,
      item: COMPONENT_ITEM[component] ?? null,
      childMo,
      parentMo: opt(c.parent)?.toUpperCase() ?? null,
      productCode: opt(c.product),
      qty: c.qty >= 0 ? num(row[c.qty]) : null,
      state: opt(c.state)?.toLowerCase() ?? null,
      linkMethod: opt(c.link),
      remarks: opt(c.remarks),
      planMonth: opt(c.month),
    });
  }
  return { present: true, rows, flagged };
}

/** The plan month a sheet names in its Plan_Month column ("10-2026",
 *  "2026-10", "October 2026") as the app's label ("October 2026"); null when
 *  the sheet has no such column or it is empty or unreadable. */
export function sheetPlanMonth(grid: unknown[][]): string | null {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const i = (grid[r] ?? []).findIndex((c) => key(S(c)) === "PLANMONTH");
    if (i < 0) continue;
    for (let rr = r + 1; rr < grid.length; rr++) {
      const v = S((grid[rr] ?? [])[i]);
      if (!v) continue;
      let m = /^(\d{1,2})[-/.](\d{4})$/.exec(v);
      if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${MONTHS[Number(m[1]) - 1]} ${m[2]}` : null;
      m = /^(\d{4})[-/.](\d{1,2})$/.exec(v);
      if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
      const named = MONTHS.findIndex((mn) => v.toLowerCase().startsWith(mn.toLowerCase().slice(0, 3)));
      const y = /(\d{4})/.exec(v)?.[1];
      return named >= 0 && y ? `${MONTHS[named]} ${y}` : null;
    }
    return null;
  }
  return null;
}

/** An Odoo state the office can no longer close against. */
export const isClosedState = (state: string | null) => state === "done" || state === "cancel" || state === "cancelled";

/**
 * Which child MO a new closing of `qty` takes: an open one (not done or
 * cancelled) with room left — its Child_Qty less what earlier ODOO rows
 * already booked on it — preferring one that holds the whole closing. Null
 * when none is open with room: the row is left for a person to fill.
 */
export function pickChildMo(
  children: readonly { childMo: string; qty: number | null; state: string | null }[],
  booked: ReadonlyMap<string, number>,
  qty: number,
): string | null {
  const open = children
    .filter((ch) => !isClosedState(ch.state))
    .map((ch) => ({ mo: ch.childMo, room: ch.qty === null ? Infinity : ch.qty - (booked.get(ch.childMo) ?? 0) }))
    .filter((ch) => ch.room > 1e-9);
  return (open.find((ch) => ch.room >= qty - 1e-9) ?? open[0])?.mo ?? null;
}
