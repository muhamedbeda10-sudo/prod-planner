// The LV panels' standard hours — which row of the timings sheet an order
// is, and what a day's output is worth per department. Pure, tested.
//
// The sheet names a panel by the FG code SEC uses (FG-SUSA-8569105); the
// plan often carries our own (FG-SUA-AS-AA-000004) — but its SEC item,
// 908569105, is the same panel: "90" and the sheet code's digits. So an
// order is found by its FG code first, then through its SEC item.

import type { RosterDept } from "./shifts";

export interface LvRate {
  fg: string;
  description: string | null;
  kind: string;
  cutH: number;
  bendH: number;
  weldH: number;
  shbH: number;
  paintH: number;
  totalH: number | null;
}

export type LvStage = "cutH" | "bendH" | "weldH" | "paintH";

/** Which stage of the sheet each LV roster department works. Shot blast is
 *  on the sheet but no LV section records it, so nobody earns it yet. */
export const LV_DEPT_STAGE: Partial<Record<RosterDept, LvStage>> = {
  Punching: "cutH",
  Bending: "bendH",
  WeldingLV: "weldH",
  PaintingLV: "paintH",
};

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The sheet code a SEC item stands for: 908569105 → the row ending 8569105. */
export function secItemDigits(secItem: string | null | undefined): string | null {
  const d = String(secItem ?? "").replace(/\D/g, "");
  if (d.length < 7) return null;
  return d.startsWith("90") ? d.slice(2) : d;
}

export interface LvRateIndex {
  byFg: Map<string, LvRate>;
  byDigits: Map<string, LvRate>;
}

export function indexLvRates(rates: readonly LvRate[]): LvRateIndex {
  const byFg = new Map<string, LvRate>();
  const byDigits = new Map<string, LvRate>();
  for (const r of rates) {
    byFg.set(norm(r.fg), r);
    // the digits after the last dash: FG-SUSA-8569105 → 8569105
    const tail = r.fg.split("-").pop()?.replace(/\D/g, "") ?? "";
    if (tail.length >= 7 && !byDigits.has(tail)) byDigits.set(tail, r);
  }
  return { byFg, byDigits };
}

/** The sheet row for an order: by its FG code, else through its SEC item. */
export function lvRateFor(idx: LvRateIndex, o: { fgCode: string | null; secItem: string | null }): { rate: LvRate; via: "fg" | "sec" } | null {
  const byFg = o.fgCode ? idx.byFg.get(norm(o.fgCode)) : undefined;
  if (byFg) return { rate: byFg, via: "fg" };
  const d = secItemDigits(o.secItem);
  const bySec = d ? idx.byDigits.get(d) : undefined;
  return bySec ? { rate: bySec, via: "sec" } : null;
}
