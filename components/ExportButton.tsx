"use client";

import * as XLSX from "xlsx";

export function ExportButton({
  rows,
  filename,
  sheetName = "Sheet1",
  label = "📊 Export Excel",
}: {
  rows: Record<string, unknown>[];
  filename: string;
  sheetName?: string;
  label?: string;
}) {
  function exportXlsx() {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, filename);
  }
  return (
    <button onClick={exportXlsx} disabled={rows.length === 0} className="no-print bg-ok-fg text-white font-bold rounded-md px-4 py-1.5 text-sm disabled:opacity-40">
      {label}
    </button>
  );
}
