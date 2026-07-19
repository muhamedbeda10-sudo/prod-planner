"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { buildBomClassifier } from "@/lib/domain/normalizeBoms";
import { isItem, isDept } from "@/lib/domain/constants";
import { parseISODate } from "@/lib/domain/dates";
import { getKnownBoms } from "@/lib/server/handover";
import { importHandoverFile, type HandoverImportResult } from "@/lib/server/importHandover";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { requireDeptEdit, requirePerm } from "@/lib/server/auth";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** The log is the single source of truth — any change to it must refresh every
 *  screen that derives balances from it (worklists, tracker, dashboard, trace). */
function revalidateEverywhere() {
  for (const p of ["/handover", "/", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/tracker", "/trace", "/report", "/boms"]) {
    revalidatePath(p);
  }
}

export async function importHandoverAction(formData: FormData): Promise<HandoverImportResult> {
  const guard = await requirePerm("logs.import");
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an Excel file." };
  const buffer = await file.arrayBuffer();
  const res = await importHandoverFile(buffer);
  if (res.ok) revalidateEverywhere();
  return res;
}

async function resolveBom(raw: string): Promise<
  | { ok: true; bom: string; bomRaw: string | null }
  | { ok: false; error: string }
> {
  const known = await getKnownBoms();
  const classify = buildBomClassifier(known);
  const c = classify(raw);
  switch (c.status) {
    case "known":
      return { ok: true, bom: c.clean, bomRaw: null };
    case "corrected":
      return { ok: true, bom: c.corrected!, bomRaw: c.clean };
    case "ambiguous":
      return { ok: false, error: `Ambiguous code "${c.clean}" — matches: ${c.candidates.join(", ")}. Fix the code.` };
    case "unknown":
      return { ok: false, error: `Unknown code "${c.clean}" — not found in any plan.` };
  }
}

export async function addHandover(formData: FormData): Promise<ActionResult> {
  const dateStr = String(formData.get("date") ?? "");
  const dept = String(formData.get("dept") ?? "");
  const bomRaw = String(formData.get("bom") ?? "").trim();
  const item = String(formData.get("item") ?? "").trim().toUpperCase();
  const qty = Number(formData.get("qty"));
  const planNo = Number(formData.get("planNo"));

  const date = parseISODate(dateStr);
  if (!date) return { ok: false, error: "Invalid date." };
  if (!isDept(dept)) return { ok: false, error: "Choose a department (Cut/Welding)." };
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  if (!item || !isItem(item)) return { ok: false, error: "Choose a valid component (CF/TC/TN/CB)." };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter a positive quantity." };
  if (!Number.isInteger(planNo) || planNo <= 0) return { ok: false, error: "Invalid plan number." };
  if (!bomRaw) return { ok: false, error: "Enter a BOM code." };

  const resolved = await resolveBom(bomRaw);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const plan = await prisma.plan.findUnique({ where: { planNo } });
  if (!plan) return { ok: false, error: `Plan ${planNo} does not exist.` };

  // physical chain guard: painted ≤ welded ≤ cut ≤ order qty
  const chainError = await checkOutputChain({ dept, bom: resolved.bom, item, qty });
  if (chainError) return { ok: false, error: chainError };

  await prisma.handoverEntry.create({
    data: { date, dept, bom: resolved.bom, bomRaw: resolved.bomRaw, item, qty, planNo, source: "manual" },
  });
  revalidateEverywhere();
  return { ok: true };
}

export async function updateHandover(formData: FormData): Promise<ActionResult> {
  const id = Number(formData.get("id"));
  const qty = Number(formData.get("qty"));
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: "Invalid quantity." };
  const data: { qty: number; note: string; date?: Date } = { qty, note: "edited" };
  if (dateStr) {
    const date = parseISODate(dateStr);
    if (!date) return { ok: false, error: "Invalid date." };
    data.date = date;
  }

  const entry = await prisma.handoverEntry.findUnique({ where: { id } });
  if (!entry) return { ok: false, error: "Record not found." };
  const guard = await requireDeptEdit(entry.dept);
  if (guard.error) return { ok: false, error: guard.error };

  // physical chain guard: painted ≤ welded ≤ cut ≤ order qty (edit included)
  const chainError = await checkOutputChain({
    dept: entry.dept, bom: entry.bom, mo: entry.mo, item: entry.item, qty, excludeId: id,
  });
  if (chainError) return { ok: false, error: chainError };

  await prisma.handoverEntry.update({ where: { id }, data });
  revalidateEverywhere();
  return { ok: true };
}

/** Bulk re-date: move MANY selected log rows to a new date in one go.
 *  Permission is checked per department present in the selection (same dept
 *  rules as single-row edits). A date-only change can never break the
 *  physical chain — totals are all-time — so no chain re-check is needed. */
export async function bulkSetHandoverDate(formData: FormData): Promise<ActionResult & { updated?: number }> {
  const dateStr = String(formData.get("date") ?? "").trim();
  const ids = String(formData.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const date = parseISODate(dateStr);
  if (!date) return { ok: false, error: "Choose a valid date." };
  if (ids.length === 0) return { ok: false, error: "No rows selected." };
  if (ids.length > 500) return { ok: false, error: "Too many rows at once — max 500." };

  const entries = await prisma.handoverEntry.findMany({ where: { id: { in: ids } }, select: { id: true, dept: true } });
  if (entries.length === 0) return { ok: false, error: "Records not found." };
  for (const d of [...new Set(entries.map((e) => e.dept))]) {
    const guard = await requireDeptEdit(d);
    if (guard.error) return { ok: false, error: guard.error };
  }

  const res = await prisma.handoverEntry.updateMany({
    where: { id: { in: entries.map((e) => e.id) } },
    data: { date, note: "edited" },
  });
  revalidateEverywhere();
  return { ok: true, updated: res.count };
}

export async function deleteHandover(formData: FormData): Promise<ActionResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };

  const entry = await prisma.handoverEntry.findUnique({ where: { id } });
  if (!entry) return { ok: false, error: "Record not found." };
  const guard = await requireDeptEdit(entry.dept);
  if (guard.error) return { ok: false, error: guard.error };

  // deleting upstream output must not leave downstream hanging (weld > cut …)
  const chainError = await checkOutputChain({
    dept: entry.dept, bom: entry.bom, mo: entry.mo, item: entry.item, qty: 0, excludeId: id,
  });
  if (chainError) return { ok: false, error: chainError };

  await prisma.handoverEntry.delete({ where: { id } });
  revalidateEverywhere();
  return { ok: true };
}

