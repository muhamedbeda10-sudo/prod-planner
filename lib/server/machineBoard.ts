import "server-only";
import { prisma } from "@/lib/db";
import { itemHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import { buildMachineBoard, lineKey, type Assignment, type BoardLine, type MachineBoard } from "@/lib/domain/machineBoard";
import { getStdData } from "./standardTimes";
import { getAllMachines, type MachineDTO } from "./machines";
import { getCutSheet, getPaintingQueue, getWeldingQueue } from "./execution";
import { getWorklistExtras } from "./worklistExtras";
import { parseISODate } from "@/lib/domain/dates";

// The machine load board for one worklist: the page hands over the open
// lines it already computed (every section of the sheet), this prices them
// in standard hours for the stage, joins the planner's assignments, today's
// downtime and crew from the shift log, and lays the board out.

export type BoardDept = "Cut" | "Welding" | "Painting" | "ShotBlast";

export interface BoardLineInput {
  bom: string;
  mo: string;
  item: string;
  description: string;
  remaining: number;
  deliveryISO: string | null;
}

export interface MachineBoardData extends MachineBoard {
  dept: BoardDept;
  /** The department's machines a line can be put on (active only). */
  machines: MachineDTO[];
  /** bom|mo|item → where the line sits, for the tables' pickers. */
  assigned: Record<string, { machineId: number; rank: number }>;
}

const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function getMachineBoard(dept: BoardDept, lines: readonly BoardLineInput[], dayISO: string): Promise<MachineBoardData> {
  const date = dayOf(dayISO);
  const [all, rows, std, orders, downtime, shifts] = await Promise.all([
    getAllMachines(),
    prisma.worklistMachine.findMany({ where: { dept }, orderBy: [{ machineId: "asc" }, { rank: "asc" }] }),
    getStdData(),
    prisma.masterOrder.findMany({ select: { mo: true, bom: true, fgCode: true, kva: true } }),
    prisma.machineDowntime.findMany({ where: { date, machine: { dept } }, select: { machineId: true, hours: true } }),
    prisma.shiftEntry.findMany({ where: { date, dept, present: true, machineId: { not: null } }, select: { machineId: true, shift: true, overtimeH: true, worker: { select: { name: true } } } }),
  ]);
  const machines = all.filter((m) => m.dept === dept);

  // the class an order belongs to, by MO; by BOM when the line has no MO and
  // every order of that BOM agrees
  const tierByMo = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const tierByBom = new Map<string, number | null>();
  for (const o of orders) {
    const t = tierByMo.get(o.mo) ?? null;
    if (!tierByBom.has(o.bom)) tierByBom.set(o.bom, t);
    else if (tierByBom.get(o.bom) !== t) tierByBom.set(o.bom, null);
  }
  const stageHours = (tier: number | null, item: string): number | null => {
    if (tier === null) return null;
    const per = itemHoursFor(std, tier)[item];
    if (!per) return null; // AR / MB carry no standard times
    return dept === "Cut" ? per.cut : dept === "Welding" ? per.weld : dept === "ShotBlast" ? per.shb : per.paint;
  };

  const boardLines: BoardLine[] = lines.map((l) => {
    const tier = (l.mo ? tierByMo.get(l.mo) : tierByBom.get(l.bom)) ?? null;
    const perPc = stageHours(tier, l.item);
    return {
      key: lineKey(l.bom, l.mo, l.item),
      bom: l.bom, mo: l.mo, item: l.item, description: l.description,
      remaining: l.remaining,
      hours: perPc === null ? null : Math.round(perPc * l.remaining * 10) / 10,
      deliveryISO: l.deliveryISO,
    };
  });

  const assignments: Assignment[] = rows.map((r) => ({ key: lineKey(r.bom, r.mo, r.item), machineId: r.machineId, rank: r.rank }));
  const downtimeH: Record<number, number> = {};
  for (const d of downtime) downtimeH[d.machineId] = (downtimeH[d.machineId] ?? 0) + d.hours;
  const crewH: Record<number, number> = {};
  const crew: Record<number, string[]> = {};
  for (const s of shifts) {
    if (s.machineId === null) continue;
    crewH[s.machineId] = (crewH[s.machineId] ?? 0) + (s.shift === "S11" ? 11 : 9) + Math.max(0, s.overtimeH);
    (crew[s.machineId] ??= []).push(s.worker.name);
  }

  const board = buildMachineBoard(machines, boardLines, assignments, { downtimeH, crewH, crew });
  const assigned: Record<string, { machineId: number; rank: number }> = {};
  for (const c of board.cards) for (const q of c.queue) assigned[q.key] = { machineId: c.machine.id, rank: q.rank };
  return { ...board, dept, machines: machines.filter((m) => m.active), assigned };
}

/** The open lines of a department's worklist, as the board wants them — the
 *  same rows the worklist page shows, gathered for a page that has not
 *  loaded them itself (the Floor canvas). Shot blast has no worklist. */
export async function getDeptBoardLines(dept: BoardDept, dayISO: string): Promise<BoardLineInput[]> {
  const day = parseISODate(dayISO) ?? new Date();
  if (dept === "Cut") {
    const sheet = await getCutSheet();
    return [
      ...[...sheet.dueNow, ...sheet.overdue, ...sheet.postponed].map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.remaining, deliveryISO: r.deliveryISO })),
      ...[...sheet.pushed, ...sheet.remarked, ...sheet.unscheduled].map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.available, deliveryISO: r.deliveryISO })),
    ];
  }
  if (dept === "ShotBlast") return [];
  const [queue, extras] = await Promise.all([dept === "Welding" ? getWeldingQueue(day) : getPaintingQueue(day), getWorklistExtras(dept)]);
  return [
    ...queue.map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.available, deliveryISO: r.deliveryISO })),
    ...extras.pushed.map((p) => ({ bom: p.bom, mo: p.mo, item: p.item, description: p.description, remaining: p.qty, deliveryISO: null })),
  ];
}
