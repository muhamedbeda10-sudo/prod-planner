// Weekly plan import — DELIVERY SCHEDULE ONLY.
//
// Grid layout (1-based columns), data starts at row 6:
//   A  BOM (merged — carry the last value down)
//   B  SOI
//   C  MO   (a row is an ORDER row iff MO is non-empty)
//   D  Description
//   E  Required Qty (informational)
//   F..AC  6 days x 4 items (CF,TC,TN,CB); column = 6 + 4*day + item  (1-based)
//   AD  REMARKS — stored for reference but NOT interpreted (no balance parsing):
//       order quantities come from the MONTHLY registry, progress from the logs.
//
// Plan dates are OVEN dates: day g -> startDate + g.
// targetQty(item) = sum of the item's day cells (the scheduled total).

import { ITEMS, type Item } from "./constants";

const GRID_FIRST_ROW = 6; // 1-based
const DAYS = 6;
const COL = {
  BOM: 0, SOI: 1, MO: 2, DESC: 3, REQ: 4, GRID_FIRST: 5, REMARK: 29, // 0-based
} as const;
const GRID_LAST_COL = COL.GRID_FIRST + DAYS * 4 - 1; // index 28 (AC)
const MAX_ORDER_ROWS = 100;

export interface ImportOrderRow {
  bom: string;
  soi: string | null;
  mo: string;
  description: string | null;
  item: Item;
  requiredQty: number;
  plannerBalance: number | null;
  targetQty: number;
  remark: string | null;
}
export interface ImportScheduleRow {
  bom: string;
  soi: string | null;
  mo: string;
  description: string | null;
  item: Item;
  dayOffset: number; // 0..5 ; ovenDate = startDate + dayOffset
  qty: number;
}
export interface ImportWarning {
  kind: "oversize-grid" | "remark-column" | "double-count";
  row: number; // 1-based sheet row
  bom?: string;
  mo?: string;
  item?: Item;
  message: string;
}
export interface ParsedPlan {
  orders: ImportOrderRow[];
  schedules: ImportScheduleRow[];
  warnings: ImportWarning[];
  orderRowCount: number;
}

const S = (v: unknown): string => (v == null ? "" : String(v).trim());
const N = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

/** grid: 2D array of the sheet, 0-based (grid[0] = sheet row 1). */
export function parseWeeklyPlan(grid: unknown[][]): ParsedPlan {
  const orders: ImportOrderRow[] = [];
  const schedules: ImportScheduleRow[] = [];
  const warnings: ImportWarning[] = [];
  let carryBom = "";
  let orderRowCount = 0;

  for (let r = GRID_FIRST_ROW - 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const sheetRow = r + 1;

    const aVal = S(row[COL.BOM]);
    if (aVal) carryBom = aVal;
    const mo = S(row[COL.MO]);
    if (!mo) continue; // only order rows

    orderRowCount++;
    if (orderRowCount > MAX_ORDER_ROWS) {
      warnings.push({
        kind: "oversize-grid",
        row: sheetRow,
        message: `Order count exceeds ${MAX_ORDER_ROWS} — check the grid size.`,
      });
    }

    const bom = carryBom;
    const soi = S(row[COL.SOI]) || null;
    const description = S(row[COL.DESC]) || null;
    const requiredQty = N(row[COL.REQ]);
    const remark = S(row[COL.REMARK]) || null;

    // extra data past the REMARKS column -> likely a misaligned grid
    for (let c = COL.REMARK + 1; c < row.length; c++) {
      if (S(row[c])) {
        warnings.push({
          kind: "remark-column",
          row: sheetRow,
          bom,
          mo,
          message: `Data found past the remarks column (column ${c + 1}) — the grid may be misaligned.`,
        });
        break;
      }
    }

    ITEMS.forEach((item, k) => {
      let gridSum = 0;
      for (let g = 0; g < DAYS; g++) {
        const cell = N(row[COL.GRID_FIRST + 4 * g + k]);
        if (cell > 0) {
          gridSum += cell;
          schedules.push({ bom, soi, mo, description, item, dayOffset: g, qty: cell });
        }
      }
      // dates-only role: the target IS the scheduled total; remarks are not parsed
      orders.push({ bom, soi, mo, description, item, requiredQty, plannerBalance: null, targetQty: gridSum, remark });
    });
  }

  return { orders, schedules, warnings, orderRowCount };
}

export { GRID_LAST_COL };
