// Which screens an account sees. The owner ticks them per person on Users &
// Permissions — admins included. A screen off for someone leaves their menu,
// their view switches and, opened by its address, sends them to the first
// screen they do see. Writes stay with the permission keys; this is sight.
//
// Stored as the HIDDEN ones (User.hiddenTabs, CSV of ids), so an account
// nobody has touched keeps seeing everything, and a screen added later shows
// for everyone until it is ticked off.

export interface TabDef {
  id: string;
  label: string;
  group: "Worklists" | "Production" | "Plan Tracker" | "Admin tools";
  /** Where it lives: "/" is the home page alone; any other path covers what is under it. */
  paths: string[];
}

export const TABS: TabDef[] = [
  { id: "worklist.cut", label: "Fabrication worklist", group: "Worklists", paths: ["/worklist/cut"] },
  { id: "worklist.welding", label: "Welding worklist", group: "Worklists", paths: ["/worklist/welding"] },
  { id: "worklist.leak-test", label: "Leak test", group: "Worklists", paths: ["/worklist/leak-test"] },
  { id: "worklist.painting", label: "Painting worklist", group: "Worklists", paths: ["/worklist/painting"] },
  { id: "worklist.punching", label: "LV Punching worklist", group: "Worklists", paths: ["/worklist/punching"] },
  { id: "worklist.bending", label: "LV Bending worklist", group: "Worklists", paths: ["/worklist/bending"] },
  { id: "worklist.machines", label: "Machines worklist", group: "Worklists", paths: ["/worklist/machines"] },

  { id: "material", label: "Material", group: "Production", paths: ["/material"] },
  { id: "analytics", label: "Material dashboard", group: "Production", paths: ["/analytics"] },
  { id: "physical", label: "Physical Material", group: "Production", paths: ["/physical"] },
  { id: "odoo", label: "ODOO", group: "Production", paths: ["/odoo"] },
  { id: "consumables", label: "Consumables", group: "Production", paths: ["/consumables"] },
  { id: "shifts", label: "Shifts", group: "Production", paths: ["/shifts"] },
  { id: "barcode", label: "Tank barcodes", group: "Production", paths: ["/barcode", "/tank"] },
  { id: "simulate", label: "Floor / Simulator", group: "Production", paths: ["/simulate"] },
  { id: "chat", label: "Chat", group: "Production", paths: ["/chat"] },

  // the id stays "dashboard": an account the home page was switched off for keeps it off
  { id: "dashboard", label: "Planning cockpit (home)", group: "Plan Tracker", paths: ["/"] },
  { id: "tracker", label: "Plan Tracker", group: "Plan Tracker", paths: ["/tracker"] },
  { id: "handover", label: "Daily log", group: "Plan Tracker", paths: ["/handover"] },
  { id: "report", label: "Report", group: "Plan Tracker", paths: ["/report"] },

  { id: "orders", label: "Orders & plan imports", group: "Admin tools", paths: ["/orders", "/import"] },
  { id: "calendar", label: "Factory calendar", group: "Admin tools", paths: ["/calendar"] },
  { id: "settings", label: "Settings", group: "Admin tools", paths: ["/admin/settings"] },
  { id: "workers", label: "Production workers", group: "Admin tools", paths: ["/admin/workers"] },
  { id: "machines", label: "Machines & lines", group: "Admin tools", paths: ["/admin/machines"] },
  { id: "machine-times", label: "Times per machine", group: "Admin tools", paths: ["/admin/machine-times"] },
  { id: "standard-times", label: "Standard times & capacity", group: "Admin tools", paths: ["/admin/standard-times"] },
];

export const TAB_GROUPS = ["Plan Tracker", "Production", "Worklists", "Admin tools"] as const;

const TAB_IDS = new Set(TABS.map((t) => t.id));

/** The hidden tab ids out of the stored CSV — unknown ids dropped. */
export function parseHiddenTabs(csv: string | null | undefined): Set<string> {
  return new Set((csv ?? "").split(",").map((s) => s.trim()).filter((s) => TAB_IDS.has(s)));
}

export function serializeHiddenTabs(ids: Iterable<string>): string {
  return [...new Set(ids)].filter((s) => TAB_IDS.has(s)).sort().join(",");
}

const covers = (base: string, path: string) => (base === "/" ? path === "/" : path === base || path.startsWith(base + "/"));

/** The screen a path belongs to — null for one outside the catalog (login,
 *  trace, Users & Permissions), which every signed-in account keeps. */
export function tabForPath(pathname: string): TabDef | null {
  const path = pathname.split("?")[0] || "/";
  let best: { tab: TabDef; len: number } | null = null;
  for (const t of TABS) for (const p of t.paths) {
    if (covers(p, path) && (!best || p.length > best.len)) best = { tab: t, len: p.length };
  }
  return best?.tab ?? null;
}

export function canSeePath(hidden: ReadonlySet<string>, pathname: string): boolean {
  const t = tabForPath(pathname);
  return !t || !hidden.has(t.id);
}

/** Where to send someone whose screen is off: the first one they see, in
 *  the order the menu reads; null when every one is off. */
export function firstVisiblePath(hidden: ReadonlySet<string>): string | null {
  const order = ["tracker", "dashboard", "material", "odoo", "consumables", "handover", "report", "analytics", "simulate", "shifts", "barcode", "chat"];
  const pick = [...order.map((id) => TABS.find((t) => t.id === id)!), ...TABS].find((t) => !hidden.has(t.id));
  return pick ? pick.paths[0] : null;
}
