"use client";

import { Printer } from "lucide-react";

/** Opens the browser print dialog — "Save as PDF" turns the page into the
 *  department's paper/PDF worklist. Print CSS hides nav, filters and inputs. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="no-print btn btn-primary btn-sm">
      <Printer size={14} />
      Print / PDF
    </button>
  );
}
