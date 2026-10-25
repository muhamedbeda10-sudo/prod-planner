import type { RosterDept, ShiftCode, WorkCentre } from "./shifts";

export interface ShiftDraft {
  workerId: number;
  dept: RosterDept;
  present: boolean;
  shift: ShiftCode;
  overtimeH: number;
  center: WorkCentre | null;
  note: string;
  recorded: boolean;
}
export const shiftDraftKey = (row: Pick<ShiftDraft, "dept" | "workerId">) => `${row.dept}|${row.workerId}`;
const same = (a: ShiftDraft, b?: ShiftDraft) => !!b && a.present === b.present && a.shift === b.shift && a.overtimeH === b.overtimeH && a.center === b.center && a.note === b.note && a.recorded === b.recorded;

export function shiftDepartmentDirty(draft: readonly ShiftDraft[], baseline: readonly ShiftDraft[], dept?: RosterDept): boolean {
  const rows = dept ? draft.filter((r) => r.dept === dept) : draft;
  const original = new Map(baseline.filter((r) => !dept || r.dept === dept).map((r) => [shiftDraftKey(r), r]));
  return rows.length !== original.size || rows.some((r) => !same(r, original.get(shiftDraftKey(r))));
}

/** A save/refresh for one department must not replace another department's unsaved work.
 * Clean rows follow fresh server data, including additions and corrections by another supervisor. */
export function reconcileShiftDrafts(draft: readonly ShiftDraft[], baseline: readonly ShiftDraft[], fresh: readonly ShiftDraft[]): ShiftDraft[] {
  const edited = new Map(draft.map((r) => [shiftDraftKey(r), r]));
  const original = new Map(baseline.map((r) => [shiftDraftKey(r), r]));
  return fresh.map((r) => {
    const old = edited.get(shiftDraftKey(r));
    return old && !same(old, original.get(shiftDraftKey(r))) ? old : r;
  });
}

/** Replace only the department acknowledged by save, clear or undo. */
export function replaceShiftDepartment(rows: readonly ShiftDraft[], dept: RosterDept, replacement: readonly ShiftDraft[]): ShiftDraft[] {
  const byKey = new Map(replacement.map((r) => [shiftDraftKey(r), r]));
  return rows.map((r) => r.dept === dept ? byKey.get(shiftDraftKey(r)) ?? r : r);
}
