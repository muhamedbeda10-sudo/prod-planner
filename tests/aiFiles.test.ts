import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// Files attached in the assistant's chat (lib/server/ai/files.ts) and the
// import tools that run the screens' own importers on them
// (lib/server/ai/tools/imports.ts): what is kept, who may open it, and that an
// import's card is the importer's own dry run — against a stubbed database
// and stubbed importers.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { aiFile: { create: fn(), count: fn(), aggregate: fn(), findMany: fn(), findUnique: fn(), updateMany: fn(), deleteMany: fn() } },
    perms: new Set<string>(),
    lines: [] as string[],
    importers: {
      importMonthlyPlan: fn(), importWeeklyPlan: fn(), importHandoverFile: fn(), importOdooSheet: fn(), importNestingTracker: fn(), importPhysicalStock: fn(),
    },
    actions: { importPlanAction: fn(), importMonthlyAction: fn(), importHandoverAction: fn(), importOdooAction: fn(), importMaterialAction: fn(), importPhysicalAction: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/line", () => ({ withLine: (l: string, f: () => unknown) => { h.lines.push(l); return f(); } }));
vi.mock("@/lib/server/import", () => ({ importWeeklyPlan: h.importers.importWeeklyPlan }));
vi.mock("@/lib/server/importMonthly", () => ({ importMonthlyPlan: h.importers.importMonthlyPlan }));
vi.mock("@/lib/server/importHandover", () => ({ importHandoverFile: h.importers.importHandoverFile }));
vi.mock("@/lib/server/odoo", () => ({ importOdooSheet: h.importers.importOdooSheet }));
vi.mock("@/lib/server/material", () => ({ importNestingTracker: h.importers.importNestingTracker }));
vi.mock("@/lib/server/physicalStock", () => ({ importPhysicalStock: h.importers.importPhysicalStock }));
// the screens' import actions stubbed; their other actions (the rest of the
// assistant's tools reach them) as they are
vi.mock("@/app/import/actions", () => ({ importPlanAction: h.actions.importPlanAction }));
vi.mock("@/app/orders/actions", async (orig) => ({ ...(await orig<object>()), importMonthlyAction: h.actions.importMonthlyAction }));
vi.mock("@/app/handover/actions", async (orig) => ({ ...(await orig<object>()), importHandoverAction: h.actions.importHandoverAction }));
vi.mock("@/app/odoo/actions", async (orig) => ({ ...(await orig<object>()), importOdooAction: h.actions.importOdooAction }));
vi.mock("@/app/material/actions", async (orig) => ({ ...(await orig<object>()), importMaterialAction: h.actions.importMaterialAction }));
vi.mock("@/app/physical/actions", async (orig) => ({ ...(await orig<object>()), importPhysicalAction: h.actions.importPhysicalAction }));

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { chatFile, questionFiles, readSheet, storeAiFile } from "@/lib/server/ai/files";
import { importDailyLogTool, importMaterialSheetTool, importMonthlyPlanTool, readAttachedFileTool } from "@/lib/server/ai/tools/imports";
import { checkToolInput } from "@/lib/server/ai/tools";

const user = { id: 1, name: "Sara", isAdmin: false, isOwner: false } as User;
const ctx: ToolCtx = { user, hidden: new Set(), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 5, automationId: null };
const now = new Date("2026-10-12T08:00:00Z");

function workbook(rows: unknown[][], sheet = "Plan"): Uint8Array<ArrayBuffer> {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
const PLAN = workbook([["MO", "BOM", "Qty"], ["SF01/MO/1", "T-1000", 4], ["SF01/MO/2", "T-630", 2]]);
const kept = (o: Record<string, unknown> = {}) => ({
  id: 12, userId: 1, conversationId: 5, name: "October plan.xlsx", kind: "excel", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: PLAN.length, sha256: "abc", data: PLAN, createdAt: new Date("2026-10-12T07:00:00Z"), ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.lines.length = 0;
  h.prisma.aiFile.count.mockResolvedValue(0);
  h.prisma.aiFile.aggregate.mockResolvedValue({ _sum: { size: 1000 } });
  h.prisma.aiFile.create.mockResolvedValue({ id: 12 });
  h.prisma.aiFile.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.aiFile.findUnique.mockResolvedValue(kept());
});

describe("keeping an attached file", () => {
  it("keeps a real workbook with its kind, size and hash, after clearing what is past its days", async () => {
    const r = await storeAiFile(user, new File([PLAN], "C:\\Downloads\\October plan.xlsx"), now);
    expect(r).toEqual({ ok: true, file: { id: 12, name: "October plan.xlsx", kind: "excel", size: PLAN.length } });
    const data = h.prisma.aiFile.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: 1, kind: "excel", size: PLAN.length });
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.prisma.aiFile.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: new Date("2026-09-28T08:00:00Z") } } });
  });

  it("refuses what is not a sheet, too big, too many in an hour, or past the store's room", async () => {
    expect(await storeAiFile(user, new File([new Uint8Array([0x4d, 0x5a, 0x90])], "plan.xlsx"), now)).toMatchObject({ ok: false, error: expect.stringContaining("not a file the assistant takes") });
    expect(await storeAiFile(user, new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.csv"), now)).toMatchObject({ ok: false, error: expect.stringContaining("at most 4 MB") });
    h.prisma.aiFile.count.mockResolvedValue(30);
    expect(await storeAiFile(user, new File([PLAN], "plan.xlsx"), now)).toMatchObject({ ok: false, error: expect.stringContaining("30 files in an hour") });
    h.prisma.aiFile.count.mockResolvedValue(0);
    h.prisma.aiFile.aggregate.mockResolvedValue({ _sum: { size: 200 * 1024 * 1024 } });
    expect(await storeAiFile(user, new File([PLAN], "plan.xlsx"), now)).toMatchObject({ ok: false, error: expect.stringContaining("file store is full") });
    expect(h.prisma.aiFile.create).not.toHaveBeenCalled();
  });
});

describe("a question's files", () => {
  it("are the person's own, still kept, and sent in no other chat", async () => {
    h.prisma.aiFile.findMany.mockResolvedValue([kept({ conversationId: null })]);
    const ok = await questionFiles(1, [12, 12], null, now);
    expect(ok).toMatchObject({ ok: true, files: [{ id: 12, name: "October plan.xlsx", kind: "excel", sheets: ["\"Plan\" (3 rows × 3 columns)"] }] });
    expect(h.prisma.aiFile.findMany).toHaveBeenCalledWith({ where: { id: { in: [12] }, userId: 1 } });

    h.prisma.aiFile.findMany.mockResolvedValue([kept({ conversationId: 9 })]);
    expect(await questionFiles(1, [12], 5, now)).toEqual({ ok: false, error: "A file was sent in another chat — attach it again here." });
    h.prisma.aiFile.findMany.mockResolvedValue([]);
    expect(await questionFiles(1, [12], 5, now)).toEqual({ ok: false, error: "A file is not there any more — attach it again." });
    h.prisma.aiFile.findMany.mockResolvedValue([kept({ createdAt: new Date("2026-09-01T00:00:00Z") })]);
    expect(await questionFiles(1, [12], 5, now)).toEqual({ ok: false, error: "A file is not there any more — attach it again." });
    expect(await questionFiles(1, [1, 2, 3, 4, 5, 6], 5, now)).toMatchObject({ ok: false, error: "At most 5 files with one question." });
  });

  it("opens for the assistant only for its person, in its chat", async () => {
    expect(await chatFile(ctx, 12)).toMatchObject({ id: 12 });
    h.prisma.aiFile.findUnique.mockResolvedValue(kept({ userId: 2 }));
    expect(await chatFile(ctx, 12)).toEqual({ error: expect.stringContaining("No file #12 in this chat") });
    h.prisma.aiFile.findUnique.mockResolvedValue(kept({ conversationId: 6 }));
    expect(await chatFile(ctx, 12)).toEqual({ error: expect.stringContaining("No file #12 in this chat") });
    expect(await chatFile({ ...ctx, conversationId: null }, 12)).toEqual({ error: "Files are read only in the chat they were attached in." });
  });

  it("reads as rows of text, a sheet at a time", async () => {
    expect(readSheet(kept(), { fromRow: 2, rows: 1 })).toEqual({ sheets: ["Plan"], sheet: "Plan", fromRow: 2, totalRows: 3, rows: [["SF01/MO/1", "T-1000", "4"]] });
    expect(readSheet(kept(), { sheet: "Nope" })).toEqual({ error: "No sheet \"Nope\" — the workbook has: Plan." });
    const r = await readAttachedFileTool.run({ fileId: 12 }, ctx);
    expect(JSON.parse(r.text)).toMatchObject({ file: "October plan.xlsx", totalRows: 3 });
  });
});

describe("importing an attached file", () => {
  const preview = { ok: true, preview: true, added: 2, existing: 1, updatedMos: 1, addedMos: ["SF01/MO/1", "SF01/MO/2"], changes: [{ mo: "SF01/MO/3", field: "soi", from: "", to: "SOI9" }], qtyProposals: [], removed: [], issues: [] };

  it("needs the line's own import permission", async () => {
    const input = checkToolInput(importMonthlyPlanTool, { fileId: 12, month: "2026-10", line: "LV" });
    if (!input.ok) throw new Error(input.error);
    h.perms.add("plans.import");
    expect(await importMonthlyPlanTool.describe(input.input, ctx)).toEqual({ error: expect.stringContaining("LV plans — import") });
  });

  it("shows the importer's own dry run on the card, and runs the screen's import on the same file", async () => {
    h.perms.add("plans.import");
    h.importers.importMonthlyPlan.mockResolvedValue(preview);
    h.actions.importMonthlyAction.mockResolvedValue({ ok: true, added: 2, updatedMos: 1 });
    const input = { fileId: 12, month: "2026-10", line: "TR" as const };
    const p = await importMonthlyPlanTool.describe(input, ctx);
    expect(h.importers.importMonthlyPlan).toHaveBeenCalledWith(expect.any(ArrayBuffer), "October 2026", true, "TR", "");
    expect(p).toMatchObject({
      title: "Import the October 2026 transformers' plan",
      summary: expect.stringContaining("cannot be undone from the chat"),
      changes: expect.arrayContaining([{ label: "New MOs", before: "—", after: "2 (SF01/MO/1; SF01/MO/2)" }, { label: "Field changes", before: "—", after: "SF01/MO/3 soi: — → SOI9" }]),
      snapshot: { file: "abc", preview: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    // the same dry run, the same snapshot — a moved one would read stale
    expect((await importMonthlyPlanTool.describe(input, ctx) as { snapshot: unknown }).snapshot).toEqual((p as { snapshot: unknown }).snapshot);

    const out = await importMonthlyPlanTool.execute(input, ctx);
    expect(h.lines).toEqual(["TR"]);
    const fd = h.actions.importMonthlyAction.mock.calls[0][0] as FormData;
    expect(fd.get("month")).toBe("2026-10");
    expect((fd.get("file") as File).name).toBe("October plan.xlsx");
    expect(out).toEqual({ ok: true, message: "Imported: 2 new MO(s), 1 changed." });
    expect(out.undo).toBeUndefined();
  });

  it("says what the importer refused, and never imports a file of another chat", async () => {
    h.perms.add("logs.import");
    h.importers.importHandoverFile.mockResolvedValue({ ok: false, error: "No data rows (data starts on row 2).", issues: [] });
    expect(await importDailyLogTool.describe({ fileId: 12 }, ctx)).toEqual({ error: "The importer refused the file: No data rows (data starts on row 2)." });
    h.prisma.aiFile.findUnique.mockResolvedValue(kept({ conversationId: 6 }));
    expect(await importDailyLogTool.describe({ fileId: 12 }, ctx)).toEqual({ error: expect.stringContaining("No file #12 in this chat") });
    expect(await importDailyLogTool.execute({ fileId: 12 }, ctx)).toMatchObject({ ok: false });
    expect(h.actions.importHandoverAction).not.toHaveBeenCalled();
  });

  it("runs a line's importer on that line, its dry run too", async () => {
    h.perms.add("lv.material");
    h.importers.importNestingTracker.mockResolvedValue({ ok: true, preview: true, added: 3, updated: 0, unchanged: 5, missing: 2, removed: 0, issues: [] });
    const p = await importMaterialSheetTool.describe({ fileId: 12, line: "LV", prune: true }, ctx);
    expect(h.lines).toEqual(["LV"]);
    expect(h.importers.importNestingTracker).toHaveBeenCalledWith(expect.any(ArrayBuffer), "Sara", true, true);
    expect(p).toMatchObject({ changes: expect.arrayContaining([{ label: "Lines the file no longer carries", before: "2", after: "removed" }]) });
  });

  it("is never offered unattended", async () => {
    const { toolsFor } = await import("@/lib/server/ai/tools");
    h.perms.add("ai.act.import");
    const owner = { ...user, isOwner: true, isAdmin: true } as User;
    const names = (unattended: boolean) => toolsFor(owner, { hidden: new Set(), actionsPaused: false, unattended }).map((t) => t.name);
    expect(names(false)).toEqual(expect.arrayContaining(["read_attached_file", "import_monthly_plan"]));
    expect(names(true)).not.toContain("import_monthly_plan");
    expect(names(true)).not.toContain("read_attached_file");
  });
});
