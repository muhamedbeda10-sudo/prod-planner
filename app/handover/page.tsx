import { getRecentHandover } from "@/lib/server/handover";
import { HandoverLog } from "@/components/HandoverLog";
import { toISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

export default async function HandoverPage() {
  const recent = await getRecentHandover(2000);

  const rows = recent.map((r) => ({
    id: r.id,
    date: toISODate(r.date),
    dept: r.dept,
    bom: r.bom,
    bomRaw: r.bomRaw,
    mo: r.mo,
    item: r.item,
    qty: r.qty,
    source: r.source,
  }));

  // No page header — every pixel goes to the log (title lives in the nav tab).
  return <HandoverLog rows={rows} />;
}
