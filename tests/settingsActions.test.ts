import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the plant-wide switches -------------------------------------------------
// Both actions here are admin-only and one of them is destructive, so these
// cover the guards and that the destructive one cannot run without being told
// what to do about the daily-log quantities.

const h = vi.hoisted(() => ({
  prisma: { settings: { upsert: vi.fn() }, $transaction: vi.fn() },
  revalidatePath: vi.fn(),
  requireAdmin: vi.fn(),
  clearAllTankRecords: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/auth", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/server/tanks", () => ({ clearAllTankRecords: h.clearAllTankRecords }));

import { setTankTracking, clearTankRecords } from "@/app/admin/settings/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ user: { name: "tester" } });
  h.prisma.settings.upsert.mockResolvedValue({});
  h.clearAllTankRecords.mockResolvedValue({ deleted: 4, ledgerRowsTouched: 0 });
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) => body({}));
});

describe("setTankTracking", () => {
  it("turns it on, creating the settings row if it is not there yet", async () => {
    const res = await setTankTracking(form({ on: "true" }));
    expect(res).toEqual({ ok: true });
    const call = h.prisma.settings.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ tankTracking: true });
    expect(call.create).toMatchObject({ id: 1, tankTracking: true });
  });

  it("turns it off", async () => {
    await setTankTracking(form({ on: "false" }));
    expect(h.prisma.settings.upsert.mock.calls[0][0].update).toEqual({ tankTracking: false });
  });

  it("refreshes the nav, which gains and loses two tabs", async () => {
    await setTankTracking(form({ on: "true" }));
    expect(h.revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(h.revalidatePath.mock.calls.map((c) => c[0])).toContain("/barcode");
  });

  it("is admin only", async () => {
    h.requireAdmin.mockResolvedValue({ error: "no permission" });
    const res = await setTankTracking(form({ on: "true" }));
    expect(res).toEqual({ ok: false, error: "no permission" });
    expect(h.prisma.settings.upsert).not.toHaveBeenCalled();
  });
});

describe("clearTankRecords", () => {
  it("keeps the daily log when told to", async () => {
    const res = await clearTankRecords(form({ mode: "keep-quantities" }));
    expect(res).toEqual({ ok: true, deleted: 4 });
    expect(h.clearAllTankRecords).toHaveBeenCalledWith(expect.anything(), { keepQuantities: true });
  });

  it("takes the quantities off when told to", async () => {
    await clearTankRecords(form({ mode: "with-quantities" }));
    expect(h.clearAllTankRecords).toHaveBeenCalledWith(expect.anything(), { keepQuantities: false });
  });

  it("will not guess what to do about the quantities", async () => {
    for (const mode of ["", "yes", "delete"]) {
      const res = await clearTankRecords(form({ mode }));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/quantities/);
    }
    expect(h.clearAllTankRecords).not.toHaveBeenCalled();
  });

  it("is admin only — it can move the plant's production figures", async () => {
    h.requireAdmin.mockResolvedValue({ error: "no permission" });
    const res = await clearTankRecords(form({ mode: "keep-quantities" }));
    expect(res).toEqual({ ok: false, error: "no permission" });
    expect(h.clearAllTankRecords).not.toHaveBeenCalled();
  });
});
