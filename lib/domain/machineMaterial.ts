// What a technician needs to know about a line before he starts it: the
// sheet it is cut from — its thickness, material and size — and how many
// sheets the pieces on HIS machine take. Read off the MATERIAL tab's nesting
// lines (the planner's Nesting Tracker): the nesting's actual rate per unit
// where the job was nested, the BOM's rate where it was not yet.

/** One nesting line, as much of it as the machine sheet reads. */
export interface NestingLineLite {
  month: string;
  soi: string;
  mo: string;
  partName: string;
  material: string;
  materialCode: string;
  thicknessMm: number;
  sheetSize: string;
  units: number;
  sheetsPerUnit: number;
  actualPerUnit: number | null;
  sheetsUsed: number | null;
}

/** One sheet the line is cut from, with the sheets ONE piece takes. */
export interface LineSheetSpec {
  material: string;
  materialCode: string;
  thicknessMm: number;
  sheetSize: string;
  /** Sheets one piece takes — the nesting's actual rate, else the BOM's. */
  perUnit: number;
  /** The rate is the nesting's own (true) or the BOM's, not nested yet. */
  actual: boolean;
  /** The nesting's sheets for the whole job — actually nested where it was,
   *  else the BOM's for its units. What the technician knows the job by. */
  jobSheets?: number | null;
}

export interface LineMaterial {
  partName: string;
  /** The nesting month the figures come from. */
  month: string;
  specs: LineSheetSpec[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "October 2026" → a sortable number; anything else sorts last. */
export function monthSortKey(label: string): number {
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(label.trim());
  const i = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && i >= 0 ? Number(m[2]) * 12 + i : -1;
}

const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * The lines of ONE job out of a part × BOM's nesting: the order's own SOI
 * when the sheet filed lines under it, else the lines that cover the BOM as
 * a whole. When neither exists, every job of the BOM is a fair stand-in —
 * the same BOM nests the same way — and one line per sheet is kept, so two
 * jobs' lines never add up.
 */
export function pickJobLines(all: readonly NestingLineLite[], soi: string | null, mo: string | null = null): NestingLineLite[] {
  // the sheet filing the transformer's own MO: that order's lines, exactly
  const m = up(mo);
  const byMo = m ? all.filter((l) => up(l.mo) === m) : [];
  if (byMo.length > 0) return byMo;
  const s = up(soi);
  const bySoi = s ? all.filter((l) => up(l.soi) === s) : [];
  if (bySoi.length > 0) return bySoi;
  const whole = all.filter((l) => !up(l.soi) && !up(l.mo));
  return whole.length > 0 ? whole : [...all];
}

/**
 * The sheets behind a line: of its job's nesting lines, the month the order
 * was planned in when the tracker has it (newest first), else the newest
 * month there is; one spec per material × thickness × sheet size.
 */
export function lineMaterialOf(lines: readonly NestingLineLite[], orderMonths: readonly string[] = []): LineMaterial | null {
  if (lines.length === 0) return null;
  const months = [...new Set(lines.map((l) => l.month))].sort((a, b) => monthSortKey(b) - monthSortKey(a));
  const planned = [...orderMonths].sort((a, b) => monthSortKey(b) - monthSortKey(a)).find((m) => months.includes(m));
  const month = planned ?? months[0];
  const seen = new Set<string>();
  const specs: LineSheetSpec[] = [];
  for (const l of lines) {
    if (l.month !== month) continue;
    const k = `${l.material}|${l.thicknessMm}|${l.sheetSize}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const rate = l.actualPerUnit !== null && l.actualPerUnit >= 0 ? l.actualPerUnit : l.sheetsUsed !== null && l.units > 0 ? l.sheetsUsed / l.units : null;
    specs.push({
      material: l.material, materialCode: l.materialCode, thicknessMm: l.thicknessMm, sheetSize: l.sheetSize,
      perUnit: rate ?? l.sheetsPerUnit, actual: rate !== null,
      jobSheets: l.sheetsUsed !== null ? l.sheetsUsed : l.units > 0 ? Math.round(l.sheetsPerUnit * l.units * 100) / 100 : null,
    });
  }
  specs.sort((a, b) => b.thicknessMm - a.thicknessMm || a.material.localeCompare(b.material));
  return { partName: lines.find((l) => l.partName)?.partName ?? "", month, specs };
}

/** A sheet's key — how a machine's share of an item names the sheet it cuts. */
export function sheetKeyOf(spec: Pick<LineSheetSpec, "thicknessMm" | "material" | "sheetSize">): string {
  return `${spec.thicknessMm}|${spec.material}|${spec.sheetSize}`;
}

/** The spec a sheet key names, out of a line's material. */
export function specOf(m: LineMaterial | undefined, sheet: string): LineSheetSpec | undefined {
  return sheet ? m?.specs.find((s) => sheetKeyOf(s) === sheet) : undefined;
}

/** "3|Steel|1220*2440" → "3 mm MS 1220×2440" — for a key with no nesting behind it any more. */
export function sheetKeyLabel(sheet: string): string {
  const [thk, material, size] = sheet.split("|");
  return [`${thk} mm ${materialShort(material ?? "")}`.trim(), sheetSizeLabel(size ?? "")].filter(Boolean).join(" ");
}

/** Sheets for `pcs` pieces — two decimals is as fine as a floor counts. */
export function sheetsFor(spec: LineSheetSpec, pcs: number): number {
  return Math.round(spec.perUnit * Math.max(0, pcs) * 100) / 100;
}

const MATERIAL_SHORT: Record<string, string> = {
  Steel: "MS",
  "Stainless steel": "SS",
  "Galvanized steel": "GI",
  Aluminium: "AL",
  Copper: "CU",
};
/** The material as the floor says it: MS, SS, GI… */
export function materialShort(material: string): string {
  return MATERIAL_SHORT[material] ?? material;
}

/** "3 mm GI" — the sheet's thickness and material. */
export function thicknessLabel(spec: Pick<LineSheetSpec, "thicknessMm" | "material">): string {
  return `${spec.thicknessMm} mm ${materialShort(spec.material)}`.trim();
}

/** "1220*2440" → "1220×2440". */
export function sheetSizeLabel(size: string): string {
  return size.replace(/\*/g, "×");
}
