import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { LV_ITEM } from "@/lib/domain/lv";
import { indexLvRates, lvRateFor, LV_DEPT_STAGE, type LvRate } from "@/lib/domain/lvStd";
import { OUTPUT_SOURCE } from "@/lib/domain/productivity";
import type { RosterDept } from "@/lib/domain/shifts";

export async function getLvRates(): Promise<LvRate[]> {
  const rows = await prisma.lvStdTime.findMany({ orderBy: [{ kind: "desc" }, { fg: "asc" }] });
  return rows.map(({ fg, description, kind, cutH, bendH, weldH, shbH, paintH, totalH }) => ({ fg, description, kind, cutH, bendH, weldH, shbH, paintH, totalH }));
}

/** Every panel order with the sheet row it is priced by (null when none). */
export async function getLvOrderRates(rates?: LvRate[]): Promise<{ mo: string; fgCode: string | null; secItem: string | null; product: string | null; planQty: number; status: string; rate: LvRate | null; via: "fg" | "sec" | null }[]> {
  const [list, orders] = await Promise.all([
    rates ? Promise.resolve(rates) : getLvRates(),
    prisma.masterOrder.findMany({ where: { line: "LV" }, select: { mo: true, fgCode: true, secItem: true, product: true, planQty: true, status: true }, orderBy: { mo: "asc" } }),
  ]);
  const idx = indexLvRates(list);
  return orders.map((o) => {
    const hit = lvRateFor(idx, o);
    return { ...o, rate: hit?.rate ?? null, via: hit?.via ?? null };
  });
}

/** The std-hours the panels' output earned on each of these days, per LV
 *  roster department — what the sheet says those panels are worth there. */
export async function earnedLvOnDays(dates: readonly string[]): Promise<Map<string, Partial<Record<RosterDept, number>>>> {
  const out = new Map<string, Partial<Record<RosterDept, number>>>();
  if (dates.length === 0) return out;
  const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const [orders, entries] = await Promise.all([
    getLvOrderRates(),
    prisma.handoverEntry.findMany({
      where: { item: LV_ITEM, OR: dates.map((iso) => ({ date: { gte: dayStart(iso), lt: new Date(dayStart(iso).getTime() + 86400000) } })) },
      select: { mo: true, dept: true, qty: true, date: true },
    }),
  ]);
  const rateOf = new Map(orders.map((o) => [o.mo, o.rate]));
  const depts = Object.keys(LV_DEPT_STAGE) as RosterDept[];
  for (const e of entries) {
    const rate = e.mo ? rateOf.get(e.mo) : null;
    if (!rate) continue;
    const iso = toISODate(e.date);
    const day = out.get(iso) ?? {};
    for (const d of depts) {
      if (!OUTPUT_SOURCE[d].depts.includes(e.dept)) continue;
      day[d] = (day[d] ?? 0) + rate[LV_DEPT_STAGE[d]!] * e.qty;
    }
    out.set(iso, day);
  }
  return out;
}
