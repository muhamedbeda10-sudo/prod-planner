import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// The powder scrap writes: who may record, correct and delete a weighing,
// what is refused, and that every change keeps the weighing before it.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      powderScrap: { create: fn(), findUnique: fn(), updateMany: fn() },
      powderScrapRevision: { create: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    requirePerm: vi.fn(),
    requireAdmin: vi.fn(),
    getCurrentUser: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/auth", () => ({
  requirePerm: h.requirePerm,
  requireAdmin: h.requireAdmin,
  getCurrentUser: h.getCurrentUser,
  hasPerm: (u: { isAdmin: boolean; perms: string }, p: string) => u.isAdmin || u.perms.split(",").includes(p),
}));

import { createPowderScrap, deletePowderScrap, updatePowderScrap } from "@/app/consumables/powderActions";
import { factoryDayISO } from "@/lib/domain/dates";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const keeper = { id: 5, name: "Store Keeper", isAdmin: false, perms: "consumables.edit" };
const colleague = { id: 6, name: "Other Keeper", isAdmin: false, perms: "consumables.edit" };
const admin = { id: 1, name: "Admin", isAdmin: true, perms: "" };
const NO_PERM = { error: "You do not have permission for this action — ask the admin." };
const today = factoryDayISO(new Date());
const valid = { day: today, department: "PaintingTX", kg: "12.5", notes: "" };
const version = new Date("2026-09-28T08:00:00.000Z");
const saved = (over: Record<string, unknown> = {}) => ({
  id: 9, day: new Date(`${today}T00:00:00Z`), department: "PaintingTX", kg: new Prisma.Decimal(12.5), notes: null,
  recordedById: 5, deletedAt: null, updatedAt: version, ...over,
});
const ref = { id: "9", version: version.toISOString() };

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: keeper });
  h.requireAdmin.mockResolvedValue({ user: admin });
  h.getCurrentUser.mockResolvedValue(keeper);
  h.prisma.powderScrap.findUnique.mockResolvedValue(saved());
  h.prisma.powderScrap.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.$transaction.mockImplementation(async (cb: (tx: typeof h.prisma) => unknown) => cb(h.prisma));
});

describe("createPowderScrap", () => {
  it("needs the consumables permission", async () => {
    h.requirePerm.mockResolvedValue(NO_PERM);
    expect(await createPowderScrap(form(valid))).toEqual({ ok: false, error: NO_PERM.error });
    expect(h.requirePerm).toHaveBeenCalledWith("consumables.edit");
    expect(h.prisma.powderScrap.create).not.toHaveBeenCalled();
  });

  it("records the weighing with its day and the recorder", async () => {
    expect(await createPowderScrap(form({ ...valid, notes: "colour change" }))).toEqual({ ok: true });
    const data = h.prisma.powderScrap.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ department: "PaintingTX", notes: "colour change", recordedById: 5, recordedBy: "Store Keeper" });
    expect(data.kg.toString()).toBe("12.5");
    expect(data.day.toISOString().slice(0, 10)).toBe(today);
    expect(h.revalidatePath).toHaveBeenCalledWith("/consumables");
  });

  it("refuses a future day and a section that does not paint", async () => {
    expect((await createPowderScrap(form({ ...valid, day: "2999-01-01" }))).error).toMatch(/future/);
    expect((await createPowderScrap(form({ ...valid, department: "WeldingTX" }))).error).toMatch(/painting section/);
    expect(h.prisma.powderScrap.create).not.toHaveBeenCalled();
  });
});

describe("updatePowderScrap", () => {
  it("lets the recorder correct his own weighing, keeping it before and after", async () => {
    expect(await updatePowderScrap(form({ ...ref, ...valid, kg: "10" }))).toEqual({ ok: true });
    const upd = h.prisma.powderScrap.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 9, updatedAt: version, deletedAt: null });
    expect(upd.data.kg.toString()).toBe("10");
    expect(upd.data.editedBy).toBe("Store Keeper");
    expect(h.prisma.powderScrapRevision.create.mock.calls[0][0].data).toMatchObject({
      scrapId: 9, action: "edit", before: { kg: 12.5 }, after: { kg: 10 }, by: "Store Keeper",
    });
  });

  it("refuses a colleague's weighing, but not the admin", async () => {
    h.getCurrentUser.mockResolvedValue(colleague);
    expect((await updatePowderScrap(form({ ...ref, ...valid, kg: "10" }))).error).toMatch(/you recorded yourself/);
    h.getCurrentUser.mockResolvedValue(admin);
    expect((await updatePowderScrap(form({ ...ref, ...valid, kg: "10" }))).ok).toBe(true);
  });

  it("refuses a stale page, a concurrent change, and no change", async () => {
    expect((await updatePowderScrap(form({ ...ref, version: "2026-01-01T00:00:00.000Z", ...valid, kg: "10" }))).error).toMatch(/Someone changed/);
    h.prisma.powderScrap.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await updatePowderScrap(form({ ...ref, ...valid, kg: "10" }))).error).toMatch(/Someone changed/);
    expect((await updatePowderScrap(form({ ...ref, ...valid }))).error).toMatch(/Nothing changed/);
    expect(h.prisma.powderScrapRevision.create).not.toHaveBeenCalled();
  });

  it("refuses a deleted weighing", async () => {
    h.prisma.powderScrap.findUnique.mockResolvedValue(saved({ deletedAt: new Date() }));
    expect((await updatePowderScrap(form({ ...ref, ...valid, kg: "10" }))).error).toMatch(/no longer exists/);
  });
});

describe("deletePowderScrap", () => {
  it("is the admin's alone", async () => {
    h.requireAdmin.mockResolvedValue(NO_PERM);
    expect((await deletePowderScrap(form(ref))).ok).toBe(false);
    expect(h.prisma.powderScrap.updateMany).not.toHaveBeenCalled();
  });

  it("deletes softly and keeps the weighing in its history", async () => {
    expect(await deletePowderScrap(form(ref))).toEqual({ ok: true });
    expect(h.prisma.powderScrap.updateMany.mock.calls[0][0].data).toMatchObject({ deletedBy: "Admin" });
    expect(h.prisma.powderScrapRevision.create.mock.calls[0][0].data).toMatchObject({ scrapId: 9, action: "delete", before: { kg: 12.5 } });
  });
});
