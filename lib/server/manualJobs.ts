import "server-only";
import { prisma } from "@/lib/db";
import { MANUAL_BOM, MANUAL_ITEM, manualDescription, manualIdOf, manualMo, type ManualJobView } from "@/lib/domain/manualJob";

/** How many finished jobs the board's list keeps in sight — the rest stay
 *  in the table, only off the list. */
const DONE_SHOWN = 60;

/** A department's jobs from outside the plan: every open one, then the
 *  latest finished — the list the planner comes back to. */
export async function getManualJobs(dept: string): Promise<ManualJobView[]> {
  const [open, done, rows] = await Promise.all([
    prisma.manualJob.findMany({ where: { dept, doneAt: null }, orderBy: { id: "desc" }, include: { machine: { select: { code: true } } } }),
    prisma.manualJob.findMany({ where: { dept, doneAt: { not: null } }, orderBy: { doneAt: "desc" }, take: DONE_SHOWN, include: { machine: { select: { code: true } } } }),
    prisma.worklistMachine.findMany({ where: { dept, bom: MANUAL_BOM, item: MANUAL_ITEM }, select: { mo: true, machine: { select: { code: true } } } }),
  ]);
  const on = new Map<number, string[]>();
  for (const r of rows) {
    const id = manualIdOf(r.mo);
    if (id !== null) (on.get(id) ?? on.set(id, []).get(id)!).push(r.machine.code);
  }
  return [...open, ...done].map((j) => ({
    id: j.id, dept: j.dept, title: j.title, bom: j.bom, item: j.item, qty: j.qty, doneQty: j.doneQty,
    material: j.material, thicknessMm: j.thicknessMm, sheetSize: j.sheetSize, sheets: j.sheets, note: j.note,
    onMachines: on.get(j.id) ?? [], lastMachine: j.machine?.code ?? null,
    createdBy: j.createdBy, createdAtISO: j.createdAt.toISOString(), doneAtISO: j.doneAt ? j.doneAt.toISOString() : null,
  }));
}

/** The open jobs as board lines — what is left of each, under its own key. */
export function manualBoardLines(jobs: readonly ManualJobView[]) {
  return jobs
    .filter((j) => !j.doneAtISO && j.qty - j.doneQty > 0)
    .map((j) => ({ bom: MANUAL_BOM, mo: manualMo(j.id), item: MANUAL_ITEM, description: manualDescription(j), remaining: j.qty - j.doneQty, deliveryISO: null, dueISO: null }));
}
