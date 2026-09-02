import { getSoiLookup } from "@/lib/server/soi";
import { getRecentHandover } from "@/lib/server/handover";
import { HandoverLog } from "@/components/HandoverLog";
import { toISODate } from "@/lib/domain/dates";
import { guardLedger } from "@/lib/domain/ledgerGuard";
import { getCurrentUser, canEditDept, hasPerm } from "@/lib/server/auth";
import { DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE } from "@/lib/domain/constants";
import { trackerPermKey } from "@/lib/domain/permissions";

export const dynamic = "force-dynamic";

export default async function HandoverPage() {
  const [recent, user, soi] = await Promise.all([getRecentHandover(2000), getCurrentUser(), getSoiLookup()]);
  // production depts follow the worklist permissions; the tracker-only stages
  // (Shot Blast / Delivered) follow their own tracker permissions
  const editableDepts = user
    ? [
        ...DEPTS.filter((d) => canEditDept(user, d)),
        ...[SHOTBLAST_STAGE, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))),
      ]
    : [];

  // the data guard runs over everything loaded (not just what the filters
  // show) so an outlier is judged against the full recent history
  const flags = guardLedger(
    recent.map((r) => ({
      id: r.id,
      dateISO: toISODate(r.date),
      dept: r.dept,
      bom: r.bom,
      mo: r.mo,
      item: r.item,
      qty: r.qty,
      createdISO: r.createdAt.toISOString(),
    }))
  );

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
    flags: flags.get(r.id)?.map((f) => f.detail) ?? null,
  }));

  // No page header — every pixel goes to the log (title lives in the nav tab).
  return <HandoverLog rows={rows} editableDepts={editableDepts} soi={soi} />;
}
