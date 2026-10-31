// The plant builds two things that never mix: distribution TRANSFORMERS — the
// tanks, covers, core frames and cable boxes every screen was built around —
// and LV PANELS, the low-voltage substations (LSS / USS) planned from their
// own monthly sheet. They share the app's tabs but not its rows: an order
// belongs to one line, and a screen whose rows depend on it shows one line at
// a time, with a switch of its own in its page head.
//
// The line on screen is part of the page's ADDRESS (`?line=LV`), never a
// setting hidden somewhere else: a link, a bookmark or a server action sent
// from the page all carry it. With none in the address, the screen opens on
// the person's own line (defaultLineOf in lib/domain/permissions.ts).
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

/** Read a line off whatever a form or a URL carried — anything that is not a
 *  known line is the default, never an error: a screen has to land somewhere. */
export function resolveLine(raw: unknown): ProductLine {
  return lineParam(raw) ?? DEFAULT_LINE;
}

/** A browser-storage key of one line's own, so the other line's choices never apply. */
export function lineKey(line: ProductLine, key: string): string {
  return `${line}:${key}`;
}

/** The address parameter that names the line on screen. */
export const LINE_PARAM = "line";
/** The request header the proxy copies that parameter into, so a loader deep
 *  inside a page or a server action can read it (lib/server/line.ts). */
export const LINE_HEADER = "x-atc-line";

/** The line an address names, or null when it names none (or nonsense). */
export function lineParam(raw: unknown): ProductLine | null {
  const v = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return isProductLine(v) ? v : null;
}

/** `href` showing `line`: the address with its line parameter set, the rest
 *  of its query and its #fragment kept. */
export function hrefWithLine(href: string, line: ProductLine): string {
  const hash = href.indexOf("#");
  const frag = hash >= 0 ? href.slice(hash) : "";
  const base = hash >= 0 ? href.slice(0, hash) : href;
  const q = base.indexOf("?");
  const path = q >= 0 ? base.slice(0, q) : base;
  const params = new URLSearchParams(q >= 0 ? base.slice(q + 1) : "");
  params.set(LINE_PARAM, line);
  return `${path}?${params}${frag}`;
}

/** The screens that belong to one line and always show it, whatever the
 *  address asks (proxy.ts hands them their own). A line named on one of them
 *  is the screen's own, not a choice to carry on to the next. */
export const PINNED_LINE = {
  "/import": "TR",
  "/worklist/cut": "TR",
  "/worklist/punching": "LV",
  "/worklist/bending": "LV",
} as const satisfies Record<string, ProductLine>;

/** The line a screen is pinned to, or null for one that shows either. */
export function pinnedLine(path: string): ProductLine | null {
  return (PINNED_LINE as Record<string, ProductLine>)[path] ?? null;
}

/** The screens that show BOTH lines on one page — the plant's dashboard (the
 *  plan and the floor), a section per line. They take no line of their own:
 *  proxy.ts sends an address naming one to that line's section (#tr, #lv),
 *  and no line is carried onto them or from them. */
/** How each of them takes a line an address names: the dashboard opens at
 *  its section (#tr, #lv); the old Production address sets its line switch
 *  (?scope=) on its way to the dashboard. */
const LINE_ON_BOTH: Record<string, "section" | "scope"> = { "/": "section", "/dashboards/production": "scope" };
export const BOTH_LINES: ReadonlySet<string> = new Set(Object.keys(LINE_ON_BOTH));

/** A screen that shows both lines, told of a line (an older link, a
 *  bookmark): the address it is shown at — the line's section, or its own
 *  switch — with the line parameter gone and the rest kept. */
export function bothLinesAddress(url: URL, line: ProductLine | null): URL {
  const to = new URL(url);
  to.searchParams.delete(LINE_PARAM);
  if (!line) return to;
  if (LINE_ON_BOTH[to.pathname] === "scope") { if (!to.searchParams.has("scope")) to.searchParams.set("scope", line); }
  else if (!to.hash) to.hash = lineSection(line);
  return to;
}

/** A line's section on a screen that shows both — the anchor a link opens at. */
export type LineSection = "tr" | "lv";
export const lineSection = (line: ProductLine): LineSection => (line === "LV" ? "lv" : "tr");

/** Whether a screen (a path, or an href with its query) shows both lines. */
export function showsBothLines(href: string): boolean {
  return BOTH_LINES.has(href.split(/[?#]/)[0] || "/");
}
