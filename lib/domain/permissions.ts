// Granular permission keys. The admin assigns any combination per account from
// the in-app Users page. Viewing is free for every active account — permissions
// gate WRITES only. isAdmin bypasses all checks and unlocks user management.

export interface PermDef {
  key: string;
  label: string;
  desc: string;
}

export const PERMISSIONS: PermDef[] = [
  { key: "cut.edit", label: "Cut — record & edit", desc: "Record output on the Cut worklist and add/edit/delete Cut rows in the Daily Logs" },
  { key: "welding.edit", label: "Welding — record & edit", desc: "Record output, returns and notes on the Welding worklist and edit Welding rows in the Daily Logs" },
  { key: "painting.edit", label: "Painting — record & edit", desc: "Record output, returns and notes on the Painting worklist and edit Painting rows in the Daily Logs" },
  { key: "tracker.edit", label: "Plan Tracker — edit", desc: "Close/reopen orders and set excluded components on the tracker" },
  { key: "plans.import", label: "Plans — import", desc: "Import monthly plans (Orders Registry) and weekly plans" },
  { key: "logs.import", label: "Daily Logs — Excel import", desc: "Bulk-import handover logs from Excel (writes to all departments)" },
  { key: "boms.manage", label: "BOM review — manage", desc: "Apply BOM corrections and decide reallocation moves" },
  { key: "calendar.manage", label: "Calendar — manage", desc: "Add and remove factory holidays" },
];

export const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/** Worklist/handover dept -> the permission key that allows writing to it. */
export function deptPermKey(dept: string): string {
  return `${dept.toLowerCase()}.edit`;
}

export function parsePerms(csv: string): Set<string> {
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => PERM_KEYS.has(s))
  );
}

export function serializePerms(perms: Iterable<string>): string {
  return [...new Set([...perms].filter((p) => PERM_KEYS.has(p)))].join(",");
}
