import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { FINISHED_STATUSES, isReadyToClose, needsMo, type ReadyRow } from "@/lib/domain/odooAlerts";
import { odooRowBomLabel } from "@/lib/domain/odoo";
import { resolveRowBoms, resolveRowMaterialStates } from "@/lib/server/odoo";

const SELECT = { id: true, line: true, date: true, soi: true, fgCode: true, product: true, odooMo: true, qty: true, status: true, source: true, ledgerId: true } as const;

type Row = { id: number; line: string; date: Date; soi: string | null; fgCode: string; product: string; odooMo: string; qty: number; status: string; source: string; ledgerId: number | null };

/** The rows as the popup lists them — each with its BOM, read the way the log
 *  reads it, and, when asked, its MO against the Material tab (the log's row
 *  colour). The count in the page's layout skips the material lookup, and a
 *  failed one only leaves the rows uncoloured — the alerts still come. */
async function view(rows: Row[], material: boolean): Promise<ReadyRow[]> {
  const boms = await resolveRowBoms(rows);
  const states = material ? await resolveRowMaterialStates(rows, boms).catch(() => null) : null;
  return rows.map((r, i) => ({
    id: r.id, line: r.line, dateISO: toISODate(r.date), soi: r.soi, bom: odooRowBomLabel(boms[i]), product: r.product,
    odooMo: r.odooMo, qty: r.qty, status: r.status, source: r.source, material: states?.[i] ?? "none",
  }));
}

/** Every row, both lines, that has Odoo's MO and is still open — oldest first,
 *  the order they wait in. `material` adds each row's Material-tab state. */
export async function getReadyToClose({ material = false }: { material?: boolean } = {}): Promise<ReadyRow[]> {
  // the closed rows — the bulk of the log, growing for ever — stay in the
  // database; the domain rule still has the last word on what comes back
  const rows = await prisma.odooEntry.findMany({
    where: { NOT: { odooMo: "" }, status: { notIn: [...FINISHED_STATUSES], mode: "insensitive" } },
    select: SELECT,
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 400,
  });
  return view(rows.filter(isReadyToClose).slice(0, 200), material);
}

/** Every row, both lines, still waiting for Odoo's MO number — oldest first. */
export async function getNeedingMo(): Promise<ReadyRow[]> {
  const rows = await prisma.odooEntry.findMany({
    where: { odooMo: "", status: { notIn: [...FINISHED_STATUSES], mode: "insensitive" } },
    select: SELECT,
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 400,
  });
  return view(rows.filter(needsMo).slice(0, 200), false);
}
