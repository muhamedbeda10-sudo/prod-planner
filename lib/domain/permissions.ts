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
      { key: "leaktest.edit", label: "Leak test — record", desc: "Record the tank leak test (pass / needs repair) and who carried it out, on the stage between Welding and Painting" },
      { key: "painting.edit", label: "Painting worklist — record & edit", desc: "Record output, returns and notes on the Painting worklist and edit Painting rows in the Daily Logs" },
    ],
  },
  {
    name: "Tanks",
    perms: [
      { key: "quality.qa", label: "Quality check — sign a tank off", desc: "Scan a tank's barcode and record the quality verdict (OK / not OK) with a note" },
      { key: "workers.manage", label: "Workers list — manage", desc: "Add, edit and deactivate the shop-floor workers who appear in the welder / tester / painter dropdowns and on the shift log" },
    ],
  },
  {
    name: "Shifts & machines",
    perms: [
      { key: "shifts.cut", label: "Shift log — Fabrication", desc: "Record who worked in Fabrication each day, their shift and overtime, the machine they were on, and machine downtime" },
      { key: "shifts.welding", label: "Shift log — Welding", desc: "Record who worked in Welding each day, their shift and overtime" },
      { key: "shifts.shotblast", label: "Shift log — Shot Blast", desc: "Record who worked on the shot-blast cabinets each day, their shift and overtime, and downtime" },
      { key: "shifts.painting", label: "Shift log — Painting", desc: "Record who worked on the paint lines each day, their shift and overtime, and downtime" },
      { key: "shifts.lv", label: "Shift log — LV panels", desc: "Record who worked on the panels each day (laser, punching, bending, welding, painting), their shift and overtime" },
    ],
  },
  {
    name: "Material",
    perms: [
      { key: "material.edit", label: "Material & nesting — record", desc: "Add and edit the material lines on the MATERIAL tab — the record of what each order actually consumed: which sheet (material, thickness, size) and how many of them were really used" },
    ],
  },
  {
    name: "Odoo",
    perms: [
      { key: "odoo.edit", label: "Odoo close-out log — record", desc: "Add and edit the rows on the ODOO tab — the daily log of which Odoo manufacturing orders were closed and what Odoo answered" },
      { key: "odoo.alerts", label: "Odoo alerts — rows ready to close", desc: "Not an access right but a notification: a count on the ODOO tab and a popup whenever a row has Odoo's MO and is still open, closable from the popup. Admins get it only when this is ticked." },
    ],
  },
  {
    name: "Plan Tracker",
    perms: [
      { key: "tracker.cut", label: "Fabrication column — record", desc: "Edit the Fab stage cells on the Plan Tracker (separate from the Fabrication worklist permission)" },
      { key: "tracker.weld", label: "Welding column — record", desc: "Edit the Weld stage cells on the Plan Tracker (separate from the Welding worklist permission)" },
      { key: "tracker.paint", label: "Painting column — record", desc: "Edit the Paint stage cells on the Plan Tracker (separate from the Painting worklist permission)" },
      { key: "tracker.shp", label: "Shot Blast column — record (SHB)", desc: "Edit the SHB cells — the core frame's real final stage after welding (shown in place of Paint for CF)" },
      { key: "tracker.delivered", label: "Delivered column — record", desc: "Record how many pieces the customer has received (Dlvd cells) — capped at the finished quantity" },
      { key: "tracker.status", label: "Close / reopen / hold orders", desc: "Close finished orders (they leave the daily screens), reopen them, and put orders on hold or release them" },
      { key: "tracker.components", label: "Required components (N/A)", desc: "Mark which components an order does not need — they leave the worklists and stop gating completion" },
      { key: "tracker.qty", label: "Order quantity — edit", desc: "Change an order's Required quantity manually (e.g. apply a confirmed decrease from a monthly revision)" },
      { key: "tracker.priority", label: "Priority flag ⭐", desc: "Flag orders as priority — they show in the dedicated table on top of every dept worklist" },
      { key: "tracker.push", label: "Send to worklist 📤", desc: "Send an order down to a dept worklist with a chosen quantity per item" },
      { key: "weekly.record", label: "Weekly plan — record quantities", desc: "Type quantities straight onto the WEEKLY plan's day cells (all stages). Separate from the monthly tracker's per-column permissions; every entry lands in the Daily Logs marked as coming from the weekly plan" },
    ],
  },
  {
    // The panels line has its own keys — a transformer supervisor's permission
    // opens nothing on the panels, and the panel clerk's nothing on the tanks.
    name: "LV Panels",
    perms: [
      { key: "lv.punching", label: "LV Punching worklist — record & edit", desc: "Record panels punched on the LV Punching worklist and add/edit/delete Punching rows in the Daily Logs" },
      { key: "lv.bending", label: "LV Bending worklist — record & edit", desc: "Record panels bent on the LV Bending worklist and edit Bending rows in the Daily Logs" },
      { key: "lv.welding", label: "LV Welding worklist — record & edit", desc: "Record panels welded on the LV Welding worklist and edit the panels' Welding rows in the Daily Logs" },
      { key: "lv.painting", label: "LV Painting worklist — record & edit", desc: "Record panels painted on the LV Painting worklist and edit the panels' Painting rows in the Daily Logs" },
      { key: "lv.tracker.punch", label: "LV tracker — Punch column", desc: "Type punching totals on the LV Plan Tracker (separate from the worklist permission)" },
      { key: "lv.tracker.bend", label: "LV tracker — Bend column", desc: "Type bending totals on the LV Plan Tracker" },
      { key: "lv.tracker.weld", label: "LV tracker — Weld column", desc: "Type welding totals on the LV Plan Tracker" },
      { key: "lv.tracker.paint", label: "LV tracker — Paint column", desc: "Type painting totals on the LV Plan Tracker" },
      { key: "lv.tracker.delivered", label: "LV tracker — Delivered column", desc: "Record how many panels the customer has received — capped at the painted quantity" },
      { key: "lv.status", label: "LV orders — close / reopen / hold", desc: "Close finished panel orders, reopen them, and put panel orders on hold or release them" },
      { key: "lv.import", label: "LV plans — import", desc: "Import the panels' monthly plan (with the LV toggle on)" },
      { key: "lv.odoo", label: "LV Odoo close-out log — record", desc: "Add and edit the ODOO tab's rows while the LV toggle is on" },
      { key: "lv.material", label: "LV material — record", desc: "Add and edit the MATERIAL tab's lines while the LV toggle is on" },
    ],
  },
  {
    name: "Admin",
    perms: [
      { key: "plans.import", label: "Plans — import", desc: "Import monthly plans (Orders Registry) and weekly plans" },
      { key: "logs.import", label: "Daily Logs — Excel import", desc: "Bulk-import handover logs from Excel (writes to all departments)" },
      { key: "calendar.manage", label: "Calendar — manage", desc: "Add and remove factory holidays" },
      { key: "machines.manage", label: "Machines — manage", desc: "Add, edit and retire the machines and lines of each department (the shift log and the worklists read the list)" },
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
 *  "Delivered"/"ShotBlast" ledger rows are governed by their tracker
 *  permissions (they are only ever created from the tracker's cells). */
export function deptPermKey(dept: string): string {
  if (dept === "Delivered") return "tracker.delivered";
  if (dept === "ShotBlast") return "tracker.shp";
  if (dept === "LeakTest") return "leaktest.edit";
  // punching and bending exist only on the panels line — their own keys
  if (dept === "Punching" || dept === "Bending") return `lv.${dept.toLowerCase()}`;
  return `${dept.toLowerCase()}.edit`;
}

/** The key that edits one ledger row: a panel's row (item USS/LSS) follows
 *  the LV keys whatever its department; a transformer's the department's. */
export function ledgerPermKey(dept: string, item: string): string {
  if (item === "USS" || item === "LSS") {
    if (dept === "Delivered") return "lv.tracker.delivered";
    return `lv.${dept.toLowerCase()}`;
  }
  return deptPermKey(dept);
}

/** The line's key for the same job: closing and holding orders, importing
 *  plans, the ODOO and MATERIAL tabs — one key per product line. */
export function linePermKey(line: string, job: "status" | "import" | "odoo" | "material"): string {
  if (line === "LV") return `lv.${job}`;
  return { status: "tracker.status", import: "plans.import", odoo: "odoo.edit", material: "material.edit" }[job];
}

/** Plan-Tracker stage column -> its own permission key (Cut → tracker.cut,
 *  Welding → tracker.weld, Painting → tracker.paint, ShotBlast → tracker.shp,
 *  Delivered → tracker.delivered). */
export function trackerPermKey(dept: string): string {
  const map: Record<string, string> = { Cut: "tracker.cut", Welding: "tracker.weld", Painting: "tracker.paint", ShotBlast: "tracker.shp", Delivered: "tracker.delivered" };
  return map[dept] ?? `tracker.${dept.toLowerCase()}`;
}

/** Shift-log department -> its permission key (Cut → shifts.cut, ShotBlast →
 *  shifts.shotblast …). */
export function shiftPermKey(dept: string): string {
  if (dept === "Punching" || dept === "Bending" || dept === "WeldingLV" || dept === "PaintingLV") return "shifts.lv";
  return `shifts.${dept.toLowerCase()}`;
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
