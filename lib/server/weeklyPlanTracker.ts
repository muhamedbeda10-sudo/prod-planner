import "server-only";
import { prisma } from "@/lib/db";
import { ITEMS, ospOf, parseExcludedItems, itemApplies, type Item } from "@/lib/domain/constants";
import { dayNumber, toISODate } from "@/lib/domain/dates";

// Plan Tracker on a WEEKLY plan, grouped BY DAY. One weekly plan is a list of
// dated promises — "this MO's components go in the oven on this date" — so the
// natural reading is day by day: what does this day ask for, and how far has
// each department got with it?
//
// Progress is CUMULATIVE and RAW: every piece ever logged for that MO + item,
// whatever week it was made in, uncapped. A day asking for 10 with 25 logged
// reads 25 — the point is "where does this order stand", not "did this week
// balance". That is deliberately different from the monthly tracker, which caps
// each figure at the order's plan quantity.
//
// The whole plan renders at once and today's group is marked, so there is no
// date to pick: open it and today is already on screen.

export interface WeeklyPlanCell {
  req: number; // pcs this day's promise asks for
  cut: number;
  weld: number;
  paint: number;
  shp: number;
  delivered: number;
  osp: number; // outsourced — our departments never make these
  eligible: boolean; // the order needs this component by rule (AR/MB are conditional)
  excluded: boolean; // admin marked it N/A for this order
}
export interface WeeklyPlanRow {
  mo: string;
  bom: string;
  soi: string | null;
  description: string | null;
  urgent: boolean;
  kva: string | null;
  rating: string | null;
  req: number; // the day's promise across every component
  items: Record<Item, WeeklyPlanCell>;
  /** Whole-order context, so a row can be read without leaving the page. */
  orderQty: number; // the MO's total plan quantity
  known: boolean; // false = the plan names an MO the order registry has never seen
}
export interface WeeklyPlanDay {
  iso: string;
  label: string; // "Sat 11/07"
  isToday: boolean;
  isPast: boolean;
  req: number;
  rows: WeeklyPlanRow[];
}
export interface WeeklyPlanTracker {
  planNo: number | null; // null = there are no weekly plans yet
  planNos: number[]; // newest first — what the picker offers
  days: WeeklyPlanDay[];
  req: number;
}

const WEEKDAY = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const emptyCell = (): WeeklyPlanCell => ({
  req: 0, cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, eligible: true, excluded: false,
});

/** One weekly plan laid out day by day, each MO carrying its cumulative
 *  all-time progress. `planNo` defaults to the newest plan. */
export async function getWeeklyPlanTracker(planNo?: number | null): Promise<WeeklyPlanTracker> {
  const plans = await prisma.plan.findMany({
    where: { planNo: { gt: 0 } }, // planNo 0 is the synthetic setup-balances bucket
    orderBy: { planNo: "desc" },
    select: { planNo: true },
  });
  const planNos = plans.map((p) => p.planNo);
  // an unknown or missing ?plan= falls back to the newest plan rather than 404ing
  const active = planNo && planNos.includes(planNo) ? planNo : (planNos[0] ?? null);
  if (active === null) return { planNo: null, planNos, days: [], req: 0 };

  const [schedules, orders, sums] = await Promise.all([
    prisma.planSchedule.findMany({
      where: { planNo: active },
      select: { bom: true, mo: true, soi: true, description: true, item: true, ovenDate: true, qty: true },
    }),
    prisma.masterOrder.findMany(),
    // CUMULATIVE and uncapped: every entry ever logged, whatever week it belongs to
    prisma.handoverEntry.groupBy({
      by: ["mo", "dept", "item"],
      where: { mo: { not: null } },
      _sum: { qty: true },
    }),
  ]);

  const orderOf = new Map(orders.map((o) => [o.mo, o]));
  const done = new Map<string, number>(); // "mo|dept|item"
  for (const s of sums) if (s.mo) done.set(`${s.mo}|${s.dept}|${s.item}`, s._sum.qty ?? 0);
  const g = (mo: string, dept: string, item: string) => done.get(`${mo}|${dept}|${item}`) ?? 0;

  const todayD = dayNumber(new Date());
  const days = new Map<number, WeeklyPlanDay>();
  const rowOf = new Map<string, WeeklyPlanRow>(); // "<dayNumber>|<mo>"

  for (const s of schedules) {
    if (!ITEMS.includes(s.item as Item)) continue; // a stray component name in the sheet
    const item = s.item as Item;
    const d = dayNumber(s.ovenDate);

    let day = days.get(d);
    if (!day) {
      const iso = toISODate(s.ovenDate);
      day = {
        iso,
        label: `${WEEKDAY[((d % 7) + 7) % 7]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`,
        isToday: d === todayD,
        isPast: d < todayD,
        req: 0,
        rows: [],
      };
      days.set(d, day);
    }

    const key = `${d}|${s.mo}`;
    let row = rowOf.get(key);
    if (!row) {
      const o = orderOf.get(s.mo);
      const excluded = o ? parseExcludedItems(o.excludedItems) : new Set<string>();
      const items = {} as Record<Item, WeeklyPlanCell>;
      for (const it of ITEMS) {
        items[it] = {
          ...emptyCell(),
          cut: g(s.mo, "Cut", it),
          weld: g(s.mo, "Welding", it),
          paint: g(s.mo, "Painting", it),
          shp: g(s.mo, "ShotBlast", it), // the core's finishing step
          delivered: g(s.mo, "Delivered", it),
          osp: o ? ospOf(o, it) : 0,
          eligible: o ? itemApplies(it, o) : true, // AR/MB only when the KVA/rating rule matches
          excluded: excluded.has(it),
        };
      }
      row = {
        mo: s.mo,
        bom: s.bom,
        soi: s.soi ?? o?.soi ?? null,
        description: s.description ?? null,
        urgent: o?.urgent ?? false,
        kva: o?.kva ?? null,
        rating: o?.rating ?? null,
        req: 0,
        items,
        orderQty: o?.planQty ?? 0,
        known: !!o,
      };
      rowOf.set(key, row);
      day.rows.push(row);
    }
    row.items[item].req += s.qty;
    row.req += s.qty;
    day.req += s.qty;
  }

  // urgent orders first inside a day, then by MO so the order never jumps around
  for (const day of days.values()) day.rows.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.mo < b.mo ? -1 : 1));

  const ordered = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { planNo: active, planNos, days: ordered, req: ordered.reduce((s, d) => s + d.req, 0) };
}
