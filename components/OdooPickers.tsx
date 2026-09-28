"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ODOO_BASES, ODOO_BASIS_LABEL, type OdooBasis, type OdooBomOption } from "@/lib/domain/odooStats";

// The dashboard's period and basis pickers. They live apart from the charts
// so the log view, which shows the pickers' neighbours but no chart, never
// downloads the charting library.

/** Count by the day a row was closed (its status went to Done) or logged. */
export function OdooBasisPicker({ basis }: { basis: OdooBasis }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (b: OdooBasis) => {
    const p = new URLSearchParams(params.toString());
    p.set("basis", b);
    router.push(`${pathname}?${p}`);
  };
  return (
    <div className="seg" role="tablist" aria-label="Count by" title="Which day a row counts on: the day its status went to Done, or the day it was logged">
      {ODOO_BASES.map((b) => (
        <button key={b} type="button" role="tab" aria-selected={basis === b} className={basis === b ? "on" : ""} onClick={() => go(b)}>
          {ODOO_BASIS_LABEL[b]}
        </button>
      ))}
    </div>
  );
}


/**
 * Narrow the whole dashboard to ONE BOM — every card, chart and table below
 * counts only its rows.
 *
 * A select rather than a row of buttons: a busy month touches a couple of
 * dozen BOMs, too many to lay out, and this is a "find the one I am chasing"
 * control. The options are the BOMs the PERIOD holds, so choosing one never
 * hides the others, and each carries its own row count — an empty period's
 * picker says so instead of pretending to be a filter.
 */
export function OdooBomPicker({ bom, boms }: { bom: string | null; boms: OdooBomOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v === "all") p.delete("bom"); else p.set("bom", v);
    router.push(`${pathname}?${p}`);
  };
  const total = boms.reduce((s, b) => s + b.rows, 0);
  return (
    <label className="inline-flex items-center gap-1.5 text-sm" title="Count only one BOM's rows — the BOM is read off each row's FG code">
      <span className="text-xs font-bold text-muted uppercase tracking-wide">BOM</span>
      <select
        value={bom === null ? "all" : bom === "" ? "none" : bom}
        onChange={(e) => go(e.target.value)}
        aria-label="BOM"
        className="border rounded-md px-2 py-1.5 bg-surface font-bold text-sm ltr max-w-[13rem]"
      >
        <option value="all">All BOMs{total > 0 ? ` (${total})` : ""}</option>
        {boms.map((b) => (
          <option key={b.bom || "none"} value={b.bom || "none"}>
            {b.bom || "No BOM in the code"} ({b.rows})
          </option>
        ))}
      </select>
    </label>
  );
}
