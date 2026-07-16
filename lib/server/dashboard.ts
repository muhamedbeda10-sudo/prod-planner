import "server-only";
import { prisma } from "@/lib/db";
import { ITEMS, PAINTED_ITEMS, type Item } from "@/lib/domain/constants";
import { getSettings } from "./data";
import { dayNumber, dateFromDayNumber, toISODate } from "@/lib/domain/dates";

// ============================================================================
// Target-based dashboard: the ONLY yardstick is the fixed capacity target —
// N pcs per item, per department, per WORKING day (Sat–Thu; Friday is off).
// Two modes: a work week (default, with prev/next navigation) or any custom
// date range — the target scales with the number of working days shown.
// ============================================================================

export interface DeptDay {
  items: Record<Item, number>;
  total: number;
  sets: number; // MIN across items — complete transformers
}

export interface DayRow {
  iso: string;
  label: string; // "Sat 11/07"
  isToday: boolean;
  isFuture: boolean;
  isFriday: boolean; // off day — output counts, but carries no target
  isHoliday: boolean; // factory-calendar day off (holiday / shutdown)
  holidayName: string | null;
  cut: DeptDay;
  weld: DeptDay;
  paint: DeptDay;
}

export interface WeekSummary {
  startISO: string;
  label: string;
  cutTotal: number;
  weldTotal: number;
  paintTotal: number;
  cutSets: number;
  weldSets: number;
  paintSets: number;
}

export interface TargetDashboard {
  mode: "week" | "range";
  targetPerItem: number; // per working day (27)
  targetPerDeptDay: number; // × 4 items
  workingDays: number; // working days in the shown period
  targetPerItemPeriod: number; // targetPerItem × workingDays
  targetPerDeptPeriod: number; // × 4
  fromISO: string;
  toISO: string;
  prevWeekISO: string; // week mode only
  nextWeekISO: string | null;
  isCurrentWeek: boolean;
  todayISO: string;
  todayInPeriod: boolean;
  paceWorkingDays: number; // working days of the period elapsed (≤ today)
  clamped: boolean; // range was longer than the 31-day display cap

  today: { cut: DeptDay; weld: DeptDay; paint: DeptDay } | null;
  period: { cut: DeptDay; weld: DeptDay; paint: DeptDay }; // cumulative over the shown period
  days: DayRow[];
  history: WeekSummary[]; // 6 work weeks anchored at the period end
}

const emptyItems = (): Record<Item, number> => ({ CF: 0, TC: 0, TN: 0, CB: 0 });
const minOf = (vals: number[]) => vals.reduce((m, v) => (v < m ? v : m), vals[0] ?? 0);
const isItem = (x: string): x is Item => (ITEMS as readonly string[]).includes(x);

// Painting only handles the painted components, so a painting "set" is the MIN
// over those items (the core CF is never painted — it can't gate a set).
function mkDeptDay(items: Record<Item, number>, painted = false): DeptDay {
  const setItems = painted ? PAINTED_ITEMS : ITEMS;
  return {
    items,
    total: ITEMS.reduce((s, it) => s + items[it], 0),
    sets: minOf(setItems.map((it) => items[it])),
  };
}

// dayNumber 0 = 1970-01-01 (Thursday): 0=Thu, 1=Fri, 2=Sat, ...
const dowOf = (d: number) => ((d % 7) + 7) % 7;
const isFridayD = (d: number) => dowOf(d) === 1;

/** Most recent Saturday ≤ d (the work week runs Sat..Thu, Friday off). */
function weekStartOf(d: number): number {
  return d - ((dowOf(d) - 2 + 7) % 7);
}

const WEEKDAY = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export async function getTargetDashboard(opts?: {
  weekOf?: Date | null;
  from?: Date | null;
  to?: Date | null;
}): Promise<TargetDashboard> {
  const [settings, holidays] = await Promise.all([
    getSettings(),
    prisma.holiday.findMany(),
  ]);
  const target = settings.dailyTarget || 27;
  const holidayName = new Map(holidays.map((h) => [dayNumber(h.date), h.name]));

  const todayD = dayNumber(new Date());
  const currentWeekStart = weekStartOf(todayD);

  // ---- resolve the shown period ----
  let mode: "week" | "range" = "week";
  let fromD: number;
  let toD: number;
  let clamped = false;
  if (opts?.from && opts?.to) {
    mode = "range";
    fromD = dayNumber(opts.from);
    toD = dayNumber(opts.to);
    if (toD < fromD) [fromD, toD] = [toD, fromD];
    if (toD - fromD > 30) {
      toD = fromD + 30; // display cap
      clamped = true;
    }
  } else {
    const ws = opts?.weekOf ? weekStartOf(dayNumber(opts.weekOf)) : currentWeekStart;
    fromD = ws;
    toD = ws + 5;
  }
  const isCurrentWeek = mode === "week" && fromD === currentWeekStart;

  // one query covers the period + 6 weeks of history behind it
  const historyAnchor = weekStartOf(toD);
  const queryStart = Math.min(fromD, historyAnchor - 7 * 5) - 7;
  const entries = await prisma.handoverEntry.findMany({
    where: { date: { gte: dateFromDayNumber(queryStart) } },
    select: { date: true, dept: true, item: true, qty: true },
  });

  const byDay = new Map<number, { cut: Record<Item, number>; weld: Record<Item, number>; paint: Record<Item, number> }>();
  for (const e of entries) {
    if (!isItem(e.item)) continue;
    const d = dayNumber(e.date);
    if (!byDay.has(d)) byDay.set(d, { cut: emptyItems(), weld: emptyItems(), paint: emptyItems() });
    const bucket = byDay.get(d)!;
    if (e.dept === "Cut") bucket.cut[e.item] += e.qty;
    else if (e.dept === "Welding") bucket.weld[e.item] += e.qty;
    else if (e.dept === "Painting") bucket.paint[e.item] += e.qty;
  }
  const dayItems = (d: number, dept: "cut" | "weld" | "paint") => byDay.get(d)?.[dept] ?? emptyItems();

  // ---- period days ----
  const days: DayRow[] = [];
  const periodCut = emptyItems();
  const periodWeld = emptyItems();
  const periodPaint = emptyItems();
  let workingDays = 0;
  let paceWorkingDays = 0;
  for (let d = fromD; d <= toD; d++) {
    const iso = toISODate(dateFromDayNumber(d));
    const cutI = dayItems(d, "cut");
    const weldI = dayItems(d, "weld");
    const paintI = dayItems(d, "paint");
    for (const it of ITEMS) {
      periodCut[it] += cutI[it];
      periodWeld[it] += weldI[it];
      periodPaint[it] += paintI[it];
    }
    const friday = isFridayD(d);
    const holiday = holidayName.has(d);
    if (!friday && !holiday) {
      workingDays++;
      if (d <= todayD) paceWorkingDays++;
    }
    days.push({
      iso,
      label: `${WEEKDAY[dowOf(d)]} ${ddmm(iso)}`,
      isToday: d === todayD,
      isFuture: d > todayD,
      isFriday: friday,
      isHoliday: holiday,
      holidayName: holidayName.get(d) ?? null,
      cut: mkDeptDay(cutI),
      weld: mkDeptDay(weldI),
      paint: mkDeptDay(paintI, true),
    });
  }

  // ---- history: 6 work weeks ending at the period end ----
  const history: WeekSummary[] = [];
  for (let w = 0; w < 6; w++) {
    const ws = historyAnchor - 7 * w;
    let cutTotal = 0, weldTotal = 0, paintTotal = 0, cutSets = 0, weldSets = 0, paintSets = 0;
    for (let g = 0; g < 6; g++) {
      const cutI = dayItems(ws + g, "cut");
      const weldI = dayItems(ws + g, "weld");
      const paintI = dayItems(ws + g, "paint");
      cutTotal += ITEMS.reduce((s, it) => s + cutI[it], 0);
      weldTotal += ITEMS.reduce((s, it) => s + weldI[it], 0);
      paintTotal += ITEMS.reduce((s, it) => s + paintI[it], 0);
      cutSets += minOf(ITEMS.map((it) => cutI[it]));
      weldSets += minOf(ITEMS.map((it) => weldI[it]));
      paintSets += minOf(PAINTED_ITEMS.map((it) => paintI[it]));
    }
    const startISO = toISODate(dateFromDayNumber(ws));
    const endISO = toISODate(dateFromDayNumber(ws + 5));
    history.push({ startISO, label: `${ddmm(startISO)} – ${ddmm(endISO)}`, cutTotal, weldTotal, paintTotal, cutSets, weldSets, paintSets });
  }

  const todayInPeriod = todayD >= fromD && todayD <= toD;

  return {
    mode,
    targetPerItem: target,
    targetPerDeptDay: target * 4,
    workingDays,
    targetPerItemPeriod: target * workingDays,
    targetPerDeptPeriod: target * workingDays * 4,
    fromISO: toISODate(dateFromDayNumber(fromD)),
    toISO: toISODate(dateFromDayNumber(toD)),
    prevWeekISO: toISODate(dateFromDayNumber(fromD - 7)),
    nextWeekISO: mode === "week" && !isCurrentWeek ? toISODate(dateFromDayNumber(fromD + 7)) : null,
    isCurrentWeek,
    todayISO: toISODate(dateFromDayNumber(todayD)),
    todayInPeriod,
    paceWorkingDays,
    clamped,
    today: todayInPeriod
      ? { cut: mkDeptDay(dayItems(todayD, "cut")), weld: mkDeptDay(dayItems(todayD, "weld")), paint: mkDeptDay(dayItems(todayD, "paint"), true) }
      : null,
    period: { cut: mkDeptDay(periodCut), weld: mkDeptDay(periodWeld), paint: mkDeptDay(periodPaint, true) },
    days,
    history,
  };
}
