import { round3, type MaterialLineInput } from "@/lib/domain/material";
import { monthLabelFromInput, monthLabelSortKey } from "@/lib/domain/dates";

// ODOO row → its nesting lines. A MATERIAL line is keyed by the transformer's
// BOM and the part code (14003E11M11 × FB-022, the TANK). The row names the
// part in its FG-CODE's prefix (FB-022-…) and the transformer through its
// SOI: the orders registry says which BOM the SOI is for. The FG-CODE's
// suffix is the same BOM for a tank (FB-022-14003E11M11) but the part's own
// drawing code for a top cover or core frame (FB-051-12011E12M12 on
// transformer 12011E16M13), so the SOI's BOM is looked up first and the
// suffix only as the fallback — the path the planner's own search takes.

/** "FB-022-14003E11M11" → part FB-022, BOM 14003E11M11. Null when the code is
 *  not shaped that way (a bare BOM, a typo) — nothing to look up. */
export function splitFgCode(fgCode: string): { partCode: string; bom: string } | null {
  const m = /^\s*([A-Z]{1,3}-\d{2,4})-(\S+)\s*$/i.exec(fgCode);
  if (!m) return null;
  return { partCode: m[1].toUpperCase(), bom: m[2].toUpperCase() };
}

/** "2026-09-07" → "September 2026", the month the tracker files its sheets under. */
export function monthLabelOfISO(iso: string): string {
  return monthLabelFromInput(iso.slice(0, 7)) ?? "";
}

/** One tracker line, as the lookup carries it across the server/client boundary. */
export type NestingLine = Pick<
  MaterialLineInput,
  "month" | "bom" | "partCode" | "partName" | "materialCode" | "material" | "thicknessMm" | "sheetSize" | "units" | "sheetsPerUnit" | "sheetsUsed" | "note"
> & { id: number };

/** Lines keyed "FB-022|14003E11M11" — the lookup the log page hands the rows. */
export type NestingLookup = Record<string, NestingLine[]>;

export const nestingKey = (partCode: string, bom: string) => `${partCode}|${bom}`;

export interface MaterialNeedLine {
  id: number;
  materialCode: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  units: number; // the tracker's job size
  sheetsPerUnit: number; // BOM rate
  sheetsUsed: number | null; // nested for the whole job, null while not nested
  actualPerUnit: number | null; // sheetsUsed / units
  /** Sheets the row's quantity needs at the BOM rate. */
  forQtyBom: number;
  /** Sheets the row's quantity really consumes at the nesting's actual rate —
   *  what the planner books in Odoo. Null while the job is not nested. */
  forQtyActual: number | null;
  /** The number to book: actual when nested, else the BOM's. */
  book: number;
  bookIsActual: boolean;
  note: string | null;
}

export interface MaterialNeed {
  partCode: string;
  partName: string;
  bom: string;
  /** How the BOM was found: through the SOI's order, or the FG-CODE's suffix. */
  via: "soi" | "fg";
  qty: number;
  /** The tracker month the lines came from. */
  month: string;
  /** Other months that also carry this part on this BOM. */
  otherMonths: string[];
  lines: MaterialNeedLine[];
  totalBom: number;
  totalActual: number;
  notNested: number;
}

const actualRate = (used: number | null, units: number) => (used === null || !(units > 0) ? null : used / units);

/** The BOMs a row's material may sit under, in lookup order: the SOI's
 *  order(s) from the registry first, then the FG-CODE's own suffix. */
export function candidateBoms(fgCode: string, soiBoms: readonly string[]): { partCode: string; boms: { bom: string; via: "soi" | "fg" }[] } | null {
  const key = splitFgCode(fgCode);
  if (!key) return null;
  const boms: { bom: string; via: "soi" | "fg" }[] = [];
  for (const b of soiBoms) {
    const bom = b.trim().toUpperCase();
    if (bom && !boms.some((x) => x.bom === bom)) boms.push({ bom, via: "soi" });
  }
  if (!boms.some((x) => x.bom === key.bom)) boms.push({ bom: key.bom, via: "fg" });
  return { partCode: key.partCode, boms };
}

/**
 * The material a logged row's quantity needs: the tracker's lines for the
 * row's part on its transformer's BOM, at the row's qty. The BOM comes from
 * the SOI's order when the registry knows it, else from the FG-CODE. The
 * month the row was logged in wins when the tracker has it; otherwise the
 * newest month that does — a BOM nested in August is the same BOM in
 * September. Null when the code cannot be split or no line exists for it.
 */
export function materialNeed(lookup: NestingLookup, fgCode: string, qty: number, loggedMonth: string, soiBoms: readonly string[] = []): MaterialNeed | null {
  const cand = candidateBoms(fgCode, soiBoms);
  if (!cand) return null;
  const hit = cand.boms.map((c) => ({ ...c, lines: lookup[nestingKey(cand.partCode, c.bom)] ?? [] })).find((c) => c.lines.length > 0);
  if (!hit) return null;
  const key = { partCode: cand.partCode, bom: hit.bom };
  const all = hit.lines;

  const months = [...new Set(all.map((l) => l.month))].sort((a, b) => monthLabelSortKey(b) - monthLabelSortKey(a) || b.localeCompare(a));
  const month = months.includes(loggedMonth) ? loggedMonth : months[0];
  const q = Number.isFinite(qty) && qty > 0 ? qty : 0;

  const lines: MaterialNeedLine[] = all
    .filter((l) => l.month === month)
    .map((l) => {
      const rate = actualRate(l.sheetsUsed, l.units);
      const forQtyBom = round3(l.sheetsPerUnit * q);
      const forQtyActual = rate === null ? null : round3(rate * q);
      return {
        id: l.id, materialCode: l.materialCode, material: l.material, thicknessMm: l.thicknessMm, sheetSize: l.sheetSize,
        units: l.units, sheetsPerUnit: l.sheetsPerUnit, sheetsUsed: l.sheetsUsed, actualPerUnit: rate,
        forQtyBom, forQtyActual, book: forQtyActual ?? forQtyBom, bookIsActual: forQtyActual !== null, note: l.note,
      };
    })
    .sort((a, b) => a.material.localeCompare(b.material) || a.thicknessMm - b.thicknessMm || a.materialCode.localeCompare(b.materialCode));

  return {
    partCode: key.partCode,
    partName: all.find((l) => l.partName)?.partName ?? "",
    bom: key.bom,
    via: hit.via,
    qty: q,
    month,
    otherMonths: months.filter((m) => m !== month),
    lines,
    totalBom: round3(lines.reduce((s, l) => s + l.forQtyBom, 0)),
    totalActual: round3(lines.reduce((s, l) => s + (l.forQtyActual ?? 0), 0)),
    notNested: lines.filter((l) => l.forQtyActual === null).length,
  };
}

/** A number as it is pasted into Odoo: up to three decimals, no trailing zeros. */
export function bookText(n: number): string {
  return String(round3(n));
}

/** The whole need as tab-separated text — one line per material, pastes into
 *  a sheet as columns. Code · material · thickness · sheet size · sheets. */
export function materialNeedText(need: MaterialNeed): string {
  const head = ["Code", "Material", "Thk mm", "Sheet", `Sheets for ${need.qty}`].join("\t");
  const rows = need.lines.map((l) =>
    [l.materialCode, l.material, l.thicknessMm, l.sheetSize, bookText(l.book) + (l.bookIsActual ? "" : " (BOM)")].join("\t")
  );
  return [head, ...rows].join("\n");
}
