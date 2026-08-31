// Domain constants shared across the port of the VBA modules.

/** All tracked components. CF/TC/TN/CB sit on every transformer; AR (Arrester
 *  Bracket) and MB (Mono Box) are CONDITIONAL — present only on orders whose
 *  KVA / rating match the rules below (see itemApplies). Order matters for
 *  display column order. */
export const ITEMS = ["CF", "TC", "TN", "CB", "AR", "MB"] as const;
export type Item = (typeof ITEMS)[number];

/** The components that appear as physical columns in the monthly & weekly plan
 *  sheets and in the balance file — every transformer has exactly one of each.
 *  AR/MB are DERIVED per order from KVA/rating and are never read from a sheet
 *  column, so all spreadsheet-structural and plan-diff code (imports, balance
 *  parsing, reconciliation, "complete sets" metrics) stays on this four-item
 *  set. Grid column order F..AC, and MinOf4 semantics. Mirrors modShared.ItemsArr. */
export const SHEET_ITEMS = ["CF", "TC", "TN", "CB"] as const;
export type SheetItem = (typeof SHEET_ITEMS)[number];

export const DEPTS = ["Cut", "Welding", "Painting"] as const;
export type Dept = (typeof DEPTS)[number];

/** Extra ledger stage (not a production dept): pieces the CUSTOMER received.
 *  Recorded on the Plan Tracker's Dlvd cells, stored in the same daily-log
 *  ledger, capped at the finished quantity. Never enters worklists/queues. */
export const DELIVERED_STAGE = "Delivered" as const;

/** Extra ledger stage for PAINT-EXEMPT items only: the core (CF) is never
 *  painted — after welding it goes through SHOT BLAST (SHB), its real final
 *  stage. Recorded on the Plan Tracker's SHB cells (shown in place of the
 *  Paint cell), stored in the same ledger; chain: delivered ≤ SHB ≤ welded. */
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

/** Display name for the finishing stage on the dashboard / report / tracker:
 *  Painting handles the painted components AND the core's Shot Blast, so those
 *  screens label it together. (The nav tab and the Painting worklist keep the
 *  plain "Painting" from deptLabel — shot blast is recorded on the tracker.) */
export const FINISHING_LABEL = "Painting & Shot Blast";

/** ONE canonical colour per stage — identical on EVERY chart and page so a
 *  department always reads as the same colour. Fabrication green · Welding
 *  blue · Painting (and the core's Shot Blast) orange · Delivered purple.
 *  These are the solid versions of the Plan Tracker's cell tints. */
export const STAGE_COLOR: Record<string, string> = {
  Cut: "#1a8150", // Fabrication — green (brand)
  Welding: "#2b6cb0", // Welding — blue
  Painting: "#d97706", // Painting — orange
  ShotBlast: "#d97706", // Shot Blast — the same orange (it IS the core's finishing)
  Delivered: "#7c3aed", // Delivered — purple
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

/** Painted components present on EVERY transformer (base sheet items minus the
 *  paint-exempt core) — used for "complete sets"/min-based metrics and the
 *  painting capacity baseline, where the conditional AR/MB must NOT drag the min. */
export const PAINTED_SHEET_ITEMS: readonly SheetItem[] = SHEET_ITEMS.filter((i) => !isPaintExempt(i)) as SheetItem[];

// ---- AR / MB: conditional components derived from the order's KVA / rating ----

/** AR (Arrester Bracket) applies to transformers rated 100–300 KVA (inclusive).
 *  Reads the first number out of the (free-text) KVA field. */
export function qualifiesAR(kva: string | null | undefined): boolean {
  const m = String(kva ?? "").match(/[0-9]+(?:\.[0-9]+)?/);
  if (!m) return false;
  const n = parseFloat(m[0]);
  return n >= 100 && n <= 300;
}

/** MB (Mono Box) applies when the KV/rating string lists two or more voltages on
 *  its secondary side — i.e. after the first "/". "13.8/0.4|0.23" → MB (two: 0.4
 *  and 0.23); "13.8/0.4" → none (one). */
export function qualifiesMB(rating: string | null | undefined): boolean {
  const s = String(rating ?? "");
  const slash = s.indexOf("/");
  if (slash < 0) return false;
  const nums = s.slice(slash + 1).match(/[0-9]+(?:\.[0-9]+)?/g);
  return !!nums && nums.length >= 2;
}

/** The order fields the AR/MB rules read. */
export interface ItemRuleFields {
  kva?: string | null;
  rating?: string | null;
}

/** Whether a component is ELIGIBLE for an order by rule, before any manual N/A.
 *  The four base components always apply; AR/MB apply only when their rule matches. */
export function itemApplies(item: Item, o: ItemRuleFields): boolean {
  if (item === "AR") return qualifiesAR(o.kva);
  if (item === "MB") return qualifiesMB(o.rating);
  return true;
}

/** Components eligible for an order by rule (ignoring manual N/A) — drives the
 *  tracker's per-order columns and the N/A editor's toggle list. */
export function eligibleItems(o: ItemRuleFields): Item[] {
  return ITEMS.filter((it) => itemApplies(it, o));
}

/** Parse the excludedItems CSV (manual N/A list) into an upper-cased Set. */
export function parseExcludedItems(csv: string | null | undefined): Set<string> {
  return new Set((csv ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

/** The components an order actually needs: rule-eligible minus manual N/A. The
 *  single source of truth for "which items does this order have". */
export function applicableItems(o: ItemRuleFields & { excludedItems?: string | null }): Item[] {
  const excluded = parseExcludedItems(o.excludedItems);
  return ITEMS.filter((it) => itemApplies(it, o) && !excluded.has(it));
}

/** Outsourced (OSP) quantity for a component. Only the four base components have
 *  OSP columns on MasterOrder; AR/MB are always made in-house → 0. */
export function ospOf(
  o: { ospCF?: number | null; ospTC?: number | null; ospTN?: number | null; ospCB?: number | null },
  item: Item,
): number {
  switch (item) {
    case "CF": return o.ospCF ?? 0;
    case "TC": return o.ospTC ?? 0;
    case "TN": return o.ospTN ?? 0;
    case "CB": return o.ospCB ?? 0;
    default: return 0; // AR, MB — no OSP
  }
}

/** Per-item daily capacity target. The four base components run at the shared
 *  capacity (Settings capacity, default 27); the conditional AR/MB lines each
 *  carry their own lower target of 20/day. */
export const AR_MB_DAILY_TARGET = 20;
export function itemDailyTarget(item: Item, baseTarget: number): number {
  return item === "AR" || item === "MB" ? AR_MB_DAILY_TARGET : baseTarget;
}
/** Sum of the daily targets over a set of items — a dept-day capacity line. */
export function sumItemTargets(items: readonly Item[], baseTarget: number): number {
  return items.reduce((s, it) => s + itemDailyTarget(it, baseTarget), 0);
}

export function isDept(x: string): x is Dept {
  return (DEPTS as readonly string[]).includes(x);
}

/** Defaults matching Lists!J2:J5. */
export const DEFAULTS = {
  leadCut: 4, // fabrication gets the plan 4 days ahead of delivery
  leadWeld: 1,
  capacityPerItem: 27,
  dailyTarget: 27,
  /** Per-piece tank tracking starts OFF — see Settings.tankTracking. */
  tankTracking: false,
} as const;
