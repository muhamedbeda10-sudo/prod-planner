// The ODOO alerts. Two people wait on the same log for different things:
// - whoever types Odoo's MO number (odoo.needMo) waits for rows that landed
//   on the log WITHOUT one — a painting / shot-blast closing, or a row typed
//   in without it;
// - whoever closes the MOs in Odoo (odoo.alerts) waits for rows that HAVE the
//   MO and are still open.
// Each is told the same way: a count on the ODOO tab and a popup when a row
// they have not seen yet appears, workable from the popup. Pure, tested.

import { isDoneStatus, statusTone } from "./odoo";

/** Subscribes a person to "ready to close". Not an access right, so an admin
 *  does not get it automatically — it is ticked. */
export const ODOO_ALERTS_PERM = "odoo.alerts";
/** Subscribes a person to "needs an MO". Ticked, like the one above. */
export const ODOO_NEED_MO_PERM = "odoo.needMo";

/** Fired in the browser after a change saved on the ODOO page, so the tab's
 *  count follows at once instead of at the next minute's check. */
export const ODOO_CHANGED_EVENT = "odoo:changed";

export type AlertKind = "close" | "mo";

export interface ReadyRow {
  id: number;
  line: string;
  dateISO: string;
  soi: string | null;
  fgCode: string;
  product: string;
  odooMo: string;
  qty: number;
  status: string;
  source: string; // manual | import | painting | shotblast
}

export function isReadyToClose(e: { odooMo: string; status: string }): boolean {
  return e.odooMo.trim() !== "" && !isDoneStatus(e.status);
}

/** No MO yet and still to be closed — Done, Blocked and Cancelled rows are
 *  not waiting on anyone's MO. */
export function needsMo(e: { odooMo: string; status: string }): boolean {
  if (e.odooMo.trim() !== "") return false;
  const tone = statusTone(e.status);
  return tone === "muted" || tone === "warn";
}

/** The key a row is remembered by as "seen" — per kind, so a row seen while
 *  it needed an MO still alerts once it is ready to close. */
export const alertKey = (kind: AlertKind, id: number) => `${kind}:${id}`;

/** The keys the person has not been shown yet — what opens the popup. */
export function unseenKeys(keys: readonly string[], seen: ReadonlySet<string>): string[] {
  return keys.filter((k) => !seen.has(k));
}

/** What is kept as "seen": only keys still live, so the list never grows
 *  without end and a row that comes back later alerts again. */
export function pruneSeen(seen: Iterable<string>, live: readonly string[]): string[] {
  const alive = new Set(live);
  return [...new Set(seen)].filter((k) => alive.has(k));
}
