"use client";

import { useSetParam } from "@/components/useSetParam";
import { DASH_SCOPES, DASH_SCOPE_LABEL, DASH_SCOPE_TITLE, type DashScope } from "@/lib/domain/dashboardScope";
import type { ProductLine } from "@/lib/domain/lines";

// All | TR | LV — the line a dashboard shows. It is the dashboards' own
// choice (?line=), apart from the nav's toggle: picking "All" here never
// moves the recording screens, which work one line at a time. Picking the
// toggle's own line clears the parameter, so the page follows the toggle
// again.

export function LineScopeTabs({ scope, active }: { scope: DashScope; active: ProductLine }) {
  const setParam = useSetParam();
  return (
    <nav className="seg no-print" role="tablist" aria-label="Line shown">
      {DASH_SCOPES.map((s) => (
        <button key={s} type="button" role="tab" aria-selected={s === scope} title={DASH_SCOPE_TITLE[s]} className={s === scope ? "on" : ""} onClick={() => setParam("line", s === active ? "" : s)}>
          {DASH_SCOPE_LABEL[s]}
        </button>
      ))}
    </nav>
  );
}
