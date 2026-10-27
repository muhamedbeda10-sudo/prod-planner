import "server-only";
import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import type { SheetStyleInput } from "@/lib/domain/sheetStyle";
import { fillWorkbook, type WorkbookResult, type WorkbookSheet } from "@/lib/excel/workbook";

// A workbook written on the server — the assistant's files. The same sheets
// as the browser's (lib/excel/workbook.ts), streamed: each row is written out
// once styled instead of the whole workbook held in memory — a quarter of the
// memory and a third of the time on the largest file the assistant keeps.

/** The workbook's bytes (fillWorkbook), streamed. */
export async function streamedWorkbookBytes(sheets: readonly WorkbookSheet[], style?: SheetStyleInput): Promise<WorkbookResult> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  // a failed write rejects both: the commit's is the one awaited
  done.catch(() => {});
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
  const filled = fillWorkbook(wb, sheets, style);
  if ("error" in filled) return { ok: false, error: filled.error };
  await wb.commit();
  await done;
  const all = Buffer.concat(chunks);
  return { ok: true, data: new Uint8Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer), names: filled.names };
}
