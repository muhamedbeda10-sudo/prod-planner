// Monthly plan import — the MASTER ORDER registry.
//
// Layout (real file "Monthly plan.xlsx"): title row(s), a header row containing
// "MO." and "BoM Ref.", one sub-header row (component names under section
// groups), then data rows until the "Total" footer. Columns are mapped BY
// HEADER NAME so column order doesn't matter.
//
// The import's contract (per the factory's flow): check each MO — if it already
// exists in the registry it is left untouched; if it is new it is added.

export type CoreItem = "CF" | "TC" | "TN" | "CB";

/** Per-dept done quantities for the 4 transformer components, as written in the
 *  sheet's section columns (Laser Cutting / Welding / Paint). */
export interface DoneMatrix {
  cut: Record<CoreItem, number>;
  weld: Record<CoreItem, number>;
  paint: Record<CoreItem, number>;
}

export interface MonthlyOrderRow {
  rowNum: number; // 1-based sheet row
  mo: string;
  soi: string | null;
  urgent: boolean;
  customer: string | null;
  fgCode: string | null;
  bom: string;
  kva: string | null;
  rating: string | null;
  secItem: string | null;
  planQty: number;
  colorRal: string | null;
  remarks: string | null;
  done: DoneMatrix; // raw sheet values (see applyCascade for the effective view)
  osp: Record<CoreItem, number>; // OSP section — quantities OUTSOURCED per component (made outside, not by our depts)
}

/**
 * The sheet has no dates and later stages imply earlier ones: if Paint finished
 * N then Welding and Cut finished at least N; if Welding finished N then Cut
 * did. Quantities are also capped at the order's plan qty.
 * THIS RULE IS FOR INTERPRETING THE SETUP SHEET ONLY — daily logs are recorded
 * per department explicitly.
 */
export function applyCascade(done: DoneMatrix, planQty: number): DoneMatrix {
  const out: DoneMatrix = {
    cut: { CF: 0, TC: 0, TN: 0, CB: 0 },
    weld: { CF: 0, TC: 0, TN: 0, CB: 0 },
    paint: { CF: 0, TC: 0, TN: 0, CB: 0 },
  };
  const cap = (v: number) => (planQty > 0 ? Math.min(v, planQty) : v);
  for (const it of ["CF", "TC", "TN", "CB"] as const) {
    const paint = cap(done.paint[it]);
    const weld = cap(Math.max(done.weld[it], paint));
    const cut = cap(Math.max(done.cut[it], weld));
    out.paint[it] = paint;
    out.weld[it] = weld;
    out.cut[it] = cut;
  }
  return out;
}

export interface ParsedMonthly {
  rows: MonthlyOrderRow[];
  issues: string[]; // rows skipped and why
  headerRow: number; // 1-based, for diagnostics
}

const S = (v: unknown): string => (v == null ? "" : String(v).replace(/\r?\n/g, " ").trim());
const N = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(S(v));
  return Number.isFinite(n) ? n : 0;
};
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");

// header aliases (normalized: letters only) -> field
const HEADERS: Record<string, string> = {
  SOI: "soi",
  URGENT: "urgent",
  CUSTOMER: "customer",
  FGCODE: "fgCode",
  MO: "mo",
  BOMREF: "bom",
  BOM: "bom",
  KVA: "kva",
  RATINGKV: "rating",
  RATING: "rating",
  SECITEM: "secItem",
  PLANQTY: "planQty",
  COLORRAL: "colorRal",
  REVREMARKS: "remarks",
  REMARKS: "remarks",
};

/** Find the header row: the one that contains both an MO and a BOM header. */
function findHeaderRow(grid: unknown[][]): number {
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const cells = (grid[r] ?? []).map((c) => norm(S(c)));
    if (cells.includes("MO") && (cells.includes("BOMREF") || cells.includes("BOM"))) return r;
  }
  return -1;
}

export function parseMonthlyPlan(grid: unknown[][]): ParsedMonthly {
  const issues: string[] = [];
  const hr = findHeaderRow(grid);
  if (hr < 0) {
    return { rows: [], issues: ['Could not find the header row (needs "MO." and "BoM Ref." columns).'], headerRow: -1 };
  }

  // map columns by normalized header name; "Rev_3.0 REMARKS" normalizes to REVREMARKS
  const cols: Record<string, number> = {};
  const header = grid[hr] ?? [];
  for (let c = 0; c < header.length; c++) {
    const key = HEADERS[norm(S(header[c]))];
    if (key && cols[key] === undefined) cols[key] = c;
  }
  if (cols.mo === undefined || cols.bom === undefined) {
    return { rows: [], issues: ["Header row found but MO/BOM columns could not be mapped."], headerRow: hr + 1 };
  }

  // ---- section groups (merged header cell + component names on the sub-header row) ----
  // e.g.  r2: ... | Laser Cutting |  |  |  |  |  | Welding | ... | Paint | ...
  //       r3: ... | Core | Top Cover | Tank | Cable Box | Mono Box | Arrester Bracket | Fins | ...
  const COMPONENT: Record<string, CoreItem> = {
    CORE: "CF",
    TOPCOVER: "TC",
    TANK: "TN",
    CABLEBOX: "CB",
    // Fins / Mono Box / Arrester Bracket are secondary items — not tracked here
  };
  const SECTION: Record<string, keyof DoneMatrix | "osp"> = {
    LASERCUTTING: "cut",
    WELDING: "weld",
    PAINT: "paint",
    OSP: "osp", // outsourced quantities (sub-headers: Fins | Tank | Core)
  };
  const sub = grid[hr + 1] ?? [];
  const sectionCols: Record<keyof DoneMatrix | "osp", Partial<Record<CoreItem, number>>> = { cut: {}, weld: {}, paint: {}, osp: {} };
  for (let c = 0; c < header.length; c++) {
    const section = SECTION[norm(S(header[c]))];
    if (!section) continue;
    // the group spans from its header cell until the next non-empty header cell
    for (let cc = c; cc < Math.max(header.length, sub.length); cc++) {
      if (cc > c && S(header[cc]) !== "") break;
      const comp = COMPONENT[norm(S(sub[cc]))];
      if (comp && sectionCols[section][comp] === undefined) sectionCols[section][comp] = cc;
    }
  }
  const hasProgress = (["cut", "weld", "paint"] as const).every(
    (s) => Object.keys(sectionCols[s]).length === 4
  );
  if (!hasProgress) {
    issues.push("Progress sections (Laser Cutting / Welding / Paint per component) were not fully mapped — done quantities default to 0.");
  }

  const rows: MonthlyOrderRow[] = [];
  const seen = new Set<string>();
  // data starts after the header row; skip the sub-header row (component names,
  // no MO) and any banner rows — anything without an MO cell is not a data row.
  for (let r = hr + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const mo = S(row[cols.mo]);
    if (!mo) continue; // sub-header / blank / Total footer
    const bom = S(row[cols.bom]);
    if (!bom) {
      issues.push(`Row ${r + 1}: MO "${mo}" has no BOM — skipped.`);
      continue;
    }
    if (seen.has(mo)) {
      issues.push(`Row ${r + 1}: duplicate MO "${mo}" inside the file — first occurrence kept.`);
      continue;
    }
    seen.add(mo);
    const get = (k: string) => (cols[k] === undefined ? "" : S(row[cols[k]]));
    const clean = (s: string) => (s === "" || s === "-" ? null : s);
    const done: DoneMatrix = { cut: { CF: 0, TC: 0, TN: 0, CB: 0 }, weld: { CF: 0, TC: 0, TN: 0, CB: 0 }, paint: { CF: 0, TC: 0, TN: 0, CB: 0 } };
    for (const s of ["cut", "weld", "paint"] as const) {
      for (const it of ["CF", "TC", "TN", "CB"] as const) {
        const c = sectionCols[s][it];
        if (c !== undefined) done[s][it] = N(row[c]);
      }
    }
    const osp: Record<CoreItem, number> = { CF: 0, TC: 0, TN: 0, CB: 0 };
    for (const it of ["CF", "TC", "TN", "CB"] as const) {
      const c = sectionCols.osp[it];
      if (c !== undefined) osp[it] = N(row[c]);
    }
    // an outsourced tank comes WITH its top cover — the sheet only has a Tank
    // column, so TN's OSP share implies the same TC share
    osp.TC = Math.max(osp.TC, osp.TN);
    rows.push({
      rowNum: r + 1,
      mo,
      soi: clean(get("soi")),
      urgent: /^y(es)?$/i.test(get("urgent")),
      customer: clean(get("customer")),
      fgCode: clean(get("fgCode")),
      bom,
      kva: clean(get("kva")),
      rating: clean(get("rating")),
      secItem: clean(get("secItem")),
      planQty: cols.planQty === undefined ? 0 : N(row[cols.planQty]),
      colorRal: clean(get("colorRal")),
      remarks: clean(get("remarks")),
      done,
      osp,
    });
  }
  return { rows, issues, headerRow: hr + 1 };
}
