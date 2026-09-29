import { describe, it, expect } from "vitest";
import {
  NEW_DEPARTMENT,
  canEditIssue,
  describeSnapshot,
  parseSnapshot,
  sameSnapshot,
  snapshotChanges,
  cleanText,
  departmentLabel,
  factoryDateTimeLabel,
  parseQty,
  readConsumableForm,
  groupLabel,
  resolveDepartment,
  workerProblem,
  workersForDepartment,
} from "./consumables";
import { factoryDayISO, factoryDayStart } from "./dates";

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null;
const valid = { item: "Welding wire 1.2mm", qty: "2", department: "WeldingTX", workerId: "7", receivedById: "7", notes: "" };

describe("parseQty", () => {
  it("takes whole and decimal quantities", () => {
    expect(parseQty("3").qty).toBe(3);
    expect(parseQty(" 0.5 ").qty).toBe(0.5);
    expect(parseQty(".25").qty).toBe(0.25);
    expect(parseQty("12.125").qty).toBe(12.125);
  });

  it("refuses zero, negatives, text and too many decimals", () => {
    expect(parseQty("").error).toMatch(/Enter the quantity/);
    expect(parseQty("0").error).toMatch(/more than zero/);
    expect(parseQty("-2").error).toMatch(/must be a number/);
    expect(parseQty("2 boxes").error).toMatch(/must be a number/);
    expect(parseQty("1e3").error).toMatch(/must be a number/);
    expect(parseQty("1.2345").error).toMatch(/at most 3 decimals/);
  });

  it("refuses an absurd quantity", () => {
    expect(parseQty("1000001").error).toMatch(/cannot exceed/);
    expect(parseQty("1000000").qty).toBe(1_000_000);
  });
});

describe("readConsumableForm", () => {
  it("reads a complete hand-out", () => {
    const r = readConsumableForm(form({ ...valid, item: "  Welding   wire\n1.2mm ", notes: " for tank 12 " }));
    expect(r.error).toBeUndefined();
    expect(r.fields).toEqual({ item: "Welding wire 1.2mm", qty: 2, department: "WeldingTX", recipients: { scope: "department" }, receivedById: 7, notes: "for tank 12" });
  });

  it("wants who asked for it / collected it", () => {
    expect(readConsumableForm(form({ ...valid, receivedById: "" })).error).toMatch(/who asked for it/);
    expect(readConsumableForm(form({ ...valid, receivedById: "x" })).error).toMatch(/who asked for it/);
  });

  it("stores empty notes as null", () => {
    expect(readConsumableForm(form(valid)).fields?.notes).toBeNull();
  });

  it("takes the typed department when the dropdown is on 'new'", () => {
    const r = readConsumableForm(form({ ...valid, department: NEW_DEPARTMENT, departmentNew: " Maintenance " }));
    expect(r.fields?.department).toBe("Maintenance");
  });

  it("names the missing field", () => {
    expect(readConsumableForm(form({ ...valid, item: " " })).error).toMatch(/item/);
    expect(readConsumableForm(form({ ...valid, qty: "" })).error).toMatch(/quantity/);
    expect(readConsumableForm(form({ ...valid, department: "" })).error).toMatch(/Pick the department/);
    expect(readConsumableForm(form({ ...valid, department: NEW_DEPARTMENT, departmentNew: "" })).error).toMatch(/new department/);
    // no worker is asked for any more — a hand-out is the department's
    expect(readConsumableForm(form({ ...valid, workerId: "" })).error).toBeUndefined();
  });

  it("records to the department whatever an older form sends of workers", () => {
    expect(readConsumableForm(form({ ...valid, workerId: "", recipientScope: "workers", workerIds: "9, 3,9" })).fields?.recipients).toEqual({ scope: "department" });
    // a typed department has no one on the workers list — still fine: the hand-out is its own
    const typed = readConsumableForm(form({ ...valid, department: NEW_DEPARTMENT, departmentNew: "Maintenance", recipientScope: "department" }));
    expect(typed.error).toBeUndefined();
    expect(typed.fields?.department).toBe("Maintenance");
  });

  it("refuses over-long text", () => {
    expect(readConsumableForm(form({ ...valid, item: "x".repeat(121) })).error).toMatch(/too long/);
    expect(readConsumableForm(form({ ...valid, department: NEW_DEPARTMENT, departmentNew: "x".repeat(61) })).error).toMatch(/too long/);
    expect(readConsumableForm(form({ ...valid, notes: "x".repeat(501) })).error).toMatch(/too long/);
  });
});

describe("groupLabel", () => {
  it("names a whole department with its count, and a few workers by name", () => {
    const w = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `W${i + 1}` }));
    expect(groupLabel("department", "WeldingTX", w(12))).toBe("Whole Welding TX (12)");
    expect(groupLabel("workers", "WeldingTX", w(2))).toBe("2 workers: W1, W2");
    expect(groupLabel("workers", "WeldingTX", w(5))).toBe("5 workers: W1, W2, W3 +2");
  });
});

describe("resolveDepartment", () => {
  it("stores a section by its code, picked or typed by name", () => {
    expect(resolveDepartment("WeldingTX", [])).toBe("WeldingTX");
    expect(resolveDepartment("welding tx", [])).toBe("WeldingTX");
    expect(resolveDepartment("  Shot   Blasting ", [])).toBe("ShotBlast");
  });

  it("reuses the first spelling of a department already used", () => {
    expect(resolveDepartment("maintenance", ["Maintenance", "Store"])).toBe("Maintenance");
    expect(resolveDepartment("STORE", ["Maintenance", "Store"])).toBe("Store");
  });

  it("keeps a new department as typed, whitespace cleaned", () => {
    expect(resolveDepartment("  Quality   Control ", ["Maintenance"])).toBe("Quality Control");
  });
});

describe("departmentLabel", () => {
  it("shows a section's label and a typed department as is", () => {
    expect(departmentLabel("PaintingLV")).toBe("USS Painting");
    expect(departmentLabel("Maintenance")).toBe("Maintenance");
  });
});

describe("workersForDepartment", () => {
  const ws = [
    { id: 1, sections: ["WeldingTX"] },
    { id: 2, sections: ["PaintingTX", "WeldingTX"] },
    { id: 3, sections: ["Punching"] },
  ];

  it("offers a section's own workers", () => {
    expect(workersForDepartment(ws, "WeldingTX").map((w) => w.id)).toEqual([1, 2]);
    expect(workersForDepartment(ws, "Punching").map((w) => w.id)).toEqual([3]);
  });

  it("offers everyone for a typed department or none yet", () => {
    expect(workersForDepartment(ws, "Maintenance")).toHaveLength(3);
    expect(workersForDepartment(ws, NEW_DEPARTMENT)).toHaveLength(3);
    expect(workersForDepartment(ws, "")).toHaveLength(3);
  });
});

describe("workerProblem", () => {
  const w = { name: "Sayed", empId: "1203", active: true, sections: ["WeldingTX"] };

  it("passes an active worker of the section, and anyone for a typed department", () => {
    expect(workerProblem(w, "WeldingTX")).toBeNull();
    expect(workerProblem(w, "Maintenance")).toBeNull();
  });

  it("refuses an unknown, inactive or out-of-section worker", () => {
    expect(workerProblem(null, "WeldingTX")).toMatch(/not on the list/);
    expect(workerProblem({ ...w, active: false }, "WeldingTX")).toMatch(/deactivated/);
    expect(workerProblem(w, "PaintingTX")).toMatch(/not registered in Transformer Painting/);
  });

  it("lets an admin's edit keep an old row's worker and department as they were", () => {
    const gone = { ...w, active: false, sections: [] };
    expect(workerProblem(gone, "WeldingTX", { worker: true, department: true })).toBeNull();
    // a new department still has to be his
    expect(workerProblem(gone, "PaintingTX", { worker: true, department: false })).toMatch(/not registered/);
    // a newly picked worker still has to be active
    expect(workerProblem({ ...w, active: false }, "WeldingTX", { worker: false, department: true })).toMatch(/deactivated/);
  });
});

describe("factory time", () => {
  it("labels a moment on the factory's clock", () => {
    // 11:05 UTC in September = 14:05 in Cairo (summer time, UTC+3)
    expect(factoryDateTimeLabel(new Date("2026-09-28T11:05:00Z"))).toBe("28/09/2026 14:05");
    // January: UTC+2
    expect(factoryDateTimeLabel(new Date("2026-01-10T22:30:00Z"))).toBe("11/01/2026 00:30");
  });

  it("finds the first instant of a factory day, summer and winter", () => {
    expect(factoryDayStart("2026-09-28")?.toISOString()).toBe("2026-09-27T21:00:00.000Z");
    expect(factoryDayStart("2026-01-11")?.toISOString()).toBe("2026-01-10T22:00:00.000Z");
    expect(factoryDayStart("nope")).toBeNull();
  });

  it("round-trips with factoryDayISO across the year", () => {
    for (const iso of ["2026-03-01", "2026-04-24", "2026-04-25", "2026-06-15", "2026-10-29", "2026-10-30", "2026-10-31", "2026-12-31"]) {
      const start = factoryDayStart(iso)!;
      expect(factoryDayISO(start)).toBe(iso);
      expect(factoryDayISO(new Date(start.getTime() - 1))).not.toBe(iso);
    }
  });

  it("cleans text", () => {
    expect(cleanText("  a \n\t b ")).toBe("a b");
    expect(cleanText(null)).toBe("");
  });
});

describe("canEditIssue", () => {
  const recorder = { id: 5, isAdmin: false, canRecord: true };
  it("lets the recorder edit his own rows only", () => {
    expect(canEditIssue(recorder, { recordedById: 5 })).toBe(true);
    expect(canEditIssue(recorder, { recordedById: 6 })).toBe(false);
    expect(canEditIssue(recorder, { recordedById: null })).toBe(false);
  });
  it("takes it back when the permission goes", () => {
    expect(canEditIssue({ ...recorder, canRecord: false }, { recordedById: 5 })).toBe(false);
  });
  it("lets an admin edit any row", () => {
    expect(canEditIssue({ id: 1, isAdmin: true, canRecord: false }, { recordedById: 6 })).toBe(true);
    expect(canEditIssue({ id: 1, isAdmin: true, canRecord: false }, { recordedById: null })).toBe(true);
  });
});

describe("snapshots", () => {
  const a = { item: "Gloves", qty: 2, department: "WeldingTX", workerId: 7, workerEmpId: "1203", workerName: "Sayed", notes: null };

  it("compares by value, the worker by id", () => {
    expect(sameSnapshot(a, { ...a, workerName: "Sayed Ali" })).toBe(true);
    expect(sameSnapshot(a, { ...a, qty: 3 })).toBe(false);
    expect(sameSnapshot(a, { ...a, notes: "x" })).toBe(false);
  });

  it("reads a stored snapshot back, and refuses junk", () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseSnapshot({ ...a, notes: "" })?.notes).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ item: "x" })).toBeNull();
    expect(parseSnapshot({ ...a, qty: 0 })).toBeNull();
    expect(parseSnapshot({ ...a, workerId: -1 })).toBeNull();
  });

  it("reads a group row's snapshot — no worker, its label as the name", () => {
    const g = { ...a, workerId: 0, workerEmpId: "", workerName: "Whole Welding TX (12)" };
    expect(parseSnapshot(JSON.parse(JSON.stringify(g)))).toEqual(g);
    expect(describeSnapshot(g)).toContain("Whole Welding TX (12)");
  });

  it("says what changed, field by field", () => {
    const b = { ...a, qty: 3, department: "Maintenance", workerId: 8, workerEmpId: "1310", workerName: "Mahmoud", notes: "spare" };
    expect(snapshotChanges(a, b)).toEqual([
      "Qty: 2 → 3",
      "Department: Welding TX → Maintenance",
      "Worker: 1203 Sayed → 1310 Mahmoud",
      "Notes: — → “spare”",
    ]);
    expect(snapshotChanges(a, null)).toEqual([]);
  });

  it("describes a snapshot in one line", () => {
    expect(describeSnapshot(a)).toBe("2 × Gloves · Welding TX · 1203 Sayed");
    expect(describeSnapshot(null)).toBe("—");
  });
});
