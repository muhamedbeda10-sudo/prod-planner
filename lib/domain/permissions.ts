// Granular permission keys. The admin assigns any combination per account from
// the in-app Users page. Viewing is free for every active account — permissions
// gate WRITES only. isAdmin bypasses all checks and unlocks user management.
//
// Keys are grouped in CATEGORIES for the Users page. Worklist recording and
// Plan-Tracker cell editing are DELIBERATELY separate: holding a dept's
// worklist permission does not open its tracker column, and vice-versa.

export interface PermDef {
  key: string;
  label: string;
  desc: string;
}

export interface PermCategory {
  name: string;
  perms: PermDef[];
}

export const PERM_CATEGORIES: PermCategory[] = [
  {
    name: "Worklists",
    perms: [
      { key: "cut.edit", label: "Fabrication worklist — record & edit", desc: "Record output on the Fabrication worklist and add/edit/delete Fabrication rows in the Daily Logs" },
      { key: "welding.edit", label: "Welding worklist — record & edit", desc: "Record output, returns and notes on the Welding worklist and edit Welding rows in the Daily Logs" },
      { key: "painting.edit", label: "Painting worklist — record & edit", desc: "Record output, returns and notes on the Painting worklist and edit Painting rows in the Daily Logs" },
    ],
  },
  {
    name: "Plan Tracker",
    perms: [
      { key: "tracker.cut", label: "Fabrication column — record", desc: "Edit the Fab stage cells on the Plan Tracker (separate from the Fabrication worklist permission)" },
      { key: "tracker.weld", label: "Welding column — record", desc: "Edit the Weld stage cells on the Plan Tracker (separate from the Welding worklist permission)" },
      { key: "tracker.paint", label: "Painting column — record", desc: "Edit the Paint stage cells on the Plan Tracker (separate from the Painting worklist permission)" },
      { key: "tracker.delivered", label: "Delivered column — record", desc: "Record how many pieces the customer has received (Dlvd cells) — capped at the finished quantity" },
      { key: "tracker.status", label: "Close / reopen orders", desc: "Close finished orders (they leave the daily screens) and reopen them" },
      { key: "tracker.components", label: "Required components (N/A)", desc: "Mark which components an order does not need — they leave the worklists and stop gating completion" },
      { key: "tracker.qty", label: "Order quantity — edit", desc: "Change an order's Required quantity manually (e.g. apply a confirmed decrease from a monthly revision)" },
      { key: "tracker.priority", label: "Priority flag ⭐", desc: "Flag orders as priority — they show in the dedicated table on top of every dept worklist" },
      { key: "tracker.push", label: "Send to worklist 📤", desc: "Send an order down to a dept worklist with a chosen quantity per item" },
    ],
  },
  {
    name: "Admin",
    perms: [
      { key: "plans.import", label: "Plans — import", desc: "Import monthly plans (Orders Registry) and weekly plans" },
      { key: "logs.import", label: "Daily Logs — Excel import", desc: "Bulk-import handover logs from Excel (writes to all departments)" },
      { key: "boms.manage", label: "BOM review — manage", desc: "Apply BOM corrections and decide reallocation moves" },
      { key: "calendar.manage", label: "Calendar — manage", desc: "Add and remove factory holidays" },
    ],
  },
];

export const PERMISSIONS: PermDef[] = PERM_CATEGORIES.flatMap((c) => c.perms);

export const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/** Retired keys auto-expand to their granular successors, so accounts created
 *  before the split keep working without touching the database. */
const LEGACY: Record<string, string[]> = {
  // "Plan Tracker — edit" used to cover status + components + qty
  "tracker.edit": ["tracker.status", "tracker.components", "tracker.qty"],
};

/** Worklist/handover dept -> the permission key that allows writing to it.
 *  "Delivered" ledger rows are governed by the tracker's Delivered permission
 *  (they are only ever created from the tracker's Dlvd cells). */
export function deptPermKey(dept: string): string {
  if (dept === "Delivered") return "tracker.delivered";
  return `${dept.toLowerCase()}.edit`;
}

/** Plan-Tracker stage column -> its own permission key (Cut → tracker.cut,
 *  Welding → tracker.weld, Painting → tracker.paint, Delivered → tracker.delivered). */
export function trackerPermKey(dept: string): string {
  const map: Record<string, string> = { Cut: "tracker.cut", Welding: "tracker.weld", Painting: "tracker.paint", Delivered: "tracker.delivered" };
  return map[dept] ?? `tracker.${dept.toLowerCase()}`;
}

export function parsePerms(csv: string): Set<string> {
  const out = new Set<string>();
  for (const raw of csv.split(",")) {
    const key = raw.trim();
    if (PERM_KEYS.has(key)) out.add(key);
    for (const expanded of LEGACY[key] ?? []) out.add(expanded);
  }
  return out;
}

export function serializePerms(perms: Iterable<string>): string {
  return [...new Set([...perms].filter((p) => PERM_KEYS.has(p)))].join(",");
}
