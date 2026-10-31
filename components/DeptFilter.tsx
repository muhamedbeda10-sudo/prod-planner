"use client";

import { FilterSelect } from "@/components/FilterControls";
import { DEPT_CENTRES, WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import { LV_FLOOR_DEPTS, LV_FLOOR_DEPT_LABEL } from "@/lib/domain/lvKpis";
import { LINE_LABEL } from "@/lib/domain/lines";
import { deptOptions, type ProductionScope } from "@/lib/domain/productionDashboard";

// The dashboard's department, in its one bar after the line switch: the
// department, and on the transformers' Fabrication a work centre. Both halves
// of the page read it — the floor's figures narrow to it, the plan to its
// centre (lib/domain/plantDashboard.ts). A department names its line, so
// picking one on All moves the switch to that line. All of it lives in the
// URL, so a link opens as sent.

export function DeptFilter({ scope, dept, lvDept, centre, onChange }: {
  scope: ProductionScope;
  dept: string;
  /** The panels' own department kept beside a transformers' one under All (an older or assistant's link) — shown so it can be cleared. */
  lvDept: string;
  centre: string;
  /** Writes the parameters (null clears one) and closes any rows open over the page. */
  onChange: (set: Record<string, string | null>) => void;
}) {
  const options = deptOptions(scope);
  const centres = scope === "TR" && (dept === "" || dept === "Fabrication") ? DEPT_CENTRES.Cut : null;
  return (
    <>
      <span className={`filter-chip ${dept ? "filter-chip-on" : ""}`}>
        <select aria-label="Department" className="ctl" value={dept}
          onChange={(e) => {
            const v = e.target.value;
            const o = options.find((x) => x.value === v);
            onChange({ dept: v || null, lvDept: null, centre: null, scope: o ? o.line.toLowerCase() : scope === "all" ? null : scope.toLowerCase() });
          }}>
          <option value="">Department: All</option>
          {scope === "all" ? (
            (["TR", "LV"] as const).map((l) => (
              <optgroup key={l} label={LINE_LABEL[l]}>
                {options.filter((o) => o.line === l).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            ))
          ) : options.map((o) => <option key={o.value} value={o.value}>Department: {o.label}</option>)}
        </select>
      </span>
      {scope === "all" && lvDept && (
        <FilterSelect label="LV department" value={lvDept} onChange={(v) => onChange({ lvDept: v || null })}
          options={LV_FLOOR_DEPTS.map((d) => ({ value: d, label: LV_FLOOR_DEPT_LABEL[d] }))} />
      )}
      {centres && (
        <span className={`filter-chip ${centre ? "filter-chip-on" : ""}`}>
          <select aria-label="Work centre" className="ctl" value={centre} onChange={(e) => onChange({ centre: e.target.value || null })}>
            <option value="">Centre: All</option>
            {centres.map((c) => <option key={c} value={c}>Centre: {WORK_CENTRE_LABEL[c]}</option>)}
          </select>
        </span>
      )}
    </>
  );
}
