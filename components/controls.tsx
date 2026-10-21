"use client";

import { FINISHING_LABEL } from "@/lib/domain/constants";
import { useSetParam } from "@/components/useSetParam";

/** Report department filter: MULTI-select toggle pills — scope every report
 *  section to any combination of stages (Painting includes the core's Shot
 *  Blast). No selection = all stages. The picked set is stored as a CSV in
 *  ?dept= (pipeline order, whatever the click order). */
const DEPT_OPTS = [
  { value: "Cut", label: "Fabrication" },
  { value: "Welding", label: "Welding" },
  { value: "Painting", label: FINISHING_LABEL },
  { value: "Delivered", label: "Delivered" },
] as const;

export function DeptPicker({ value }: { value: string }) {
  const set = useSetParam();
  const selected = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    set("dept", DEPT_OPTS.map((o) => o.value).filter((x) => next.has(x)).join(","));
  };
  return (
    <div className="inline-flex items-center gap-2 text-sm font-semibold">
      <span>Dept:</span>
      <div className="flex flex-wrap gap-1">
        {DEPT_OPTS.map((o) => {
          const on = selected.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className={`rounded-md border px-2.5 py-1.5 text-xs font-bold transition-colors ${on ? "bg-brand-fill text-white border-brand-fill" : "bg-surface text-muted hover:text-foreground hover:border-brand/60"}`}
              title={`${o.label} — pick one or more; the whole report scopes to them`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

