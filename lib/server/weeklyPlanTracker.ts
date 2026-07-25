import "server-only";
import { prisma } from "@/lib/db";
import { ITEMS, isPaintExempt, ospOf, type Item } from "@/lib/domain/constants";
import { dayNumber, toISODate } from "@/lib/domain/dates";

// Plan Tracker on a WEEKLY plan, grouped BY DELIVERY DAY.
//
// A weekly plan is a list of dated promises. The date is the DELIVERY date —
// by then the whole thing should be finished — so the only useful question is
// "how far has each department got with what this day owes?". Everything here
// serves that one question:
//
//   • Rows are PROJECTS (BOM). Manufacturing orders are an accounting detail
//     the floor doesn't read at, so a BOM's MOs are summed into one row.
//   • A day shows ONLY the components it actually asks for. If a project owes
//     10 top covers that day, that is the row — its other components are not
//     this day's business and would only be noise.
//   • Figures are CAPPED at what the day asks for. Progress counts every piece
//     ever logged for those orders (work done early still counts), but the
//     number shown never exceeds the requirement: 10 owed with 25 made reads
//     10/10, not 25. So a cell is always "how much of this day's promise is
//     covered", and the percentage tops out at 100.

export interface WeeklyPlanCell {
  req: number; // pcs this delivery day asks for
  cut: number; // every figure below is capped at `req`
  weld: number;
  finish: number; // Painting, or SHOT BLAST for the core — plus outsourced qty
  delivered: number;
}
export interface WeeklyPlanRow {
  bom: string;
  soi: string | null;
  description: string | null;
  urgent: boolean; // any of the day's orders for this project is flagged urgent
  req: number; // the day's promise across every component it asks for
  items: Partial<Record<Item, WeeklyPlanCell>>; // ONLY what the day asks for
}
export interface WeeklyPlanDay {
  iso: string;
  label: string; // "Sat 11/07"
  isToday: boolean;
  isPast: boolean; // the delivery date has passed — it should be finished
  req: number;
  covered: number; // pcs of `req` whose final stage is done
  items: Item[]; // the components THIS day asks for, in pipeline order
  rows: WeeklyPlanRow[];
}
export interface WeeklyPlanTracker {
  planNo: number | null; // null = there are no weekly plans yet
  planNos: number[]; // newest first — what the picker offers
  days: WeeklyPlanDay[];
  req: number;
  covered: number;
}

const WEEKDAY = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

/** One weekly plan laid out by delivery day, each project carrying how much of
 *  that day's promise each department has covered. `planNo` defaults to the
 *  newest plan, so the page opens on the current week with nothing to pick. */
export async function getWeeklyPlanTracker(planNo?: number | null): Promise<WeeklyPlanTracker> {
  const plans = await prisma.plan.findMany({
    where: { planNo: { gt: 0 } }, // planNo 0 is the synthetic setup-balances bucket
    orderBy: { planNo: "desc" },
    select: { planNo: true },
  });
  const planNos = plans.map((p) => p.planNo);
  // an unknown or missing ?plan= falls back to the newest plan rather than 404ing
  const active = planNo && planNos.includes(planNo) ? planNo : (planNos[0] ?? null);
  if (active === null) return { planNo: null, planNos, days: [], req: 0, covered: 0 };

  const [schedules, orders, sums] = await Promise.all([
    prisma.planSchedule.findMany({
      where: { planNo: active },
      select: { bom: true, mo: true, soi: true, description: true, item: true, ovenDate: true, qty: true },
    }),
    prisma.masterOrder.findMany(),
    // every entry ever logged — work done ahead of the delivery date still counts
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

  // ---- gather the promises per delivery day × project, folding the MOs in ----
  type Draft = {
    bom: string;
    soi: string | null;
    description: string | null;
    urgent: boolean;
    req: Partial<Record<Item, number>>;
    mos: Set<string>; // the orders this project owes on this day — the progress to read
  };
  const todayD = dayNumber(new Date());
  const dayMeta = new Map<number, { iso: string }>();
  const drafts = new Map<string, Draft>(); // "<dayNumber>|<bom>"

  for (const s of schedules) {
    if (!ITEMS.includes(s.item as Item) || !s.qty) continue; // a stray component name, or an empty promise
    const item = s.item as Item;
    const d = dayNumber(s.ovenDate);
    if (!dayMeta.has(d)) dayMeta.set(d, { iso: toISODate(s.ovenDate) });

    const key = `${d}|${s.bom}`;
    let draft = drafts.get(key);
    if (!draft) {
      draft = { bom: s.bom, soi: s.soi ?? null, description: s.description ?? null, urgent: false, req: {}, mos: new Set() };
      drafts.set(key, draft);
    }
    draft.req[item] = (draft.req[item] ?? 0) + s.qty;
    draft.mos.add(s.mo);
    draft.soi ??= s.soi ?? orderOf.get(s.mo)?.soi ?? null;
    draft.description ??= s.description ?? null;
    if (orderOf.get(s.mo)?.urgent) draft.urgent = true;
  }

  // ---- turn each project's promise into capped per-department progress ----
  const days = new Map<number, WeeklyPlanDay>();
  for (const [key, draft] of drafts) {
    const d = Number(key.slice(0, key.indexOf("|")));
    let day = days.get(d);
    if (!day) {
      const iso = dayMeta.get(d)!.iso;
      day = {
        iso,
        label: `${WEEKDAY[((d % 7) + 7) % 7]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`,
        isToday: d === todayD,
        isPast: d < todayD,
        req: 0,
        covered: 0,
        items: [],
        rows: [],
      };
      days.set(d, day);
    }

    const items: WeeklyPlanRow["items"] = {};
    let rowReq = 0;
    for (const it of ITEMS) {
      const req = draft.req[it] ?? 0;
      if (!req) continue; // not this day's business — leave it out entirely
      // sum only the orders this project owes TODAY, then cap at the promise
      let cut = 0, weld = 0, fin = 0, delivered = 0, osp = 0;
      for (const mo of draft.mos) {
        const o = orderOf.get(mo);
        cut += g(mo, "Cut", it);
        weld += g(mo, "Welding", it);
        // the core's finishing IS its shot blast — it is never painted
        fin += isPaintExempt(it) ? g(mo, "ShotBlast", it) : g(mo, "Painting", it);
        delivered += g(mo, "Delivered", it);
        osp += o ? ospOf(o, it) : 0; // outsourced: our departments never make these
      }
      const cap = (v: number) => Math.min(v, req);
      items[it] = { req, cut: cap(cut), weld: cap(weld + osp), finish: cap(fin + osp), delivered: cap(delivered) };
      rowReq += req;
      day.covered += cap(fin + osp);
    }
    if (rowReq === 0) continue; // nothing left to say about this project today

    day.req += rowReq;
    day.rows.push({ bom: draft.bom, soi: draft.soi, description: draft.description, urgent: draft.urgent, req: rowReq, items });
  }

  for (const day of days.values()) {
    // the columns THIS day needs, in pipeline order — an empty column is noise
    day.items = ITEMS.filter((it) => day.rows.some((r) => r.items[it]));
    // urgent first, then the biggest promise, then by name so rows never jump
    day.rows.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.req - a.req || (a.bom < b.bom ? -1 : 1));
  }

  const ordered = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    planNo: active,
    planNos,
    days: ordered,
    req: ordered.reduce((s, d) => s + d.req, 0),
    covered: ordered.reduce((s, d) => s + d.covered, 0),
  };
}
