import "server-only";
import { prisma } from "@/lib/db";
import { MANUAL_BOM, MANUAL_ITEM, manualDescription, manualIdOf, manualMo, roundSheets, withPlanSpelling, type ManualJobView } from "@/lib/domain/manualJob";

/** How many finished jobs the board's list keeps in sight — the rest stay
 *  in the table, only off the list. */
const DONE_SHOWN = 60;

/** A department's jobs from outside the plan: every open one, then the
 *  latest finished — the list the planner comes back to. */
export async function getManualJobs(dept: string): Promise<ManualJobView[]> {
  const include = { machine: { select: { code: true } }, parts: { orderBy: { id: "asc" as const } } };
  const [open, done, rows] = await Promise.all([
    prisma.manualJob.findMany({ where: { dept, doneAt: null }, orderBy: { id: "desc" }, include }),
    prisma.manualJob.findMany({ where: { dept, doneAt: { not: null } }, orderBy: { doneAt: "desc" }, take: DONE_SHOWN, include }),
    prisma.worklistMachine.findMany({ where: { dept, bom: MANUAL_BOM, item: MANUAL_ITEM }, select: { mo: true, machine: { select: { code: true } } } }),
  ]);
  const on = new Map<number, string[]>();
  for (const r of rows) {
    const id = manualIdOf(r.mo);
    if (id !== null) (on.get(id) ?? on.set(id, []).get(id)!).push(r.machine.code);
  }
  return [...open, ...done].map((j) => ({
    id: j.id, dept: j.dept, title: j.title, bom: j.bom, item: j.item, qty: j.qty, doneQty: j.doneQty,
    bySheet: j.bySheet, parts: j.parts.map((p) => ({ id: p.id, bom: p.bom, item: p.item, part: p.part, pcs: p.pcs })),
    material: j.material, thicknessMm: j.thicknessMm, sheetSize: j.sheetSize, sheets: j.sheets, note: j.note,
    onMachines: on.get(j.id) ?? [], lastMachine: j.machine?.code ?? null,
    createdBy: j.createdBy, createdAtISO: j.createdAt.toISOString(), doneAtISO: j.doneAt ? j.doneAt.toISOString() : null,
  }));
}

/** The open jobs as board lines — what is left of each (pieces, or a sheet
 *  job's sheets, to the hundredth), under its own key. */
export function manualBoardLines(jobs: readonly ManualJobView[]) {
  return jobs
    .map((j) => ({ j, left: roundSheets(j.qty - j.doneQty) }))
    .filter(({ j, left }) => !j.doneAtISO && left > 0)
    .map(({ j, left }) => ({ bom: MANUAL_BOM, mo: manualMo(j.id), item: MANUAL_ITEM, description: manualDescription(j), remaining: left, deliveryISO: null, dueISO: null }));
}

/** The projects a sheet job's parts name, matched to the plan however they
 *  were typed: upper-cased BOM → the plan's own spelling. A BOM missing from
 *  the map is no project the plan carries. */
async function knownBoms(boms: readonly string[]): Promise<Map<string, string>> {
  const want = [...new Set(boms.map((b) => b.trim()).filter(Boolean))];
  if (want.length === 0) return new Map();
  const rows = await prisma.masterOrder.findMany({
    where: { OR: want.map((b) => ({ bom: { equals: b, mode: "insensitive" as const } })) },
    select: { bom: true },
    distinct: ["bom"],
  });
  return new Map(rows.map((r) => [r.bom.toUpperCase(), r.bom]));
}

/** A sheet job's parts with each BOM the plan carries in the plan's own
 *  spelling, the rest as typed — and which of them the plan does not carry. */
export async function partsWithPlanBoms<P extends { bom: string }>(parts: readonly P[]): Promise<{ parts: P[]; notInPlan: string[] }> {
  return withPlanSpelling(parts, await knownBoms(parts.map((p) => p.bom)));
}

/** The open transformer projects, A→Z — the BOMs the job form suggests. */
export async function openJobBoms(): Promise<string[]> {
  const rows = await prisma.masterOrder.findMany({ where: { status: "open", line: "TR" }, select: { bom: true }, distinct: ["bom"], orderBy: { bom: "asc" } });
  return rows.map((r) => r.bom);
}
