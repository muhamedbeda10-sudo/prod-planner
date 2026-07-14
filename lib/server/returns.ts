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
