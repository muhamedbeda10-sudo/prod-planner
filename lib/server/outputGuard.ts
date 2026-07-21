import "server-only";
import { prisma } from "@/lib/db";
import { isPaintExempt } from "@/lib/domain/constants";

// The physical chain — one rule enforced everywhere the log is written:
//   delivered ≤ finished ≤ … ≤ welded ≤ cut ≤ order qty   (per MO × item)
// where "finished" is the item's FINAL production stage (welding for the
// paint-exempt core CF, painting otherwise). Entries carrying an MO are
// checked against that MO's totals; entries without one are checked at BOM
// level (the chain holds for the aggregate too).
// The WHOLE chain is re-checked after the proposed change, so reducing or
// deleting an upstream entry can't leave downstream output hanging.
// Totals are all-time, so date edits can never break the chain by themselves.

export async function checkOutputChain(opts: {
  dept: string;
  bom: string;
  mo?: string | null;
  item: string;
  qty: number; // the entry's quantity after the change (0 = deletion)
  excludeId?: number; // when editing/deleting an existing entry
}): Promise<string | null> {
  const mo = (opts.mo ?? "").trim();
  const scope = mo ? { mo, item: opts.item } : { bom: opts.bom, item: opts.item };
  const label = `${mo || opts.bom} ${opts.item}`;

  const [sums, master] = await Promise.all([
    prisma.handoverEntry.groupBy({
      by: ["dept"],
      where: { ...scope, ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}) },
      _sum: { qty: true },
    }),
    mo ? prisma.masterOrder.findUnique({ where: { mo } }) : Promise.resolve(null),
  ]);
  const tot = (d: string) =>
    (sums.find((s) => s.dept === d)?._sum.qty ?? 0) + (opts.dept === d ? opts.qty : 0);
  const cut = tot("Cut");
  const weld = tot("Welding");
  const paint = tot("Painting");
  const delivered = tot("Delivered");

  const finished = isPaintExempt(opts.item) ? weld : paint;
  if (delivered > finished)
    return `Chain check: ${label} would have ${delivered} delivered but only ${finished} finished — delivered must stay ≤ ${isPaintExempt(opts.item) ? "welded" : "painted"}.`;
  if (paint > weld)
    return `Chain check: ${label} would have ${paint} painted but only ${weld} welded — painted must stay ≤ welded.`;
  if (weld > cut)
    return `Chain check: ${label} would have ${weld} welded but only ${cut} cut — welded must stay ≤ cut.`;
  if (master && master.planQty > 0 && cut > master.planQty)
    return `Chain check: order ${mo} is for ${master.planQty} pcs — cut would reach ${cut}. Max extra cut now: ${Math.max(0, master.planQty - (cut - (opts.dept === "Cut" ? opts.qty : 0)))}.`;
  return null;
}
