"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ODOO_BASES, ODOO_BASIS_LABEL, ODOO_COMPARES, ODOO_COMPARE_LABEL, type OdooBasis, type OdooBomOption, type OdooCompare } from "@/lib/domain/odooStats";
import { FilterSelect } from "@/components/FilterControls";

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
    <FilterSelect
      label="BOM"
      value={bom === null ? "all" : bom === "" ? "none" : bom}
      emptyValue="all"
      onChange={go}
      title="Count only one BOM's rows — the BOM of the closing, else the SOI's order, else the FG code's suffix (as the log shows it)"
      options={[
        { value: "all", label: `All${total > 0 ? ` (${total})` : ""}` },
        ...boms.map((b) => ({ value: b.bom || "none", label: `${b.bom || "No known BOM"} (${b.rows})` })),
      ]}
    />
  );
}

/** What the period's figures are compared with: the days just before it, or
 *  the same days a week, a month or a year earlier — or nothing. */
export function OdooComparePicker({ compare }: { compare: OdooCompare }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v === "prev") p.delete("compare"); else p.set("compare", v);
    router.push(`${pathname}?${p}`);
  };
  return (
    <FilterSelect
      label="Compare with"
      value={compare}
      emptyValue="prev"
      onChange={go}
      title="What the ▲▼ changes compare the period with"
      options={ODOO_COMPARES.map((c) => ({ value: c, label: ODOO_COMPARE_LABEL[c] }))}
    />
  );
}
