"use client";

import { createContext, useContext } from "react";
import { DEFAULT_LINE, type ProductLine } from "@/lib/domain/lines";

// Which product line the browser is looking at, for the client components that
// must key something by it. The cookie decides it on the server; this carries
// the answer down so a hook does not have to guess.
//
// It exists because of a bug worth remembering: the screens' filters live in
// the browser's storage under one key each, and a filter set on the
// transformers' side stayed set when the toggle moved to the panels. A Product
// filter reading "Tank" emptied the panels' ODOO tab, and the daily log's Item
// filter — hidden on the panels — kept filtering for "CF" with no control on
// screen to clear it. A closing that HAD been recorded looked like it never
// arrived. Keying the storage by line keeps each line's filters its own.

const LineCtx = createContext<ProductLine>(DEFAULT_LINE);

export function LineProvider({ line, children }: { line: ProductLine; children: React.ReactNode }) {
  return <LineCtx.Provider value={line}>{children}</LineCtx.Provider>;
}

/** The line this browser is on — `DEFAULT_LINE` outside the provider. */
export function useActiveLine(): ProductLine {
  return useContext(LineCtx);
}

/** A storage key of this line's own, so the other line's choices never apply. */
export function useLineKey(key: string): string {
  return `${useContext(LineCtx)}:${key}`;
}
