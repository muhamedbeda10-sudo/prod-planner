import { describe, expect, it } from "vitest";
import { reconcileShiftDrafts, replaceShiftDepartment, shiftDepartmentDirty, type ShiftDraft } from "./shiftDraft";

const cut: ShiftDraft = { dept: "Cut", workerId: 1, present: false, shift: "S9", overtimeH: 0, center: "Cutting", note: "", recorded: false };
const welding: ShiftDraft = { ...cut, dept: "Welding", center: null };
describe("independent attendance department drafts", () => {
  it("keeps another department's note and attendance during a save refresh, including a shared worker", () => {
    const baseline = [cut, welding];
    const draft = [{ ...cut, recorded: true, present: true }, { ...welding, note: "Move to night", recorded: true, present: true, shift: "S11" as const }];
    const fresh = [{ ...cut, recorded: true, present: true }, welding];
    const merged = reconcileShiftDrafts(draft, baseline, fresh);
    expect(merged[1]).toEqual(draft[1]);
    expect(shiftDepartmentDirty(merged, fresh, "Cut")).toBe(false);
    expect(shiftDepartmentDirty(merged, fresh, "Welding")).toBe(true);
  });
  it("applies fresh server changes to clean rows while retaining only edits still unsaved", () => {
    const baseline = [cut, welding];
    const draft = [cut, { ...welding, note: "My draft" }];
    const added = { ...cut, workerId: 2 };
    const fresh = [{ ...cut, recorded: true, present: true, note: "Recorded by supervisor" }, welding, added];
    expect(reconcileShiftDrafts(draft, baseline, fresh)).toEqual([fresh[0], draft[1], added]);
  });
  it("acknowledges, clears or undoes only the selected department and keeps newly arrived workers", () => {
    const draft = [{ ...cut, recorded: true, present: true }, { ...welding, note: "Keep this" }, { ...cut, workerId: 2 }];
    const rows = replaceShiftDepartment(draft, "Cut", [cut]);
    expect(rows).toEqual([cut, draft[1], draft[2]]);
    expect(shiftDepartmentDirty(rows, [cut, welding, draft[2]], "Cut")).toBe(false);
    expect(shiftDepartmentDirty(rows, [cut, welding, draft[2]])).toBe(true);
  });
});
