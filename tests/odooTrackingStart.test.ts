import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ requireAdmin: h.admin }));
vi.mock("@/lib/db", () => ({ prisma: { settings: { upsert: h.save } } }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
import { saveOdooTrackingStart } from "@/app/admin/settings/actions";
beforeEach(() => { vi.resetAllMocks(); h.admin.mockResolvedValue({ user: { name: "Admin" } }); h.save.mockResolvedValue({}); });
const form = (month: string) => { const fd = new FormData(); fd.set("month", month); return fd; };
it("allows an admin to persist the shared tracking month and refresh both allocation views", async () => {
  expect(await saveOdooTrackingStart(form("2026-09"))).toEqual({ ok: true });
  expect(h.save).toHaveBeenCalledWith({ where: { id: 1 }, create: { id: 1, odooTrackingFrom: "2026-09" }, update: { odooTrackingFrom: "2026-09" } });
  expect(h.revalidate).toHaveBeenCalledWith("/tracker"); expect(h.revalidate).toHaveBeenCalledWith("/trace");
});
it("rejects invalid months and non-admin changes without changing the shared baseline", async () => {
  expect((await saveOdooTrackingStart(form("2026-13"))).ok).toBe(false); expect(h.save).not.toHaveBeenCalled();
  h.admin.mockResolvedValue({ error: "Admins only." });
  expect(await saveOdooTrackingStart(form("2026-09"))).toEqual({ ok: false, error: "Admins only." }); expect(h.save).not.toHaveBeenCalled();
});
it("can unset the start so unknown historical project quantities are no longer automatically assigned", async () => {
  expect((await saveOdooTrackingStart(form(""))).ok).toBe(true);
  expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ update: { odooTrackingFrom: null } }));
});
