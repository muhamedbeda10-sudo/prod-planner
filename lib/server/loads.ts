import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";

// The tables every screen reads, loaded ONCE per request. A worklist page
// used to fetch the orders registry five times and the whole daily log
// twice (the sheet, the machine board, the SOI lookup, the priority table,
// the run order each asked for their own copy); with React's request cache
// the first caller pays for the query and the rest share the rows. The
// tables are small (a few thousand rows), so filtering in memory beats
// another round trip every time. Callers must treat the arrays as
// read-only — they are shared for the rest of the request.

/** Every order in the registry, urgent first then by MO. */
export const loadMasterOrders = cache(async () => prisma.masterOrder.findMany({ orderBy: [{ urgent: "desc" }, { mo: "asc" }] }));

/** Every schedule line of every weekly plan, in import order. */
export const loadAllSchedules = cache(async () => prisma.planSchedule.findMany({ orderBy: { id: "asc" } }));

/** The whole daily log — progress is global, so most screens need all of it. */
export const loadAllHandover = cache(async () => prisma.handoverEntry.findMany());

export const loadHolidays = cache(async () => prisma.holiday.findMany());

export const loadPlans = cache(async () => prisma.plan.findMany({ orderBy: { planNo: "asc" } }));

export const loadSettingsRow = cache(async () => prisma.settings.findUnique({ where: { id: 1 } }));
