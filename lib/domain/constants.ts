// Domain constants shared across the port of the VBA modules.

/** The four components; every transformer needs exactly one of each. Order matters
 *  (grid column order F..AC, and MinOf4 semantics). Mirrors modShared.ItemsArr. */
export const ITEMS = ["CF", "TC", "TN", "CB"] as const;
export type Item = (typeof ITEMS)[number];

export const DEPTS = ["Cut", "Welding", "Painting"] as const;
export type Dept = (typeof DEPTS)[number];

/** Extra ledger stage (not a production dept): pieces the CUSTOMER received.
 *  Recorded on the Plan Tracker's Dlvd cells, stored in the same daily-log
 *  ledger, capped at the finished quantity. Never enters worklists/queues. */
export const DELIVERED_STAGE = "Delivered" as const;

/** Extra ledger stage for PAINT-EXEMPT items only: the core (CF) is never
 *  painted — after welding it goes through SHOT BLAST (SHP), its real final
 *  stage. Recorded on the Plan Tracker's SHP cells (shown in place of the
 *  Paint cell), stored in the same ledger; chain: delivered ≤ SHP ≤ welded. */
export const SHOTBLAST_STAGE = "ShotBlast" as const;

/** DISPLAY names only — the stored dept value stays "Cut" so every existing
 *  handover row, permission key and plan keeps working untouched. */
export const DEPT_LABELS: Record<Dept, string> = {
  Cut: "Fabrication",
  Welding: "Welding",
  Painting: "Painting",
};
export function deptLabel(dept: string): string {
  if (dept === "ShotBlast") return "Shot Blast";
  return DEPT_LABELS[dept as Dept] ?? dept;
}
/** Compact form for tight table headers (stage columns). */
export const DEPT_SHORT: Record<Dept, string> = {
  Cut: "Fab",
  Welding: "Weld",
  Painting: "Paint",
};

export function isItem(x: string): x is Item {
  return (ITEMS as readonly string[]).includes(x);
}

/** Components that SKIP the Painting stage — the core (CF) is welded, then it's
 *  finished. For a paint-exempt component the FINAL stage is Welding, so:
 *   • completion counts its WELDED qty (not painted),
 *   • it never enters the Painting worklist,
 *   • Painting targets / sets / balance ignore it.
 *  Everything upstream (Cut, Welding) is unaffected. */
export const PAINT_EXEMPT = ["CF"] as const;
export function isPaintExempt(x: string): boolean {
  return (PAINT_EXEMPT as readonly string[]).includes(x);
}
/** The components that DO go through Painting (all items minus the exempt ones). */
export const PAINTED_ITEMS: readonly Item[] = ITEMS.filter((i) => !isPaintExempt(i));

export function isDept(x: string): x is Dept {
  return (DEPTS as readonly string[]).includes(x);
}

/** Defaults matching Lists!J2:J5. */
export const DEFAULTS = {
  leadCut: 4, // fabrication gets the plan 4 days ahead of delivery
  leadWeld: 1,
  capacityPerItem: 27,
  dailyTarget: 27,
} as const;
