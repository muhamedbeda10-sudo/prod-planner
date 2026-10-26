"use client";

import { createContext, useContext } from "react";
import { useSearchParams } from "next/navigation";
import { DEFAULT_LINE, LINE_PARAM, hrefWithLine, lineParam, type ProductLine } from "@/lib/domain/lines";

// Which product line the browser is looking at, for the client components that
// must key something by it. The page's address names it (`?line=LV`); with
// none there, the screen is on the person's own line, which the layout hands
// down here — the same answer the server's getActiveLine gives.
//
// It exists because of a bug worth remembering: the screens' filters live in
// the browser's storage under one key each, and a filter set on the
// transformers' side stayed set when the screen moved to the panels. A Product
// filter reading "Tank" emptied the panels' ODOO log, and the daily log's Item
// filter — hidden on the panels — kept filtering for "CF" with no control on
// screen to clear it. A closing that HAD been recorded looked like it never
// arrived. Keying the storage by line keeps each line's filters its own.

const LineCtx = createContext<ProductLine>(DEFAULT_LINE);

/** `line` is the person's own line — where a screen opens when its address names none. */
export function LineProvider({ line, children }: { line: ProductLine; children: React.ReactNode }) {
  return <LineCtx.Provider value={line}>{children}</LineCtx.Provider>;
}

/** The line this screen is on: the address's, else the person's own. */
export function useActiveLine(): ProductLine {
  const own = useContext(LineCtx);
  return lineParam(useSearchParams().get(LINE_PARAM)) ?? own;
}

/** A storage key of this line's own, so the other line's choices never apply. */
export function useLineKey(key: string): string {
  return `${useActiveLine()}:${key}`;
}

/** Links to the other screens of the same tab keep the line the address
 *  names: from the panels' Plan Tracker, the Daily log opens on the panels
 *  too. With no line in the address there is nothing to carry. */
export function useCarryLine(): (href: string) => string {
  const named = lineParam(useSearchParams().get(LINE_PARAM));
  return (href) => (named ? hrefWithLine(href, named) : href);
}
