import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { loadAllSchedules, loadHolidays, loadMasterOrders } from "./loads";
import { toISODate } from "@/lib/domain/dates";
import { isPaintExempt, type Item, ITEMS } from "@/lib/domain/constants";
import { tierForOrder, itemHoursFor } from "@/lib/domain/stdEngine";
import { forecastEta, ETA_STAGES, type EtaOrder, type EtaStage, type EtaResult } from "@/lib/domain/eta";
import { getStdData } from "./standardTimes";
import { getMasterTracker } from "./masterTracker";

// how much history feeds the run-rate: enough to smooth a slow day, short
// enough to track the CURRENT crew — and it must be past days only, or the
// half-finished today would drag every rate down
const RATE_WINDOW_WD = 14;

const DAY = 86400000;
const isWorkday = (d: Date, off: Set<string>) => d.getUTCDay() !== 5 && !off.has(toISODate(d));

/** The plant's ACTUAL std-hours per working day per ETA stage, over the last
 *  RATE_WINDOW_WD working days (ending yesterday). */
export const getStageRates = cache(async (): Promise<{ rates: Record<EtaStage, number>; sigma: Record<EtaStage, number>; windowDays: number }> => {
  const holidays = new Set((await loadHolidays()).map((h) => toISODate(h.date)));
  // walk back from yesterday until the window holds RATE_WINDOW_WD working days
  const end = new Date(Math.floor(Date.now() / DAY) * DAY - DAY);
  let start = new Date(end);
  let wd = isWorkday(end, holidays) ? 1 : 0;
  while (wd < RATE_WINDOW_WD) {
    start = new Date(start.getTime() - DAY);
    if (isWorkday(start, holidays)) wd++;
  }

  const [entries, orders, std] = await Promise.all([
    prisma.handoverEntry.findMany({
      where: { date: { gte: start, lt: new Date(end.getTime() + DAY) } },
      select: { mo: true, bom: true, dept: true, item: true, qty: true, date: true },
    }),
    loadMasterOrders(),
    getStdData(),
  ]);
  const moTier = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const bomTier = new Map<string, number | null>();
  for (const o of orders) {
    const t = moTier.get(o.mo) ?? null;
    if (!bomTier.has(o.bom)) bomTier.set(o.bom, t);
    else if (bomTier.get(o.bom) !== t) bomTier.set(o.bom, null);
  }

  // per-DAY earned hours per stage — the day-to-day scatter is what the
  // ETA confidence band is made of
  const daily = new Map<string, Record<EtaStage, number>>();
  for (const e of entries) {
    const tier = (e.mo ? moTier.get(e.mo) : bomTier.get(e.bom)) ?? null;
    if (tier === null) continue;
    const per = itemHoursFor(std, tier)[e.item];
    if (!per) continue;
    const iso = toISODate(e.date);
    if (!daily.has(iso)) daily.set(iso, { cut: 0, weld: 0, finish: 0 });
    const day = daily.get(iso)!;
    if (e.dept === "Cut") day.cut += per.cut * e.qty;
    else if (e.dept === "Welding") day.weld += per.weld * e.qty;
    // painted = shot blasted first; both work centres flow through "finish"
    else if (e.dept === "Painting") day.finish += (per.shb + per.paint) * e.qty;
    else if (e.dept === "ShotBlast") day.finish += per.shb * e.qty;
  }

  const rates: Record<EtaStage, number> = { cut: 0, weld: 0, finish: 0 };
  const sigma: Record<EtaStage, number> = { cut: 0, weld: 0, finish: 0 };
  for (const s of ETA_STAGES) {
    // every working day in the window counts — a day with no output is a
    // real zero, not a missing sample
    const values = [...daily.values()].map((d) => d[s]);
    while (values.length < wd) values.push(0);
    const mean = values.reduce((a, b) => a + b, 0) / wd;
    rates[s] = mean;
    sigma[s] = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / wd);
  }
  return { rates, sigma, windowDays: wd };
});

/** One order-component as the forecast schedules it: its own remaining
 *  pieces per station. Pieces flow — the TC of an order can be welding while
 *  its TN is still being cut. */
export interface EtaJob extends EtaOrder {
  mo: string;
  bom: string;
  item: string;
  left: { cut: number; weld: number; finish: number }; // PIECES per stage
  perPc: Record<EtaStage, number>; // std-hours one piece costs each station
}

/** Everything the baseline forecast is made of — shared by the live ETA
 *  column and the what-if simulator (which re-runs scenarios over it). */
export interface EtaBase {
  jobs: EtaJob[]; // open (MO × item) jobs, FIFO by due date
  results: EtaResult[]; // baseline forecast, same order as `jobs`
  rates: Record<EtaStage, number>;
  sigma: Record<EtaStage, number>; // day-to-day scatter of the same rates
  windowDays: number;
  holidayISOs: string[];
  todayISO: string;
}

export const getEtaBase = cache(async (): Promise<EtaBase> => {
  const [tracker, std, { rates, sigma, windowDays }, schedules, holidayRows, masters] = await Promise.all([
    getMasterTracker(),
    getStdData(),
    getStageRates(),
    loadAllSchedules(),
    loadHolidays(),
    loadMasterOrders(),
  ]);
  const masterByMo = new Map(masters.map((m) => [m.mo, m]));

  const dueByMo = new Map<string, string>();
  for (const s of schedules) {
    const iso = toISODate(s.ovenDate);
    const cur = dueByMo.get(s.mo);
    if (!cur || iso > cur) dueByMo.set(s.mo, iso);
  }

  const open = tracker.filter((r) => r.status === "open");
  const jobs: EtaJob[] = [];
  for (const r of open) {
    // resolve through the registry row itself so the FG map gets its say
    const tier = tierForOrder(std, masterByMo.get(r.mo) ?? { fgCode: null, kva: r.kva });
    const per = tier !== null ? itemHoursFor(std, tier) : null;
    if (!per) continue; // no standard times — no honest forecast for this MO
    for (const it of ITEMS) {
      const c = r.items[it];
      if (!c.eligible || c.excluded) continue;
      const p = per[it];
      if (!p) continue; // AR / MB — no standard times
      const reqInHouse = Math.max(0, r.required - c.osp);
      const left = {
        cut: Math.max(0, reqInHouse - c.cut),
        weld: Math.max(0, reqInHouse - c.weld),
        finish: Math.max(0, reqInHouse - (isPaintExempt(it as Item) ? c.shp : c.paint)),
      };
      const perPc: Record<EtaStage, number> = { cut: p.cut, weld: p.weld, finish: p.shb + p.paint };
      jobs.push({
        id: `${r.mo}|${it}`,
        mo: r.mo,
        bom: r.bom,
        item: it,
        dueISO: dueByMo.get(r.mo) ?? null,
        left,
        perPc,
        hours: { cut: left.cut * perPc.cut, weld: left.weld * perPc.weld, finish: left.finish * perPc.finish },
      });
    }
  }

  return {
    jobs,
    results: forecastEta(jobs, rates),
    rates,
    sigma,
    windowDays,
    holidayISOs: holidayRows.map((h) => toISODate(h.date)),
    todayISO: toISODate(new Date(Math.floor(Date.now() / DAY) * DAY)),
  };
});

export interface OrderEta {
  etaISO: string | null; // forecast completion date; null when blocked or done
  dueISO: string | null; // latest scheduled delivery date for the MO
  late: boolean; // eta lands after the due date
  done: boolean; // nothing left to make
  blockedBy: EtaStage | null; // stage with no trailing rate — no honest forecast
}

/** ETA per OPEN order: its item jobs flow through the Cut→Weld→Finish flow
 *  shop at the trailing rates (FIFO by delivery date, pieces pipelining
 *  between stations); the ORDER's ETA is when its LAST item clears. */
export async function getOrderEtas(): Promise<{ byMo: Map<string, OrderEta>; windowDays: number }> {
  const { jobs, results, windowDays, holidayISOs, todayISO } = await getEtaBase();
  const holidays = new Set(holidayISOs);

  // working-day offset → calendar date: day 0 = the next working day from today
  const today = new Date(`${todayISO}T00:00:00.000Z`);
  const dateForOffset = (days: number): string => {
    let d = new Date(today);
    while (!isWorkday(d, holidays)) d = new Date(d.getTime() + DAY);
    let left = Math.max(0, Math.ceil(days) - 1);
    while (left > 0) {
      d = new Date(d.getTime() + DAY);
      if (isWorkday(d, holidays)) left--;
    }
    return toISODate(d);
  };

  // fold the item jobs up to their MO: worst days wins, any block blocks
  const perMo = new Map<string, { dueISO: string | null; days: number; blockedBy: EtaStage | null }>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const j = jobs[i];
    const cur = perMo.get(j.mo) ?? { dueISO: j.dueISO, days: 0, blockedBy: null };
    if (r.blockedBy) cur.blockedBy = cur.blockedBy ?? r.blockedBy;
    else if (r.days !== null) cur.days = Math.max(cur.days, r.days);
    perMo.set(j.mo, cur);
  }

  const byMo = new Map<string, OrderEta>();
  for (const [mo, agg] of perMo) {
    if (agg.blockedBy) {
      byMo.set(mo, { etaISO: null, dueISO: agg.dueISO, late: false, done: false, blockedBy: agg.blockedBy });
    } else if (agg.days === 0) {
      byMo.set(mo, { etaISO: null, dueISO: agg.dueISO, late: false, done: true, blockedBy: null });
    } else {
      const etaISO = dateForOffset(agg.days);
      byMo.set(mo, { etaISO, dueISO: agg.dueISO, late: !!agg.dueISO && etaISO > agg.dueISO, done: false, blockedBy: null });
    }
  }
  return { byMo, windowDays };
}
