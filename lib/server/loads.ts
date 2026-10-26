import "server-only";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActiveLine, ledgerItemWhere } from "./line";
import type { ProductLine } from "@/lib/domain/lines";

// The tables every screen reads, loaded ONCE per request. A worklist page
// used to fetch the orders registry five times and the whole daily log
// twice (the sheet, the machine board, the SOI lookup, the priority table,
// the run order each asked for their own copy); with React's request cache
// the first caller pays for the query and the rest share the rows. The
// tables are small (a few thousand rows), so filtering in memory beats
// another round trip every time. Callers must treat the arrays as
// read-only — they are shared for the rest of the request.

/** Every order of ONE product line, urgent first then by MO — memoised per
 *  line, so a screen that builds both lines (the Floor) gets each its own. */
export const loadMasterOrdersOf = cache(async (line: ProductLine) =>
  prisma.masterOrder.findMany({ where: { line }, orderBy: [{ urgent: "desc" }, { mo: "asc" }] })
);

/** Every order of the product line the screens are showing. The line comes
 *  from the page's address (getActiveLine), read here so that every screen
 *  built on this loader shows one line at a time without having to ask. */
export async function loadMasterOrders() {
  return loadMasterOrdersOf(await getActiveLine());
}

// What the daily screens read off a ledger row: the key it is counted under
// (plan, department, project, order, component), the quantity and the day.
// The audit columns (note, source, machine, who logged it) never reach the
// queue maths, and the ledger is the largest table the request touches, so
// they stay on the server.
const LEDGER_SELECT = { planNo: true, dept: true, bom: true, mo: true, item: true, qty: true, date: true } satisfies Prisma.HandoverEntrySelect;
export type LedgerRow = Prisma.HandoverEntryGetPayload<{ select: typeof LEDGER_SELECT }>;

/** The daily log of ONE product line — the ledger carries no line, so a
 *  panel's rows are the ones under its item code and a transformer's are
 *  every other. Memoised per line. */
export const loadAllHandoverOf = cache(
  async (line: ProductLine): Promise<LedgerRow[]> => prisma.handoverEntry.findMany({ where: ledgerItemWhere(line), select: LEDGER_SELECT }),
);

/** Every schedule line of every weekly plan, in import order. */
export const loadAllSchedules = cache(async () => prisma.planSchedule.findMany({ orderBy: { id: "asc" } }));

/** The daily log of the line on screen — progress is global within a line,
 *  so most of its screens need all of it. */
export async function loadAllHandover() {
  return loadAllHandoverOf(await getActiveLine());
}

export const loadHolidays = cache(async () => prisma.holiday.findMany());

export const loadPlans = cache(async () => prisma.plan.findMany({ orderBy: { planNo: "asc" } }));

export const loadSettingsRow = cache(async () => prisma.settings.findUnique({ where: { id: 1 } }));
