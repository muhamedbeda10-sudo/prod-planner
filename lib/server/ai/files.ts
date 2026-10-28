import "server-only";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import type { AiFile, User } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { AI_FILE_LIMITS, XLSX_TYPE, aiFileKind, cleanFileName, madeFileName, fileRefId, fileSizeText, filesToSend, isSeenKind, questionSeenProblem, type AiFileKind, type AttachedFile, type SeenImageType } from "@/lib/domain/aiFiles";
import { MAX_TITLE_LINES, type SheetStyleInput } from "@/lib/domain/sheetStyle";
import { parseCsv } from "@/lib/domain/tableExport";
import type { WorkbookSheet } from "@/lib/excel/workbook";
import { streamedWorkbookBytes } from "@/lib/server/excel";
import type { ToolCtx } from "./tools/types";

// The files people attach in the assistant's chat (lib/domain/aiFiles.ts has
// the rules). A file is a person's own and its chat's: the assistant's tools
// open it only for that person, in that chat. Kept in the database — there
// is no other storage to configure — for a fortnight, then cleared.

const DAY_MS = 86_400_000;

export type StoreResult = { ok: true; file: { id: number; name: string; kind: AiFileKind; size: number } } | { ok: false; error: string };

/** How the model takes a photo or a PDF — measured before it is kept, so a
 *  file the model refuses never reaches a chat (lib/server/ai/vision.ts). */
export type MeasureSeen = (f: { kind: "image" | "pdf"; type: string; data: Uint8Array }) => Promise<{ ok: true; tokens: number | null } | { ok: false; error: string }>;

/** A workbook out of a kept file's bytes — null when it cannot be read. */
function workbookOf(data: Uint8Array): XLSX.WorkBook | null {
  try {
    return XLSX.read(data, { type: "array", cellDates: false, dense: true });
  } catch {
    return null;
  }
}

/** Why one more file of `bytes` cannot be kept for the person now — how
 *  many they kept this hour, or the plant's room — or null. What is past its
 *  days goes first, so the room left is the real one. */
export async function roomProblem(userId: number, bytes: number, now: Date): Promise<string | null> {
  await pruneAiFiles(now);
  const [lastHour, kept] = await Promise.all([
    prisma.aiFile.count({ where: { userId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
    prisma.aiFile.aggregate({ _sum: { size: true } }),
  ]);
  if (lastHour >= AI_FILE_LIMITS.perHour) return `That is ${AI_FILE_LIMITS.perHour} files in an hour — wait a while.`;
  if ((kept._sum.size ?? 0) + bytes > AI_FILE_LIMITS.plantBytes) return `The assistant's file store is full — files are cleared ${AI_FILE_LIMITS.keepDays} days after they were kept. Try again later.`;
  return null;
}

/** Write a kept file's row — the person's own, its bytes fingerprinted. */
async function insertAiFile(f: { userId: number; conversationId?: number; name: string; kind: AiFileKind; type: string; tokens: number | null; data: Uint8Array<ArrayBuffer> }): Promise<{ id: number; name: string; kind: AiFileKind; size: number }> {
  const row = await prisma.aiFile.create({
    data: { ...f, size: f.data.length, sha256: createHash("sha256").update(f.data).digest("hex") },
    select: { id: true },
  });
  return { id: row.id, name: f.name, kind: f.kind, size: f.data.length };
}

/** Keep a file the person attached, once it is checked: its kind by its
 *  bytes, its size, how many they attached this hour, and the room left — and
 *  a photo or a PDF by the model itself, which must take it within reason. */
export async function storeAiFile(user: User, file: File, now = new Date(), measure?: MeasureSeen): Promise<StoreResult> {
  const name = cleanFileName(file.name);
  if (file.size === 0) return { ok: false, error: `"${name}" is empty.` };
  if (file.size > AI_FILE_LIMITS.maxBytes) return { ok: false, error: `"${name}" is ${fileSizeText(file.size)} — at most ${fileSizeText(AI_FILE_LIMITS.maxBytes)} a file.` };
  const data = new Uint8Array(await file.arrayBuffer());
  const kind = aiFileKind(name, data.subarray(0, 4096));
  if (!kind) return { ok: false, error: `"${name}" is not a file the assistant takes — a photo (JPEG, PNG, WebP), a PDF, an Excel workbook or a CSV sheet. An iPhone photo in HEIC: send it as a screenshot, or set the camera to "Most Compatible".` };
  let tokens: number | null = null;
  if (isSeenKind(kind.kind)) {
    if (measure) {
      const m = await measure({ kind: kind.kind, type: kind.type, data });
      if (!m.ok) return { ok: false, error: `"${name}" cannot be read by the assistant: ${m.error}` };
      if (m.tokens !== null && m.tokens > AI_FILE_LIMITS.seenTokens) {
        return { ok: false, error: `"${name}" is too much for the assistant to look at with one question — send the pages that matter, or a smaller photo.` };
      }
      tokens = m.tokens;
    }
  } else if (!workbookOf(data)) return { ok: false, error: `"${name}" could not be read as a sheet — is it damaged?` };

  const full = await roomProblem(user.id, data.length, now);
  if (full) return { ok: false, error: full };
  return { ok: true, file: await insertAiFile({ userId: user.id, name, kind: kind.kind, type: kind.type, tokens, data }) };
}

/** A workbook the assistant made for the person — written in the house
 *  style and the style asked for (lib/excel/workbook.ts), kept as their own
 *  file in their chat, under the same size limit as the files they attach,
 *  cleared on the same day. The caller checks the room first (roomProblem),
 *  before it reads what goes on the sheets; a style that does not fit them
 *  is refused before anything is written. Never sent to the model again: only a question's own
 *  attachments are. */
export async function storeMadeWorkbook(
  ctx: Pick<ToolCtx, "user" | "conversationId">,
  name: string,
  sheets: readonly WorkbookSheet[],
  style?: SheetStyleInput,
): Promise<(StoreResult & { ok: false }) | (StoreResult & { ok: true; sheets: string[] })> {
  if (ctx.conversationId === null) return { ok: false, error: "A file is made only in a chat the person is in." };
  const made = await streamedWorkbookBytes(sheets, style);
  if (!made.ok) return made;
  const { data, names } = made;
  if (data.length > AI_FILE_LIMITS.maxBytes) return { ok: false, error: `That sheet comes to ${fileSizeText(data.length)} — at most ${fileSizeText(AI_FILE_LIMITS.maxBytes)} a file. Narrow it (a shorter period, fewer orders) or split it in two.` };
  const file = await insertAiFile({
    userId: ctx.user.id, conversationId: ctx.conversationId, name: madeFileName(name), kind: "excel",
    type: XLSX_TYPE, tokens: null, data,
  });
  return { ok: true, file, sheets: names };
}

/** A workbook's sheets with their size — "Plan (230 rows × 25 columns)". */
export function sheetsOf(data: Uint8Array): string[] {
  const wb = workbookOf(data);
  if (!wb) return [];
  return wb.SheetNames.map((n) => {
    const ref = wb.Sheets[n]?.["!ref"];
    if (!ref) return `"${n}" (empty)`;
    const r = XLSX.utils.decode_range(ref);
    return `"${n}" (${r.e.r + 1} rows × ${r.e.c + 1} columns)`;
  });
}

/** The files sent with a question, checked: the person's own, kept still,
 *  sent in no other chat (a new chat: in none yet), and its photos and PDFs
 *  few enough to go to the model together. Nothing is written. */
export async function questionFiles(userId: number, ids: readonly number[], conversationId: number | null, now = new Date()): Promise<{ ok: true; files: AttachedFile[] } | { ok: false; error: string }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, files: [] };
  if (unique.length > AI_FILE_LIMITS.perQuestion) return { ok: false, error: `At most ${AI_FILE_LIMITS.perQuestion} files with one question.` };
  const rows = await prisma.aiFile.findMany({ where: { id: { in: unique }, userId } });
  const since = now.getTime() - AI_FILE_LIMITS.keepDays * DAY_MS;
  if (rows.length !== unique.length || rows.some((f) => f.createdAt.getTime() < since)) return { ok: false, error: "A file is not there any more — attach it again." };
  if (rows.some((f) => f.conversationId !== null && f.conversationId !== conversationId)) return { ok: false, error: "A file was sent in another chat — attach it again here." };
  const tooMuch = questionSeenProblem(rows);
  if (tooMuch) return { ok: false, error: tooMuch };
  const byId = new Map(rows.map((f) => [f.id, f]));
  return {
    ok: true,
    files: unique.map((id) => {
      const f = byId.get(id)!;
      return { id: f.id, name: f.name, kind: f.kind as AiFileKind, size: f.size, ...(isSeenKind(f.kind) ? {} : { sheets: sheetsOf(f.data) }) };
    }),
  };
}

/** Tie the files a question was sent with to its chat — theirs from then on. */
export async function linkFiles(userId: number, ids: readonly number[], conversationId: number): Promise<void> {
  if (ids.length === 0) return;
  await prisma.aiFile.updateMany({ where: { id: { in: [...ids] }, userId, conversationId: null }, data: { conversationId } });
}

/** Take back a file attached but not sent with a question. */
export async function discardFile(userId: number, id: number): Promise<void> {
  await prisma.aiFile.deleteMany({ where: { id, userId, conversationId: null } });
}

/** A file for one of the assistant's tools: the person's own, sent in this
 *  very chat — or why not. */
export async function chatFile(ctx: Pick<ToolCtx, "user" | "conversationId">, id: number): Promise<AiFile | { error: string }> {
  if (ctx.conversationId === null) return { error: "Files are read only in the chat they were attached in." };
  const f = await prisma.aiFile.findUnique({ where: { id } });
  if (!f || f.userId !== ctx.user.id || f.conversationId !== ctx.conversationId) return { error: `No file #${id} in this chat — the person attaches it with the paperclip.` };
  return f;
}

/** A kept file's bytes as the importers take them. */
export function bytesOf(f: Pick<AiFile, "data">): ArrayBuffer {
  const d = f.data;
  return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
}

/** A kept file as a screen's import form posts it. */
export function uploadOf(f: Pick<AiFile, "data" | "name" | "type">): File {
  return new File([bytesOf(f)], f.name, { type: f.type });
}

export interface SheetRows {
  sheets: string[];
  sheet: string;
  /** The first row shown, 1-based as the sheet numbers it. */
  fromRow: number;
  totalRows: number;
  rows: string[][];
}

const CELL_MAX = 200;

/** Rows of one sheet as text, the way the sheet shows them (formatted
 *  values, dates as dates) — for the assistant to read. */
export function readSheet(f: Pick<AiFile, "data" | "kind">, o: { sheet?: string; fromRow?: number; rows?: number }): SheetRows | { error: string } {
  if (isSeenKind(f.kind)) return { error: `That file is ${f.kind === "pdf" ? "a PDF" : "a photo"} — you see it with the question it came with; there is no sheet to read.` };
  const wb = workbookOf(f.data);
  if (!wb) return { error: "The file cannot be read as a sheet." };
  const sheet = o.sheet === undefined ? wb.SheetNames[0] : wb.SheetNames.find((n) => n.trim().toLowerCase() === o.sheet!.trim().toLowerCase());
  if (!sheet) return { error: `No sheet "${o.sheet}" — the workbook has: ${wb.SheetNames.join(", ")}.` };
  const grid = textGrid(wb.Sheets[sheet], { blankrows: true });
  const from = Math.max(1, o.fromRow ?? 1);
  const count = Math.min(Math.max(1, o.rows ?? 60), 200);
  const rows = grid.slice(from - 1, from - 1 + count).map((r) => {
    const cells = r.map((c) => c.slice(0, CELL_MAX));
    // trailing empty cells say nothing
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    return cells;
  });
  return { sheets: wb.SheetNames, sheet, fromRow: from, totalRows: grid.length, rows };
}

/** A kept sheet whole, as text, its header row first — a CSV read as the
 *  UTF-8 it is written in (a table sent from a screen, Arabic and all), a
 *  workbook's first sheet as it shows its cells. */
export function sheetGrid(f: Pick<AiFile, "data" | "kind" | "name">): string[][] | { error: string } {
  if (isSeenKind(f.kind)) return { error: `"${f.name}" is ${f.kind === "pdf" ? "a PDF" : "a photo"}, not a sheet.` };
  if (f.kind === "csv") return parseCsv(new TextDecoder("utf-8").decode(f.data));
  const wb = workbookOf(f.data);
  if (!wb) return { error: `"${f.name}" cannot be read as a sheet.` };
  return textGrid(wb.Sheets[wb.SheetNames[0]]);
}

export interface PrintableSheet {
  sheet: string;
  header: string[];
  rows: string[][];
  /** The rows under the header the sheet has, printed or not. */
  total: number;
}

/** A person's own workbook as grids to print, sheet by sheet: each one's
 *  header row and the rows under it, as the sheet shows them — at most
 *  `limit` rows over all of them. Null when there is no such file of theirs,
 *  or it is not a sheet. */
export async function printableSheets(userId: number, id: number, limit: number): Promise<{ name: string; title: string[]; sheets: PrintableSheet[]; createdAt: Date } | null> {
  const f = await prisma.aiFile.findFirst({ where: { id, userId }, select: { name: true, kind: true, data: true, createdAt: true } });
  if (!f || isSeenKind(f.kind)) return null;
  // only the rows printed are read — each sheet's count comes from its own range
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(f.data, { type: "array", dense: true, sheetRows: limit + 2 + MAX_TITLE_LINES });
  } catch {
    return null;
  }
  let left = limit;
  // every sheet of a file carries the same title: the first one's is the file's
  let title: string[] = [];
  const sheets: PrintableSheet[] = [];
  wb.SheetNames.forEach((sheet, index) => {
    const ws = wb.Sheets[sheet];
    if (!ws) return;
    const full = ws["!fullref"] ?? ws["!ref"];
    const range = full ? XLSX.utils.decode_range(full) : null;
    const top = tableTop(wb, ws, index);
    if (sheets.length === 0) title = top.title;
    const total = range ? Math.max(0, range.e.r - top.headerRow) : 0;
    // past the rows printed, only the sheet's size is read
    const [header = [], ...rows] = textGrid(ws, { from: top.headerRow, rows: Math.max(0, left) + 1 });
    sheets.push({ sheet, header, rows, total });
    left -= rows.length;
  });
  return sheets.length === 0 ? null : { name: f.name, title, sheets, createdAt: f.createdAt };
}

/** Where a sheet's table starts — the row its print titles repeat (a made
 *  workbook's, lib/excel/workbook.ts), else its first — and the title lines
 *  over it. */
function tableTop(wb: XLSX.WorkBook, ws: XLSX.WorkSheet, index: number): { title: string[]; headerRow: number } {
  const printTitles = wb.Workbook?.Names?.find((d) => d.Name === "_xlnm.Print_Titles" && d.Sheet === index)?.Ref;
  const repeated = printTitles ? /\$(\d+):\$\d+$/.exec(printTitles) : null;
  const headerRow = repeated ? Math.min(Number(repeated[1]) - 1, MAX_TITLE_LINES + 1) : 0;
  const title = headerRow > 0 ? textGrid(ws, { rows: headerRow }).map((r) => r[0]?.trim() ?? "").filter(Boolean) : [];
  return { title, headerRow };
}

/** A sheet as text, cell by cell, as it shows them (formatted values, dates as dates). */
function textGrid(ws: XLSX.WorkSheet | undefined, o: { blankrows?: boolean; from?: number; rows?: number } = {}): string[][] {
  if (!ws?.["!ref"]) return [];
  // from a row on, at most `rows` rows — the rest never formatted
  const range = XLSX.utils.decode_range(ws["!ref"]);
  if (o.from !== undefined) range.s.r = Math.max(range.s.r, o.from);
  if (o.rows !== undefined) range.e.r = Math.min(range.e.r, range.s.r + o.rows - 1);
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: o.blankrows ?? false, range }).map((r) => r.map((c) => String(c ?? "")));
}

/** Clear the files kept past their days. */
export async function pruneAiFiles(now = new Date()): Promise<number> {
  const r = await prisma.aiFile.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - AI_FILE_LIMITS.keepDays * DAY_MS) } } });
  return r.count;
}

// ------------------------------------------------------------- seen files

type Block = Record<string, unknown> & { type?: string; source?: Record<string, unknown> & { type?: string; file_id?: unknown } };
type Message = { role: string; content: unknown };

/** The blocks a question carries for its photos and PDFs — references the
 *  app turns into the files each time the chat is sent (fileExpander). */
export function seenBlocks(files: readonly Pick<AttachedFile, "id" | "name" | "kind">[], ref: (id: number) => string): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  return files.filter((f) => isSeenKind(f.kind)).map((f): Anthropic.Beta.Messages.BetaContentBlockParam =>
    f.kind === "image"
      ? { type: "image", source: { type: "file", file_id: ref(f.id) } }
      : { type: "document", source: { type: "file", file_id: ref(f.id) }, title: f.name.slice(0, 200) },
  );
}

const fileIdOf = (b: Block): number | null => ((b.type === "image" || b.type === "document") && b.source?.type === "file" ? fileRefId(b.source.file_id) : null);

/** A chat's messages as the model is sent them: each photo or PDF it refers
 *  to by reference, the file itself (base64) — the newest of them, while they
 *  fit the limits (filesToSend); an older one past them, or one cleared
 *  since, a line saying so. The person's own files only. Each file is read
 *  once a question: the returned function remembers them. */
export function fileExpander(userId: number): <M extends Message>(messages: M[]) => Promise<M[]> {
  type Kept = { kind: "image" | "pdf"; type: string; name: string; size: number; tokens: number | null };
  const kept = new Map<number, Kept | null>(); // null: not kept any more
  const base64 = new Map<number, string>();

  return async (messages) => {
    // every place a file is in the chat, in the chat's order
    const places: { at: string; id: number }[] = [];
    messages.forEach((m, mi) => {
      if (Array.isArray(m.content)) {
        (m.content as Block[]).forEach((b, bi) => {
          const id = fileIdOf(b);
          if (id !== null) places.push({ at: `${mi}:${bi}`, id });
        });
      }
    });
    if (places.length === 0) return messages;

    const unknown = [...new Set(places.map((p) => p.id))].filter((id) => !kept.has(id));
    if (unknown.length > 0) {
      const rows = await prisma.aiFile.findMany({ where: { id: { in: unknown }, userId }, select: { id: true, kind: true, type: true, name: true, size: true, tokens: true } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of unknown) {
        const r = byId.get(id);
        kept.set(id, r && isSeenKind(r.kind) ? { kind: r.kind, type: r.type, name: r.name, size: r.size, tokens: r.tokens } : null);
      }
    }

    // the newest that fit go; the rest are named
    const live = places.filter((p) => kept.get(p.id));
    const fits = filesToSend(live.map((p) => kept.get(p.id)!));
    const going = live.filter((_, i) => fits[i]);
    const unread = [...new Set(going.map((p) => p.id))].filter((id) => !base64.has(id));
    if (unread.length > 0) {
      const rows = await prisma.aiFile.findMany({ where: { id: { in: unread }, userId }, select: { id: true, data: true } });
      for (const r of rows) base64.set(r.id, Buffer.from(r.data).toString("base64"));
      for (const id of unread) if (!base64.has(id)) kept.set(id, null); // cleared between the two reads
    }
    const goes = new Set(going.filter((p) => base64.has(p.id)).map((p) => p.at));
    const withFiles = new Set(places.map((p) => Number(p.at.split(":")[0])));

    return messages.map((m, mi) => {
      if (!withFiles.has(mi)) return m;
      const content = (m.content as Block[]).map((b, bi): Block => {
        const id = fileIdOf(b);
        if (id === null) return b;
        const f = kept.get(id);
        if (!f) return { type: "text", text: `[file #${id} is no longer kept — it was attached more than ${AI_FILE_LIMITS.keepDays} days ago]` };
        if (!goes.has(`${mi}:${bi}`)) {
          return { type: "text", text: `[file #${id} "${f.name}" — ${f.kind === "pdf" ? "a PDF" : "a photo"} sent earlier in this chat — is not shown with this question: the chat carries more files than one question can. If you need to look at it again, ask the person to attach it again.]` };
        }
        const data = base64.get(id)!;
        return f.kind === "image"
          ? { type: "image", source: { type: "base64", media_type: f.type as SeenImageType, data } }
          : { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: f.name.slice(0, 200) };
      });
      return { ...m, content };
    });
  };
}

/** A question's photos and PDFs as plain lines — what is kept of a question
 *  the model refused to read, so the chat is not refused again on the next
 *  question for a file it carries. */
export function withoutSeen<M extends Message>(m: M, names: ReadonlyMap<number, string>): M {
  if (!Array.isArray(m.content)) return m;
  return {
    ...m,
    content: (m.content as Block[]).map((b) => {
      const id = fileIdOf(b);
      return id === null ? b : { type: "text", text: `[file #${id} "${names.get(id) ?? "?"}" could not be read by the assistant — attach it again, or another copy]` };
    }),
  };
}
