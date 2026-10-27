import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { TRANSFORMERS } from "../planning/fixtures";

// The assistant evaluation's synthetic plant: the planning cases' transformer
// orders plus MO-D — a second order on MO-A's BOM, so "the same BOM across
// months and MOs" has a case. Expected figures are hand-computed here, never
// by the code under evaluation.

const shared: MasterTrackerRow = {
  ...TRANSFORMERS[0],
  mo: "MO-D", bom: "BOM-MO-A", soi: "SOI-MO-D", urgent: false, required: 8, complete: 2, remaining: 6, welded: 2, achievement: 0.25,
  months: ["October 2026"],
  items: Object.fromEntries(Object.entries(TRANSFORMERS[0].items).map(([it, c]) => [it, { ...c, cut: 2, weld: 2, paint: 2, shp: 2, delivered: 0, osp: 0, excluded: false }])) as MasterTrackerRow["items"],
};
export const AGENT_TRANSFORMERS: MasterTrackerRow[] = [...TRANSFORMERS, shared];

/** The totals the tracker tool must hand the model for each view. */
export const EXPECTED = {
  // MO-A (10/5) + MO-C (30/0, on hold) + MO-D (8/2)
  october: { orders: 3, required: 48, complete: 7, remaining: 41 },
  // with Status all: MO-A carried from September (10/5) + MO-B closed (20/20); the carried order counts once per view
  september: { orders: 2, required: 30, complete: 25, remaining: 5 },
  // the BOM's two orders, in two plan months, read per MO — never merged into one
  bom: { orders: 2, required: 18, complete: 7, remaining: 11 },
};
