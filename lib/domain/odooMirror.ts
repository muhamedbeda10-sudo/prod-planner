import { SHOTBLAST_STAGE, type Item } from "@/lib/domain/constants";
import { productSeries } from "@/lib/domain/odooStats";

// A closing in the ledger → a row on the ODOO tab. Painting is the last stage
// of every painted component and shot blast the last of the core, so the
// moment one of them is recorded, the office has an Odoo manufacturing order
// to close for exactly that many pieces. The row is born here with what the
// ledger knows — day, SOI, product, qty — and an EMPTY MO: Odoo's number is
// Odoo's, the clerk types it. The FG-CODE is copied from the last row of the
// same SOI and product when there is one (a top cover's code carries its own
// drawing number, which only an earlier row knows); otherwise it is composed
// from the part code and the transformer's BOM and flagged as a guess.

export type OdooSource = "manual" | "import" | "painting" | "shotblast";

/** Odoo's name for each component and the part code its FG-CODE starts with. */
export const ITEM_PRODUCT: Record<Item, { product: string; partCode: string | null }> = {
  CF: { product: "Core Frame", partCode: "FB-058" },
  TC: { product: "Top Cover", partCode: "FB-051" },
  TN: { product: "Tank", partCode: "FB-022" },
  CB: { product: "Cable Box", partCode: "FB-024" },
  AR: { product: "Arrester Bracket", partCode: "FB-027" },
  MB: { product: "Mono Box", partCode: null },
};

/** The default status a born row starts in — the clerk's "still to close". */
export const MIRROR_STATUS = "MO to be close";

/** Which closing a ledger row is, or null when it is not one: painting of
 *  any component, or the core's shot blast. */
export function mirrorSource(dept: string, item: string): Extract<OdooSource, "painting" | "shotblast"> | null {
  if (dept === "Painting") return "painting";
  if (dept === SHOTBLAST_STAGE && item === "CF") return "shotblast";
  return null;
}

/** The FG-CODE for a born row: the prior row's when one exists, else
 *  `<part>-<BOM>` marked as a guess, else nothing (a part without a code). */
export function mirrorFgCode(prior: string | null | undefined, item: Item, bom: string): { fgCode: string; guessed: boolean } {
  const p = (prior ?? "").trim().toUpperCase();
  if (p) return { fgCode: p, guessed: false };
  const part = ITEM_PRODUCT[item].partCode;
  const b = bom.trim().toUpperCase();
  if (!part || !b) return { fgCode: "", guessed: true };
  return { fgCode: `${part}-${b}`, guessed: true };
}

/** Two product names are the same product when they fold to the same series
 *  ("TC", "top cover" and "Top Cover" are all the top cover). */
export function sameProduct(a: string, b: string): boolean {
  return productSeries(a) === productSeries(b);
}

/** Nobody has worked a born row yet: no MO typed, status untouched, no notes.
 *  Such a row still belongs to its ledger entry and follows it. */
export function isUntouched(e: { odooMo: string; status: string; notes?: { length: number } | number }): boolean {
  const notes = typeof e.notes === "number" ? e.notes : (e.notes?.length ?? 0);
  return e.odooMo.trim() === "" && e.status.trim() === MIRROR_STATUS && notes === 0;
}

/** How the source reads on the row. */
export function sourceLabel(source: string): string | null {
  if (source === "painting") return "from Painting";
  if (source === "shotblast") return "from Shot Blast";
  if (source === "import") return "imported";
  return null;
}
