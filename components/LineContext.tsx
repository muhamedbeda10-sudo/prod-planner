"use client";

import { createContext, useCallback, useContext } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DEFAULT_LINE, LINE_PARAM, hrefWithLine, lineKey, lineParam, pinnedLine, showsBothLines, type ProductLine } from "@/lib/domain/lines";

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

/** The line this screen is on: a pinned screen's own, else the address's,
 *  else the person's own — what the proxy hands the server. */
export function useActiveLine(): ProductLine {
  const own = useContext(LineCtx);
  const named = lineParam(useSearchParams().get(LINE_PARAM));
  return pinnedLine(usePathname()) ?? named ?? own;
}

/** A storage key of this line's own (the screen's, or `line`), so the other
 *  line's choices never apply. */
export function useLineKey(key: string, line?: ProductLine): string {
  const active = useActiveLine();
  return lineKey(line ?? active, key);
}

/** Links to the other screens of the same tab keep the line the address
 *  names: from the panels' Plan Tracker, the Daily log opens on the panels
 *  too. With no line in the address there is nothing to carry — nor on a
 *  screen pinned to one line, whose line was never the reader's choice — and
 *  none rides onto a screen that shows both lines. */
export function useCarryLine(): (href: string) => string {
  const here = usePathname();
  const own = pinnedLine(here) !== null || showsBothLines(here);
  const asked = lineParam(useSearchParams().get(LINE_PARAM));
  const named = own ? null : asked;
  return useCallback((href: string) => (named && !showsBothLines(href) ? hrefWithLine(href, named) : href), [named]);
}
