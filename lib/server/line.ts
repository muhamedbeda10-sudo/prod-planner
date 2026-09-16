import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { DEFAULT_LINE, resolveLine, type ProductLine } from "@/lib/domain/lines";

// Which product line the screens are showing — transformers or LV panels.
//
// It is a COOKIE, not a URL parameter: the choice has to follow the planner
// from tab to tab (the toggle sits in the nav, above every tab), and a
// server component on any route has to be able to read it before it loads a
// single row. A URL parameter would be lost on the first link he clicked.

export const LINE_COOKIE = "line";

/** The line the screens show this request. Read once per request. */
export const getActiveLine = cache(async (): Promise<ProductLine> => {
  try {
    return resolveLine((await cookies()).get(LINE_COOKIE)?.value);
  } catch {
    // outside a request (a script, a test) there is no cookie jar
    return DEFAULT_LINE;
  }
});
