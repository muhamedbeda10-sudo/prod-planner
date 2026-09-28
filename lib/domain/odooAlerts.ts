// The ODOO closing alert: a row is READY TO CLOSE once Odoo's MO is on it and
// it is still open — nothing stands between it and the closing but someone
// doing it. The one who closes is told: a count on the ODOO tab and a popup
// when a row he has not seen yet becomes ready. Pure, tested.

import { isDoneStatus } from "./odoo";

/** The permission that subscribes a person to the alert. Not an access
 *  right, so an admin does not get it automatically — it is ticked. */
export const ODOO_ALERTS_PERM = "odoo.alerts";

/** Fired in the browser after a change saved on the ODOO page, so the tab's
 *  count follows at once instead of at the next minute's check. */
export const ODOO_CHANGED_EVENT = "odoo:changed";

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
}

export function isReadyToClose(e: { odooMo: string; status: string }): boolean {
  return e.odooMo.trim() !== "" && !isDoneStatus(e.status);
}

/** The ready rows the person has not been shown yet — what opens the popup. */
export function unseenReady(rows: readonly { id: number }[], seen: ReadonlySet<number>): number[] {
  return rows.filter((r) => !seen.has(r.id)).map((r) => r.id);
}

/** What is kept as "seen": only the rows still ready, so the list never grows
 *  without end and a row that is re-opened later alerts again. */
export function pruneSeen(seen: Iterable<number>, rows: readonly { id: number }[]): number[] {
  const live = new Set(rows.map((r) => r.id));
  return [...new Set(seen)].filter((id) => live.has(id));
}
