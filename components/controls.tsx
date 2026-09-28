"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { FINISHING_LABEL } from "@/lib/domain/constants";

/** Remembers the dashboard's From→To range across sessions (localStorage, so
 *  it survives closing the browser). Opening the dashboard bare restores the
 *  last range; "Back to weekly ✕" (or any switch out of range mode) forgets
 *  it. Renders nothing. */
export function DashboardPeriodMemory() {
  const router = useRouter();
  const sp = useSearchParams();
  const didInit = useRef(false);
  useEffect(() => {
    const from = sp.get("from");
    const to = sp.get("to");
    const cur = from && to ? `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "";
    try {
      if (!didInit.current) {
        // entry: a bare dashboard gets the remembered range; an explicit URL
        // (?w=… or ?from=…) is respected as-is
        didInit.current = true;
        if (cur) {
          localStorage.setItem("dash.period", cur);
        } else if (!sp.get("w")) {
          const saved = localStorage.getItem("dash.period");
          if (saved) router.replace(`/?${saved}`);
        }
        return;
      }
      // in-app change: keep the latest range, forget it when leaving range mode
      if (cur) localStorage.setItem("dash.period", cur);
      else localStorage.removeItem("dash.period");
    } catch {}
  }, [sp, router]);
  return null;
}

function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(params.toString());
      if (value) p.set(key, value);
      else p.delete(key);
      router.push(`${pathname}?${p.toString()}`);
    },
    [router, pathname, params]
  );
}

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
              className={`rounded-md border px-2.5 py-1.5 text-xs font-bold transition-colors ${on ? "bg-brand text-white border-brand" : "bg-surface text-muted hover:text-foreground hover:border-brand/60"}`}
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

