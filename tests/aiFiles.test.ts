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
    prisma: { aiFile: { create: fn(), count: fn(), aggregate: fn(), findMany: fn(), findUnique: fn(), findFirst: fn(), updateMany: fn(), deleteMany: fn() } },
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
import { chatFile, fileExpander, questionFiles, readSheet, seenBlocks, storeAiFile, withoutSeen } from "@/lib/server/ai/files";
import { fileRef } from "@/lib/domain/aiFiles";
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

describe("a photo or a PDF", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PDF = new TextEncoder().encode("%PDF-1.4\n%âãÏÓ\n1 0 obj");

  it("is measured by the model before it is kept, and refused when the model refuses it", async () => {
    const measure = vi.fn().mockResolvedValue({ ok: true, tokens: 1600 });
    expect(await storeAiFile(user, new File([JPEG], "IMG_2041"), now, measure)).toEqual({ ok: true, file: { id: 12, name: "IMG_2041", kind: "image", size: JPEG.length } });
    expect(measure).toHaveBeenCalledWith({ kind: "image", type: "image/jpeg", data: JPEG });
    // what the model counted it as is kept with it — how many of a chat's files go with each question
    expect(h.prisma.aiFile.create.mock.calls[0][0].data).toMatchObject({ kind: "image", type: "image/jpeg", tokens: 1600 });

    measure.mockResolvedValue({ ok: false, error: "The PDF is damaged." });
    expect(await storeAiFile(user, new File([PDF], "note.pdf"), now, measure)).toEqual({ ok: false, error: "\"note.pdf\" cannot be read by the assistant: The PDF is damaged." });
    measure.mockResolvedValue({ ok: true, tokens: 500_000 });
    expect(await storeAiFile(user, new File([PDF], "manual.pdf"), now, measure)).toMatchObject({ ok: false, error: expect.stringContaining("too much for the assistant") });
    // a count that could not be made does not hold the file back
    measure.mockResolvedValue({ ok: true, tokens: null });
    expect(await storeAiFile(user, new File([PDF], "note.pdf"), now, measure)).toMatchObject({ ok: true });
    expect(h.prisma.aiFile.create.mock.calls[1][0].data).toMatchObject({ kind: "pdf", tokens: null });
  });

  /** The kept photos and PDFs, as the expander's reads find them. */
  const store = (rows: { id: number; userId?: number; kind: string; name?: string; size?: number; tokens?: number | null }[]) =>
    h.prisma.aiFile.findMany.mockImplementation(async ({ where }: { where: { id: { in: number[] }; userId: number } }) =>
      rows
        .filter((r) => where.id.in.includes(r.id) && (r.userId ?? 1) === where.userId)
        .map((r) => ({ type: "image/jpeg", name: `photo ${r.id}.jpg`, size: JPEG.length, tokens: 1600, data: JPEG, ...r })));
  const photoQuestion = (id: number) => ({ role: "user", content: [...seenBlocks([{ id, name: `photo ${id}.jpg`, kind: "image" }], fileRef), { type: "text", text: `photo ${id}` }] });

  it("goes with the question as a reference, and to the model as the file itself", async () => {
    const blocks = seenBlocks([{ id: 12, name: "sheet.jpg", kind: "image" }, { id: 13, name: "plan.xlsx", kind: "excel" }, { id: 14, name: "note.pdf", kind: "pdf" }], fileRef);
    expect(blocks).toEqual([
      { type: "image", source: { type: "file", file_id: "aifile_12" } },
      { type: "document", source: { type: "file", file_id: "aifile_14" }, title: "note.pdf" },
    ]);
    // the person's own only: someone else's file is as good as gone
    store([{ id: 12, kind: "image", name: "sheet.jpg" }, { id: 14, userId: 2, kind: "pdf" }]);
    const expand = fileExpander(1);
    const messages = [
      { role: "user", content: [...blocks, { type: "text", text: "Take the welding figures off it" }] },
      { role: "assistant", content: [{ type: "text", text: "Here they are." }] },
    ];
    const sent = await expand(messages);
    expect(sent[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(JPEG).toString("base64") } },
      { type: "text", text: "[file #14 is no longer kept — it was attached more than 14 days ago]" },
      { type: "text", text: "Take the welding figures off it" },
    ]);
    // the record keeps the references, and each file is read once a question
    expect(messages[0].content[0]).toEqual(blocks[0]);
    expect(sent[1]).toBe(messages[1]);
    await expand(messages);
    expect(h.prisma.aiFile.findMany).toHaveBeenCalledTimes(2);
  });

  it("goes again with each later question while the chat's files fit — the newest first, older ones named", async () => {
    store(Array.from({ length: 22 }, (_, i) => ({ id: 100 + i, kind: "image" })));
    const messages = Array.from({ length: 22 }, (_, i) => photoQuestion(100 + i));
    const sent = await fileExpander(1)(messages);
    expect(sent.map((m) => (m.content as { type: string }[])[0].type)).toEqual([...Array(2).fill("text"), ...Array(20).fill("image")]);
    expect(sent[0].content).toEqual([
      { type: "text", text: "[file #100 \"photo 100.jpg\" — a photo sent earlier in this chat — is not shown with this question: the chat carries more files than one question can. If you need to look at it again, ask the person to attach it again.]" },
      { type: "text", text: "photo 100" },
    ]);
    // only the files that go are read
    expect(h.prisma.aiFile.findMany.mock.calls[1][0]).toEqual({ where: { id: { in: Array.from({ length: 20 }, (_, i) => 102 + i) }, userId: 1 }, select: { id: true, data: true } });
  });

  it("is kept as a line only when the model refused the question carrying it", () => {
    const q = { role: "user", content: [...seenBlocks([{ id: 12, name: "sheet.jpg", kind: "image" }], fileRef), { type: "text", text: "Read it" }] };
    expect(withoutSeen(q, new Map([[12, "sheet.jpg"]])).content).toEqual([
      { type: "text", text: "[file #12 \"sheet.jpg\" could not be read by the assistant — attach it again, or another copy]" },
      { type: "text", text: "Read it" },
    ]);
  });

  it("is never read as a sheet", () => {
    expect(readSheet({ kind: "image", data: JPEG }, {})).toEqual({ error: expect.stringContaining("a photo") });
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

  it("carry no more photos and PDFs than go to the model together", async () => {
    const pdf = (id: number, o: Record<string, unknown> = {}) => kept({ id, name: `scan ${id}.pdf`, kind: "pdf", type: "application/pdf", size: 4 * 1024 * 1024, tokens: 20_000, ...o });
    h.prisma.aiFile.findMany.mockResolvedValue([pdf(1), pdf(2), pdf(3), pdf(4), pdf(5)]);
    expect(await questionFiles(1, [1, 2, 3, 4, 5], 5, now)).toEqual({ ok: false, error: "The photos and PDFs sent with one question come to at most 16 MB — these come to 20 MB. Send some of them with the next question." });
    h.prisma.aiFile.findMany.mockResolvedValue([pdf(1, { tokens: 120_000 }), pdf(2, { tokens: 120_000 }), pdf(3, { size: 1000, tokens: 15_000 })]);
    expect(await questionFiles(1, [1, 2, 3], 5, now)).toMatchObject({ ok: false, error: expect.stringContaining("too much for the assistant to look at with one question") });
    // a sheet is read with a tool: it does not count
    h.prisma.aiFile.findMany.mockResolvedValue([pdf(1), pdf(2), pdf(3), pdf(4), kept({ id: 5, size: 4 * 1024 * 1024 })]);
    expect(await questionFiles(1, [1, 2, 3, 4, 5], 5, now)).toMatchObject({ ok: true });
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

describe("a wide sheet is read within one answer's room", () => {
  it("cuts the rows (then the columns) to what fits, and says so", async () => {
    const wide = workbook(Array.from({ length: 150 }, (_, r) => Array.from({ length: 80 }, (_, c) => `cell ${r}-${c} ${"x".repeat(50)}`)));
    h.prisma.aiFile.findUnique.mockResolvedValue(kept({ data: wide, size: wide.length }));
    const r = await readAttachedFileTool.run({ fileId: 12, rows: 150 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(30_000);
    const parsed = JSON.parse(r.text) as { rows: string[][]; totalRows: number; note: string };
    expect(parsed.totalRows).toBe(150);
    expect(parsed.rows.length).toBeLessThan(150);
    expect(parsed.note).toContain(`read on from row ${1 + parsed.rows.length}`);
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
    expect(h.importers.importMonthlyPlan).toHaveBeenCalledWith(expect.any(ArrayBuffer), "October 2026", true, "TR", "", { keepMissing: true });
    expect(p).toMatchObject({
      title: "Import the October 2026 transformers' plan",
      summary: expect.stringContaining("cannot be undone from the chat"),
      changes: expect.arrayContaining([
        { label: "New MOs", before: "—", after: "2 (SF01/MO/1; SF01/MO/2)" },
        { label: "Field changes", before: "—", after: "SF01/MO/3 soi: — → SOI9" },
        { label: "Quantity changes (held, not applied)", before: "—", after: "0" },
        { label: "Removed", before: "—", after: "0 removed" },
      ]),
      snapshot: { file: "abc", preview: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    // the same dry run, the same snapshot — a moved one would read stale
    expect((await importMonthlyPlanTool.describe(input, ctx) as { snapshot: unknown }).snapshot).toEqual((p as { snapshot: unknown }).snapshot);

    const out = await importMonthlyPlanTool.execute(input, ctx);
    expect(h.lines).toEqual(["TR"]);
    const fd = h.actions.importMonthlyAction.mock.calls[0][0] as FormData;
    expect(fd.get("month")).toBe("2026-10");
    expect(fd.get("missing")).toBe("keep");
    expect((fd.get("file") as File).name).toBe("October plan.xlsx");
    expect(out).toEqual({ ok: true, message: "Imported: 2 new MO(s), 1 updated, 0 removed." });
    expect(out.undo).toBeUndefined();
  });

  it("never removes the month's other MOs unless asked to in so many words", async () => {
    h.perms.add("plans.import");
    h.importers.importMonthlyPlan.mockResolvedValue({ ...preview, keepMissing: true, notInSheet: 18 });
    h.actions.importMonthlyAction.mockResolvedValue({ ok: true, added: 2, updatedMos: 1, removed: [] });
    const input = { fileId: 12, month: "2026-10", line: "TR" as const };
    expect(await importMonthlyPlanTool.describe(input, ctx)).toMatchObject({
      summary: expect.stringContaining("0 removed"),
      changes: expect.arrayContaining([{ label: "Removed", before: "18 not in the sheet", after: "0 removed — 18 MO(s) of the month not in the sheet stay exactly as they are" }]),
    });

    h.importers.importMonthlyPlan.mockResolvedValue({ ...preview, keepMissing: false, notInSheet: 1, removed: [{ mo: "SF01/MO/9", action: "deleted" }] });
    const takeOut = { ...input, keepMissing: false };
    expect(await importMonthlyPlanTool.describe(takeOut, ctx)).toMatchObject({
      changes: expect.arrayContaining([{ label: "Taken out of the month", before: "1 not in the sheet", after: "1 taken out (SF01/MO/9 deleted)" }]),
    });
    expect(h.importers.importMonthlyPlan).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), "October 2026", true, "TR", "", { keepMissing: false });
    await importMonthlyPlanTool.execute(takeOut, ctx);
    expect((h.actions.importMonthlyAction.mock.calls.at(-1)![0] as FormData).get("missing")).toBe("takeOut");
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
