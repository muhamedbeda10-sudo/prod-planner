// The CONSUMABLES tab — the store's log of what it hands out to the shop
// floor. Pure rules only (reading the form, the department vocabulary, which
// workers a department offers); the database side is lib/server/consumables.ts.

import { WORKER_SECTIONS, isWorkerSection, sectionLabel, type WorkerSection } from "./tanks";

export const CONSUMABLE_LIMITS = {
  item: 120,
  department: 60,
  notes: 500,
  /** More than a million of anything in one hand-out is a typo. */
  qtyMax: 1_000_000,
  qtyDecimals: 3,
} as const;

/** The department dropdown's "type a new one" choice. */
export const NEW_DEPARTMENT = "__new__";

/** Collapse runs of whitespace (including line breaks) to one space. */
export function cleanText(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/** A positive quantity with at most three decimals ("2", "0.5", "12.125").
 *  Returns the number, or the message to show. */
export function parseQty(raw: unknown): { qty?: number; error?: string } {
  const s = cleanText(raw);
  if (s === "") return { error: "Enter the quantity." };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { error: "The quantity must be a number." };
  const decimals = s.includes(".") ? s.split(".")[1].length : 0;
  if (decimals > CONSUMABLE_LIMITS.qtyDecimals) return { error: `The quantity takes at most ${CONSUMABLE_LIMITS.qtyDecimals} decimals.` };
  const qty = Number(s);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "The quantity must be more than zero." };
  if (qty > CONSUMABLE_LIMITS.qtyMax) return { error: `The quantity cannot exceed ${CONSUMABLE_LIMITS.qtyMax.toLocaleString("en-US")}.` };
  return { qty };
}

export interface ConsumableFields {
  item: string;
  qty: number;
  /** As typed or picked — resolveDepartment turns it into what is stored. */
  department: string;
  workerId: number;
  notes: string | null;
}

/** Read and validate the hand-out form. The department comes from the
 *  dropdown (`department`), or from the text box beside it (`departmentNew`)
 *  when the dropdown is on "type a new one". */
export function readConsumableForm(get: (name: string) => unknown): { fields?: ConsumableFields; error?: string } {
  const item = cleanText(get("item"));
  if (!item) return { error: "Enter the item." };
  if (item.length > CONSUMABLE_LIMITS.item) return { error: `The item is too long (at most ${CONSUMABLE_LIMITS.item} characters).` };

  const q = parseQty(get("qty"));
  if (q.error) return { error: q.error };

  const picked = cleanText(get("department"));
  const department = picked === NEW_DEPARTMENT ? cleanText(get("departmentNew")) : picked;
  if (!department) return { error: picked === NEW_DEPARTMENT ? "Type the new department's name." : "Pick the department." };
  if (department.length > CONSUMABLE_LIMITS.department) return { error: `The department name is too long (at most ${CONSUMABLE_LIMITS.department} characters).` };
  if (department === NEW_DEPARTMENT) return { error: "Pick the department." };

  const workerRaw = cleanText(get("workerId"));
  const workerId = Number(workerRaw);
  if (!workerRaw || !Number.isInteger(workerId) || workerId <= 0) return { error: "Pick the worker." };

  const notesRaw = String(get("notes") ?? "").trim();
  if (notesRaw.length > CONSUMABLE_LIMITS.notes) return { error: `The notes are too long (at most ${CONSUMABLE_LIMITS.notes} characters).` };

  return { fields: { item, qty: q.qty!, department, workerId, notes: notesRaw || null } };
}

const fold = (s: string) => cleanText(s).toLowerCase();

/**
 * What a department is stored as. A worker section is stored by its code,
 * whether it was picked or typed by its name ("welding tx" → WeldingTX); a
 * department already used is stored in the spelling it was first used with
 * ("maintenance" → "Maintenance"), so the dropdown does not grow a twin for
 * every way it can be typed. Anything else is new and stored as typed.
 */
export function resolveDepartment(typed: string, knownCustom: readonly string[]): string {
  const t = fold(typed);
  const section = WORKER_SECTIONS.find((s) => s.code.toLowerCase() === t || s.label.toLowerCase() === t);
  if (section) return section.code;
  return knownCustom.find((d) => fold(d) === t) ?? cleanText(typed);
}

/** A department's name on screen: a section's label, or the typed name. */
export function departmentLabel(department: string): string {
  return sectionLabel(department);
}

export function isSectionDepartment(department: string): department is WorkerSection {
  return isWorkerSection(department);
}

/** The workers a department's dropdown offers: a section offers the workers
 *  registered in it; a typed department (Maintenance, Store …) is nobody's
 *  section on the workers list, so it offers everyone. */
export function workersForDepartment<W extends { sections: readonly string[] }>(workers: readonly W[], department: string): W[] {
  if (!department || department === NEW_DEPARTMENT) return [...workers];
  if (!isSectionDepartment(department)) return [...workers];
  return workers.filter((w) => w.sections.includes(department));
}

/** The worker check an action applies. A worker must be active and — for a
 *  section department — registered in that section. An admin correcting
 *  something else on an old row keeps its worker even if he has since been
 *  deactivated or moved: `unchanged` skips the checks that would refuse him. */
export function workerProblem(
  worker: { name: string; empId: string; active: boolean; sections: readonly string[] } | null,
  department: string,
  unchanged: { worker: boolean; department: boolean } = { worker: false, department: false }
): string | null {
  if (!worker) return "That worker is not on the list — refresh the page.";
  if (!worker.active && !unchanged.worker) return `${worker.empId} — ${worker.name} is deactivated on the workers list — pick another name.`;
  if (unchanged.worker && unchanged.department) return null;
  if (isSectionDepartment(department) && !worker.sections.includes(department)) {
    return `${worker.empId} — ${worker.name} is not registered in ${departmentLabel(department)}.`;
  }
  return null;
}

const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** "28/09/2026 14:05" — the moment as the factory's clock showed it. */
export function factoryDateTimeLabel(at: Date): string {
  const p = Object.fromEntries(TIME_FMT.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
