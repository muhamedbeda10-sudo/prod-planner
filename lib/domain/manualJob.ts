// A job outside the plan, put on a machine by hand (see ManualJob in the
// schema). On the board it is a line like any other, under a key of its own
// so the machine queue — rank, running, split, take off — works on it
// unchanged: BOM "MANUAL", MO "MANUAL-<id>", item "JOB".
//
// On the fabrication board every job is a SHEET JOB: sheets of one
// thickness, material and size, carrying the parts of several projects
// (a tank's Bottom of one BOM beside the Side walls of another). Its count —
// what the board queues, splits over machines and closes — is its SHEETS,
// to the hundredth of a sheet (2.5 sheets; a quarter sheet is 0.25).

import { ITEMS } from "./constants";
import { sheetKeyLabel, sheetKeyOf, type LineMaterial } from "./machineMaterial";

export const MANUAL_BOM = "MANUAL";
export const MANUAL_ITEM = "JOB";

export const manualMo = (id: number) => `MANUAL-${id}`;

/** "MANUAL-12" → 12; null for a plan line's MO. */
export function manualIdOf(mo: string | null | undefined): number | null {
  const m = /^MANUAL-(\d+)$/.exec((mo ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** The boards whose jobs are typed and closed in sheets — fabrication's. */
export const jobsBySheet = (dept: string) => dept === "Cut";

/** A count of sheets rounded to the hundredth — half a sheet, a quarter, a
 *  sheet and a quarter are counted, nothing finer — so what is cut and what
 *  is left add up to the job exactly (0.1 + 0.2 is not left as 0.30000004).
 *  A whole count of pieces comes back as it was. */
export const roundSheets = (n: number) => Math.round(n * 100) / 100;

/** Whether a count of sheets is one a job may carry: above 0, to the
 *  hundredth at most (2, 2.5, 0.25 — not 0.125). */
export const isSheetCount = (n: number) => Number.isFinite(n) && n > 0 && Math.abs(roundSheets(n) - n) < 1e-9;

/** What a sheet count box says when it is refused. */
export const SHEET_COUNT_RULE = "a number above 0, to two decimals at most (2, 2.5, 0.25)";

/** A count as it is typed in a box: "2.5", or "2,5" as a phone keypad may
 *  write it — a comma followed by one or two digits is the decimal point
 *  ("1,000" stays no number). NaN when it is no number; 0 when blank. */
export function typedCount(raw: string): number {
  const t = raw.trim();
  return Number(/^\d+,\d{1,2}$/.test(t) ? t.replace(",", ".") : t);
}

/** The board lines counted in sheets: a sheet job on the fabrication board.
 *  Its share on a machine may be a fraction of a sheet; any other line's is
 *  whole pieces. */
export const isSheetJobLine = (dept: string, bom: string) => bom === MANUAL_BOM && jobsBySheet(dept);

/** The most parts one sheet job carries. */
export const MAX_JOB_PARTS = 40;

export interface ManualJobPartView {
  id: number;
  /** The project (BOM) the part belongs to; "" for work outside the plan. */
  bom: string;
  /** Its component (TN, TC, CF …); "" when none. */
  item: string;
  /** The part, in the planner's words — Bottom, Side wall, Skirt base … */
  part: string;
  /** Pieces of it the job's sheets carry; null when the count was not given. */
  pcs: number | null;
}

export interface ManualJobView {
  id: number;
  dept: string;
  title: string;
  bom: string;
  item: string;
  /** Pieces wanted — on a sheet job, sheets wanted. */
  qty: number;
  /** Pieces done — on a sheet job, sheets cut. */
  doneQty: number;
  /** Counted in sheets, its parts listed (the fabrication board's jobs). */
  bySheet: boolean;
  parts: ManualJobPartView[];
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

/** The sheet a sheet job is cut from, as a sheet key ("3|Steel|1250*2500"). */
export function jobSheetKey(j: Pick<ManualJobView, "thicknessMm" | "material" | "sheetSize">): string {
  return sheetKeyOf({ thicknessMm: j.thicknessMm ?? 0, material: j.material, sheetSize: j.sheetSize });
}

/** "3 mm MS 1250×2500" — the sheet a sheet job is cut from, in words. */
export const jobSheetLabel = (j: Pick<ManualJobView, "thicknessMm" | "material" | "sheetSize">) => sheetKeyLabel(jobSheetKey(j));

/** What a job is called on a list: its title, or a sheet job's sheet when it was given none. */
export function jobName(j: Pick<ManualJobView, "title" | "bySheet" | "thicknessMm" | "material" | "sheetSize">): string {
  const t = j.title.trim();
  if (!j.bySheet) return t;
  return t || jobSheetLabel(j);
}

/** "A123 TN Bottom ×4 · B456 TN Side wall" — a sheet job's parts in one
 *  line, a part's count where it was given. */
export function partsText(parts: readonly Pick<ManualJobPartView, "bom" | "item" | "part" | "pcs">[]): string {
  return parts.map((p) => `${[p.bom, p.item, p.part].filter((x) => x.trim()).join(" ")}${p.pcs !== null ? ` ×${p.pcs}` : ""}`).join(" · ");
}

/** What the board writes beside it: a sheet job's sheet and its parts; any
 *  other job the planner's words, then its BOM and part. */
export function manualDescription(j: Pick<ManualJobView, "title" | "bom" | "item" | "bySheet" | "parts" | "thicknessMm" | "material" | "sheetSize">): string {
  if (j.bySheet) {
    const head = ["🧾 " + jobSheetLabel(j), j.title.trim()].filter(Boolean).join(" · ");
    return j.parts.length > 0 ? `${head} — ${partsText(j.parts)}` : head;
  }
  return ["✋ " + j.title.trim(), j.bom.trim() && `BOM ${j.bom.trim()}`, j.item.trim()].filter(Boolean).join(" · ");
}

/** The sheet it was typed with, in the shape the plan lines' nesting has —
 *  so the card and the printed sheet draw it the same way. A sheet job's
 *  count IS its sheets: one sheet a unit. */
export function manualMaterial(j: Pick<ManualJobView, "material" | "thicknessMm" | "sheetSize" | "sheets" | "qty" | "bySheet">): LineMaterial | null {
  if (j.thicknessMm === null || !(j.thicknessMm > 0)) return null;
  return {
    partName: "",
    month: "typed with the job",
    specs: [{
      material: j.material.trim(), materialCode: "", thicknessMm: j.thicknessMm, sheetSize: j.sheetSize.trim(),
      perUnit: j.bySheet ? 1 : j.sheets !== null && j.qty > 0 ? j.sheets / j.qty : 0, actual: true,
    }],
  };
}

export type JobQtyEdit = { ok: true; finished: boolean } | { ok: false; error: string };

/** What a new count wanted does to a job — pieces, or a sheet job's sheets:
 *  never below what is already done; equal to it finishes the job (it leaves
 *  every machine, as its last ✓ would); above it the job is open — a
 *  finished one opens again, on no machine until it is put on one, as
 *  ↺ Again does. */
export function editedJobQty(doneQty: number, qty: number, bySheet = false): JobQtyEdit {
  if (bySheet ? !isSheetCount(qty) : !Number.isInteger(qty) || qty <= 0) {
    return { ok: false, error: bySheet ? `Sheets must be ${SHEET_COUNT_RULE}.` : "Pieces must be a whole number above 0." };
  }
  if (roundSheets(qty) < roundSheets(doneQty)) {
    return { ok: false, error: bySheet ? `${doneQty} sheet(s) are cut already — the job cannot have fewer than that.` : `${doneQty} piece(s) are done already — the job cannot want fewer than that.` };
  }
  return { ok: true, finished: roundSheets(qty) === roundSheets(doneQty) };
}

/** A sheet job's part rows as the form holds them — one list per column, in
 *  row order — back as rows; a row left wholly empty is no part. The pieces
 *  stay as typed ("" = not given) for readJobParts to check. */
export function partRowsOf(cols: { bom: readonly string[]; item: readonly string[]; part: readonly string[]; pcs: readonly string[] }): { bom: string; item: string; part: string; pcs: string | null }[] {
  const n = Math.max(cols.bom.length, cols.item.length, cols.part.length, cols.pcs.length);
  const rows: { bom: string; item: string; part: string; pcs: string | null }[] = [];
  for (let i = 0; i < n; i += 1) {
    const bom = (cols.bom[i] ?? "").trim();
    const item = (cols.item[i] ?? "").trim();
    const part = (cols.part[i] ?? "").trim();
    const pcs = (cols.pcs[i] ?? "").trim();
    if (!bom && !part && !pcs) continue;
    rows.push({ bom, item, part, pcs: pcs || null });
  }
  return rows;
}

/** A sheet job's parts with each BOM written as the plan writes it, where
 *  the plan carries it (`known`: upper-cased BOM → the plan's spelling); a
 *  BOM the plan does not carry stays as typed — a job may be for any
 *  project — and is named in `notInPlan`, once each. */
export function withPlanSpelling<P extends { bom: string }>(parts: readonly P[], known: ReadonlyMap<string, string>): { parts: P[]; notInPlan: string[] } {
  const notInPlan = new Set<string>();
  const out = parts.map((p) => {
    if (!p.bom) return p;
    const bom = known.get(p.bom.toUpperCase());
    if (bom) return { ...p, bom };
    notInPlan.add(p.bom);
    return p;
  });
  return { parts: out, notInPlan: [...notInPlan] };
}

export type JobPartsRead = { ok: true; parts: Omit<ManualJobPartView, "id">[] } | { ok: false; error: string };

const PART_ITEMS: readonly string[] = ITEMS;

/** A sheet job's parts as the form (or the assistant) sends them, checked:
 *  at least one, each with the part named, its pieces — when given — whole
 *  and above 0 (blank or null = not given), its component one the plan knows
 *  (or none), the same part of the same project once. The BOM is free text
 *  — any project, in the plan or not. */
export function readJobParts(raw: unknown): JobPartsRead {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "Add the parts the sheets carry — at least one." };
  if (raw.length > MAX_JOB_PARTS) return { ok: false, error: `At most ${MAX_JOB_PARTS} parts on one job.` };
  const parts: Omit<ManualJobPartView, "id">[] = [];
  const seen = new Set<string>();
  for (const p of raw as unknown[]) {
    const r = (p ?? {}) as Record<string, unknown>;
    const bom = String(r.bom ?? "").trim().slice(0, 60);
    const item = String(r.item ?? "").trim().toUpperCase().slice(0, 10);
    const part = String(r.part ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const rawPcs = r.pcs === null || r.pcs === undefined ? "" : String(r.pcs).trim();
    const pcs = rawPcs === "" ? null : Number(rawPcs);
    const what = [bom, item, part].filter(Boolean).join(" ") || "A part";
    if (!part) return { ok: false, error: `${what}: name the part (Bottom, Side wall …).` };
    if (item && !PART_ITEMS.includes(item)) return { ok: false, error: `${what}: the component must be one of ${ITEMS.join(", ")} — or left empty.` };
    if (pcs !== null && (!Number.isInteger(pcs) || pcs <= 0 || pcs > 100_000)) return { ok: false, error: `${what}: pieces must be a whole number above 0 — or left empty.` };
    const k = `${bom}|${item}|${part}`.toUpperCase();
    if (seen.has(k)) return { ok: false, error: `${what} is on the job twice — put its pieces on one row.` };
    seen.add(k);
    parts.push({ bom, item, part, pcs });
  }
  return { ok: true, parts };
}

/** The distinct part names already typed, most used first — what the form
 *  offers so the floor keeps one spelling for each. */
export function partNameSuggestions(jobs: readonly Pick<ManualJobView, "parts">[], limit = 60): string[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const j of jobs) for (const p of j.parts) {
    const k = p.part.trim().toUpperCase();
    if (!k) continue;
    const cur = count.get(k);
    if (cur) cur.n += 1;
    else count.set(k, { name: p.part.trim(), n: 1 });
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, limit).map((x) => x.name);
}
