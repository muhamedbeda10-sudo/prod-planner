"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useSetParams, withParams } from "@/components/useSetParam";
import { DEPT_CENTRES, WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import { LINE_LABEL } from "@/lib/domain/lines";
import { PRODUCTION_SCOPES, SCOPE_LABEL, deptOptions, type ProductionScope } from "@/lib/domain/productionDashboard";

// The Production dashboard's own filters, at the start of the page's one bar
// (the date slicer's row): the line first — All | TR | LV — then the
// department, and on the transformers' Fabrication a work centre. All of it
// lives in the URL, so a link opens as sent; a department names its line,
// so picking one on All moves the switch to that line.

export function ProductionFilters({ scope, dept, centre }: { scope: ProductionScope; dept: string; centre: string }) {
  const params = useSearchParams();
  const path = usePathname();
  const setParams = useSetParams();
  // a new filter closes any rows open over the page
  const go = (set: Record<string, string | null>) => setParams({ ...set, focus: null, day: null });
  const options = deptOptions(scope);
  const centres = scope === "TR" && (dept === "" || dept === "Fabrication") ? DEPT_CENTRES.Cut : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav className="seg" aria-label="Product line">
        {PRODUCTION_SCOPES.map((s) => (
          <Link key={s} scroll={false} href={`${path}${withParams(params, { scope: s === "all" ? null : s, dept: null, lvDept: null, centre: null, focus: null, day: null })}`}
            aria-current={s === scope ? "page" : undefined} className={s === scope ? "on" : ""} title={s === "all" ? "Both lines" : LINE_LABEL[s]}>
            {SCOPE_LABEL[s]}
          </Link>
        ))}
      </nav>
      <select aria-label="Department" className="ctl" value={dept}
        onChange={(e) => {
          const v = e.target.value;
          const o = options.find((x) => x.value === v);
          go({ dept: v || null, lvDept: null, centre: null, scope: o ? o.line : scope === "all" ? null : scope });
        }}>
        <option value="">Department: All</option>
        {scope === "all" ? (
          (["TR", "LV"] as const).map((l) => (
            <optgroup key={l} label={LINE_LABEL[l]}>
              {options.filter((o) => o.line === l).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))
        ) : options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {centres && (
        <select aria-label="Work centre" className="ctl" value={centre} onChange={(e) => go({ centre: e.target.value || null })}>
          <option value="">Centre: All</option>
          {centres.map((c) => <option key={c} value={c}>{WORK_CENTRE_LABEL[c]}</option>)}
        </select>
      )}
    </div>
  );
}
