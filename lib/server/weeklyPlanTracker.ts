import "server-only";
import { prisma } from "@/lib/db";
import { ITEMS, isPaintExempt, ospOf, parseExcludedItems, type Item } from "@/lib/domain/constants";
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
//   • When ONE order is promised across SEVERAL days, its output WATERFALLS:
//     the earliest day's promise fills first and only the overflow reaches the
//     next day. 11 welded against 15-then-13 promises reads 11 and 0 — never
//     11 and 11, which would count the same pieces twice.
//   • A promise the ORDER disowns stays on the sheet but out of the maths: a
//     component marked N/A on the order (excludedItems) still shows with its
//     scheduled qty, flagged "not manufactured", and counts in NO total or
//     percentage. Outsourced (OSP) pieces DO count as covered — they arrive
//     without our departments working — and the cell says how many were OSP.
//   • Output logged WITHOUT an order number still counts. The Daily Logs form
//     records against the PROJECT (there is no MO field), and older log files
//     have no MO column at all, so a lot of real output carries bom + item and
//     nothing else. Reading progress by MO alone made that work invisible and
//     showed finished promises as untouched. Those pieces are pooled per
//     project+component and fill whatever the order-tagged figures left short,
//     earliest promise first — each ledger row is read once, never twice.

export interface WeeklyPlanCell {
  req: number; // pcs this delivery day asks for (as scheduled — N/A pcs included)
  // pcs of `req` marked N/A on the order (excludedItems) — the plan asked for
  // them but they will NOT be manufactured. Shown, never counted as work owed.
  na: number;
  osp: number; // pcs of this day's promise covered by outsourcing (made outside)
  cut: number; // every figure below is capped at `req - na`
  weld: number;
  finish: number; // Painting, or SHOT BLAST for the core — plus outsourced qty
  delivered: number;
  // the orders that owe this component TODAY and can actually receive output
  // (N/A ones left out) — recording a quantity on the cell distributes over them
  mos: string[];
}
export interface WeeklyPlanRow {
  bom: string;
  soi: string | null;
  description: string | null;
  urgent: boolean; // any of the day's orders for this project is flagged urgent
  req: number; // the day's promise to MANUFACTURE across every component (N/A excluded)
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
    // every entry ever logged — work done ahead of the delivery date still
    // counts. Rows with no MO are kept: they are the Daily Logs entries, read
    // at project level below.
    prisma.handoverEntry.groupBy({
      by: ["mo", "bom", "dept", "item"],
      _sum: { qty: true },
    }),
  ]);

  const orderOf = new Map(orders.map((o) => [o.mo, o]));
  // manual N/A per order: components the order does not need at all. The weekly
  // sheet may still schedule them — those promises stay VISIBLE but are never
  // counted as work owed (they will not be manufactured).
  const excludedOf = new Map(orders.map((o) => [o.mo, parseExcludedItems(o.excludedItems)]));
  // ---- what the ledger says, split by what it can be attributed to ----
  // Stage buckets. `fin` is the component's FINAL stage: shot blast for the
  // paint-exempt core, painting for everything else — a Painting row on a core
  // (or a ShotBlast row on a painted component) is not that component's finish
  // and is ignored here, exactly as the order-tagged reading has always done.
  type Pool = { cut: number; weld: number; fin: number; delivered: number };
  const emptyPool = (): Pool => ({ cut: 0, weld: 0, fin: 0, delivered: 0 });
  const stageOf = (dept: string, item: string): keyof Pool | null =>
    dept === "Cut" ? "cut"
    : dept === "Welding" ? "weld"
    : dept === "Delivered" ? "delivered"
    : dept === (isPaintExempt(item as Item) ? "ShotBlast" : "Painting") ? "fin"
    : null;

  const done = new Map<string, number>(); // "mo|dept|item" — logged against an order
  // "bom|item" — logged against the PROJECT only (no order number on the row).
  // The Daily Logs form cannot record an MO and legacy log files have no MO
  // column, so this is ordinary output, not an edge case.
  const loose = new Map<string, Pool>();
  for (const s of sums) {
    const qty = s._sum.qty ?? 0;
    if (!qty) continue;
    if (s.mo) {
      // the same order can be logged under more than one BOM spelling — add up
      const k = `${s.mo}|${s.dept}|${s.item}`;
      done.set(k, (done.get(k) ?? 0) + qty);
      continue;
    }
    if (!s.bom) continue;
    const f = stageOf(s.dept, s.item);
    if (!f) continue;
    const k = `${s.bom}|${s.item}`;
    let pool = loose.get(k);
    if (!pool) loose.set(k, (pool = emptyPool()));
    pool[f] += qty;
  }
  const g = (mo: string, dept: string, item: string) => done.get(`${mo}|${dept}|${item}`) ?? 0;

  // ---- the waterfall: one order promised across several days hands its
  // output to the EARLIEST promise first; only the overflow flows on ----
  // lines per (mo, item): the day-quantities in date order
  const moLines = new Map<string, { d: number; qty: number }[]>();
  for (const s of schedules) {
    if (!ITEMS.includes(s.item as Item) || !s.qty) continue;
    const k = `${s.mo}|${s.item}`;
    if (!moLines.has(k)) moLines.set(k, []);
    const lines = moLines.get(k)!;
    const d = dayNumber(s.ovenDate);
    const line = lines.find((l) => l.d === d);
    if (line) line.qty += s.qty;
    else lines.push({ d, qty: s.qty });
  }
  // alloc "mo|item|day" → the slice of the order's output this day may claim.
  // `osp` waterfalls exactly like the stage figures, so a cell can SAY how much
  // of its coverage was made outside rather than by our departments.
  type Slice = { cut: number; weld: number; fin: number; delivered: number; osp: number };
  const alloc = new Map<string, Slice>();
  for (const [k, lines] of moLines) {
    lines.sort((a, b) => a.d - b.d);
    const [mo, item] = k.split("|");
    const o = orderOf.get(mo);
    const osp = o ? ospOf(o, item as Item) : 0; // outsourced pieces count as made
    const pool: Slice = {
      cut: g(mo, "Cut", item),
      weld: g(mo, "Welding", item) + osp,
      // the core's finishing IS its shot blast — it is never painted
      fin: (isPaintExempt(item as Item) ? g(mo, "ShotBlast", item) : g(mo, "Painting", item)) + osp,
      delivered: g(mo, "Delivered", item),
      osp,
    };
    for (const line of lines) {
      const slice: Slice = { cut: 0, weld: 0, fin: 0, delivered: 0, osp: 0 };
      for (const f of ["cut", "weld", "fin", "delivered", "osp"] as const) {
        slice[f] = Math.min(pool[f], line.qty);
        pool[f] -= slice[f];
      }
      alloc.set(`${k}|${line.d}`, slice);
    }
  }

  // ---- gather the promises per delivery day × project, folding the MOs in ----
  type Draft = {
    bom: string;
    soi: string | null;
    description: string | null;
    urgent: boolean;
    req: Partial<Record<Item, number>>;
    na: Partial<Record<Item, number>>; // the slice of req scheduled from N/A orders
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
      draft = { bom: s.bom, soi: s.soi ?? null, description: s.description ?? null, urgent: false, req: {}, na: {}, mos: new Set() };
      drafts.set(key, draft);
    }
    draft.req[item] = (draft.req[item] ?? 0) + s.qty;
    // scheduled against an order that doesn't need this component — the promise
    // stays visible, but it is not work we will do
    if (excludedOf.get(s.mo)?.has(item)) draft.na[item] = (draft.na[item] ?? 0) + s.qty;
    draft.mos.add(s.mo);
    draft.soi ??= s.soi ?? orderOf.get(s.mo)?.soi ?? null;
    draft.description ??= s.description ?? null;
    if (orderOf.get(s.mo)?.urgent) draft.urgent = true;
  }

  // ---- turn each project's promise into capped per-department progress ----
  const days = new Map<number, WeeklyPlanDay>();
  // earliest delivery day first, so the project-level pool below fills the
  // promise that came due first — the same rule the order-tagged waterfall uses
  const ordered = [...drafts.entries()].sort(
    (a, b) => Number(a[0].slice(0, a[0].indexOf("|"))) - Number(b[0].slice(0, b[0].indexOf("|"))),
  );
  for (const [key, draft] of ordered) {
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
      // pcs the plan asked for but the order marked N/A — visible, never owed.
      // Only what remains is a promise to manufacture; every figure caps there.
      const na = Math.min(draft.na[it] ?? 0, req);
      const owed = req - na;
      // each order contributes THIS day's waterfall slice — output already
      // claimed by an earlier promise never shows up again
      let cut = 0, weld = 0, fin = 0, delivered = 0, osp = 0;
      const mos: string[] = [];
      for (const mo of draft.mos) {
        const slice = alloc.get(`${mo}|${it}|${d}`);
        if (!slice) continue; // this order owes a different component today
        // an order that marked the component N/A cannot receive output
        if (!excludedOf.get(mo)?.has(it)) mos.push(mo);
        cut += slice.cut;
        weld += slice.weld;
        fin += slice.fin;
        delivered += slice.delivered;
        osp += slice.osp;
      }
      // pieces logged against the project with no order number fill whatever
      // the order-tagged figures left short — they belong to this project and
      // to no particular order, so this promise is the only place to read them
      const pool = loose.get(`${draft.bom}|${it}`);
      if (pool) {
        const take = (have: number, f: keyof typeof pool) => {
          // a return is logged as a negative row — it can shrink the pool, but
          // it must never subtract from what an order already accounted for
          const gap = Math.max(0, Math.min(pool[f], owed - have));
          pool[f] -= gap;
          return have + gap;
        };
        cut = take(cut, "cut");
        weld = take(weld, "weld");
        fin = take(fin, "fin");
        delivered = take(delivered, "delivered");
      }
      const cap = (v: number) => Math.min(v, owed);
      items[it] = { req, na, osp: cap(osp), cut: cap(cut), weld: cap(weld), finish: cap(fin), delivered: cap(delivered), mos: mos.sort() };
      rowReq += owed;
      day.covered += cap(fin);
    }
    // a project whose every promise today is N/A still shows (so the plan's ask
    // stays on the sheet) — it just carries no work and no percentage
    if (Object.keys(items).length === 0) continue;

    day.req += rowReq;
    day.rows.push({ bom: draft.bom, soi: draft.soi, description: draft.description, urgent: draft.urgent, req: rowReq, items });
  }

  for (const day of days.values()) {
    // the columns THIS day needs, in pipeline order — an empty column is noise
    day.items = ITEMS.filter((it) => day.rows.some((r) => r.items[it]));
    // urgent first, then the biggest promise, then by name so rows never jump
    day.rows.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.req - a.req || (a.bom < b.bom ? -1 : 1));
  }

  const byDay = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    planNo: active,
    planNos,
    days: byDay,
    req: byDay.reduce((s, d) => s + d.req, 0),
    covered: byDay.reduce((s, d) => s + d.covered, 0),
  };
}
