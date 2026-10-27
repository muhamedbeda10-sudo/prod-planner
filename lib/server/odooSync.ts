import "server-only";
import { prisma } from "@/lib/db";
import { isOdooSyncLate, nextOdooSlotLabel, normMo, odooAgreement, odooDiffers, type OdooSyncSummary } from "@/lib/domain/odooSync";

// What the Odoo sync last did, for Admin → Settings. The sync itself is not
// run from here: a scheduled task on the owner's computer reads Odoo in the
// Claude desktop app's browser (lib/domain/odooPull.ts) and writes through
// the database's odoo_ingest() — see lib/domain/odooSync.ts.

export interface OdooSyncStatus {
  last: { status: string; startedAtISO: string; finishedAtISO: string | null; summary: OdooSyncSummary | null; error: string | null } | null;
  lastOkAtISO: string | null;
  /** The last scheduled run should have landed and did not. */
  late: boolean;
  nextLabel: string;
  /** The close-out log's rows that read differently from Odoo right now. */
  differs: number;
}

/** How many of the log's rows read differently from what Odoo said last. */
export async function countOdooDiffers(): Promise<number> {
  const [rows, states] = await Promise.all([
    prisma.odooEntry.findMany({ where: { NOT: { odooMo: "" } }, select: { odooMo: true, status: true, fgCode: true } }),
    prisma.odooMoState.findMany({ select: { name: true, found: true, state: true, productCode: true } }),
  ]);
  const by = new Map(states.map((x) => [x.name, x]));
  return rows.filter((r) => odooDiffers(odooAgreement(r, by.get(normMo(r.odooMo))))).length;
}

export async function getOdooSyncStatus(now = new Date()): Promise<OdooSyncStatus> {
  const [last, lastOk, differs] = await Promise.all([
    prisma.odooSyncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.odooSyncRun.findFirst({ where: { status: { in: ["ok", "partial"] } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    countOdooDiffers(),
  ]);
  return {
    last: last ? {
      status: last.status, startedAtISO: last.startedAt.toISOString(), finishedAtISO: last.finishedAt?.toISOString() ?? null,
      summary: (last.summary as unknown as OdooSyncSummary | null) ?? null, error: last.error,
    } : null,
    lastOkAtISO: lastOk?.startedAt.toISOString() ?? null,
    late: isOdooSyncLate(lastOk?.startedAt ?? null, now),
    nextLabel: nextOdooSlotLabel(now),
    differs,
  };
}
