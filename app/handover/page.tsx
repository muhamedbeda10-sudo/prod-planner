import { getSoiLookup } from "@/lib/server/soi";
import { getRecentHandover } from "@/lib/server/handover";
import { HandoverLog } from "@/components/HandoverLog";
import { toISODate } from "@/lib/domain/dates";
import { guardLedger } from "@/lib/domain/ledgerGuard";
import { getCurrentUser, canEditDept, hasPerm, guardTab } from "@/lib/server/auth";
import { DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE } from "@/lib/domain/constants";
import { ledgerPermKey, trackerPermKey } from "@/lib/domain/permissions";
import { getActiveLine } from "@/lib/server/line";
import { LV_CHAIN, LV_ITEM } from "@/lib/domain/lv";
import { TrackerSections } from "@/components/TrackerSections";
import { LineSwitch } from "@/components/LineSwitch";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HandoverPage() {
  await guardTab("/handover");
  const [recent, user, soi, line] = await Promise.all([getRecentHandover(2000), getCurrentUser(), getSoiLookup(), getActiveLine()]);
  // production depts follow the worklist permissions; the tracker-only stages
  // (Shot Blast / Delivered) follow their own tracker permissions. A panel's
  // stages follow the LV keys — the same rule the actions check.
  const editableDepts = !user
    ? []
    : line === "LV"
      ? LV_CHAIN.filter((d) => hasPerm(user, ledgerPermKey(d, LV_ITEM)))
      : [
          ...DEPTS.filter((d) => canEditDept(user, d)),
          ...[SHOTBLAST_STAGE, DELIVERED_STAGE].filter((d) => hasPerm(user, trackerPermKey(d))),
        ];

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

  return (
    <>
      <TrackerSections current="handover" />
      <PageHead title="Daily log" sub="Every entry the tracker adds up"><LineSwitch /></PageHead>
      <HandoverLog rows={rows} line={line} editableDepts={editableDepts} soi={soi} />
    </>
  );
}
