"use client";

import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";

/** Writes the rows to an .xlsx and hands it to the browser. SheetJS is
 *  loaded on this first call (see below). */
export async function downloadXlsx(rows: Record<string, unknown>[], filename: string, sheetName = "Sheet1") {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

// SheetJS is a quarter of a megabyte — far more than any page it sits on.
// It is fetched the first time someone actually presses Export, never on
// page load, so a dozen tabs open faster for a button most visits never use.
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
