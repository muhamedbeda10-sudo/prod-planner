"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireDeptEdit } from "@/lib/server/auth";
import { RUN_BOM, RUN_ITEM, partsDoneAt, runMo, runSheet } from "@/lib/domain/nestRun";
import { normalizeMaterialType, normalizeSheetSize } from "@/lib/domain/material";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";

// Nest runs on the cutting machines: sheets of one thickness carrying parts
// of several jobs. The Cut worklist's permission covers them, the same as
// putting a line on a machine.

export interface NestRunResult {
  ok: boolean;
  error?: string;
}

const DEPT = "Cut";
const MAX_PARTS = 40;

function revalidate() {
  for (const p of ["/worklist/cut", "/worklist/machines", "/simulate"]) revalidatePath(p);
}

const text = (fd: FormData, k: string, max = 120) => String(fd.get(k) ?? "").trim().slice(0, max);

/** Put a run together — the sheet, how many, and every job's part on them —
 *  and queue it on a machine (an idle machine starts on it). */
export async function createNestRun(fd: FormData): Promise<NestRunResult> {
  const guard = await requireDeptEdit(DEPT);
  if (guard.error) return { ok: false, error: guard.error };
  const material = normalizeMaterialType(text(fd, "material", 60));
  const thicknessMm = Number(text(fd, "thicknessMm"));
  const sheetSize = normalizeSheetSize(text(fd, "sheetSize", 40));
  const sheets = Number(text(fd, "sheets"));
  if (!material) return { ok: false, error: "Pick the sheet's material." };
  if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) return { ok: false, error: "Thickness must be a number of mm above 0." };
  if (!Number.isInteger(sheets) || sheets <= 0) return { ok: false, error: "Sheets must be a whole number above 0." };

  let raw: unknown;
  try { raw = JSON.parse(String(fd.get("parts") ?? "[]")); } catch { return { ok: false, error: "The parts list could not be read — reload the page." }; }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "Add at least one job's part to the run." };
  if (raw.length > MAX_PARTS) return { ok: false, error: `At most ${MAX_PARTS} parts in one run.` };
  const parts: { bom: string; mo: string; item: string; pcs: number }[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const bom = String(p?.bom ?? "").trim();
    const mo = String(p?.mo ?? "").trim();
    const item = String(p?.item ?? "").trim().toUpperCase();
    const pcs = Number(p?.pcs);
    if (!bom || !item) return { ok: false, error: "A part is missing its line — pick it again." };
    if (!Number.isInteger(pcs) || pcs <= 0) return { ok: false, error: `Pieces of ${bom} ${item} must be a whole number above 0.` };
    const k = `${bom}|${mo}|${item}`;
    if (seen.has(k)) return { ok: false, error: `${bom} ${item} is in the run twice — put its pieces on one row.` };
    seen.add(k);
    parts.push({ bom, mo, item, pcs });
  }

  let machineId: number | null = null;
  const rawMachine = text(fd, "machineId");
  if (rawMachine) {
    machineId = Number(rawMachine);
    const machine = Number.isInteger(machineId) ? await prisma.machine.findUnique({ where: { id: machineId } }) : null;
    if (!machine || machine.dept !== DEPT) return { ok: false, error: "That machine is not a cutting machine." };
    if (!machine.active) return { ok: false, error: `${machine.code} is retired.` };
  }

  const by = guard.user?.name ?? null;
  await prisma.$transaction(async (tx) => {
    const run = await tx.nestRun.create({
      data: { dept: DEPT, material, thicknessMm, sheetSize, sheets, note: text(fd, "note", 500) || null, createdBy: by, parts: { create: parts } },
    });
    if (machineId === null) return;
    const [last, runningNow] = await Promise.all([
      tx.worklistMachine.aggregate({ where: { dept: DEPT, machineId }, _max: { rank: true } }),
      tx.worklistMachine.count({ where: { dept: DEPT, machineId, running: true } }),
    ]);
    await tx.worklistMachine.create({
      data: { dept: DEPT, bom: RUN_BOM, mo: runMo(run.id), item: RUN_ITEM, machineId, rank: (last._max.rank ?? 0) + 1, running: runningNow === 0, qty: null, setBy: by },
    });
  });
  revalidate();
  return { ok: true };
}

/** ✓ on a run: the sheets finished. Every part's pieces follow pro rata (the
 *  last sheet brings them all to their count) and go on the cut log with the
 *  machine; once every sheet is cut the run leaves the machine, finished. */
export async function recordNestRunSheets(fd: FormData): Promise<NestRunResult> {
  const id = Number(text(fd, "id"));
  const run = Number.isInteger(id) ? await prisma.nestRun.findUnique({ where: { id }, include: { parts: true } }) : null;
  if (!run) return { ok: false, error: "That run is gone — reload the page." };
  const guard = await requireDeptEdit(run.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const n = Number(text(fd, "qty"));
  const left = run.sheets - run.sheetsDone;
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Enter the sheets finished — a whole number above 0." };
  if (n > left) return { ok: false, error: `Only ${left} sheet(s) left on this run.` };
  const machineId = Number(text(fd, "machineId")) || null;
  const date = parseISODate(text(fd, "date")) ?? parseISODate(factoryDayISO(new Date()))!;
  const sheetsDone = run.sheetsDone + n;
  const finished = sheetsDone >= run.sheets;
  const done = partsDoneAt(run.parts, run.sheets, sheetsDone);
  const sheet = runSheet(run);
  const by = guard.user?.name ?? null;
  await prisma.$transaction(async (tx) => {
    await tx.nestRun.update({ where: { id }, data: { sheetsDone, doneAt: finished ? new Date() : null } });
    for (const p of run.parts) {
      const now = done.get(p.id) ?? p.donePcs;
      const delta = now - p.donePcs;
      if (delta <= 0) continue;
      await tx.nestRunPart.update({ where: { id: p.id }, data: { donePcs: now } });
      // kept for good: which thickness this machine cut, for which item
      await tx.sheetCutLog.create({
        data: { date, dept: run.dept, bom: p.bom, mo: p.mo, item: p.item, sheet, thicknessMm: run.thicknessMm, machineId, qty: delta, createdBy: by },
      });
    }
    if (finished) await tx.worklistMachine.deleteMany({ where: { dept: run.dept, bom: RUN_BOM, mo: runMo(id), item: RUN_ITEM } });
  });
  revalidate();
  return { ok: true };
}

/** Delete a run put together by mistake — only while none of its sheets is cut. */
export async function deleteNestRun(fd: FormData): Promise<NestRunResult> {
  const id = Number(text(fd, "id"));
  const run = Number.isInteger(id) ? await prisma.nestRun.findUnique({ where: { id } }) : null;
  if (!run) return { ok: true };
  const guard = await requireDeptEdit(run.dept);
  if (guard.error) return { ok: false, error: guard.error };
  if (run.sheetsDone > 0) return { ok: false, error: `${run.sheetsDone} of its sheets are already cut — the run stays, with what was cut.` };
  await prisma.$transaction([
    prisma.worklistMachine.deleteMany({ where: { dept: run.dept, bom: RUN_BOM, mo: runMo(id), item: RUN_ITEM } }),
    prisma.nestRun.delete({ where: { id } }),
  ]);
  revalidate();
  return { ok: true };
}
