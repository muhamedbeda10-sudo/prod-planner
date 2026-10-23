import { describe, expect, it, vi } from "vitest";
import type { User } from "@prisma/client";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: vi.fn() }));
vi.mock("@/lib/server/lvTracker", () => ({ getLvTracker: vi.fn() }));
vi.mock("@/lib/server/line", () => ({ withLine: (_line: string, run: () => unknown) => run() }));
import { trackerSummaryTool } from "@/lib/server/ai/tools/planning";
import { checkToolInput } from "@/lib/server/ai/input";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { PANELS, TRANSFORMERS } from "@/evals/planning/fixtures";
const ctx: ToolCtx = { user: { id: 1 } as User, hidden: new Set(), now: new Date(), todayISO: "2026-10-24", conversationId: 1, automationId: null, line: "LV", page: { path: "/tracker", filters: { product: "USS" } } };
const setup = () => {
  const loaders = { tr: vi.fn(async () => TRANSFORMERS), lv: vi.fn(async () => PANELS) };
  return { loaders, tool: trackerSummaryTool(loaders) };
};
describe("planning scope and access", () => {
  it("defaults to the selected line and lets explicit filters override the monthly screen", async () => {
    const { tool, loaders } = setup();
    const result = await tool.run({ usePageFilters: true, filters: { product: "LSS" } }, ctx);
    expect(JSON.parse(result.text).totals).toMatchObject({ orders: 1, required: 30, remaining: 30 });
    expect(loaders.tr).not.toHaveBeenCalled();
    expect(result.links).toContainEqual(expect.objectContaining({ href: "/trace?mo=LV-C&line=LV" }));
  });
  it("does not read a hidden tracker", async () => {
    const { tool, loaders } = setup();
    expect((await tool.run({}, { ...ctx, hidden: new Set(["tracker"]) })).ok).toBe(false);
    expect(loaders.lv).not.toHaveBeenCalled();
    expect(loaders.tr).not.toHaveBeenCalled();
  });
  it("refuses to substitute monthly figures for a weekly or unrelated page or another line", async () => {
    const { tool, loaders } = setup();
    const pages: ToolCtx["page"][] = [null, { path: "/ai", filters: {} }, { path: "/tracker", filters: { view: "weekly" } }];
    for (const page of pages) {
      expect((await tool.run({ usePageFilters: true }, { ...ctx, page })).ok).toBe(false);
    }
    expect((await tool.run({ usePageFilters: true, line: "TR" }, ctx)).ok).toBe(false);
    expect(loaders.lv).not.toHaveBeenCalled();
    expect(loaders.tr).not.toHaveBeenCalled();
  });
  it("bounds the attention list without changing the complete totals and does not infer lateness", async () => {
    const { tool } = setup();
    const result = await tool.run({ line: "TR", detailLimit: 1 }, ctx);
    const data = JSON.parse(result.text);
    expect(data.totals).toMatchObject({ orders: 4, required: 65, complete: 25, remaining: 40 });
    expect(data.attention).toHaveLength(1);
    expect(data.attention[0].mo).toBe("MO-C");
    expect(data.attentionTruncated).toBe(true);
    expect(data.attention[0]).not.toHaveProperty("late");
    expect(data.note).toContain("No schedule lateness");
  });
  it("validates size and rejects filters belonging to the other line", async () => {
    const { tool, loaders } = setup();
    for (const detailLimit of [0, 31]) expect(checkToolInput(tool, { detailLimit }).ok).toBe(false);
    for (const filters of [{ status: "unknown" }, { urgent: "maybe" }, { progress: "unknown" }, { family: "invalid" }, { deptStage: "Welding" }]) {
      expect((await tool.run({ filters }, ctx)).ok).toBe(false);
    }
    expect((await tool.run({ line: "TR", filters: { product: "USS" } }, ctx)).ok).toBe(false);
    expect(loaders.lv).not.toHaveBeenCalled();
    expect(loaders.tr).not.toHaveBeenCalled();
  });
});
