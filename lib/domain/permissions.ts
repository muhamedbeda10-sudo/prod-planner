// Granular permission keys. The admin assigns any combination per account from
// the in-app Users page. Viewing is free for every active account — permissions
// gate WRITES only. Admins follow their ticks like everyone else; isAdmin
// itself unlocks user management, settings and the admin pages with no key.
//
// One key records a department everywhere: its worklist, its rows in the
// Daily Logs and its column on the Plan Tracker (they were two keys once; an
// account that held either holds the merged one — LEGACY below). The panels
// line keeps keys of its own. The Users page lays the keys out as tables
// (PERM_TABLES); the assistant's keys are kept on AI assistant settings
// alone (AI_PERM_KEYS), and the two pages never write each other's keys.

import { LV_ITEM, lvStageAt } from "./lv";

export interface PermDef {
  key: string;
  label: string;
  desc: string;
  /** A notification, not an access right: never ticked in bulk (an admin
   *  gets the access rights, not everyone's alerts). */
  notify?: true;
  /** A choice the person opts into, not an access right: never ticked in
   *  bulk, and not handed to the owner with the rights either — the owner
   *  ticks it for themselves like anyone else. */
  optIn?: true;
}

export interface PermCategory {
  name: string;
  perms: PermDef[];
}

export const PERM_CATEGORIES: PermCategory[] = [
  {
    name: "Departments",
    perms: [
      { key: "cut.edit", label: "Fabrication — record", desc: "Record output on the Fabrication worklist, edit Fabrication rows in the Daily Logs and type the Fab column on the Plan Tracker" },
      { key: "welding.edit", label: "Welding — record", desc: "Record output, returns and notes on the Welding worklist, edit Welding rows in the Daily Logs and type the Weld column on the Plan Tracker" },
      { key: "leaktest.edit", label: "Leak test — record", desc: "Record the tank leak test (pass / needs repair) and who carried it out, on the stage between Welding and Painting" },
      { key: "tracker.shp", label: "Shot blast — record", desc: "Type the SHB cells — the core frame's real final stage after welding (shown in place of Paint for CF)" },
      { key: "painting.edit", label: "Painting — record", desc: "Record output, returns and notes on the Painting worklist, edit Painting rows in the Daily Logs and type the Paint column on the Plan Tracker" },
      { key: "tracker.delivered", label: "Delivered — record", desc: "Record how many pieces the customer has received (Dlvd cells) — capped at the finished quantity" },
      { key: "shifts.cut", label: "Shift log — Fabrication", desc: "Record who worked in Fabrication each day, their shift and overtime, the machine they were on, and machine downtime" },
      { key: "shifts.welding", label: "Shift log — Welding", desc: "Record who worked in Welding each day, their shift and overtime" },
      { key: "shifts.shotblast", label: "Shift log — Shot Blast", desc: "Record who worked on the shot-blast cabinets each day, their shift and overtime, and downtime" },
      { key: "shifts.painting", label: "Shift log — Painting", desc: "Record who worked on the paint lines each day, their shift and overtime, and downtime" },
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
    name: "Material",
    perms: [
      { key: "stock.edit", label: "Physical material — count & import", desc: "Import the store's stock sheet on the PHYSICAL MATERIAL tab, correct a code's physical count or Odoo figure, add and remove items, and note why a count differs" },
      { key: "material.edit", label: "Material & nesting — record", desc: "Add and edit the material lines on the MATERIAL tab — the record of what each order actually consumed: which sheet (material, thickness, size) and how many of them were really used" },
    ],
  },
  {
    name: "Odoo",
    perms: [
      { key: "odoo.edit", label: "Odoo close-out log — record", desc: "Add and edit the rows on the ODOO tab — the daily log of which Odoo manufacturing orders were closed and what Odoo answered" },
      { key: "odoo.needMo", notify: true, label: "Odoo alerts — rows that need an MO", desc: "Not an access right but a notification: a count on the ODOO tab and a popup whenever a row lands on the log without Odoo's MO number (a painting / shot-blast closing), with a box to type the MO right there. Ticked per person, admins included." },
      { key: "odoo.alerts", notify: true, label: "Odoo alerts — rows ready to close", desc: "Not an access right but a notification: a count on the ODOO tab and a popup whenever a row has Odoo's MO and is still open, closable from the popup. Ticked per person, admins included." },
    ],
  },
  {
    name: "Consumables",
    perms: [
      { key: "consumables.edit", label: "Consumables — record hand-outs & manage limits", desc: "Record on the CONSUMABLES tab what the store hands out (the item from the catalogue, the quantity, the department and the worker) and correct the rows you recorded yourself; a hand-out over a limit needs a reason. Also keeps the catalogue and its limits (Limits view) — every change is recorded. Deleting a hand-out stays the admin's" },
    ],
  },
  {
    name: "Plan Tracker",
    perms: [
      { key: "tracker.status", label: "Close / reopen / hold orders", desc: "Close finished orders (they leave the daily screens), reopen them, and put orders on hold or release them" },
      { key: "tracker.components", label: "Required components (N/A)", desc: "Mark which components an order does not need — they leave the worklists and stop gating completion" },
      { key: "tracker.qty", label: "Order quantity — edit", desc: "Change an order's Required quantity manually (e.g. apply a confirmed decrease from a monthly revision)" },
      { key: "tracker.priority", label: "Priority flag ⭐", desc: "Flag orders as priority — they show in the dedicated table on top of every dept worklist" },
      { key: "tracker.push", label: "Send to worklist 📤", desc: "Send an order down to a dept worklist with a chosen quantity per item" },
      { key: "weekly.record", label: "Weekly plan — record quantities", desc: "Type quantities straight onto the WEEKLY plan's day cells (all stages). Every entry lands in the Daily Logs marked as coming from the weekly plan" },
    ],
  },
  {
    // The panels line has its own keys — a transformer supervisor's permission
    // opens nothing on the panels, and the panel clerk's nothing on the tanks.
    name: "LV Panels",
    perms: [
      { key: "lv.punching", label: "LV Punching — record", desc: "Record panels punched on the LV Punching worklist, edit Punching rows in the Daily Logs and type the Punch column on the LV Plan Tracker" },
      { key: "lv.bending", label: "LV Bending — record", desc: "Record panels bent on the LV Bending worklist, edit Bending rows in the Daily Logs and type the Bend column on the LV Plan Tracker" },
      { key: "lv.welding", label: "LV Welding — record", desc: "Record panels welded on the LV Welding worklist, edit the panels' Welding rows in the Daily Logs and type the Weld column on the LV Plan Tracker" },
      { key: "lv.painting", label: "LV Painting — record", desc: "Record panels painted on the LV Painting worklist, edit the panels' Painting rows in the Daily Logs and type the Paint column on the LV Plan Tracker" },
      { key: "lv.tracker.delivered", label: "LV Delivered — record", desc: "Record how many panels the customer has received — capped at the painted quantity" },
      { key: "shifts.lv", label: "Shift log — LV panels", desc: "Record who worked on the panels each day (laser, punching, bending, welding, painting), their shift and overtime" },
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
      { key: "machines.manage", label: "Machines — manage", desc: "Add, edit and retire the machines and lines of each department (the shift log and the worklists read the list), and keep each machine's rules — which work it takes, never takes or is preferred for — that ⚡ Plan follows" },
      { key: "simulator.edit", label: "Simulator — save and delete scenarios", desc: "Save what-if scenarios on the Simulator under a name, overwrite them and delete them. Applying a scenario as the run order stays the admin's" },
      { key: "tasks.assign", label: "Tasks — give tasks", desc: "Give colleagues tasks — on the inbox's Tasks tab or through the assistant — follow their updates and photos, approve what they mark done or return it for rework. Everyone can receive tasks and report on them" },
    ],
  },
  {
    // What the assistant may DO for this person. It never does more than the
    // person may do themselves: every change also needs the person's own key
    // for it (a tracker column, a worklist, the Odoo log …), and waits for
    // their approval in the chat unless it is a small one and they opted in.
    name: "AI assistant",
    perms: [
      { key: "ai.act.tracker", label: "AI — Plan Tracker, Daily log and worklists", desc: "The assistant may prepare changes on the Plan Tracker, the Daily log and the worklists for this person: close, reopen, hold and flag orders, quantities, specs and components, recorded totals, output taken off a production sheet or a photo of one, log corrections, the worklists' notes, returns, dates and hidden lines, tanks piece by piece (welder, leak test, repair, painting, quality), and an admin's edits on the Orders Registry. Each one still needs the person's own permission for it" },
      { key: "ai.act.machines", label: "AI — machines and the distribution", desc: "The assistant may put lines and jobs on machines, order and split the queues, plan the machines, keep the machines' rules, and type in jobs (the fabrication board's sheet jobs with their parts) and record their sheets and pieces — within the person's own worklist and machines permissions" },
      { key: "ai.act.simulator", label: "AI — the simulator", desc: "The assistant may build and run what-if scenarios, save and delete them, and — for an admin — apply one as the run order" },
      { key: "ai.act.data", label: "AI — other data", desc: "The assistant may change the rest of the app's data for this person — the ODOO log, Material, Physical material, Consumables (hand-outs, the catalogue and its limits, powder scrap), the shift roster, the calendar, workers and machines — each within the person's own permission for it" },
      { key: "ai.act.setup", label: "AI — standard times and settings", desc: "The assistant may change the plant's set-up for this person — the standard times, the FG map, the LV panels' hours, each stage's capacity and calibration, the times per machine, the shift hours and the master switches — within the person's own admin or machines permission. Every figure the app plans with is built on these, so each change waits for an approval" },
      { key: "ai.act.import", label: "AI — imports", desc: "The assistant may import a file this person attaches in its chat — a monthly or weekly plan, a Daily-log sheet, an ODOO sheet, the MATERIAL sheet or the store's stock sheet — after showing what the import would do. Each still needs the person's own import permission for it, and waits for an approval" },
      { key: "ai.act.delete", label: "AI — deletions", desc: "The assistant may prepare deletions (log rows, scenarios, queue lines, holidays …). A deletion always waits for an explicit approval, whatever else is ticked, and the assistant's log keeps what it removed" },
      { key: "ai.automations", label: "AI — automations and scheduled reports", desc: "Create automations with the assistant — \"when this happens, tell that person\", \"every working day at 7:30 send me a report on …\". They run as this person, with this person's permissions, and stop when those are taken away. It also sends messages for this person when asked — to colleagues' inboxes or in the team chat" },
      { key: "ai.automations.act", label: "AI — automations may change data", desc: "An automation of this person may prepare changes — they wait in the person's AI inbox for approval, or the small ones run on their own when the person also opted into small changes without asking" },
      { key: "ai.act.noconfirm", optIn: true, label: "AI — small changes without asking", desc: "Not an access right but a choice: the assistant makes LOW-RISK changes (a flag, a spec, a queue's order …) without waiting for an approval click. Quantities, closings, the run order, deletions and anything over several rows still wait. Never ticked in bulk" },
      { key: "ai.suggestions", notify: true, label: "AI — daily review and suggestions", desc: "Not an access right but a notification: every working morning the assistant reviews the plant for this person and sends its suggestions to their AI inbox, each with the change ready to approve. Ticked per person" },
    ],
  },
];

export const PERMISSIONS: PermDef[] = PERM_CATEGORIES.flatMap((c) => c.perms);

export const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/** Every access right (no notifications, no opt-in choices) — what an admin
 *  starts ticked with, and what the owner holds without ticking. */
export const ACCESS_PERM_KEYS = PERMISSIONS.filter((p) => !p.notify && !p.optIn).map((p) => p.key);

/** Retired keys auto-expand to their granular successors, so accounts created
 *  before the split keep working without touching the database. */
const LEGACY: Record<string, string[]> = {
  // "Plan Tracker — edit" used to cover status + components + qty
  "tracker.edit": ["tracker.status", "tracker.components", "tracker.qty"],
  // a department's tracker column and its worklist were two keys: either
  // one now holds the merged key
  "tracker.cut": ["cut.edit"],
  "tracker.weld": ["welding.edit"],
  "tracker.paint": ["painting.edit"],
  "lv.tracker.punch": ["lv.punching"],
  "lv.tracker.bend": ["lv.bending"],
  "lv.tracker.weld": ["lv.welding"],
  "lv.tracker.paint": ["lv.painting"],
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

/** The key that edits one ledger row: a panel's row (item PNL) follows the
 *  LV keys whatever its department; a transformer's the department's. The
 *  panel's TYPE (USS / LSS) sits on its order, never on a ledger row. */
export function ledgerPermKey(dept: string, item: string): string {
  if (item === LV_ITEM) {
    if (dept === "Delivered") return "lv.tracker.delivered";
    return `lv.${dept.toLowerCase()}`;
  }
  return deptPermKey(dept);
}

/** The keys that schedule a bay's shared machines, one per line: the
 *  transformers' (the bay's own) and the panels' (the LV stage the bay
 *  works) — null where the bay takes no panels. */
export function bayPermKeys(bay: string): { tr: string; lv: string | null } {
  const stage = lvStageAt(bay);
  return { tr: deptPermKey(bay), lv: stage ? ledgerPermKey(stage, LV_ITEM) : null };
}

/** The key that schedules one line on a bay's machines — puts it on, moves,
 *  starts, splits, takes it off, ticks it done. The machines are shared, so
 *  the LINE decides, never the bay: a panel's line the LV key, anything
 *  else the bay's. Null for a panel on a bay that takes none. */
export function machineLinePermKey(bay: string, item: string): string | null {
  const keys = bayPermKeys(bay);
  return item === LV_ITEM ? keys.lv : keys.tr;
}

/** What one account may schedule on a bay's shared machines, line by line. */
export interface BayAccess {
  tr: boolean;
  lv: boolean;
}

export function mayScheduleLine(access: BayAccess, item: string): boolean {
  return item === LV_ITEM ? access.lv : access.tr;
}

/** The line's key for the same job: closing and holding orders, importing
 *  plans, the ODOO and MATERIAL tabs — one key per product line. */
export function linePermKey(line: string, job: "status" | "import" | "odoo" | "material"): string {
  if (line === "LV") return `lv.${job}`;
  return { status: "tracker.status", import: "plans.import", odoo: "odoo.edit", material: "material.edit" }[job];
}

/** Plan-Tracker stage column -> the key that types it: the department's own
 *  (Cut → cut.edit, Welding → welding.edit, Painting → painting.edit,
 *  ShotBlast → tracker.shp, Delivered → tracker.delivered). */
export function trackerPermKey(dept: string): string {
  const map: Record<string, string> = { Cut: "cut.edit", Welding: "welding.edit", Painting: "painting.edit", ShotBlast: "tracker.shp", Delivered: "tracker.delivered" };
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

// ---- the assistant's keys: kept on AI assistant settings, apart from the rest ----

/** The keys of what the assistant may do for a person — edited on AI
 *  assistant settings, never on Users & Permissions. */
export const AI_PERM_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.key.startsWith("ai.")).map((p) => p.key);
const AI_SET = new Set(AI_PERM_KEYS);

/** The assistant's keys as AI assistant settings groups them. */
export const AI_PERM_GROUPS: { title: string; keys: string[] }[] = [
  { title: "Changes it may prepare", keys: ["ai.act.tracker", "ai.act.machines", "ai.act.simulator", "ai.act.data", "ai.act.setup", "ai.act.import", "ai.act.delete"] },
  { title: "Automations", keys: ["ai.automations", "ai.automations.act"] },
  { title: "Choices", keys: ["ai.act.noconfirm", "ai.suggestions"] },
];

export function isAiPerm(key: string): boolean {
  return AI_SET.has(key);
}

/** A stored key list with its assistant keys replaced by `ai` — the rest of
 *  the person's keys stay exactly as they were. Unknown keys are dropped. */
export function withAiPerms(csv: string, ai: Iterable<string>): string {
  const rest = [...parsePerms(csv)].filter((k) => !AI_SET.has(k));
  return serializePerms([...rest, ...[...ai].filter((k) => AI_SET.has(k))]);
}

/** A stored key list with everything but its assistant keys replaced by
 *  `keys` — what Users & Permissions saves, leaving the assistant's alone. */
export function withoutAiChange(csv: string, keys: Iterable<string>): string {
  const ai = [...parsePerms(csv)].filter((k) => AI_SET.has(k));
  return serializePerms([...[...keys].filter((k) => !AI_SET.has(k)), ...ai]);
}

// ---- how Users & Permissions lays the keys out ----

export interface PermTableRow {
  label: string;
  /** One key per column; null where the column has none for this row. */
  cells: (string | null)[];
}

export interface PermTable {
  title: string;
  columns: string[];
  rows: PermTableRow[];
}

/** The keys as tables: a department's row across the two lines and its shift
 *  log, an order's job across the two lines. */
export const PERM_TABLES: PermTable[] = [
  {
    title: "Departments",
    columns: ["Transformers", "LV panels", "Shift log"],
    rows: [
      { label: "Fabrication", cells: ["cut.edit", null, "shifts.cut"] },
      { label: "Punching", cells: [null, "lv.punching", null] },
      { label: "Bending", cells: [null, "lv.bending", null] },
      { label: "Welding", cells: ["welding.edit", "lv.welding", "shifts.welding"] },
      { label: "Leak test", cells: ["leaktest.edit", null, null] },
      { label: "Shot blast", cells: ["tracker.shp", null, "shifts.shotblast"] },
      { label: "Painting", cells: ["painting.edit", "lv.painting", "shifts.painting"] },
      { label: "Delivered", cells: ["tracker.delivered", "lv.tracker.delivered", null] },
      { label: "LV panels — all stages", cells: [null, null, "shifts.lv"] },
    ],
  },
  {
    title: "Orders",
    columns: ["Transformers", "LV panels"],
    rows: [
      { label: "Close / reopen / hold", cells: ["tracker.status", "lv.status"] },
      { label: "Import plans", cells: ["plans.import", "lv.import"] },
      { label: "Odoo close-out log", cells: ["odoo.edit", "lv.odoo"] },
      { label: "Material & nesting", cells: ["material.edit", "lv.material"] },
      { label: "Required components (N/A)", cells: ["tracker.components", null] },
      { label: "Order quantity", cells: ["tracker.qty", null] },
      { label: "Priority ⭐", cells: ["tracker.priority", null] },
      { label: "Send to worklist 📤", cells: ["tracker.push", null] },
      { label: "Weekly plan — record", cells: ["weekly.record", null] },
    ],
  },
];

/** The keys of one line each, under the tables. */
export const PERM_OTHER: readonly string[] = [
  "quality.qa", "workers.manage", "stock.edit", "consumables.edit", "logs.import", "calendar.manage", "machines.manage", "simulator.edit", "tasks.assign",
];

/** Notifications, not rights — apart from them. */
export const PERM_ALERTS: readonly string[] = ["odoo.needMo", "odoo.alerts"];

export function permDef(key: string): PermDef | undefined {
  return PERMISSIONS.find((p) => p.key === key);
}
