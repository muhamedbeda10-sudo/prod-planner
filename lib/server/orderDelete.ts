import "server-only";
import { prisma } from "@/lib/db";

/** What a delete would take with it, and what it would leave behind. An order
 *  that has RECORDED WORK against it is not a mistaken import — deleting it
 *  would orphan the ledger, so the registry says so and refuses unless the
 *  planner confirms it deliberately. */
export interface OrderDeletePreview {
  mo: string;
  bom: string;
  planQty: number;
  /** Pieces already recorded against the MO in the daily log. */
  loggedQty: number;
  loggedRows: number;
  /** Serial-tracked tanks born from it. */
  tanks: number;
  /** Planning rows that go with it (worklist dates, hides, pushes, machine
   *  placements, run order, queue notes) — none of them is history. */
  planningRows: number;
}

/** Count what hangs off each MO of the registry, so a delete can say it out
 *  loud — the Orders Registry's button and the assistant's card alike. */
export async function orderDeletePreview(mos: readonly string[]): Promise<OrderDeletePreview[]> {
  const list = [...mos];
  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: list } } });
  if (orders.length === 0) return [];
  const [ledger, tanks, dates, hides, pushes, machines, runOrder, notes] = await Promise.all([
    prisma.handoverEntry.groupBy({ by: ["mo"], where: { mo: { in: list } }, _sum: { qty: true }, _count: { _all: true } }),
    prisma.tankUnit.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
    prisma.worklistDateOverride.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
    prisma.worklistLineHide.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
    prisma.worklistPush.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
    prisma.worklistMachine.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
    prisma.runOrderEntry.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
    prisma.queueNote.groupBy({ by: ["mo"], where: { mo: { in: list } }, _count: { _all: true } }),
  ]);
  const count = (g: { mo: string | null; _count: { _all: number } }[], mo: string) => g.find((x) => x.mo === mo)?._count._all ?? 0;
  return orders.map((o) => {
    const l = ledger.find((x) => x.mo === o.mo);
    return {
      mo: o.mo,
      bom: o.bom,
      planQty: o.planQty,
      loggedQty: l?._sum.qty ?? 0,
      loggedRows: l?._count._all ?? 0,
      tanks: count(tanks, o.mo),
      planningRows: count(dates, o.mo) + count(hides, o.mo) + count(pushes, o.mo) + count(machines, o.mo) + count(runOrder, o.mo) + count(notes, o.mo),
    };
  });
}
