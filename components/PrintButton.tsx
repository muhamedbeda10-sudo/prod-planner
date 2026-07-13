"use client";

/** Opens the browser print dialog — "Save as PDF" turns the page into the
 *  department's paper/PDF worklist. Print CSS hides nav, filters and inputs. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print bg-brand hover:bg-brand-dark text-white font-bold rounded-md px-3 py-1.5 text-xs transition-colors"
    >
      🖨️ Print / PDF
    </button>
  );
}
