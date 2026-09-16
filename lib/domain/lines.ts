// The plant builds two things that never mix: distribution TRANSFORMERS — the
// tanks, covers, core frames and cable boxes every screen was built around —
// and LV PANELS, the low-voltage substations (LSS / USS) planned from their
// own monthly sheet. They share the app's tabs but not its rows: an order
// belongs to one line, a screen shows one line at a time, and the toggle in
// the nav is what switches between them.
//
// The line is a fact about the ORDER, stamped when its plan is imported. It
// is never inferred from the order's shape, so an LV order with a BOM that
// happens to look like a transformer's still stays where it was planned.

export const PRODUCT_LINES = ["TR", "LV"] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number];

export const DEFAULT_LINE: ProductLine = "TR";

export const LINE_LABEL: Record<ProductLine, string> = {
  TR: "Transformers",
  LV: "LV Panels",
};

/** The word for one unit of the line — what a quantity counts. */
export const LINE_UNIT: Record<ProductLine, string> = {
  TR: "transformer",
  LV: "panel",
};

export function isProductLine(x: unknown): x is ProductLine {
  return typeof x === "string" && (PRODUCT_LINES as readonly string[]).includes(x);
}

/** Read a line off whatever a cookie, a form or a URL carried — anything
 *  that is not a known line is the default, never an error: the toggle has
 *  to land somewhere. */
export function resolveLine(raw: unknown): ProductLine {
  const v = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return isProductLine(v) ? v : DEFAULT_LINE;
}

/** The other line — what the toggle switches to. */
export function otherLine(line: ProductLine): ProductLine {
  return line === "TR" ? "LV" : "TR";
}
