// ODOO close-out log — pure helpers shared by the server and the form.

/** The product names as Odoo's FG codes call them — a dropdown, not a
 *  constraint: anything typed is kept. */
export const ODOO_PRODUCTS = ["Tank", "Top Cover", "Core Frame", "Encloser", "Cable Box", "Conservator"] as const;

/** Where a close attempt can stand. Free text is still accepted, so a new
 *  Odoo state never needs a code change. */
export const ODOO_STATUSES = ["MO to be close", "Closed", "Blocked", "Cancelled"] as const;

/** "Done" is the one reason worth recognising: it is what a clean close says. */
export function isDoneReason(reason: string | null | undefined): boolean {
  return (reason ?? "").trim().toLowerCase() === "done";
}

/** Odoo's error text names the item in [BRACKETS] first — pull that out so a
 *  table can show the blocked item without the whole sentence. */
export function blockedItem(reason: string | null | undefined): string | null {
  const m = /^\s*\[([^\]]+)\]/.exec(reason ?? "");
  return m ? m[1] : null;
}

export interface OdooEntryView {
  id: number;
  dateISO: string;
  soi: string | null;
  fgCode: string;
  product: string;
  odooMo: string;
  qty: number;
  status: string;
  reason: string | null;
  done: boolean;
  blockedItem: string | null;
  recordedBy: string | null;
}
