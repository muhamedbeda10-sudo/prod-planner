import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// The Limits view's writes: who may change the catalogue and its limits, what
// is refused, and that every change leaves its trace.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = {
    consumableItem: { findUnique: fn(), update: fn(), create: fn() },
    consumableLimit: { findUnique: fn(), update: fn(), create: fn(), delete: fn() },
    consumableCatalogueChange: { create: fn() },
  };
  return {
    tx,
    prisma: {
      consumableItem: { findFirst: fn(), findUnique: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    requirePerm: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm }));

import { saveCatalogueItem, saveConsumableLimit, deleteConsumableLimit } from "@/app/consumables/catalogueActions";

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

const keeper = { id: 5, name: "Store Keeper" };
const NO_PERM = { error: "You do not have permission for this action — ask the admin." };

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: keeper });
  h.prisma.$transaction.mockImplementation(async (cb: (tx: typeof h.tx) => unknown) => cb(h.tx));
  h.prisma.consumableItem.findFirst.mockResolvedValue(null);
  h.prisma.consumableItem.findUnique.mockResolvedValue({ id: 3 });
  h.tx.consumableItem.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 50, ...data }));
  h.tx.consumableLimit.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 70, ...data }));
});

describe("saveCatalogueItem", () => {
  it("needs the consumables permission", async () => {
    h.requirePerm.mockResolvedValue(NO_PERM);
    expect(await saveCatalogueItem(form({ name: "Gloves" }))).toEqual({ ok: false, error: NO_PERM.error });
    expect(h.requirePerm).toHaveBeenCalledWith("consumables.edit");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("adds an item, the code upper-cased and PC by default, and records it", async () => {
    const res = await saveCatalogueItem(form({ name: " Spare  fuse ", code: "c-con-fuse-1" }));
    expect(res).toEqual({ ok: true });
    expect(h.tx.consumableItem.create.mock.calls[0][0].data).toEqual({ name: "Spare fuse", code: "C-CON-FUSE-1", uom: "PC", remark: null, active: true });
    expect(h.tx.consumableCatalogueChange.create.mock.calls[0][0].data).toMatchObject({ itemId: 50, entity: "item", action: "create", by: "Store Keeper", byId: 5 });
  });

  it("refuses a name or code another item already has, in any case", async () => {
    h.prisma.consumableItem.findFirst.mockResolvedValueOnce({ name: "Cotton Gloves", code: "C-CON-GLV-COTT" });
    expect((await saveCatalogueItem(form({ name: "cotton gloves" }))).error).toMatch(/already in the catalogue/);
    h.prisma.consumableItem.findFirst.mockResolvedValueOnce({ name: "Cotton Gloves", code: "C-CON-GLV-COTT" });
    expect((await saveCatalogueItem(form({ name: "Other", code: "c-con-glv-cott" }))).error).toMatch(/already Cotton Gloves's/);
  });

  it("retires an item, keeping what it was", async () => {
    const prev = { id: 3, name: "Drill Bit 4mm", code: "C-CON-DRB-04", uom: "PC", remark: null, active: true };
    h.tx.consumableItem.findUnique.mockResolvedValue(prev);
    h.tx.consumableItem.update.mockResolvedValue({ ...prev, active: false });
    expect(await saveCatalogueItem(form({ id: "3", name: "Drill Bit 4mm", code: "C-CON-DRB-04", active: "false" }))).toEqual({ ok: true });
    expect(h.tx.consumableCatalogueChange.create.mock.calls[0][0].data).toMatchObject({ action: "update", before: { active: true }, after: { active: false } });
  });
});

describe("saveConsumableLimit", () => {
  it("adds a limit for the departments picked", async () => {
    const res = await saveConsumableLimit(form({ itemId: "3", departments: ["PaintingLV", "WeldingTX"], basis: "pool", period: "month", qty: "10" }));
    expect(res).toEqual({ ok: true });
    const data = h.tx.consumableLimit.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ itemId: 3, departments: "WeldingTX,PaintingLV", basis: "pool", period: "month" });
    expect(data.qty.toString()).toBe("10");
    expect(h.tx.consumableCatalogueChange.create.mock.calls[0][0].data).toMatchObject({ itemId: 3, entity: "limit", entityId: 70, action: "create" });
  });

  it("stores 'all departments' as one star", async () => {
    await saveConsumableLimit(form({ itemId: "3", allDepartments: "true", departments: ["WeldingTX"], basis: "person", period: "week", qty: "2" }));
    expect(h.tx.consumableLimit.create.mock.calls[0][0].data).toMatchObject({ departments: "*", basis: "person" });
  });

  it("refuses a limit with no department, a bad period or basis, or no quantity", async () => {
    expect((await saveConsumableLimit(form({ itemId: "3", basis: "pool", period: "week", qty: "5" }))).error).toMatch(/at least one department/);
    expect((await saveConsumableLimit(form({ itemId: "3", departments: "WeldingTX", basis: "pool", period: "fortnight", qty: "5" }))).error).toMatch(/how often/);
    expect((await saveConsumableLimit(form({ itemId: "3", departments: "WeldingTX", basis: "team", period: "week", qty: "5" }))).error).toMatch(/each department its own, shared, or per worker/);
    expect((await saveConsumableLimit(form({ itemId: "3", departments: "WeldingTX", basis: "pool", period: "week", qty: "0" }))).error).toMatch(/more than zero/);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("changes a limit and keeps the number it had", async () => {
    h.tx.consumableLimit.findUnique.mockResolvedValue({ id: 8, itemId: 3, departments: "WeldingTX", basis: "pool", period: "week", qty: new Prisma.Decimal(15) });
    h.tx.consumableLimit.update.mockResolvedValue({ id: 8, itemId: 3, departments: "WeldingTX", basis: "pool", period: "week", qty: new Prisma.Decimal(20) });
    expect(await saveConsumableLimit(form({ id: "8", itemId: "3", departments: "WeldingTX", basis: "pool", period: "week", qty: "20" }))).toEqual({ ok: true });
    expect(h.tx.consumableCatalogueChange.create.mock.calls[0][0].data).toMatchObject({ action: "update", before: { qty: 15 }, after: { qty: 20 } });
  });

  it("refuses a limit that belongs to another item", async () => {
    h.tx.consumableLimit.findUnique.mockResolvedValue({ id: 8, itemId: 99, departments: "WeldingTX", basis: "pool", period: "week", qty: new Prisma.Decimal(15) });
    expect((await saveConsumableLimit(form({ id: "8", itemId: "3", departments: "WeldingTX", basis: "pool", period: "week", qty: "20" }))).error).toMatch(/no longer exists/);
    expect(h.tx.consumableLimit.update).not.toHaveBeenCalled();
  });
});

describe("deleteConsumableLimit", () => {
  it("removes a limit and keeps what it was", async () => {
    h.tx.consumableLimit.findUnique.mockResolvedValue({ id: 8, itemId: 3, departments: "WeldingTX", basis: "pool", period: "week", qty: new Prisma.Decimal(15) });
    expect(await deleteConsumableLimit(form({ id: "8" }))).toEqual({ ok: true });
    expect(h.tx.consumableLimit.delete).toHaveBeenCalledWith({ where: { id: 8 } });
    expect(h.tx.consumableCatalogueChange.create.mock.calls[0][0].data).toMatchObject({ itemId: 3, entity: "limit", action: "delete", before: { departments: "WeldingTX", qty: 15 } });
  });

  it("needs the permission", async () => {
    h.requirePerm.mockResolvedValue(NO_PERM);
    expect((await deleteConsumableLimit(form({ id: "8" }))).ok).toBe(false);
    expect(h.tx.consumableLimit.delete).not.toHaveBeenCalled();
  });
});
