import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { DEFAULT_LINE, resolveLine, type ProductLine } from "@/lib/domain/lines";
import { LV_ITEM } from "@/lib/domain/lv";

// Which product line the screens are showing — transformers or LV panels.
//
// It is a COOKIE, not a URL parameter: the choice has to follow the planner
// from tab to tab (the toggle sits in the nav, above every tab), and a
// server component on any route has to be able to read it before it loads a
// single row. A URL parameter would be lost on the first link he clicked.
//
// One screen is the exception: the Floor is one physical floor, and the
// punches carry panels beside transformer parts, so it draws BOTH lines'
// work whatever the toggle. `withLine` lets it build each line's lines
// through the same loaders the line's own screens use, by overriding the
// line for the span of one call.

export const LINE_COOKIE = "line";

const override = new AsyncLocalStorage<ProductLine>();

/** The line the screens show this request — an override in force, else the
 *  cookie, else transformers. Cheap enough to call anywhere. */
export async function getActiveLine(): Promise<ProductLine> {
  const forced = override.getStore();
  if (forced) return forced;
  try {
    return resolveLine((await cookies()).get(LINE_COOKIE)?.value);
  } catch {
    // outside a request (a script, a test) there is no cookie jar
    return DEFAULT_LINE;
  }
}

/** Run `fn` with every loader inside it reading `line`, whatever the toggle
 *  says — how one screen shows both lines at once. */
export function withLine<T>(line: ProductLine, fn: () => Promise<T>): Promise<T> {
  return override.run(line, fn);
}

/** The ledger rows that belong to a line, as a Prisma `where` fragment. The
 *  ledger carries no line of its own: a panel's rows are the ones under the
 *  panel's item code, a transformer's every other. */
export function ledgerItemWhere(line: ProductLine): { item: string } | { item: { not: string } } {
  return line === "LV" ? { item: LV_ITEM } : { item: { not: LV_ITEM } };
}
