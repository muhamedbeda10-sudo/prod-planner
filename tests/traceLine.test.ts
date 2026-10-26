import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ guard: vi.fn(), line: vi.fn(), withLine: vi.fn(), tr: vi.fn(), lv: vi.fn(), order: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ guardTab: h.guard }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: h.line, withLine: h.withLine }));
vi.mock("@/lib/server/trace", () => ({ getTrace: h.tr }));
vi.mock("@/lib/db", () => ({ prisma: { masterOrder: { findUnique: h.order } } }));
vi.mock("@/lib/server/lvTrace", () => ({ getLvTrace: h.lv }));
vi.mock("@/components/LvTraceView", () => ({ LvTraceView: () => null }));
vi.mock("@/components/TraceView", () => ({ TraceView: () => null }));
vi.mock("@/components/TraceSearch", () => ({ TraceSearch: () => null }));
vi.mock("@/components/ui", () => ({ PageHeader: () => null }));
import TracePage from "@/app/trace/page";
beforeEach(() => {
  vi.resetAllMocks();
  h.line.mockResolvedValue("TR");
  h.withLine.mockImplementation((_line, run) => run());
  h.tr.mockResolvedValue({ exists: true });
  h.lv.mockResolvedValue({ exists: true });
  h.order.mockResolvedValue(null);
});
it("opens the cited panel record even when the screen is on the transformers", async () => {
  await TracePage({ searchParams: Promise.resolve({ mo: "LV-A", line: "LV" }) });
  expect(h.guard).toHaveBeenCalledWith("/trace");
  expect(h.withLine).toHaveBeenCalledWith("LV", expect.any(Function));
  expect(h.lv).toHaveBeenCalledWith({ mo: "LV-A", bom: "" });
  expect(h.tr).not.toHaveBeenCalled();
});
it("opens an order on its own line when the link names none", async () => {
  h.order.mockResolvedValue({ line: "LV" });
  await TracePage({ searchParams: Promise.resolve({ mo: "LV-A" }) });
  expect(h.withLine).toHaveBeenCalledWith("LV", expect.any(Function));
  expect(h.line).not.toHaveBeenCalled();
});
it("trusts the order's own line over the one the link named", async () => {
  h.order.mockResolvedValue({ line: "LV" });
  await TracePage({ searchParams: Promise.resolve({ mo: "LV-A", line: "TR" }) });
  expect(h.withLine).toHaveBeenCalledWith("LV", expect.any(Function));
});
it("reads a code's line off the link, without looking for an order", async () => {
  await TracePage({ searchParams: Promise.resolve({ bom: "B-1", line: "LV" }) });
  expect(h.order).not.toHaveBeenCalled();
  expect(h.withLine).toHaveBeenCalledWith("LV", expect.any(Function));
});
it("uses the line on screen when neither the link nor an order names one", async () => {
  h.line.mockResolvedValue("LV");
  await TracePage({ searchParams: Promise.resolve({ mo: "LV-A", line: "invalid" }) });
  expect(h.withLine).toHaveBeenCalledWith("LV", expect.any(Function));
});
it("checks access before loading either line", async () => {
  h.guard.mockRejectedValue(Error("Hidden"));
  await expect(TracePage({ searchParams: Promise.resolve({ mo: "LV-A", line: "LV" }) })).rejects.toThrow("Hidden");
  expect(h.lv).not.toHaveBeenCalled();
  expect(h.tr).not.toHaveBeenCalled();
});
