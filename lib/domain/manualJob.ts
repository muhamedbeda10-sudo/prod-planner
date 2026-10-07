// A job outside the plan, put on a machine by hand (see ManualJob in the
// schema). On the board it is a line like any other, under a key of its own
// so the machine queue — rank, running, split, take off — works on it
// unchanged: BOM "MANUAL", MO "MANUAL-<id>", item "JOB".

import type { LineMaterial } from "./machineMaterial";

export const MANUAL_BOM = "MANUAL";
export const MANUAL_ITEM = "JOB";

export const manualMo = (id: number) => `MANUAL-${id}`;

/** "MANUAL-12" → 12; null for a plan line's MO. */
export function manualIdOf(mo: string | null | undefined): number | null {
  const m = /^MANUAL-(\d+)$/.exec((mo ?? "").trim());
  return m ? Number(m[1]) : null;
}

export interface ManualJobView {
  id: number;
  dept: string;
  title: string;
  bom: string;
  item: string;
  qty: number;
  doneQty: number;
  material: string;
  thicknessMm: number | null;
  sheetSize: string;
  sheets: number | null;
  note: string | null;
  /** The machines it sits on now (codes) — empty when it is off every machine. */
  onMachines: string[];
  /** The machine it was last put on or finished on. */
  lastMachine: string | null;
  createdBy: string | null;
  createdAtISO: string;
  doneAtISO: string | null;
}

/** What the board writes beside it: the planner's words, then its BOM and part. */
export function manualDescription(j: Pick<ManualJobView, "title" | "bom" | "item">): string {
  return ["✋ " + j.title.trim(), j.bom.trim() && `BOM ${j.bom.trim()}`, j.item.trim()].filter(Boolean).join(" · ");
}

/** The sheet it was typed with, in the shape the plan lines' nesting has —
 *  so the card and the printed sheet draw it the same way. */
export function manualMaterial(j: Pick<ManualJobView, "material" | "thicknessMm" | "sheetSize" | "sheets" | "qty">): LineMaterial | null {
  if (j.thicknessMm === null || !(j.thicknessMm > 0)) return null;
  return {
    partName: "",
    month: "typed with the job",
    specs: [{
      material: j.material.trim(), materialCode: "", thicknessMm: j.thicknessMm, sheetSize: j.sheetSize.trim(),
      perUnit: j.sheets !== null && j.qty > 0 ? j.sheets / j.qty : 0, actual: true,
    }],
  };
}
