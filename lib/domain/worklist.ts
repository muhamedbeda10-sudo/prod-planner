// Daily worklists — pure port of modCut.ShowCutDay and modWeld.ShowWeldingDay.
//
// Both merge by BomGroup. Scheduled rows come first (something DUE on/ before the
// day), then FILL-UP rows top up each item to the daily capacity. Overdue rolls
// forward because "due" subtracts only what was done BEFORE today, not the plan
// for today alone.

import { ITEMS, type Item } from "./constants";
import type { BomGrouper } from "./bom";
import { dayNumber } from "./dates";

export interface ScheduleRow {
  bom: string;
  item: string;
  ovenDate: Date;
  qty: number;
  kva?: string | null;
}
export interface OrderRowLite {
  bom: string;
  item: string;
  targetQty: number;
  kva?: string | null;
}
export interface HandoverRowLite {
  dept: string;
  bom: string;
  item: string;
  qty: number;
  date: Date;
}

export type CutStatus = "Done" | "In progress" | "Pending";
export type WorklistType =
  | "Scheduled"
  | "Fill-up (unscheduled)"
  | "Fill-up (cut done)";

export interface CutRow {
  bom: string;
  kva: string;
  item: Item;
  type: WorklistType;
  totalRequired: number;
  cutDue: number;
  doneToday: number;
  stillDue: number;
  todayTarget: number;
  status: CutStatus;
}

export interface WeldRow {
  bom: string;
  kva: string;
  item: Item;
  type: WorklistType;
  totalRequired: number;
  weldingDue: number;
  weldedToday: number;
  stillDue: number;
  cutReady: number;
  todayTarget: number;
  cutAlarm: string;
  status: CutStatus;
}

const num = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
const add = (m: Map<string, number>, k: string, q: number) => m.set(k, (m.get(k) ?? 0) + q);
const first = (m: Map<string, string>, k: string, v: string) => {
  if (!m.has(k)) m.set(k, v);
};

interface WorklistInput {
  schedule: ScheduleRow[];
  orders: OrderRowLite[];
  handover: HandoverRowLite[];
  grouper: BomGrouper;
  day: Date;
  lead: number;
  capacity: number;
}

/** Shared aggregation of schedule + orders + handover, keyed by BomGroup. */
function aggregate(inp: WorklistInput) {
  const { schedule, orders, handover, grouper, day, lead } = inp;
  const dt = dayNumber(day);

  const aKva = new Map<string, string>(); // key -> kva
  const aTot = new Map<string, number>(); // key -> total scheduled
  const aDue = new Map<string, number>(); // key -> scheduled due cum (oven <= dt+lead)
  const kvaOf = new Map<string, string>(); // bomGroup -> kva (schedule)
  const keyOrder: string[] = []; // schedule key insertion order

  for (const s of schedule) {
    const bg = grouper(s.bom);
    const key = `${bg}|${s.item}`;
    if (!aKva.has(key)) {
      aKva.set(key, String(s.kva ?? ""));
      keyOrder.push(key);
    }
    add(aTot, key, s.qty || 0);
    if (dayNumber(s.ovenDate) <= dt + lead) add(aDue, key, s.qty || 0);
    kvaOf.set(bg, String(s.kva ?? ""));
  }

  const tgt = new Map<string, number>(); // bomGroup|item -> target
  const kva2 = new Map<string, string>(); // bomGroup -> kva (orders)
  const bomOrder: string[] = [];
  const bomSeen = new Set<string>();
  for (const o of orders) {
    const bg = grouper(o.bom);
    add(tgt, `${bg}|${o.item}`, o.targetQty || 0);
    if (!bomSeen.has(bg)) {
      bomSeen.add(bg);
      bomOrder.push(bg);
    }
    first(kva2, bg, String(o.kva ?? ""));
  }

  return { dt, aKva, aTot, aDue, kvaOf, keyOrder, tgt, kva2, bomOrder };
}

function sortRows<T extends { bom: string; item: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.bom < b.bom ? -1 : a.bom > b.bom ? 1 : a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

export function computeCutWorklist(inp: WorklistInput): CutRow[] {
  const { handover, grouper, capacity } = inp;
  const g = aggregate(inp);
  const dt = g.dt;

  // handover Cut: prev / today / cum, keyed by BomGroup|item
  const cutPrev = new Map<string, number>();
  const cutT = new Map<string, number>();
  const cutCum = new Map<string, number>();
  for (const h of handover) {
    if (h.dept !== "Cut") continue;
    const key = `${grouper(h.bom)}|${h.item}`;
    const d = dayNumber(h.date);
    if (d < dt) add(cutPrev, key, h.qty || 0);
    if (d === dt) add(cutT, key, h.qty || 0);
    if (d <= dt) add(cutCum, key, h.qty || 0);
  }

  // scheduled rows
  let rows: CutRow[] = [];
  for (const key of g.keyOrder) {
    const gDC = num(g.aDue, key);
    if (gDC <= 0) continue;
    let dueC = gDC - num(cutPrev, key);
    if (dueC < 0) dueC = 0;
    let stillC = dueC - num(cutT, key);
    if (stillC < 0) stillC = 0;
    const [bom, item] = key.split("|") as [string, Item];
    const today = num(cutT, key);
    rows.push({
      bom,
      kva: g.aKva.get(key) ?? "",
      item,
      type: "Scheduled",
      totalRequired: num(g.tgt, key),
      cutDue: dueC,
      doneToday: today,
      stillDue: stillC,
      todayTarget: 0,
      status: stillC === 0 ? "Done" : today > 0 ? "In progress" : "Pending",
    });
  }
  rows = sortRows(rows);

  // capacity allocation for Today Target
  const capUsed = new Map<string, number>();
  for (const [key, q] of cutT) capUsed.set(key.split("|")[1], (capUsed.get(key.split("|")[1]) ?? 0) + q);
  for (const r of rows) {
    let room = capacity - num(capUsed, r.item);
    if (room < 0) room = 0;
    const alloc = Math.min(r.stillDue, room);
    r.todayTarget = alloc;
    add(capUsed, r.item, alloc);
  }

  // fill-up from unscheduled backlog
  for (const item of ITEMS) {
    let need = capacity - num(capUsed, item);
    for (const bg of g.bomOrder) {
      if (need <= 0) break;
      const keyF = `${bg}|${item}`;
      let base = num(g.aTot, keyF);
      if (num(cutCum, keyF) > base) base = num(cutCum, keyF);
      const pool = num(g.tgt, keyF) - base;
      if (pool > 0) {
        const take = Math.min(pool, need);
        rows.push({
          bom: bg,
          kva: g.kva2.get(bg) ?? g.kvaOf.get(bg) ?? "",
          item,
          type: "Fill-up (unscheduled)",
          totalRequired: num(g.tgt, keyF),
          cutDue: take,
          doneToday: 0,
          stillDue: take,
          todayTarget: take,
          status: "Pending",
        });
        need -= take;
        add(capUsed, item, take);
      }
    }
  }
  return rows;
}

export function computeWeldWorklist(inp: WorklistInput): WeldRow[] {
  const { handover, grouper, capacity } = inp;
  const g = aggregate(inp);
  const dt = g.dt;

  const cutReady = new Map<string, number>(); // cut done up to yesterday
  const weldPrev = new Map<string, number>();
  const weldT = new Map<string, number>();
  for (const h of handover) {
    const key = `${grouper(h.bom)}|${h.item}`;
    const d = dayNumber(h.date);
    if (h.dept === "Cut") {
      if (d <= dt - 1) add(cutReady, key, h.qty || 0);
    } else if (h.dept === "Welding") {
      if (d < dt) add(weldPrev, key, h.qty || 0);
      if (d === dt) add(weldT, key, h.qty || 0);
    }
  }

  let rows: WeldRow[] = [];
  const schedStill = new Map<string, number>();
  for (const key of g.keyOrder) {
    const gDW = num(g.aDue, key);
    if (gDW <= 0) continue;
    let dueW = gDW - num(weldPrev, key);
    if (dueW < 0) dueW = 0;
    let stillW = dueW - num(weldT, key);
    if (stillW < 0) stillW = 0;
    let ready = num(cutReady, key) - num(weldPrev, key) - num(weldT, key);
    if (ready < 0) ready = 0;
    schedStill.set(key, stillW);
    const [bom, item] = key.split("|") as [string, Item];
    const today = num(weldT, key);
    let alarm: string;
    if (stillW === 0) alarm = "-";
    else if (ready >= stillW) alarm = "Cut ready";
    else if (ready > 0) alarm = `Partial - ${stillW - ready} not cut`;
    else alarm = "NOT CUT YET";
    rows.push({
      bom,
      kva: g.aKva.get(key) ?? "",
      item,
      type: "Scheduled",
      totalRequired: num(g.tgt, key),
      weldingDue: dueW,
      weldedToday: today,
      stillDue: stillW,
      cutReady: ready,
      todayTarget: 0,
      cutAlarm: alarm,
      status: stillW === 0 ? "Done" : today > 0 ? "In progress" : "Pending",
    });
  }
  rows = sortRows(rows);

  const capUsed = new Map<string, number>();
  for (const [key, q] of weldT) capUsed.set(key.split("|")[1], (capUsed.get(key.split("|")[1]) ?? 0) + q);
  for (const r of rows) {
    let room = capacity - num(capUsed, r.item);
    if (room < 0) room = 0;
    let alloc = r.stillDue;
    if (r.cutReady < alloc) alloc = r.cutReady;
    if (alloc > room) alloc = room;
    r.todayTarget = alloc;
    add(capUsed, r.item, alloc);
  }

  // fill-up: extra pieces Cut finished beyond the schedule
  for (const [key, ready] of cutReady) {
    const extra = ready - num(weldPrev, key) - num(weldT, key) - num(schedStill, key);
    if (extra <= 0) continue;
    const [bg, item] = key.split("|") as [string, Item];
    let room = capacity - num(capUsed, item);
    if (room < 0) room = 0;
    const take = Math.min(extra, room);
    if (take <= 0) continue;
    rows.push({
      bom: bg,
      kva: g.kva2.get(bg) ?? g.kvaOf.get(bg) ?? "",
      item,
      type: "Fill-up (cut done)",
      totalRequired: num(g.tgt, key),
      weldingDue: take,
      weldedToday: 0,
      stillDue: take,
      cutReady: extra,
      todayTarget: take,
      cutAlarm: "Cut ready",
      status: "Pending",
    });
    add(capUsed, item, take);
  }
  return rows;
}
