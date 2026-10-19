// Typing a new total into a tracker cell. The cell shows each order's ledger
// total capped at the order's quantity, and the person types the total they
// want; the server records the difference. That difference is only right
// while the ledger still holds what the page showed — the tracker does not
// refresh itself, and the worklists keep recording under it. Pure, shared by
// the trackers that show the figure and the actions that write against it.

/** What a tracker cell shows for one order at one stage: its ledger total,
 *  capped at the order's quantity when it has one. */
export function shownStageTotal(ledgerTotal: number, planQty: number): number {
  return planQty > 0 ? Math.min(ledgerTotal, planQty) : ledgerTotal;
}

/** The figure the page showed when the total was typed ("base" on the form),
 *  or null when the caller sent none (the assistant, which re-reads the
 *  ledger itself before it writes). */
export function readBase(v: FormDataEntryValue | null): number | null {
  if (v === null) return null;
  const raw = String(v).trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/** Refuse a typed total worked out from a figure the ledger has since moved
 *  away from: recording the difference from a stale page would double-count
 *  output, or take back pieces (and tank serials) recorded meanwhile. */
export function staleTotalError(base: number | null, shownNow: number): string | null {
  if (base === null || base === shownNow) return null;
  return `This figure is now ${shownNow}, not the ${base} on your screen — someone recorded meanwhile. Refresh the page and type the total again.`;
}
