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

// ---- who a hand-out is for ----
//
// One worker (the usual), several named workers at once, or a whole
// department — the store handing a section its week's gloves in one go.
// A group row keeps the workers it was for (the department's active workers
// at work that day, for a whole department) so the per-person limits can
// give each his share, and the count does not drift as people come and go.

export const RECIPIENT_SCOPES = ["worker", "workers", "department"] as const;
export type RecipientScope = (typeof RECIPIENT_SCOPES)[number];
export const RECIPIENT_SCOPE_LABEL: Record<RecipientScope, string> = { worker: "One worker", workers: "Several workers", department: "Whole department" };
/** More names than any section has — a bigger list is a script gone wrong. */
export const MAX_GROUP_WORKERS = 300;

export type RecipientPick =
  | { scope: "worker"; workerId: number }
  | { scope: "workers"; workerIds: number[] }
  | { scope: "department" };

export function isRecipientScope(x: string): x is RecipientScope {
  return (RECIPIENT_SCOPES as readonly string[]).includes(x);
}

/** Read who the hand-out is for. "workerIds" is the ticked workers as a
 *  comma-separated list; a form that sends no scope is an older one — one
 *  worker. One worker ticked under "several" is simply that worker. */
export function readRecipients(get: (name: string) => unknown): { recipients?: RecipientPick; error?: string } {
  const rawScope = cleanText(get("recipientScope")) || "worker";
  if (!isRecipientScope(rawScope)) return { error: "Pick who the hand-out is for." };
  if (rawScope === "department") return { recipients: { scope: "department" } };
  if (rawScope === "workers") {
    const parts = cleanText(get("workerIds")).split(",").map((x) => x.trim()).filter(Boolean);
    const ids = [...new Set(parts.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { error: "Tick the workers again — the list did not read." };
    if (ids.length === 0) return { error: "Tick the workers the hand-out is for." };
    if (ids.length > MAX_GROUP_WORKERS) return { error: `At most ${MAX_GROUP_WORKERS} workers in one hand-out.` };
    return { recipients: ids.length === 1 ? { scope: "worker", workerId: ids[0] } : { scope: "workers", workerIds: ids.sort((a, b) => a - b) } };
  }
  const workerRaw = cleanText(get("workerId"));
  const workerId = Number(workerRaw);
  if (!workerRaw || !Number.isInteger(workerId) || workerId <= 0) return { error: "Pick the worker." };
  return { recipients: { scope: "worker", workerId } };
}

/** How a group row reads in the log: "Whole Welding TX (12)", or "3 workers:
 *  Sayed, Ali, Hassan" (the first names, then "+2"). */
export function groupLabel(scope: Exclude<RecipientScope, "worker">, department: string, workers: readonly { name: string }[]): string {
  if (scope === "department") return `Whole ${departmentLabel(department)} (${workers.length})`;
  const names = workers.map((w) => w.name);
  const shown = names.slice(0, 3).join(", ");
  return `${workers.length} workers: ${shown}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
}

/** The workers each worker section has — its active workers on the list,
 *  those on leave included (a department's limit follows its staff, not who
 *  came in today). A per-person limit is times this number. */
export function departmentWorkers<W extends { active: boolean; sections: readonly string[] }>(workers: readonly W[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of workers) {
    if (!w.active) continue;
    for (const s of new Set(w.sections)) m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

/** Who "whole department" hands out to: the section's active workers who are
 *  at work today (not away on vacation) — the headcount a per-person limit
 *  is multiplied by. */
export function departmentCrew<W extends { active: boolean; onVacation: boolean; sections: readonly string[] }>(workers: readonly W[], department: string): W[] {
  if (!isSectionDepartment(department)) return [];
  return workers.filter((w) => w.active && !w.onVacation && w.sections.includes(department));
}

/** Who a saved row went to, in the log's words: the worker, or the group's
 *  label with no emp ID. */
export function issueWho(r: {
  department: string;
  recipientScope: string;
  worker: { empId: string; name: string } | null;
  recipients: readonly { worker: { name: string } }[];
}): { empId: string; name: string } {
  if (r.worker) return { empId: r.worker.empId, name: r.worker.name };
  // hand-outs are recorded to a department now — no one named
  if (r.recipientScope === "department" && r.recipients.length === 0) return { empId: "", name: departmentLabel(r.department) };
  const scope = r.recipientScope === "department" ? "department" : "workers";
  return { empId: "", name: groupLabel(scope, r.department, r.recipients.map((x) => x.worker)) };
}

export interface ConsumableFields {
  item: string;
  qty: number;
  /** As typed or picked — resolveDepartment turns it into what is stored. */
  department: string;
  recipients: RecipientPick;
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

  const notesRaw = String(get("notes") ?? "").trim();
  if (notesRaw.length > CONSUMABLE_LIMITS.notes) return { error: `The notes are too long (at most ${CONSUMABLE_LIMITS.notes} characters).` };

  // a hand-out is recorded to the department and the quantity it took — no
  // worker is named any more (older rows keep the one they had)
  return { fields: { item, qty: q.qty!, department, recipients: { scope: "department" }, notes: notesRaw || null } };
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

// ---- who may change a saved row, and the versions kept of it ----

/** The row as a revision keeps it — before and after each change. A group
 *  row has workerId 0, no emp ID, and its label ("Whole Welding TX (12)") as
 *  the name: its workers are fixed when it is recorded and never edited. */
export interface ConsumableSnapshot {
  item: string;
  qty: number;
  department: string;
  workerId: number;
  workerEmpId: string;
  workerName: string;
  notes: string | null;
  /** The catalogue item; null for a typed item. Absent on revisions written
   *  before the catalogue existed. */
  itemId?: number | null;
}

/** An admin edits any row; someone holding consumables.edit edits the rows he
 *  recorded himself — his own mistakes, not a colleague's. A row whose
 *  recorder's account is gone is the admin's. */
export function canEditIssue(
  user: { id: number; isAdmin: boolean; canRecord: boolean },
  issue: { recordedById: number | null }
): boolean {
  if (user.isAdmin) return true;
  return user.canRecord && issue.recordedById !== null && issue.recordedById === user.id;
}

/** The same hand-out, field for field (the worker by id — his name on the
 *  list may have changed since). */
export function sameSnapshot(a: ConsumableSnapshot, b: ConsumableSnapshot): boolean {
  return a.item === b.item && a.qty === b.qty && a.department === b.department && a.workerId === b.workerId && (a.notes ?? null) === (b.notes ?? null)
    && (a.itemId ?? null) === (b.itemId ?? null);
}

/** Read a snapshot back from a revision's JSON; null when it is not one. */
export function parseSnapshot(raw: unknown): ConsumableSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const qty = Number(s.qty);
  const workerId = Number(s.workerId);
  if (typeof s.item !== "string" || !s.item || !Number.isFinite(qty) || qty <= 0) return null;
  // 0 = a group row
  if (typeof s.department !== "string" || !s.department || !Number.isInteger(workerId) || workerId < 0) return null;
  return {
    item: s.item, qty, department: s.department, workerId,
    workerEmpId: typeof s.workerEmpId === "string" ? s.workerEmpId : "",
    workerName: typeof s.workerName === "string" ? s.workerName : "",
    notes: typeof s.notes === "string" && s.notes ? s.notes : null,
    ...(s.itemId === undefined ? {} : { itemId: Number.isInteger(Number(s.itemId)) && s.itemId !== null ? Number(s.itemId) : null }),
  };
}

// ---- the catalogue pick and the over-limit reason ----

/** The item dropdown's "not in the catalogue — type it" choice. */
export const NEW_ITEM = "__new__";
export const OVER_LIMIT_REASON_MAX = 300;

/** Which item the form picked: a catalogue id, or a typed item (null — the
 *  name is in the "item" box). */
export function readItemPick(get: (name: string) => unknown): { itemId?: number | null; error?: string } {
  const raw = cleanText(get("itemId"));
  if (raw === NEW_ITEM) return { itemId: null };
  if (raw === "") {
    // an older form (or a script) that only sends the typed name
    return cleanText(get("item")) ? { itemId: null } : { error: "Pick the item." };
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: "Pick the item." };
  return { itemId: id };
}

/** The recorder's reason for going over a limit — one line, trimmed. */
export function readOverLimitReason(get: (name: string) => unknown): { reason: string | null; error?: string } {
  const reason = cleanText(get("overLimitReason"));
  if (reason.length > OVER_LIMIT_REASON_MAX) return { reason: null, error: `The reason is too long (at most ${OVER_LIMIT_REASON_MAX} characters).` };
  return { reason: reason || null };
}

/** A snapshot in one line: "2 × Welding wire · Welding TX · 1203 Sayed · “note”". */
export function describeSnapshot(s: ConsumableSnapshot | null): string {
  if (!s) return "—";
  return [
    `${s.qty} × ${s.item}`,
    departmentLabel(s.department),
    `${s.workerEmpId} ${s.workerName}`.trim() || null,
    s.notes ? `“${s.notes}”` : null,
  ].filter(Boolean).join(" · ");
}

/** The fields that differ between two snapshots, as "Qty 10 → 8" lines — what
 *  the admin reads first. */
export function snapshotChanges(before: ConsumableSnapshot | null, after: ConsumableSnapshot | null): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  if (before.item !== after.item) out.push(`Item: ${before.item} → ${after.item}`);
  if (before.qty !== after.qty) out.push(`Qty: ${before.qty} → ${after.qty}`);
  if (before.department !== after.department) out.push(`Department: ${departmentLabel(before.department)} → ${departmentLabel(after.department)}`);
  if (before.workerId !== after.workerId) out.push(`Worker: ${before.workerEmpId} ${before.workerName} → ${after.workerEmpId} ${after.workerName}`);
  if ((before.notes ?? "") !== (after.notes ?? "")) out.push(`Notes: ${before.notes ? `“${before.notes}”` : "—"} → ${after.notes ? `“${after.notes}”` : "—"}`);
  return out;
}
