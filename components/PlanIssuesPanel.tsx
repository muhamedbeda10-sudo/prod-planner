"use client";

import { useMemo, useState } from "react";
import type { PlanLineIssue, PlanLineState } from "@/lib/domain/execution";

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Reason groups, in the order a planner would want to read them: the harmless
 *  "not yet" first, the ones that need a decision last. */
const GROUPS: { state: PlanLineState; label: string; tone: string }[] = [
  { state: "future", label: "Not due yet — shows on its own day", tone: "pill-ok" },
  { state: "done", label: "Already fabricated in full", tone: "pill-muted" },
  { state: "covered", label: "Covered by output already recorded", tone: "pill-muted" },
  { state: "na", label: "Component not required for the order", tone: "pill-muted" },
  { state: "closed", label: "Order closed on the tracker", tone: "pill-warn" },
  { state: "unknown-order", label: "MO not in the orders registry", tone: "pill-bad" },
  { state: "hidden", label: "Removed from this worklist", tone: "pill-warn" },
];

/** "This is in the weekly plan — why isn't it on the list?" answered per line.
 *  Collapsed by default: it is a reconciliation tool, not daily reading. */
export function PlanIssuesPanel({ rows, planNo }: { rows: PlanLineIssue[]; planNo: number | null }) {
  const [only, setOnly] = useState<PlanLineState | "">("");

  const counts = useMemo(() => {
    const m = new Map<PlanLineState, number>();
    for (const r of rows) m.set(r.state, (m.get(r.state) ?? 0) + 1);
    return m;
  }, [rows]);

  if (rows.length === 0) return null;
  const shown = only ? rows.filter((r) => r.state === only) : rows;
  const needsAction = rows.filter((r) => r.state === "closed" || r.state === "unknown-order").length;

  return (
    <details className="mt-8 no-print">
      <summary className="text-xs text-muted cursor-pointer select-none">
        🔎 In the weekly plan{planNo !== null ? ` (plan ${planNo})` : ""} but not on this list ({rows.length}) — click for the reason of each
        {needsAction > 0 && <span className="pill pill-bad ml-2 normal-case">{needsAction} need a decision</span>}
      </summary>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {GROUPS.filter((g) => counts.get(g.state)).map((g) => (
          <button
            key={g.state}
            type="button"
            onClick={() => setOnly(only === g.state ? "" : g.state)}
            className={`pill ${g.tone} ${only === g.state ? "ring-2 ring-brand" : ""}`}
            title={`Show only: ${g.label}`}
          >
            {g.label} · {counts.get(g.state)}
          </button>
        ))}
      </div>

      <div className="bg-surface border rounded-xl overflow-x-auto mt-2">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-accent-gray/90 text-white text-left">
              <th className="p-2">Deliver on</th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">Planned</th>
              <th className="p-2">Why it is not here</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.bom}|${r.mo}|${r.item}`}>
                <td className="p-2 whitespace-nowrap">
                  <span className="pill pill-muted">📅 {ddmm(r.deliveryISO)}</span>
                </td>
                <td className="p-2 text-xs font-semibold whitespace-nowrap">{r.mo}</td>
                <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                <td className="p-2 text-center font-bold">{r.item}</td>
                <td className="p-2 text-center tabnum font-bold">{r.qty}</td>
                <td className="p-2 text-xs">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted mt-1">
        Every line the current weekly plan schedules is checked against what the page shows. Fabrication only lists work whose
        cut-due day (delivery − lead) has arrived, for open orders the registry knows, minus what the daily logs already cover.
      </p>
    </details>
  );
}
