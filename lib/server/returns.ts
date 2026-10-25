import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";

export interface ReturnRowDTO {
  id: number;
  dateISO: string;
  fromDept: string;
  bom: string;
  mo: string;
  item: string;
  qty: number;
  reason: string;
  status: string;
}

/** OPEN returns addressed TO this dept, newest first. Resolved ones vanish
 *  from the screen — their audit trail lives in the daily logs. */
export async function getReturnsFor(toDept: "Cut" | "Welding"): Promise<ReturnRowDTO[]> {
  const rows = await prisma.returnEntry.findMany({
    where: { toDept, status: "open" },
    orderBy: { id: "desc" },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    dateISO: toISODate(r.date),
    fromDept: r.fromDept,
    bom: r.bom,
    mo: r.mo ?? "",
    item: r.item,
    qty: r.qty,
    reason: r.reason,
    status: r.status,
  }));
}

/** Why a return cannot be filed on this BOM × MO line, or null when it can.
 *  The line must be the order's: a BOM typed beside an MO of another BOM
 *  would file the return and its ledger deduction under a line that never
 *  had the pieces — the registry's BOM, or one the log or a plan holds the MO
 *  under (the plan sheet's own spelling), is the order's. A BOM-level line (no MO) is not checked here. Shared by the
 *  worklist's "send back" (returnToUpstream) and the assistant's tool. */
export async function orderLineError(bom: string, mo: string | null): Promise<string | null> {
  if (!mo) return null;
  const order = await prisma.masterOrder.findUnique({ where: { mo }, select: { bom: true } });
  if (order?.bom === bom) return null;
  // a worklist line carries the plan sheet's spelling of the BOM, which can
  // differ from the registry's for the same order: the line is the order's
  // when the log or a plan already holds this MO under this BOM
  const [logged, planned] = await Promise.all([
    prisma.handoverEntry.findFirst({ where: { bom, mo }, select: { id: true } }),
    prisma.planSchedule.findFirst({ where: { bom, mo }, select: { id: true } }),
  ]);
  if (logged || planned) return null;
  return order ? `${mo} is on BOM ${order.bom}, not ${bom}.` : `${mo} is not in the orders registry or the log for ${bom}.`;
}
