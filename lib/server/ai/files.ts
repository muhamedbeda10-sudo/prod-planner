import "server-only";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import type { AiFile, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AI_FILE_LIMITS, aiFileKind, cleanFileName, fileSizeText, type AiFileKind, type AttachedFile } from "@/lib/domain/aiFiles";
import type { ToolCtx } from "./tools/types";

// The files people attach in the assistant's chat (lib/domain/aiFiles.ts has
// the rules). A file is a person's own and its chat's: the assistant's tools
// open it only for that person, in that chat. Kept in the database — there
// is no other storage to configure — for a fortnight, then cleared.

const DAY_MS = 86_400_000;

export type StoreResult = { ok: true; file: { id: number; name: string; kind: AiFileKind; size: number } } | { ok: false; error: string };

/** A workbook out of a kept file's bytes — null when it cannot be read. */
function workbookOf(data: Uint8Array): XLSX.WorkBook | null {
  try {
    return XLSX.read(data, { type: "array", cellDates: false, dense: true });
  } catch {
    return null;
  }
}

/** Keep a file the person attached, once it is checked: its kind by its
 *  bytes, its size, how many they attached this hour, and the room left. */
export async function storeAiFile(user: User, file: File, now = new Date()): Promise<StoreResult> {
  const name = cleanFileName(file.name);
  if (file.size === 0) return { ok: false, error: `"${name}" is empty.` };
  if (file.size > AI_FILE_LIMITS.maxBytes) return { ok: false, error: `"${name}" is ${fileSizeText(file.size)} — at most ${fileSizeText(AI_FILE_LIMITS.maxBytes)} a file.` };
  const data = new Uint8Array(await file.arrayBuffer());
  const kind = aiFileKind(name, data.subarray(0, 4096));
  if (!kind) return { ok: false, error: `"${name}" is not a file the assistant takes — an Excel workbook (.xlsx, .xls) or a CSV sheet.` };
  if (!workbookOf(data)) return { ok: false, error: `"${name}" could not be read as a sheet — is it damaged?` };

  // what is past its days goes first, so the room left is the real one
  await pruneAiFiles(now);
  const [lastHour, kept] = await Promise.all([
    prisma.aiFile.count({ where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
    prisma.aiFile.aggregate({ _sum: { size: true } }),
  ]);
  if (lastHour >= AI_FILE_LIMITS.perHour) return { ok: false, error: `That is ${AI_FILE_LIMITS.perHour} files in an hour — wait a while.` };
  if ((kept._sum.size ?? 0) + data.length > AI_FILE_LIMITS.plantBytes) {
    return { ok: false, error: `The assistant's file store is full — files are cleared ${AI_FILE_LIMITS.keepDays} days after they were attached. Try again later.` };
  }
  const row = await prisma.aiFile.create({
    data: { userId: user.id, name, kind: kind.kind, type: kind.type, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data },
    select: { id: true },
  });
  return { ok: true, file: { id: row.id, name, kind: kind.kind, size: data.length } };
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
 *  and sent in no other chat (a new chat: in none yet). Nothing is written. */
export async function questionFiles(userId: number, ids: readonly number[], conversationId: number | null, now = new Date()): Promise<{ ok: true; files: AttachedFile[] } | { ok: false; error: string }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, files: [] };
  if (unique.length > AI_FILE_LIMITS.perQuestion) return { ok: false, error: `At most ${AI_FILE_LIMITS.perQuestion} files with one question.` };
  const rows = await prisma.aiFile.findMany({ where: { id: { in: unique }, userId } });
  const since = now.getTime() - AI_FILE_LIMITS.keepDays * DAY_MS;
  if (rows.length !== unique.length || rows.some((f) => f.createdAt.getTime() < since)) return { ok: false, error: "A file is not there any more — attach it again." };
  if (rows.some((f) => f.conversationId !== null && f.conversationId !== conversationId)) return { ok: false, error: "A file was sent in another chat — attach it again here." };
  const byId = new Map(rows.map((f) => [f.id, f]));
  return {
    ok: true,
    files: unique.map((id) => {
      const f = byId.get(id)!;
      return { id: f.id, name: f.name, kind: f.kind as AiFileKind, size: f.size, sheets: sheetsOf(f.data) };
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
export function readSheet(f: Pick<AiFile, "data">, o: { sheet?: string; fromRow?: number; rows?: number }): SheetRows | { error: string } {
  const wb = workbookOf(f.data);
  if (!wb) return { error: "The file cannot be read as a sheet." };
  const sheet = o.sheet === undefined ? wb.SheetNames[0] : wb.SheetNames.find((n) => n.trim().toLowerCase() === o.sheet!.trim().toLowerCase());
  if (!sheet) return { error: `No sheet "${o.sheet}" — the workbook has: ${wb.SheetNames.join(", ")}.` };
  const ws = wb.Sheets[sheet];
  const grid = ws?.["!ref"] ? XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: true }) : [];
  const from = Math.max(1, o.fromRow ?? 1);
  const count = Math.min(Math.max(1, o.rows ?? 60), 200);
  const rows = grid.slice(from - 1, from - 1 + count).map((r) => {
    const cells = (r as unknown[]).map((c) => String(c ?? "").slice(0, CELL_MAX));
    // trailing empty cells say nothing
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    return cells;
  });
  return { sheets: wb.SheetNames, sheet, fromRow: from, totalRows: grid.length, rows };
}

/** Clear the files kept past their days. */
export async function pruneAiFiles(now = new Date()): Promise<number> {
  const r = await prisma.aiFile.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - AI_FILE_LIMITS.keepDays * DAY_MS) } } });
  return r.count;
}
