// Weekly plan import — DELIVERY SCHEDULE ONLY.
//
// Typical layout (1-based columns), data starts at row 6:
//   A  BOM (merged — carry the last value down)
//   B  SOI
//   C  MO   (a row is an ORDER row iff MO is non-empty)
//   D  Description
//   E  Required Qty (informational)
//   F..AC  6 days x 4 items (CF,TC,TN,CB); column = 6 + 4*day + item  (1-based)
//   AD  REMARKS — stored for reference but NOT interpreted (no balance parsing):
//       order quantities come from the MONTHLY registry, progress from the logs.
//
// The day grid is LOCATED FROM THE SHEET'S OWN HEADER (the CF/TC/TN/CB row),
// not assumed at column F: planners hand out workbooks with an extra
// description column, and reading the grid one column off silently turned the
// total-qty column into "day 1 needs N core frames" and shifted every other
// component one place — while looking perfectly plausible on screen.
//
// Plan dates are OVEN dates: day g -> startDate + g.
// targetQty(item) = sum of the item's day cells (the scheduled total).

import { SHEET_ITEMS, type Item } from "./constants";

const GRID_FIRST_ROW = 6; // 1-based
const DAYS = 6;
const DEFAULT_COL = {
  BOM: 0, SOI: 1, MO: 2, DESC: 3, REQ: 4, GRID_FIRST: 5, REMARK: 29, // 0-based
} as const;
const GRID_LAST_COL = DEFAULT_COL.GRID_FIRST + DAYS * 4 - 1; // index 28 (AC)
const MAX_ORDER_ROWS = 100;

export interface PlanLayout {
  desc: number;
  req: number;
  gridFirst: number;
  remark: number;
  detected: boolean; // false = the header row was unreadable, defaults used
}

const norm = (v: unknown): string => (v == null ? "" : String(v).trim().toUpperCase());

/** The Description column, by its own header label. Counting places left of
 *  the grid does not survive the reshuffles: the sheets that gained a voltage
 *  column left Description two places left of the grid on one sheet and three
 *  on the next, so counting reads the voltage ("33/0.416") as the description.
 *  Without a label, keep the historical two-left-of-the-grid. */
function findDescCol(grid: unknown[][], headerRowIdx: number, gridFirst: number): number {
  const last = Math.min(headerRowIdx + 2, grid.length - 1); // the sub-header repeats it
  for (let r = 0; r <= last; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < Math.min(row.length, gridFirst); c++) {
      if (/^DESC/.test(norm(row[c]))) return c;
    }
  }
  return Math.max(0, gridFirst - 2);
}

/** Find the day grid by its own header. The header row is the one whose cells
 *  spell CF,TC,TN,CB over and over; the grid starts at the first CF of the
 *  longest such run, Required-Qty sits just before it, and REMARKS just after
 *  the 24th column. Falls back to the classic fixed layout. */
export function detectLayout(grid: unknown[][]): PlanLayout {
  const fallback: PlanLayout = {
    desc: DEFAULT_COL.DESC,
    req: DEFAULT_COL.REQ,
    gridFirst: DEFAULT_COL.GRID_FIRST,
    remark: DEFAULT_COL.REMARK,
    detected: false,
  };
  const wanted = SHEET_ITEMS.map((i) => norm(i)); // CF, TC, TN, CB

  for (let r = 0; r < Math.min(grid.length, GRID_FIRST_ROW - 1); r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (norm(row[c]) !== wanted[0]) continue;
      // count how many complete CF,TC,TN,CB blocks follow from here
      let blocks = 0;
      while (blocks < DAYS) {
        const base = c + blocks * 4;
        if (!wanted.every((w, k) => norm(row[base + k]) === w)) break;
        blocks++;
      }
      // one stray "CF" somewhere is not a grid — require at least two days
      if (blocks >= 2) {
        const gridFirst = c;
        return {
          desc: findDescCol(grid, r, gridFirst),
          req: gridFirst - 1,
          gridFirst,
          remark: gridFirst + DAYS * 4,
          detected: true,
        };
      }
    }
  }
  return fallback;
}

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
  kind: "oversize-grid" | "remark-column" | "double-count" | "layout";
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
  layout: PlanLayout;
}

const colName = (i: number): string => {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

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

  const layout = detectLayout(grid);
  const COL = { BOM: DEFAULT_COL.BOM, SOI: DEFAULT_COL.SOI, MO: DEFAULT_COL.MO, DESC: layout.desc, REQ: layout.req, GRID_FIRST: layout.gridFirst, REMARK: layout.remark };
  if (layout.detected && layout.gridFirst !== DEFAULT_COL.GRID_FIRST) {
    warnings.push({
      kind: "layout",
      row: 4,
      message:
        `This sheet's day grid starts at column ${colName(layout.gridFirst)} (not the usual ` +
        `${colName(DEFAULT_COL.GRID_FIRST)}) — read from the CF/TC/TN/CB header, so the quantities line up.`,
    });
  }

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

    // The weekly grid has exactly 4 component columns per day (F..AC); AR/MB are
    // derived per order from KVA/rating and never appear as grid columns.
    SHEET_ITEMS.forEach((item, k) => {
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

  return { orders, schedules, warnings, orderRowCount, layout };
}

export { GRID_LAST_COL };
