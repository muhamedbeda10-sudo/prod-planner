import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The transformers' material sheet import against a stubbed database. The
// sheet is the MATERIAL tab's only source — nothing is typed in the tab — so
// what the sheet says replaces what a line held, a rate typed by hand before
// included (a blank note aside), and mirroring the file drops every line it no
// longer carries, one typed in by hand before included.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      materialUsage: { findMany: fn(), createMany: fn(), update: fn(), deleteMany: fn() },
      masterOrder: { findMany: fn() },
      odooEntry: { findMany: fn() },
      handoverEntry: { findMany: fn() },
      $transaction: fn(),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "TR" }));

import { importNestingTracker } from "@/lib/server/material";

function sheet(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Nesting Tracker");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

const HEADER = ["MO", "BOM Ref", "Quantity of Units", "Part Code", "Part Name", "Material Type", "Thickness", "Sheet Size", "No. of Sheets in BOM for one Unit", "No. of Sheets in Actual Nesting for one Unit", "No. of Sheets in Actual Nesting for Job", "Notes"];
const MO = "SF01/MO/20941";
const file = sheet([HEADER, [MO, "B1", 4, "FB-022", "TANK", "Steel", 3, "1220*2440", 0.5, 0.25, 1, null]]);

// the line as the tab holds it: a rate someone typed by hand, and a note
const held = (over: Record<string, unknown> = {}) => ({
  id: 7, month: "", line: "TR", bom: "B1", mo: MO, partCode: "FB-022", partName: "TANK", materialCode: "", material: "Steel", thicknessMm: 3, sheetSize: "1220*2440",
  units: 4, sheetsPerUnit: 0.5, actualPerUnit: 0.4, actualPerUnitManual: true, sheetsUsed: 1, producedQty: null, sortOrder: 2,
  soi: "", mtr: "", weightKg: null, utilization: null, note: "typed note", recordedBy: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.materialUsage.createMany.mockResolvedValue({ count: 0 });
  h.prisma.materialUsage.update.mockImplementation((a: unknown) => a);
  h.prisma.materialUsage.deleteMany.mockResolvedValue({ count: 1 });
  h.prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.odooEntry.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.findMany.mockResolvedValue([]);
});

describe("the material sheet import", () => {
  it("replaces a rate typed in the tab with the sheet's, and keeps a note the sheet leaves blank", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([held()]);
    const r = await importNestingTracker(file, "Sara");
    expect(r).toMatchObject({ ok: true, added: 0, updated: 1, unchanged: 0 });
    expect(h.prisma.materialUsage.update).toHaveBeenCalledWith({ where: { id: 7 }, data: expect.objectContaining({ actualPerUnit: 0.25, actualPerUnitManual: false }) });
    expect(h.prisma.materialUsage.update.mock.calls[0][0].data).not.toHaveProperty("note");
  });

  it("leaves a line alone once it holds exactly what the sheet says", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([held({ actualPerUnit: 0.25, actualPerUnitManual: false })]);
    const r = await importNestingTracker(file, "Sara");
    expect(r).toMatchObject({ ok: true, updated: 0, unchanged: 1 });
    expect(h.prisma.materialUsage.update).not.toHaveBeenCalled();
  });

  it("mirroring the file drops a line typed in by hand before like any other", async () => {
    const typedByHand = held({ id: 9, bom: "B9", mo: "", sortOrder: 1_000_000 });
    h.prisma.materialUsage.findMany.mockResolvedValue([held({ actualPerUnit: 0.25, actualPerUnitManual: false }), typedByHand]);
    const r = await importNestingTracker(file, "Sara", false, true);
    expect(r).toMatchObject({ ok: true, missing: 1, removed: 1 });
    expect(h.prisma.materialUsage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [9] } } });
  });

  it("a plain upload keeps the lines the file does not carry", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([held({ actualPerUnit: 0.25, actualPerUnitManual: false }), held({ id: 9, bom: "B9", mo: "", sortOrder: 1_000_000 })]);
    const r = await importNestingTracker(file, "Sara");
    expect(r).toMatchObject({ ok: true, missing: 1, removed: 0 });
    expect(h.prisma.materialUsage.deleteMany).not.toHaveBeenCalled();
  });

  describe("the sheet moving from the part's MO to the transformer's", () => {
    const ORDER = "PF01/MO/100";
    const onOrder = sheet([HEADER, [ORDER, "B1", 4, "FB-022", "TANK", "Steel", 3, "1220*2440", 0.5, 0.25, 1, null]]);
    // the part MO was closed against the order on the ODOO log
    const closedOnOdoo = () => {
      h.prisma.masterOrder.findMany.mockResolvedValue([{ mo: ORDER }]);
      h.prisma.odooEntry.findMany.mockResolvedValue([{ odooMo: MO, status: "Done", qty: 2, ledgerId: 50 }]);
      h.prisma.handoverEntry.findMany.mockResolvedValue([{ id: 50, mo: ORDER, item: "TN" }]);
    };

    it("takes the older part-MO line over — its MO becomes the order's — rather than add it twice", async () => {
      closedOnOdoo();
      h.prisma.materialUsage.findMany.mockResolvedValue([held({ actualPerUnit: 0.25, actualPerUnitManual: false })]);
      const r = await importNestingTracker(onOrder, "Sara");
      expect(r).toMatchObject({ ok: true, added: 0, updated: 1, moved: 1 });
      expect(h.prisma.materialUsage.update).toHaveBeenCalledWith({ where: { id: 7 }, data: expect.objectContaining({ mo: ORDER, bom: "B1", partCode: "FB-022" }) });
      expect(h.prisma.materialUsage.createMany).not.toHaveBeenCalled();
    });

    it("a preview moves nothing, yet says what would move", async () => {
      closedOnOdoo();
      h.prisma.materialUsage.findMany.mockResolvedValue([held()]);
      const r = await importNestingTracker(onOrder, "Sara", true);
      expect(r).toMatchObject({ ok: true, moved: 1, updated: 1 });
      expect(h.prisma.materialUsage.update).not.toHaveBeenCalled();
    });

    it("notes a row still on an MO no order has", async () => {
      h.prisma.materialUsage.findMany.mockResolvedValue([]);
      const r = await importNestingTracker(file, "Sara");
      expect(r.issues?.some((i) => i.includes("no order of the Plan Tracker has"))).toBe(true);
      expect(h.prisma.odooEntry.findMany).toHaveBeenCalled();
    });

    it("a sheet with no MO column reads nothing more", async () => {
      h.prisma.materialUsage.findMany.mockResolvedValue([]);
      const noMo = sheet([HEADER.slice(1), ["B1", 4, "FB-022", "TANK", "Steel", 3, "1220*2440", 0.5, 0.25, 1, null]]);
      const r = await importNestingTracker(noMo, "Sara");
      expect(r).toMatchObject({ ok: true, added: 1 });
      expect(h.prisma.odooEntry.findMany).not.toHaveBeenCalled();
    });
  });
});
