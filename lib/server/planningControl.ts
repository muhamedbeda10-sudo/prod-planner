import "server-only";
import { prisma } from "@/lib/db";
import { isPaintExempt } from "@/lib/domain/constants";
import { toISODate, parseISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { downtimeHoursInRange, downtimeWindowWhere } from "@/lib/domain/downtimePeriods";
import { itemHoursFor, tierForOrder, type ItemStageHours } from "@/lib/domain/stdEngine";
import { CONTROL_STAGES, DEPT_STAGE, stagePerPc, type ControlStage, type IoWeekIn, type PlantWeek } from "@/lib/domain/planningControl";
import type { WhatIfInputs } from "@/lib/domain/whatif";
import { getStdData } from "./standardTimes";
import { ledgerItemWhere, withLine } from "./line";
import { loadMasterOrders } from "./loads";
import { getWhatIfInputs } from "./whatif";

// The facts the planning-control tools compute from (lib/domain/planningControl.ts):
// the what-if model's jobs and rates, the orders' flags, what is on a machine
// now, the stations' flow week by week, the machine stops and an order's
// release facts. Transformers only — the standard times and the flow model
// are the transformers'.

export interface ControlInputs {
  inputs: WhatIfInputs;
  priorityMos: Set<string>;
  urgentMos: Set<string>;
  /** Jobs ("MO|ITEM") a machine is working right now, per station — the
   *  machine boards record it for Fabrication and Painting only. */
  running: Record<ControlStage, Set<string>>;
}

export async function getControlInputs(): Promise<ControlInputs> {
  return withLine("TR", async () => {
    const [inputs, orders, onMachines] = await Promise.all([
      getWhatIfInputs(),
      loadMasterOrders(),
      prisma.worklistMachine.findMany({ where: { running: true }, select: { dept: true, mo: true, item: true } }),
    ]);
    const running: Record<ControlStage, Set<string>> = { cut: new Set(), weld: new Set(), finish: new Set() };
    for (const m of onMachines) {
      const stage = DEPT_STAGE[m.dept];
      if (stage) running[stage].add(`${m.mo}|${m.item}`);
    }
    return {
      inputs,
      priorityMos: new Set(orders.filter((o) => o.priority).map((o) => o.mo)),
      urgentMos: new Set(orders.filter((o) => o.urgent).map((o) => o.mo)),
      running,
    };
  });
}

/** One piece's std hours at each station, by its order's class; null when unpriced. */
type Pricer = (mo: string | null, bom: string, item: string) => Record<ControlStage, number> | null;

async function pricer(): Promise<Pricer> {
  const [orders, std] = await Promise.all([loadMasterOrders(), getStdData()]);
  const moTier = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const bomTier = new Map<string, number | null>();
  for (const o of orders) {
    const t = moTier.get(o.mo) ?? null;
    if (!bomTier.has(o.bom)) bomTier.set(o.bom, t);
    else if (bomTier.get(o.bom) !== t) bomTier.set(o.bom, null);
  }
  const perTier = new Map<number, Record<string, ItemStageHours>>();
  return (mo, bom, item) => {
    const tier = (mo ? moTier.get(mo) : bomTier.get(bom)) ?? null;
    if (tier === null) return null;
    if (!perTier.has(tier)) perTier.set(tier, itemHoursFor(std, tier));
    const p = perTier.get(tier)![item];
    return p ? stagePerPc(p) : null;
  };
}

/** Each past week's flow through every station, in std hours: what reached it
 *  (the station before's output, priced at this station; Fabrication's input
 *  is not recorded), what it earned, and what the weekly plans dated that week
 *  asked of it. A plan dates the oven; the stations before are planned in the
 *  same week — the plant keeps no offset between them. */
export async function getStationFlows(weeks: readonly PlantWeek[]): Promise<{ flows: Record<ControlStage, IoWeekIn[]>; unpricedPcs: number }> {
  return withLine("TR", async () => {
    const blank = (stage: ControlStage): IoWeekIn[] => weeks.map((w) => ({ ...w, plannedInput: stage === "cut" ? null : 0, actualInput: stage === "cut" ? null : 0, plannedOutput: 0, actualOutput: 0 }));
    const flows: Record<ControlStage, IoWeekIn[]> = { cut: blank("cut"), weld: blank("weld"), finish: blank("finish") };
    if (weeks.length === 0) return { flows, unpricedPcs: 0 };
    const from = parseISODate(weeks[0].fromISO)!;
    const to = parseISODate(addDaysISO(weeks[weeks.length - 1].toISO, 1))!;
    const [price, entries, schedules] = await Promise.all([
      pricer(),
      prisma.handoverEntry.findMany({ where: { date: { gte: from, lt: to }, ...ledgerItemWhere("TR") }, select: { mo: true, bom: true, dept: true, item: true, qty: true, date: true } }),
      prisma.planSchedule.findMany({ where: { ovenDate: { gte: from, lt: to } }, select: { planNo: true, mo: true, bom: true, item: true, ovenDate: true, qty: true } }),
    ]);
    const weekOf = (iso: string) => weeks.findIndex((w) => iso >= w.fromISO && iso <= w.toISO);
    let unpricedPcs = 0;
    for (const e of entries) {
      const i = weekOf(toISODate(e.date));
      if (i < 0) continue;
      const p = price(e.mo, e.bom, e.item);
      if (!p) { unpricedPcs += e.qty; continue; }
      // a station's output, booked as the forecast books it, is the next one's
      // input: a painted piece passed shot blast too; a shot-blast entry is the
      // core frame's finish
      if (e.dept === "Cut") {
        flows.cut[i].actualOutput += e.qty * p.cut;
        flows.weld[i].actualInput! += e.qty * p.weld;
      } else if (e.dept === "Welding") {
        flows.weld[i].actualOutput += e.qty * p.weld;
        flows.finish[i].actualInput! += e.qty * p.finish;
      } else if (e.dept === "Painting" || (e.dept === "ShotBlast" && isPaintExempt(e.item))) flows.finish[i].actualOutput += e.qty * p.finish;
    }
    // the newest plan that dates a day speaks for that day
    const newest = new Map<string, number>();
    for (const s of schedules) {
      const iso = toISODate(s.ovenDate);
      newest.set(iso, Math.max(newest.get(iso) ?? 0, s.planNo));
    }
    for (const s of schedules) {
      const iso = toISODate(s.ovenDate);
      if (s.planNo !== newest.get(iso)) continue;
      const i = weekOf(iso);
      const p = price(s.mo, s.bom, s.item);
      if (i < 0 || !p) continue;
      for (const stage of CONTROL_STAGES) {
        flows[stage][i].plannedOutput! += s.qty * p[stage];
        if (stage !== "cut") flows[stage][i].plannedInput! += s.qty * p[stage];
      }
    }
    // a week no plan dates has no plan to read against
    const plannedWeeks = new Set([...newest.keys()].map(weekOf));
    for (const stage of CONTROL_STAGES) flows[stage].forEach((r, i) => { if (!plannedWeeks.has(i)) { r.plannedOutput = null; r.plannedInput = null; } });
    return { flows, unpricedPcs };
  });
}

/** The machine-hours each station lost to stops in a window (factory days), planned maintenance apart. */
export async function getStationStops(fromISO: string, toISO: string, now = new Date()): Promise<{ stage: ControlStage | null; dept: string; reasonCode: string | null; reason: string | null; hours: number; machine: string }[]> {
  const rows = await prisma.machineDowntime.findMany({
    where: downtimeWindowWhere(fromISO, toISO),
    select: { date: true, hours: true, startTime: true, endTime: true, endsNextDay: true, isOpen: true, endDate: true, reasonCode: true, reason: true, customDept: true, customName: true, machine: { select: { dept: true, code: true } } },
  });
  return rows.map((r) => {
    const dept = r.machine?.dept ?? r.customDept ?? "";
    return { stage: DEPT_STAGE[dept] ?? null, dept, reasonCode: r.reasonCode, reason: r.reason, hours: downtimeHoursInRange(r, fromISO, toISO, now), machine: r.machine?.code ?? r.customName ?? "Unlisted" };
  }).filter((r) => r.hours > 0);
}

/** What the release checklist reads about one order: the order itself (found
 *  whatever the case it was typed in), its nesting lines, its newest weekly-plan
 *  date and whether Fabrication has started it. */
export async function getReleaseFacts(mo: string) {
  return withLine("TR", async () => {
    const order = await prisma.masterOrder.findFirst({ where: { mo: { equals: mo, mode: "insensitive" }, line: "TR" } });
    if (!order) return null;
    const [nesting, cut, planned] = await Promise.all([
      prisma.materialUsage.findMany({ where: { line: "TR", bom: order.bom, OR: [{ mo: order.mo }, { mo: "" }] }, select: { actualPerUnit: true, sheetsUsed: true } }),
      prisma.handoverEntry.aggregate({ where: { mo: order.mo, dept: "Cut", ...ledgerItemWhere("TR") }, _sum: { qty: true } }),
      prisma.planSchedule.aggregate({ where: { mo: order.mo }, _max: { ovenDate: true } }),
    ]);
    return {
      order,
      nesting: { lines: nesting.length, nested: nesting.filter((n) => n.actualPerUnit !== null || n.sheetsUsed !== null).length },
      plannedDueISO: planned._max.ovenDate ? toISODate(planned._max.ovenDate) : null,
      alreadyStarted: (cut._sum.qty ?? 0) > 0,
    };
  });
}
