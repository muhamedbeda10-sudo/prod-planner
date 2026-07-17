import { getRecentHandover } from "@/lib/server/handover";
import { HandoverLog } from "@/components/HandoverLog";
import { toISODate } from "@/lib/domain/dates";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";
import { DEPTS } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default async function HandoverPage() {
  const [recent, user] = await Promise.all([getRecentHandover(2000), getCurrentUser()]);
  const editableDepts = user ? DEPTS.filter((d) => canEditDept(user, d)) : [];

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
  return <HandoverLog rows={rows} editableDepts={editableDepts} />;
}
