import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The LV "Consumption Details" import against a stubbed database: what a
// bare number in the consumed cell becomes, and the produced count — the
// sheet's where it states one, else the tracker's (nothing is typed in the tab).

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      materialUsage: { findMany: fn(), upsert: fn(), deleteMany: fn() },
      masterOrder: { findMany: fn() },
    },
    // when set, stands in for the parser's result (to vary its wording)
    lvParse: null as null | ((grid: unknown[][]) => unknown),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "LV" }));
vi.mock("@/lib/domain/lvMaterial", async (orig) => {
  const real = await orig<typeof import("@/lib/domain/lvMaterial")>();
  return { ...real, parseLvConsumption: (grid: unknown[][]) => (h.lvParse ? h.lvParse(grid) : real.parseLvConsumption(grid)) };
});

import { importNestingTracker } from "@/lib/server/material";

function sheet(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Consumption Details");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

const HEADER = ["Sr.No", "Product", "Sec Item", "Planned qty", "MO", "BOM ", "Material", "Thickness", "Sheet Size", "No. of Sheets In BOM For One Unit", "Sheets Qty as Per Bom ", "Actually Consumed Sheets Qty as per Nesting", "REMARKS"];
const BARE = "SF01/MO/03673-007"; // a running block: a bare 14.4 consumed, no remark
const STATED = "SF01/MO/03673-005"; // a running block: "For 8 Units 14.4 Sheets Consumed"
const file = sheet([
  HEADER,
  [1, "Lss", 908569106, 30, BARE, "FG-SUA-AS-AA-000004-2", "GI Sheet", "1.5 mm", "1220 × 2440", 1.2, 36, 14.4, null],
  [2, "Uss", 908569105, 19, STATED, "FG-SUA-AS-AA-000004-1", "GI Sheet", "1.5 mm", "1220 × 2440", 1.8, 34.2, "For 8 Units 14.4 Sheets Consumed", null],
]);

// the tab's rows as the last upload left them, each with a produced count the
// LV clerk typed over the tracker's before typing was closed
const line = (over: Record<string, unknown>) => ({
  id: 1, month: "", line: "LV", partCode: "", material: "Galvanized steel", thicknessMm: 1.5, sheetSize: "1220*2440",
  actualPerUnit: null, actualPerUnitManual: false, sheetsUsed: null, note: null, recordedBy: null, ...over,
});
const bareRow = line({ id: 1, bom: "FG-SUA-AS-AA-000004-2", mo: BARE, units: 30, sheetsPerUnit: 1.2, partName: "LSS", materialCode: "908569106", sortOrder: 2, producedQty: 10 });
const statedRow = line({ id: 2, bom: "FG-SUA-AS-AA-000004-1", mo: STATED, units: 19, sheetsPerUnit: 1.8, partName: "USS", materialCode: "908569105", sortOrder: 3, producedQty: 3 });

beforeEach(() => {
  vi.clearAllMocks();
  h.lvParse = null;
  h.prisma.masterOrder.findMany.mockResolvedValue([{ mo: BARE }, { mo: STATED }]);
  h.prisma.materialUsage.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.materialUsage.upsert.mockResolvedValue({});
});

const upsertFor = (mo: string) => h.prisma.materialUsage.upsert.mock.calls.map((c) => c[0]).find((a) => a.where.month_bom_mo_partCode_material_thicknessMm_sheetSize.mo === mo);

describe("a bare number in the consumed cell", () => {
  it("is flagged, not taken for the job's nesting — the job is still running — and the produced count falls back to the tracker", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([{ ...bareRow, units: 1 }, statedRow]);
    const r = await importNestingTracker(file, "Sara");
    expect(r.issues).toEqual([`Row 2: ${BARE} shows 14.4 sheets consumed but neither "Done" nor "For N units" — not counted yet; write "For N units" on the sheet, or "Done" once the job is nested.`]);
    const u = upsertFor(BARE)!;
    // the sheet is the only source: it gives no count, so the typed 10 goes and
    // the panels painted on the tracker count instead
    expect(u.update).toMatchObject({ sheetsUsed: null, actualPerUnit: null, producedQty: null, units: 30, sheetsPerUnit: 1.2 });
    expect(u.create).toMatchObject({ sheetsUsed: null, actualPerUnit: null, producedQty: null, mo: BARE, line: "LV" });
  });

  it("counts as a change in the dry run too, and writes nothing", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([bareRow, statedRow]);
    const r = await importNestingTracker(file, "Sara", true);
    expect(r).toMatchObject({ ok: true, preview: true });
    expect(r.issues).toContain(`Row 2: ${BARE} shows 14.4 sheets consumed but neither "Done" nor "For N units" — not counted yet; write "For N units" on the sheet, or "Done" once the job is nested.`);
    expect(h.prisma.materialUsage.upsert).not.toHaveBeenCalled();
  });

  it("is unchanged once the tab holds exactly what the sheet says", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([{ ...bareRow, producedQty: null }, { ...statedRow, producedQty: 8, actualPerUnit: 1.8 }]);
    const r = await importNestingTracker(file, "Sara");
    expect(r).toMatchObject({ ok: true, added: 0, updated: 0, unchanged: 2 });
    expect(h.prisma.materialUsage.upsert).not.toHaveBeenCalled();
  });
});

describe("the produced count on a re-import", () => {
  it("is the sheet's where it says 'For N Units', with the rate consumed ÷ N", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([bareRow, statedRow]);
    await importNestingTracker(file, "Sara");
    const u = upsertFor(STATED)!;
    // running: the rate and the produced count, not the job's nesting
    expect(u.update).toMatchObject({ producedQty: 8, sheetsUsed: null, actualPerUnit: 1.8 });
    expect(u.create).toMatchObject({ producedQty: 8, sheetsUsed: null, actualPerUnit: 1.8 });
  });

  it("replaces a rate typed in the tab before — the sheet is the only source, as on the TR sheet", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([bareRow, { ...statedRow, producedQty: 8, actualPerUnit: 1.8, actualPerUnitManual: true }]);
    const r = await importNestingTracker(file, "Sara");
    const u = upsertFor(STATED)!;
    // the same figure, but typed: still rewritten, so it is the sheet's from now on
    expect(u.update).toMatchObject({ producedQty: 8, sheetsUsed: null, actualPerUnit: 1.8, actualPerUnitManual: false });
    expect(r.updated).toBe(2);
  });
});

describe("mirroring the file (prune)", () => {
  // the tab holds a third sheet row (id 3) the file no longer carries
  const goneRow = line({ id: 3, bom: "FG-OLD", mo: "SF01/MO/00001-001", units: 1, sheetsPerUnit: 1, partName: "", materialCode: "", sortOrder: 4, producedQty: null });
  beforeEach(() => {
    h.prisma.materialUsage.findMany.mockResolvedValue([bareRow, statedRow, goneRow]);
    h.prisma.materialUsage.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("removes the rows the file no longer carries when every row was read", async () => {
    const r = await importNestingTracker(file, "Sara", false, true);
    expect(r).toMatchObject({ ok: true, missing: 1, removed: 1 });
    expect(h.prisma.materialUsage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [3] } } });
  });

  it("keeps them when a row was skipped — the file does carry it", async () => {
    const withSkip = sheet([
      HEADER,
      [1, "Lss", 908569106, 30, BARE, "FG-SUA-AS-AA-000004-2", "GI Sheet", "1.5 mm", "1220 × 2440", 1.2, 36, 14.4, null],
      [null, null, null, null, null, null, null, "2 mm", "1220 × 2440", null, null, null, null], // no sheets-per-unit
      [2, "Uss", 908569105, 19, STATED, "FG-SUA-AS-AA-000004-1", "GI Sheet", "1.5 mm", "1220 × 2440", 1.8, 34.2, "For 8 Units 14.4 Sheets Consumed", null],
    ]);
    const r = await importNestingTracker(withSkip, "Sara", false, true);
    expect(r).toMatchObject({ ok: true, missing: 1, removed: 0 });
    expect(h.prisma.materialUsage.deleteMany).not.toHaveBeenCalled();
    expect(r.issues).toContain("1 row(s) could not be read, so nothing was removed — fix them and upload again to mirror the file.");
  });

  it("keeps them on the parser's skipped count, however its messages are worded", async () => {
    const { parseLvConsumption } = await vi.importActual<typeof import("@/lib/domain/lvMaterial")>("@/lib/domain/lvMaterial");
    h.lvParse = (grid) => ({ ...parseLvConsumption(grid), issues: ["Row 9: unreadable (reworded, no trailing marker)"], skipped: 1 });
    const r = await importNestingTracker(file, "Sara", false, true);
    expect(r).toMatchObject({ ok: true, missing: 1, removed: 0 });
    expect(h.prisma.materialUsage.deleteMany).not.toHaveBeenCalled();
  });

  it("does not let a message that merely reads like a skip block the prune", async () => {
    const { parseLvConsumption } = await vi.importActual<typeof import("@/lib/domain/lvMaterial")>("@/lib/domain/lvMaterial");
    h.lvParse = (grid) => ({ ...parseLvConsumption(grid), issues: ["Row 9: a note — skipped."], skipped: 0 });
    const r = await importNestingTracker(file, "Sara", false, true);
    expect(r).toMatchObject({ ok: true, missing: 1, removed: 1 });
  });
});
