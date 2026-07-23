import { getRecentHandover } from "@/lib/server/handover";
import { HandoverLog } from "@/components/HandoverLog";
import { toISODate } from "@/lib/domain/dates";
import { getCurrentUser, canEditDept, hasPerm } from "@/lib/server/auth";
import { DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE } from "@/lib/domain/constants";
import { trackerPermKey } from "@/lib/domain/permissions";

export const dynamic = "force-dynamic";

export default async function HandoverPage() {
  const [recent, user] = await Promise.all([getRecentHandover(2000), getCurrentUser()]);
  // production depts follow the worklist permissions; the tracker-only stages
  // (Shot Blast / Delivered) follow their own tracker permissions
  const editableDepts = user
    ? [
        ...DEPTS.filter((d) => canEditDept(user, d)),
        ...[SHOTBLAST_STAGE, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))),
      ]
    : [];

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
    createdBy: r.createdBy,
  }));

  // No page header — every pixel goes to the log (title lives in the nav tab).
  return <HandoverLog rows={rows} editableDepts={editableDepts} />;
}
