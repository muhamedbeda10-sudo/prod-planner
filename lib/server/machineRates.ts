import "server-only";
import { prisma } from "@/lib/db";
import { measureRates, ratesByMachine, type MeasuredRate, type RateHours, type RateOutput } from "@/lib/domain/machineRates";
import { stdHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import { getStdData } from "./standardTimes";
import { getShiftHours } from "./data";
import { hoursOfShift, isShiftCode } from "@/lib/domain/shifts";
import { factoryToday, toISODate } from "@/lib/domain/dates";
import { loadMasterOrdersOf } from "./loads";

// What each item really takes on each machine, measured from the floor: the
// pieces a machine finished (recorded with ✓ on its card, which is the only
// thing that carries the machine) against the man-hours the shift log put on
// it. Output recorded anywhere else has no machine and cannot count — the page
// says how much of the output that is, so the figure is read for what it is.

/** How far back a rate looks. Long enough to gather several days of a machine
 *  running one item, short enough to be this plant as it works now. */
const WINDOW_DAYS = 90;

export interface MachineRatesReport {
  rates: MeasuredRate[];
  byMachine: Record<number, Record<string, MeasuredRate>>;
  fromISO: string;
  /** Pieces recorded in the window that carry a machine, and in total. */
  attributedPcs: number;
  totalPcs: number;
}

export async function getMeasuredRates(dept?: string): Promise<MachineRatesReport> {
  const from = factoryToday();
  from.setUTCDate(from.getUTCDate() - WINDOW_DAYS);

  const [entries, shifts, std, orders, shiftHours] = await Promise.all([
    prisma.handoverEntry.findMany({
      where: { date: { gte: from }, ...(dept ? { dept } : {}) },
      select: { date: true, dept: true, mo: true, bom: true, item: true, qty: true, machineId: true },
    }),
    prisma.shiftEntry.findMany({
      where: { date: { gte: from }, present: true, machineId: { not: null }, ...(dept ? { dept } : {}) },
      select: { date: true, machineId: true, shift: true, overtimeH: true },
    }),
    getStdData(),
    // the machines are one physical floor, and the records above carry no
    // line: priced against the transformer registry whatever line is on
    // screen, else the panels' screens would leave every machine row unpriced
    loadMasterOrdersOf("TR"),
    getShiftHours(),
  ]);

  // the class an order belongs to, so a piece's standard hours are known
  const tierByMo = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const tierByBom = new Map<string, number | null>();
  for (const o of orders) {
    const t = tierByMo.get(o.mo) ?? null;
    if (!tierByBom.has(o.bom)) tierByBom.set(o.bom, t);
    else if (tierByBom.get(o.bom) !== t) tierByBom.set(o.bom, null);
  }

  let attributedPcs = 0;
  let totalPcs = 0;
  const output: RateOutput[] = [];
  for (const e of entries) {
    if (!(e.qty > 0)) continue; // a correction is not production
    totalPcs += e.qty;
    if (e.machineId === null) continue;
    attributedPcs += e.qty;
    // an order's class by its number, else by its project's — a record whose
    // order is not on the master list yet is still priced (as the cockpit does)
    const tier = (e.mo ? tierByMo.get(e.mo) : undefined) ?? tierByBom.get(e.bom) ?? null;
    output.push({
      dateISO: toISODate(e.date),
      machineId: e.machineId,
      item: e.item,
      qty: e.qty,
      stdHours: stdHoursFor(std, e.dept, e.item, tier) * e.qty,
    });
  }

  const hours: RateHours[] = shifts.map((s) => ({
    dateISO: toISODate(s.date),
    machineId: s.machineId!,
    hours: hoursOfShift(isShiftCode(s.shift) ? s.shift : "S9", shiftHours) + Math.max(0, s.overtimeH),
  }));

  const rates = measureRates(output, hours);
  return {
    rates,
    byMachine: ratesByMachine(rates),
    fromISO: toISODate(from),
    attributedPcs: Math.round(attributedPcs * 100) / 100,
    totalPcs: Math.round(totalPcs * 100) / 100,
  };
}
