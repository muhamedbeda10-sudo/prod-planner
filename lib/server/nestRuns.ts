import "server-only";
import { prisma } from "@/lib/db";
import { RUN_BOM, RUN_ITEM, runIdOf, runSheet, type NestRunView } from "@/lib/domain/nestRun";

/** How many finished runs the board's list keeps in sight. */
const DONE_SHOWN = 40;

/** A department's nest runs: every open one, then the latest finished. */
export async function getNestRuns(dept: string): Promise<NestRunView[]> {
  const [open, done, rows] = await Promise.all([
    prisma.nestRun.findMany({ where: { dept, doneAt: null }, orderBy: { id: "desc" }, include: { parts: { orderBy: { id: "asc" } } } }),
    prisma.nestRun.findMany({ where: { dept, doneAt: { not: null } }, orderBy: { doneAt: "desc" }, take: DONE_SHOWN, include: { parts: { orderBy: { id: "asc" } } } }),
    prisma.worklistMachine.findMany({ where: { dept, bom: RUN_BOM, item: RUN_ITEM }, select: { mo: true, machineId: true, machine: { select: { code: true } } } }),
  ]);
  const on = new Map<number, string[]>();
  const onIds = new Map<number, number[]>();
  for (const r of rows) {
    const id = runIdOf(r.mo);
    if (id === null) continue;
    (on.get(id) ?? on.set(id, []).get(id)!).push(r.machine.code);
    (onIds.get(id) ?? onIds.set(id, []).get(id)!).push(r.machineId);
  }
  return [...open, ...done].map((r) => ({
    id: r.id, material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, sheets: r.sheets, sheetsDone: r.sheetsDone, identical: r.identical, sheetMinutes: r.sheetMinutes, note: r.note,
    parts: r.parts.map((p) => ({ id: p.id, bom: p.bom, mo: p.mo, item: p.item, pcs: p.pcs, donePcs: p.donePcs, consumedPcs: p.consumedPcs, replaces: p.replaces })),
    onMachines: on.get(r.id) ?? [],
    machineIds: onIds.get(r.id) ?? [],
    createdBy: r.createdBy, createdAtISO: r.createdAt.toISOString(), doneAtISO: r.doneAt ? r.doneAt.toISOString() : null,
  }));
}

/** The part of each line's sheet the runs hold — not yet counted by the
 *  item's Cut record (cut or still to cut). */
export function runCover(runs: readonly NestRunView[]): { key: string; sheet: string; pcs: number }[] {
  const out: { key: string; sheet: string; pcs: number }[] = [];
  for (const r of runs) for (const p of r.parts) {
    const pcs = p.pcs - p.consumedPcs;
    if (pcs > 0) out.push({ key: `${p.bom}|${p.mo}|${p.item}`, sheet: p.replaces || runSheet(r), pcs });
  }
  return out;
}

/** What the runs have CUT of each line's sheet and the Cut record has not
 *  counted yet — beside the machines' own sheet figures, what makes a piece whole. */
export function runCut(runs: readonly NestRunView[]): { key: string; sheet: string; sheetDone: number }[] {
  const out: { key: string; sheet: string; sheetDone: number }[] = [];
  for (const r of runs) for (const p of r.parts) {
    const n = p.donePcs - p.consumedPcs;
    if (n > 0) out.push({ key: `${p.bom}|${p.mo}|${p.item}`, sheet: p.replaces || runSheet(r), sheetDone: n });
  }
  return out;
}
