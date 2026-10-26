import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DEFAULT_LINE, LINE_HEADER, LINE_PARAM, defaultLineOf, lineParam, type ProductLine } from "@/lib/domain/lines";
import { LV_ITEM } from "@/lib/domain/lv";
import { getCurrentUser, userPerms } from "./auth";

// Which product line the screens are showing — transformers or LV panels.
//
// It is part of the page's ADDRESS (`?line=LV`). The proxy copies it into a
// request header, so a loader deep inside a page reads it without the page
// threading it down — and a server action sent from the page reads the same
// line, because the browser posts an action to the page's own address. With
// no line in the address, the screen opens on the person's own line
// (defaultLineOf in lib/domain/lines.ts).
//
// Some screens show BOTH lines (the Floor's machine boards, the trace of a
// given order): `withLine` lets them build each line's rows through the same
// loaders the line's own screens use, by overriding the line for the span of
// one call.

const override = new AsyncLocalStorage<ProductLine>();

/** The line the screens show this request — an override in force, else the
 *  address's, else the person's own, else transformers. Cheap enough to call
 *  anywhere. */
export async function getActiveLine(): Promise<ProductLine> {
  const forced = override.getStore();
  if (forced) return forced;
  try {
    const named = lineParam((await headers()).get(LINE_HEADER));
    if (named) return named;
    const me = await getCurrentUser();
    return me ? defaultLineOf(userPerms(me), me.isAdmin) : DEFAULT_LINE;
  } catch {
    // outside a request (a script, a test) there is no address and no person
    return DEFAULT_LINE;
  }
}

/** Run `fn` with every loader inside it reading `line`, whatever the address
 *  says — how one screen shows both lines at once. */
export function withLine<T>(line: ProductLine, fn: () => Promise<T>): Promise<T> {
  return override.run(line, fn);
}

/** A screen that belongs to one line only: opened on the other, it reopens
 *  on its own line with the rest of its address kept — so the address, the
 *  page's switches and every action sent from it agree. */
export async function pinLine(line: ProductLine, path: string, sp: Record<string, string | string[] | undefined> = {}): Promise<void> {
  if ((await getActiveLine()) === line) return;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== LINE_PARAM) q.set(k, v);
  q.set(LINE_PARAM, line);
  redirect(`${path}?${q}`);
}

/** The ledger rows that belong to a line, as a Prisma `where` fragment. The
 *  ledger carries no line of its own: a panel's rows are the ones under the
 *  panel's item code, a transformer's every other. */
export function ledgerItemWhere(line: ProductLine): { item: string } | { item: { not: string } } {
  return line === "LV" ? { item: LV_ITEM } : { item: { not: LV_ITEM } };
}
