"use client";

import { useEffect } from "react";

/** Opens the print dialog once the page has drawn — the assistant's "Print"
 *  link lands on a page that is only there to be printed. */
export function AutoPrint() {
  useEffect(() => {
    // a beat for the logo and the table to lay out before the dialog freezes them
    const t = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}
