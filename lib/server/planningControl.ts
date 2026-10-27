import "server-only";
import { prisma } from "@/lib/db";
import { isPaintExempt } from "@/lib/domain/constants";
import { toISODate, parseISODate } from "@/lib/domain/dates";
import { downtimeHoursInRange, downtimeWindowWhere } from "@/lib/domain/downtimePeriods";
import { itemHoursFor, tierForOrder, type ItemStageHours } from "@/lib/domain/stdEngine";
import { CONTROL_STAGES, arrivedPcs, type ControlStage, type IoWeekIn, type PlantWeek } from "@/lib/domain/planningControl";
import type { WhatIfInputs } from "@/lib/domain/whatif";
import { getStdData } from "./standardTimes";
import { getMasterTracker } from "./masterTracker";
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
      const stage = m.dept === "Cut" ? "cut" : m.dept === "Welding" ? "weld" : m.dept === "Painting" || m.dept === "ShotBlast" ? "finish" : null;
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

/** The std hours waiting in front of each station now: at Fabrication every
 *  piece not cut yet, at the others the pieces the station before has passed on. */
export function queueNow(inputs: Pick<WhatIfInputs, "jobs">): Record<ControlStage, number> {
  const q: Record<ControlStage, number> = { cut: 0, weld: 0, finish: 0 };
  for (const j of inputs.jobs) for (const s of CONTROL_STAGES) q[s] += arrivedPcs(j, s) * (j.perPc[s] || 0);
  return q;
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
    if (!p) return null;
    // priced as the forecast prices a job (lib/server/eta.ts): finishing = shot blast + paint
    return { cut: p.cut, weld: p.weld, finish: p.shb + p.paint };
  };
}

/** Each past week's flow through every station, in std hours: what reached it
 *  (the station before's output, priced at this station; Fabrication's input
 *  is not recorded), what it earned, and what the weekly plans dated that week
 *  asked of it. A plan dates the oven; the stations before are planned in the
 *  same week — the plant keeps no offset between them. */
export async function getStationFlows(weeks: readonly PlantWeek[]): Promise<{ flows: Record<ControlStage, IoWeekIn[]>; unpricedPcs: number }> {
  return withLine("TR", async () => {
    const flows = { cut: [], weld: [], finish: [] } as Record<ControlStage, IoWeekIn[]>;
    if (weeks.length === 0) return { flows, unpricedPcs: 0 };
    const from = parseISODate(weeks[0].fromISO)!;
    const to = new Date(parseISODate(weeks[weeks.length - 1].toISO)!.getTime() + 86400000);
    const [price, entries, schedules] = await Promise.all([
      pricer(),
      prisma.handoverEntry.findMany({ where: { date: { gte: from, lt: to }, ...ledgerItemWhere("TR") }, select: { mo: true, bom: true, dept: true, item: true, qty: true, date: true } }),
      prisma.planSchedule.findMany({ where: { ovenDate: { gte: from, lt: to } }, select: { planNo: true, mo: true, bom: true, item: true, ovenDate: true, qty: true } }),
    ]);
    const weekOf = (iso: string) => weeks.findIndex((w) => iso >= w.fromISO && iso <= w.toISO);
    for (const stage of CONTROL_STAGES) flows[stage] = weeks.map((w) => ({ ...w, plannedInput: stage === "cut" ? null : 0, actualInput: stage === "cut" ? null : 0, plannedOutput: 0, actualOutput: 0 }));
    let unpricedPcs = 0;
    for (const e of entries) {
      const i = weekOf(toISODate(e.date));
      if (i < 0) continue;
      const p = price(e.mo, e.bom, e.item);
      if (!p) { unpricedPcs += e.qty; continue; }
      // what one station passes on is the next one's input
      if (e.dept === "Cut") flows.weld[i].actualInput! += e.qty * p.weld;
      if (e.dept === "Welding") flows.finish[i].actualInput! += e.qty * p.finish;
      // each station's own output, booked as the forecast books it: a painted
      // piece passed shot blast too; a shot-blast entry is the core frame's finish
      if (e.dept === "Cut") flows.cut[i].actualOutput += e.qty * p.cut;
      else if (e.dept === "Welding") flows.weld[i].actualOutput += e.qty * p.weld;
      else if (e.dept === "Painting" || (e.dept === "ShotBlast" && isPaintExempt(e.item))) flows.finish[i].actualOutput += e.qty * p.finish;
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
    const planned = [...newest.keys()];
    for (const stage of CONTROL_STAGES) for (const r of flows[stage]) if (!planned.some((iso) => iso >= r.fromISO && iso <= r.toISO)) { r.plannedOutput = null; r.plannedInput = null; }
    return { flows, unpricedPcs };
  });
}

const STOP_STAGE: Record<string, ControlStage> = { Cut: "cut", Welding: "weld", ShotBlast: "finish", Painting: "finish" };

/** The machine-hours each station lost to stops in a window (factory days), planned maintenance apart. */
export async function getStationStops(fromISO: string, toISO: string, now = new Date()): Promise<{ stage: ControlStage | null; dept: string; reasonCode: string | null; reason: string | null; hours: number; machine: string }[]> {
  const rows = await prisma.machineDowntime.findMany({
    where: downtimeWindowWhere(fromISO, toISO),
    select: { date: true, hours: true, startTime: true, endTime: true, endsNextDay: true, isOpen: true, endDate: true, reasonCode: true, reason: true, customDept: true, customName: true, machine: { select: { dept: true, code: true } } },
  });
  return rows.map((r) => {
    const dept = r.machine?.dept ?? r.customDept ?? "";
    return { stage: STOP_STAGE[dept] ?? null, dept, reasonCode: r.reasonCode, reason: r.reason, hours: downtimeHoursInRange(r, fromISO, toISO, now), machine: r.machine?.code ?? r.customName ?? "Unlisted" };
  }).filter((r) => r.hours > 0);
}

/** What the release checklist reads about one order. */
export async function getReleaseFacts(mo: string) {
  return withLine("TR", async () => {
    // typed as the person typed it — the registry's own spelling is used from here
    const [order, tracker] = await Promise.all([prisma.masterOrder.findFirst({ where: { mo: { equals: mo, mode: "insensitive" }, line: "TR" } }), getMasterTracker()]);
    if (!order) return null;
    const row = tracker.find((r) => r.mo === order.mo) ?? null;
    const nesting = await prisma.materialUsage.findMany({
      where: { line: "TR", bom: order.bom, OR: [{ mo: order.mo }, { mo: "" }] },
      select: { actualPerUnit: true, sheetsUsed: true },
    });
    const cut = row ? Object.values(row.items).reduce((a, c) => a + (c.eligible && !c.excluded ? c.cut : 0), 0) : 0;
    return { order, row, nesting: { lines: nesting.length, nested: nesting.filter((n) => n.actualPerUnit !== null || n.sheetsUsed !== null).length }, alreadyStarted: cut > 0 };
  });
}
