"use client";

import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";

/** Writes the rows to an .xlsx in the house style (lib/excel/workbook.ts) —
 *  or, for a .csv, plain — and hands it to the browser. The writer is loaded
 *  on this first call (see below). */
export async function downloadXlsx(rows: Record<string, unknown>[], filename: string, sheetName = "Sheet1") {
  if (/\.csv$/i.test(filename)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
    XLSX.writeFile(wb, filename);
    return;
  }
  const { workbookBytes, XLSX_TYPE } = await import("@/lib/excel/workbook");
  const made = await workbookBytes([{ name: sheetName, rows }]);
  if (!made.ok) throw new Error(made.error);
  const url = URL.createObjectURL(new Blob([made.data], { type: XLSX_TYPE }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // the download has its bytes once the click is handled
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The writer is a megabyte — far more than any page it sits on. It is
// fetched the first time someone actually presses Export, never on page
// load, so a dozen tabs open faster for a button most visits never use.
export function ExportButton({
  rows,
  filename,
  sheetName = "Sheet1",
  label = "Export Excel",
}: {
  rows: Record<string, unknown>[];
  filename: string;
  sheetName?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function exportXlsx() {
    setBusy(true);
    try {
      await downloadXlsx(rows, filename, sheetName);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button onClick={exportXlsx} disabled={rows.length === 0 || busy} className="no-print btn btn-secondary btn-sm">
      <FileSpreadsheet size={14} className="text-ok-fg" />
      {busy ? "Preparing…" : label.replace(/^📊\s*/, "")}
    </button>
  );
}
