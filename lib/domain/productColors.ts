import type { Item } from "@/lib/domain/constants";

/**
 * ONE colour per product, the same on every page and chart: the Plan
 * Tracker's component headers, the ODOO dashboard's cards and stacks, the KPI
 * cards. A product keeps its colour whatever else is on screen — the colour
 * follows the product, never its rank in a period.
 *
 * The nine products are the ones the ODOO log actually carries: the
 * transformers' six and the LV panels' three. Their colours are a validated
 * categorical set — colour-blind safe on neighbouring pairs (ΔE ≥ 8 under CVD
 * simulation, ≥ 15 for normal vision) in both themes, checked with the dataviz
 * validator against #ffffff and #242b28. That guarantee holds for products
 * shown side by side in PRODUCT_ORDER, which is why the charts order their
 * series by it.
 *
 * The CSS values live in app/globals.css (--prod-1 … --prod-9, each with an
 * --prod-N-ink for text drawn ON the colour). Any other product name (Encloser,
 * Conservator — names the app knows but the log hardly uses) reads as "Other"
 * in grey: a tenth hue would not stay distinguishable.
 */
export const PRODUCT_ORDER = [
  "Tank",
  "Top Cover",
  "Core Frame",
  "Cable Box",
  "Mono Box",
  "Arrester Bracket",
  "USS",
  "Skid Base",
  "LSS",
] as const;
export type Product = (typeof PRODUCT_ORDER)[number];

/** The tracker's component codes → their product. */
export const ITEM_PRODUCT: Record<Item, Product> = {
  TN: "Tank",
  TC: "Top Cover",
  CF: "Core Frame",
  CB: "Cable Box",
  AR: "Arrester Bracket",
  MB: "Mono Box",
};

const SLOT = new Map<string, number>(PRODUCT_ORDER.map((p, i) => [p.toLowerCase(), i + 1]));

/** The product's place in PRODUCT_ORDER (1-based), or null for any other name. */
export function productSlot(name: string | null | undefined): number | null {
  return SLOT.get(String(name ?? "").trim().toLowerCase()) ?? null;
}

/** The product's colour as a CSS value; grey for an unknown product. */
export function productColor(name: string | null | undefined): string {
  const s = productSlot(name);
  return s === null ? "var(--prod-other)" : `var(--prod-${s})`;
}

/** The ink for text drawn ON the product's colour (a stack segment's label). */
export function productInk(name: string | null | undefined): string {
  const s = productSlot(name);
  return s === null ? "var(--prod-other-ink)" : `var(--prod-${s}-ink)`;
}

/** A tracker component's colour (CF → Core Frame's). */
export function itemColor(item: Item): string {
  return productColor(ITEM_PRODUCT[item]);
}

/** Sort product names by PRODUCT_ORDER; unknown names after, keeping their order. */
export function byProductOrder(a: string, b: string): number {
  const sa = productSlot(a) ?? 99;
  const sb = productSlot(b) ?? 99;
  return sa - sb;
}
