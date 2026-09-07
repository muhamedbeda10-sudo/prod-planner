import "server-only";
import { prisma } from "@/lib/db";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { blockedItem, isDoneReason, type OdooEntryView } from "@/lib/domain/odoo";

export interface OdooPageData {
  entries: OdooEntryView[];
  /** Every day that has at least one row — the day picker's quick jumps. */
  days: string[];
  /** Typing aids from the orders registry: SOIs and FG codes it already knows. */
  knownSois: string[];
  knownFgCodes: string[];
}

/** The tab for one day (ISO), or every day when `dayISO` is "all". */
export async function getOdooData(dayISO: string): Promise<OdooPageData> {
  const day = dayISO === "all" ? null : parseISODate(dayISO);
  const where = day
    ? { date: { gte: day, lt: new Date(day.getTime() + 24 * 60 * 60 * 1000) } }
    : undefined;

  const [rows, dayRows, orders] = await Promise.all([
    prisma.odooEntry.findMany({ where, orderBy: [{ date: "desc" }, { id: "asc" }] }),
    prisma.odooEntry.findMany({ select: { date: true }, distinct: ["date"], orderBy: { date: "desc" } }),
    prisma.masterOrder.findMany({ select: { soi: true, fgCode: true } }),
  ]);

  const entries: OdooEntryView[] = rows.map((r) => ({
    id: r.id,
    dateISO: toISODate(r.date),
    soi: r.soi,
    fgCode: r.fgCode,
    product: r.product,
    odooMo: r.odooMo,
    qty: r.qty,
    status: r.status,
    reason: r.reason,
    done: isDoneReason(r.reason),
    blockedItem: blockedItem(r.reason),
    recordedBy: r.recordedBy,
  }));

  const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].sort();
  return {
    entries,
    days: [...new Set(dayRows.map((d) => toISODate(d.date)))],
    knownSois: uniq(orders.map((o) => o.soi)),
    knownFgCodes: uniq(orders.map((o) => o.fgCode)),
  };
}
