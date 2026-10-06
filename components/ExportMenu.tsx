"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileSpreadsheet, Printer } from "lucide-react";
import { ExportButton, downloadXlsx } from "@/components/ExportButton";
import { PrintButton } from "@/components/PrintButton";

export interface ExcelExport {
  /** What the file is ("Excel", "Monthly Excel") — the menu's line. */
  label?: string;
  rows: Record<string, unknown>[];
  filename: string;
  sheetName?: string;
}

/**
 * A page's exports as ONE control in its head. One export alone stays a
 * plain button; two or more (an Excel and the print, two Excel files) fold
 * into an "Export" menu so the head keeps a single action.
 */
export function ExportMenu({ excel = [], print = false }: { excel?: ExcelExport[]; print?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const count = excel.length + (print ? 1 : 0);
  if (count === 0) return null;
  if (count === 1) {
    if (print) return <PrintButton />;
    const x = excel[0];
    return <ExportButton rows={x.rows} filename={x.filename} sheetName={x.sheetName} label={x.label ? `Export ${x.label}` : "Export Excel"} />;
  }

  async function run(x: ExcelExport) {
    setBusy(x.filename);
    try {
      await downloadXlsx(x.rows, x.filename, x.sheetName);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div className="relative no-print" ref={ref}>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Download size={14} aria-hidden />
        Export
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="nav-drop absolute right-0 top-[calc(100%+6px)] z-40 min-w-52 bg-surface border rounded-[var(--r-md)] p-1">
          {excel.map((x) => (
            <button
              key={x.filename} type="button" role="menuitem" disabled={x.rows.length === 0 || busy !== null}
              onClick={() => run(x)}
              className="w-full flex items-center gap-2 rounded-[var(--r-sm)] px-2.5 py-2 text-sm font-semibold text-start hover:bg-surface-2 disabled:opacity-50"
            >
              <FileSpreadsheet size={14} className="text-ok-fg shrink-0" aria-hidden />
              {busy === x.filename ? "Preparing…" : `${x.label ?? "Excel"} (.${x.filename.split(".").pop()})`}
            </button>
          ))}
          {print && (
            <button
              type="button" role="menuitem" onClick={() => { setOpen(false); window.print(); }}
              className="w-full flex items-center gap-2 rounded-[var(--r-sm)] px-2.5 py-2 text-sm font-semibold text-start hover:bg-surface-2"
            >
              <Printer size={14} className="text-muted shrink-0" aria-hidden />
              Print / PDF
            </button>
          )}
        </div>
      )}
    </div>
  );
}
