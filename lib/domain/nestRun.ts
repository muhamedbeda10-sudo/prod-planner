// A nest run (see NestRun in the schema): sheets of one material, thickness
// and size on a cutting machine, carrying parts of several jobs. On the
// board it is a line under a key of its own, so the machine queue works on
// it unchanged: BOM "RUN", MO "RUN-<id>", item "SHEET" — its pieces are its
// sheets.

import { sheetKeyOf, sheetKeyLabel } from "./machineMaterial";

export const RUN_BOM = "RUN";
export const RUN_ITEM = "SHEET";

export const runMo = (id: number) => `RUN-${id}`;

/** "RUN-7" → 7; null for any other line's MO. */
export function runIdOf(mo: string | null | undefined): number | null {
  const m = /^RUN-(\d+)$/.exec((mo ?? "").trim());
  return m ? Number(m[1]) : null;
}

export interface NestRunPartView {
  id: number;
  bom: string;
  mo: string;
  item: string;
  pcs: number;
  donePcs: number;
  consumedPcs: number;
  /** The item's own sheet this part stands in for, when the run's sheet is
   *  not one its nesting uses; "" = the run's sheet is the item's. */
  replaces: string;
}

export interface NestRunView {
  id: number;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheets: number;
  sheetsDone: number;
  /** The sheets carry the same parts — one time stands for each. */
  identical: boolean;
  /** Cutting minutes: one figure for identical sheets, one per sheet otherwise; empty = not given. */
  sheetMinutes: number[];
  note: string | null;
  parts: NestRunPartView[];
  /** The machines it sits on now (codes). */
  onMachines: string[];
  createdBy: string | null;
  createdAtISO: string;
  doneAtISO: string | null;
}

/** The sheet key the run cuts — the same key a machine's share of an item names. */
export const runSheet = (r: Pick<NestRunView, "thicknessMm" | "material" | "sheetSize">) => sheetKeyOf(r);

/** "5 × 3 mm MS 1250×2500" */
export function runTitle(r: Pick<NestRunView, "sheets" | "thicknessMm" | "material" | "sheetSize">): string {
  return `${r.sheets} × ${sheetKeyLabel(runSheet(r))}`;
}

/** What the board writes for it: the sheets, then every job's part on them. */
export function runDescription(r: Pick<NestRunView, "sheets" | "thicknessMm" | "material" | "sheetSize" | "parts">): string {
  const by = new Map<string, number>();
  for (const p of r.parts) by.set(`${p.bom} ${p.item}`, (by.get(`${p.bom} ${p.item}`) ?? 0) + p.pcs);
  return `🧩 ${runTitle(r)} — ${[...by].map(([k, n]) => `${k} ×${n}`).join(" · ")}`;
}

/** Each part's pieces cut once `sheetsDone` of the run's sheets are finished:
 *  its share of them, rounded down so nothing is counted before it is cut —
 *  the last sheet brings every part to its full count. */
export function partsDoneAt(parts: readonly Pick<NestRunPartView, "id" | "pcs">[], sheets: number, sheetsDone: number): Map<number, number> {
  const out = new Map<number, number>();
  const done = Math.max(0, Math.min(sheets, sheetsDone));
  for (const p of parts) out.set(p.id, sheets <= 0 || done >= sheets ? p.pcs : Math.floor((p.pcs * done) / sheets));
  return out;
}

/** The sheets the parts should take by the nesting's own rates, against the
 *  sheets the run says — a run far off it is worth a second look. Null when
 *  no part has a rate. */
export function expectedSheets(parts: readonly { pcs: number; perUnit: number | null }[]): number | null {
  const rated = parts.filter((p) => p.perUnit !== null && p.perUnit > 0);
  if (rated.length === 0) return null;
  return Math.round(rated.reduce((s, p) => s + p.pcs * p.perUnit!, 0) * 100) / 100;
}

/** Every sheet's cutting minutes, in the order they are cut; null when the
 *  run was saved without a time. Identical sheets repeat their one figure. */
export function minutesPerSheet(r: Pick<NestRunView, "sheets" | "identical" | "sheetMinutes">): number[] | null {
  const m = r.sheetMinutes.filter((x) => Number.isFinite(x) && x >= 0);
  if (m.length === 0) return null;
  if (r.identical) return Array.from({ length: r.sheets }, () => m[0]);
  return Array.from({ length: r.sheets }, (_, i) => m[i] ?? 0);
}

/** Minutes of cutting the run still holds — the sheets not finished yet. */
export function minutesLeft(r: Pick<NestRunView, "sheets" | "sheetsDone" | "identical" | "sheetMinutes">): number | null {
  const all = minutesPerSheet(r);
  return all === null ? null : all.slice(Math.max(0, r.sheetsDone)).reduce((s, x) => s + x, 0);
}

/** 95 → "1 h 35 min"; 40 → "40 min". */
export function minutesText(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
