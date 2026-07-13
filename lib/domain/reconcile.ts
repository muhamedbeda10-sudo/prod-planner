// Plan-vs-plan reconciliation (NEW feature — no VBA original).
//
// Compares plan N against plan N-1 per (bom, item). Because welding output is
// only knowable per BOM+item (not per MO), we reconcile at BOM+item granularity
// and annotate which MOs are new/dropped/continued. Categories:
//   CONTINUED             — bom in both plans; flag when newTarget deviates from
//                           (oldTarget - welded during N-1).
//   DROPPED_WITH_BACKLOG  — bom/MO gone from N but oldTarget - welded > 0.
//   DROPPED               — gone from N with no backlog.
//   NEW                   — bom/MO only in N.
// A BALANCE CONFLICT flag is added when the remark-declared planner balance for
// (bom,item) in plan N disagrees with the actual remaining from the handover log
// (required - welded all-time).

import { ITEMS, type Item } from "./constants";
import { groupKey } from "./bom";

export interface ReconOrder {
  bom: string;
  mo: string;
  item: string;
  requiredQty: number;
  targetQty: number;
  plannerBalance?: number | null;
}

export type ReconCategory = "CONTINUED" | "DROPPED_WITH_BACKLOG" | "MOVED" | "DROPPED" | "NEW";
export type Severity = "high" | "warn" | "info";

export interface ReconRow {
  bom: string;
  item: Item;
  category: ReconCategory;
  oldTarget: number;
  newTarget: number;
  weldedPrev: number; // welded under plan N-1
  expected: number; // max(0, oldTarget - weldedPrev)
  delta: number; // newTarget - expected  (CONTINUED)
  backlog: number; // max(0, oldTarget - weldedPrev)  (DROPPED)
  plannerBalance: number | null;
  actualRemaining: number | null; // required - weldedAll
  balanceConflict: boolean;
  newMOs: string[];
  droppedMOs: string[];
  severity: Severity;
  message: string;
}

function aggregate(orders: ReconOrder[]) {
  const target = new Map<string, number>(); // bom|item -> sum target
  const required = new Map<string, number>(); // bom|item -> required (deduped per mo)
  const balance = new Map<string, number | null>(); // bom|item -> plannerBalance
  const mos = new Map<string, Set<string>>(); // bom -> mo set
  const reqSeen = new Set<string>();
  for (const o of orders) {
    const bom = (o.bom ?? "").trim();
    if (!bom) continue;
    const ki = `${bom}|${o.item}`;
    target.set(ki, (target.get(ki) ?? 0) + (o.targetQty || 0));
    const rk = `${bom}|${o.mo}|${o.item}`;
    if (!reqSeen.has(rk)) {
      reqSeen.add(rk);
      required.set(ki, (required.get(ki) ?? 0) + (o.requiredQty || 0));
    }
    if (o.plannerBalance != null) balance.set(ki, o.plannerBalance);
    if (!mos.has(bom)) mos.set(bom, new Set());
    mos.get(bom)!.add(o.mo);
  }
  return { target, required, balance, mos };
}

export function computeReconciliation(
  current: ReconOrder[],
  previous: ReconOrder[],
  weldedPrev: Map<string, number>, // bom|item -> welded during plan N-1
  weldedAll: Map<string, number> // bom|item -> welded all-time
): ReconRow[] {
  const cur = aggregate(current);
  const prev = aggregate(previous);
  const boms = new Set<string>([...cur.mos.keys(), ...prev.mos.keys()]);
  const rows: ReconRow[] = [];

  // BOM families (same base + M number) per plan, for detecting code shifts
  const curFamily = new Map<string, string[]>();
  for (const b of cur.mos.keys()) {
    const k = groupKey(b.toUpperCase());
    if (!curFamily.has(k)) curFamily.set(k, []);
    curFamily.get(k)!.push(b);
  }
  const prevFamily = new Map<string, string[]>();
  for (const b of prev.mos.keys()) {
    const k = groupKey(b.toUpperCase());
    if (!prevFamily.has(k)) prevFamily.set(k, []);
    prevFamily.get(k)!.push(b);
  }

  for (const bom of boms) {
    const inCur = cur.mos.has(bom);
    const inPrev = prev.mos.has(bom);
    const curMOs = cur.mos.get(bom) ?? new Set();
    const prevMOs = prev.mos.get(bom) ?? new Set();
    const newMOs = [...curMOs].filter((m) => !prevMOs.has(m));
    const droppedMOs = [...prevMOs].filter((m) => !curMOs.has(m));

    for (const item of ITEMS) {
      const ki = `${bom}|${item}`;
      const oldTarget = prev.target.get(ki) ?? 0;
      const newTarget = cur.target.get(ki) ?? 0;
      const wPrev = weldedPrev.get(ki) ?? 0;
      const expected = Math.max(0, oldTarget - wPrev);

      // Balance conflict — the planner's remark balance declares what carries in
      // from LAST week, so the correct baseline is `expected` (last week's target
      // minus what was actually welded under it). Comparing against the full
      // required-minus-all-time-welded flags every order whose history predates
      // the log. Only meaningful when the bom continued from the previous plan.
      const pb = inCur ? (cur.balance.get(ki) ?? null) : null;
      const actualRemaining = inCur && inPrev ? expected : null;
      const balanceConflict = pb != null && actualRemaining != null && pb !== actualRemaining;

      let category: ReconCategory;
      let severity: Severity = "info";
      let message = "";
      let delta = 0;
      let backlog = 0;

      if (inCur && !inPrev) {
        if (newTarget === 0 && !balanceConflict) continue;
        category = "NEW";
        const prevSiblings = prevFamily.get(groupKey(bom.toUpperCase()))?.filter((b) => b !== bom) ?? [];
        message =
          prevSiblings.length > 0
            ? `New code — its family was in the previous plan as ${prevSiblings.join(", ")}.`
            : "New order not present in the previous plan.";
      } else if (!inCur && inPrev) {
        backlog = expected;
        const curSiblings = curFamily.get(groupKey(bom.toUpperCase())) ?? [];
        if (backlog > 0 && curSiblings.length > 0) {
          category = "MOVED";
          severity = "warn";
          message = `Backlog ${backlog} likely moved within the family to ${curSiblings.join(", ")} — verify quantities.`;
        } else if (backlog > 0) {
          category = "DROPPED_WITH_BACKLOG";
          severity = "high";
          message = `Dropped from the new plan with ${backlog} remaining.`;
        } else {
          category = "DROPPED";
          message = "Dropped from the new plan (no backlog).";
        }
      } else {
        category = "CONTINUED";
        delta = newTarget - expected;
        if (delta !== 0) {
          severity = Math.abs(delta) >= 3 ? "high" : "warn";
          message = `New target ${newTarget} differs from expected ${expected} (=${oldTarget}-${wPrev}) by ${delta > 0 ? "+" : ""}${delta}.`;
        }
      }

      if (balanceConflict) {
        severity = severity === "info" ? "warn" : severity;
        message = (message ? message + " " : "") + `Balance conflict: remark ${pb} ≠ actual remaining ${actualRemaining}.`;
      }

      // skip perfectly-continued, no-conflict rows (nothing to review)
      if (category === "CONTINUED" && delta === 0 && !balanceConflict) continue;

      rows.push({
        bom, item, category, oldTarget, newTarget, weldedPrev: wPrev, expected,
        delta, backlog, plannerBalance: pb, actualRemaining, balanceConflict,
        newMOs: category === "NEW" ? newMOs : [],
        droppedMOs: category === "MOVED" || category.startsWith("DROPPED") ? droppedMOs : [],
        severity, message,
      });
    }
  }

  const rank = { high: 0, warn: 1, info: 2 };
  return rows.sort((a, b) => rank[a.severity] - rank[b.severity] || a.bom.localeCompare(b.bom) || ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item));
}
