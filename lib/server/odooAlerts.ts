import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { FINISHED_STATUSES, isReadyToClose, needsMo, type ReadyRow } from "@/lib/domain/odooAlerts";
import { odooRowBomLabel } from "@/lib/domain/odoo";
import { resolveRowBoms, resolveRowMaterialStates } from "@/lib/server/odoo";
import type { MoMaterialState } from "@/lib/domain/odooMaterial";

const SELECT = { id: true, line: true, date: true, soi: true, fgCode: true, product: true, odooMo: true, qty: true, status: true, source: true, ledgerId: true } as const;

type Row = { id: number; line: string; date: Date; soi: string | null; fgCode: string; product: string; odooMo: string; qty: number; status: string; source: string; ledgerId: number | null };

/** The rows as the popup lists them — each with its BOM, read the way the log reads it. */
async function view(rows: Row[]): Promise<ReadyRow[]> {
  const boms = await resolveRowBoms(rows);
  return rows.map((r, i) => ({
    id: r.id, line: r.line, dateISO: toISODate(r.date), soi: r.soi, bom: odooRowBomLabel(boms[i]), product: r.product,
    odooMo: r.odooMo, qty: r.qty, status: r.status, source: r.source,
  }));
}

// The two alert lists and the bar's count read the log the same way: the
// still-open rows with (ready to close) or without (needs an MO) Odoo's MO,
// oldest first — the order they wait in. The closed rows, the bulk of the
// log and growing for ever, stay in the database; the domain rule still has
// the last word on what comes back, and a popup lists at most SHOWN of them.
const READ = 400, SHOWN = 200;
const KINDS = {
  close: { where: { NOT: { odooMo: "" } }, rule: isReadyToClose },
  mo: { where: { odooMo: "" }, rule: needsMo },
} as const;
function readOpen<S extends Record<string, true>>(kind: keyof typeof KINDS, select: S) {
  return prisma.odooEntry.findMany({
    where: { ...KINDS[kind].where, status: { notIn: [...FINISHED_STATUSES], mode: "insensitive" } },
    select,
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: READ,
  });
}

/** Every row, both lines, that has Odoo's MO and is still open. */
export async function getReadyToClose(): Promise<ReadyRow[]> {
  return view((await readOpen("close", SELECT)).filter(isReadyToClose).slice(0, SHOWN));
}

/** Every row, both lines, still waiting for Odoo's MO number. */
export async function getNeedingMo(): Promise<ReadyRow[]> {
  return view((await readOpen("mo", SELECT)).filter(needsMo).slice(0, SHOWN));
}

/** The bar's badge: how many rows getReadyToClose / getNeedingMo would list,
 *  read off the two columns the rules need — without resolving each row's BOM. */
export async function countOdooAlerts(wantClose: boolean, wantMo: boolean): Promise<number> {
  const count = async (kind: keyof typeof KINDS) =>
    Math.min(SHOWN, (await readOpen(kind, { odooMo: true, status: true })).filter(KINDS[kind].rule).length);
  const [ready, mo] = await Promise.all([wantClose ? count("close") : 0, wantMo ? count("mo") : 0]);
  return ready + mo;
}

/** The Material-tab state of these rows' MOs, by row id — the popup's row
 *  colours, the ODOO log's. Asked for only while the popup is open, so the
 *  minute's poll stays two small reads. */
export async function getRowsMaterial(ids: readonly number[]): Promise<Record<number, MoMaterialState>> {
  if (ids.length === 0) return {};
  const rows = await prisma.odooEntry.findMany({ where: { id: { in: [...ids] } }, select: SELECT });
  const states = await resolveRowMaterialStates(rows);
  return Object.fromEntries(rows.map((r, i) => [r.id, states[i]]));
}
