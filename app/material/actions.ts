"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getActiveLine } from "@/lib/server/line";
import { importNestingTracker, type MaterialImportResult } from "@/lib/server/material";
import { normalizeMaterialType, normalizeSheetSize, parseSheetNumber, partNameFor, rateIsTyped } from "@/lib/domain/material";
import { monthLabelFromInput } from "@/lib/domain/dates";

// The MATERIAL tab's writes. Every line is keyed on month × BOM × order ×
// part × material × thickness × sheet size — entering the same line twice edits it,
// it never becomes a second row saying something different.

export interface MaterialActionResult {
  ok: boolean;
  error?: string;
}

function revalidateMaterial() {
  revalidatePath("/material");
}

/** The month field arrives as an <input type="month"> value ("2026-07") or,
 *  from an inline save, already as a label. Both land on the label. */
function readMonth(v: FormDataEntryValue | null): string {
  const raw = String(v ?? "").trim();
  return monthLabelFromInput(raw) ?? raw;
}

interface LineFields {
  month: string; bom: string; mo: string; units: number | null; partCode: string; partName: string; materialCode: string;
  material: string; thicknessMm: number | null;
  sheetSize: string; sheetsPerUnit: number | null; actualPerUnit: number | null; sheetsUsed: number | null; producedQty: number | null; note: string | null;
}

function readLine(formData: FormData): LineFields {
  const note = String(formData.get("note") ?? "").trim();
  const partCode = String(formData.get("partCode") ?? "").trim().toUpperCase();
  return {
    month: readMonth(formData.get("month")),
    bom: String(formData.get("bom") ?? "").replace(/[\r\n]/g, "").trim().toUpperCase(),
    mo: String(formData.get("mo") ?? "").trim(),
    units: parseSheetNumber(formData.get("units")),
    partCode,
    partName: String(formData.get("partName") ?? "").trim().toUpperCase() || partNameFor(partCode),
    materialCode: String(formData.get("materialCode") ?? "").trim().toUpperCase(),
    material: normalizeMaterialType(formData.get("material")),
    thicknessMm: parseSheetNumber(formData.get("thicknessMm")),
    sheetSize: normalizeSheetSize(formData.get("sheetSize")),
    sheetsPerUnit: parseSheetNumber(formData.get("sheetsPerUnit")),
    actualPerUnit: parseSheetNumber(formData.get("actualPerUnit")),
    sheetsUsed: parseSheetNumber(formData.get("sheetsUsed")),
    producedQty: parseSheetNumber(formData.get("producedQty")),
    note: note || null,
  };
}

function validate(f: LineFields): string | null {
  if (!f.month) return "Pick the plan month this line belongs to.";
  if (!f.bom) return "Enter the BOM reference.";
  if (f.units === null || f.units < 0) return "Enter the quantity of units.";
  if (!f.material) return "Enter the material type (Steel, Stainless steel, …).";
  if (f.thicknessMm === null || f.thicknessMm <= 0) return "Enter the sheet thickness in mm.";
  if (!f.sheetSize) return "Enter the sheet size, e.g. 1220*2440.";
  if (f.sheetsPerUnit === null || f.sheetsPerUnit < 0) return "Enter how many sheets ONE unit needs.";
  if (f.actualPerUnit !== null && f.actualPerUnit < 0) return "Sheets actually nested for one unit cannot be negative.";
  if (f.sheetsUsed !== null && f.sheetsUsed < 0) return "Sheets actually nested cannot be negative.";
  if (f.producedQty !== null && f.producedQty < 0) return "Units produced cannot be negative.";
  return null;
}

function keyOf(f: LineFields) {
  return { month: f.month, bom: f.bom, mo: f.mo, partCode: f.partCode, material: f.material, thicknessMm: f.thicknessMm!, sheetSize: f.sheetSize };
}

function dataOf(f: LineFields, by: string | null, rateTyped: boolean) {
  return {
    ...keyOf(f), units: f.units!, partName: f.partName, materialCode: f.materialCode,
    sheetsPerUnit: f.sheetsPerUnit!, actualPerUnit: f.actualPerUnit, actualPerUnitManual: rateTyped,
    sheetsUsed: f.sheetsUsed,
    producedQty: f.producedQty, note: f.note, recordedBy: by,
  };
}

const lineLabel = (f: LineFields) => `${f.partCode ? `${f.partCode} ` : ""}${f.material} ${f.thicknessMm}mm ${f.sheetSize}`;

/** Lines typed in the tab sort after any sheet's rows (a sheet has fewer rows than this). */
const MANUAL_SORT = 1_000_000;

export async function createMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const clash = await prisma.materialUsage.findUnique({ where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: keyOf(f) } });
  if (clash) return { ok: false, error: `${lineLabel(f)} is already on ${f.bom} for ${f.month} — edit that line instead.` };
  // a typed line goes after the sheet's rows, in the order it was typed
  await prisma.materialUsage.create({ data: { ...dataOf(f, guard.user?.name ?? null, f.actualPerUnit !== null), line: await getActiveLine(), sortOrder: MANUAL_SORT } });
  revalidateMaterial();
  return { ok: true };
}

export async function updateMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const [clash, was] = await Promise.all([
    prisma.materialUsage.findUnique({ where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: keyOf(f) } }),
    prisma.materialUsage.findUnique({ where: { id }, select: { actualPerUnit: true, actualPerUnitManual: true } }),
  ]);
  if (clash && clash.id !== id) return { ok: false, error: `Another line already records ${lineLabel(f)} on ${f.bom} for ${f.month}.` };
  if (!was) return { ok: false, error: "That material line is gone — refresh the page." };
  await prisma.materialUsage.update({ where: { id }, data: dataOf(f, guard.user?.name ?? null, rateIsTyped(was, f.actualPerUnit)) });
  revalidateMaterial();
  return { ok: true };
}

/** The three cells typed straight into the table. An empty box clears the
 *  value — "not nested yet" / "nothing produced yet" / "no rate of its own" —
 *  which is not zero. */
async function setCell(formData: FormData, field: "actualPerUnit" | "sheetsUsed" | "producedQty", label: string): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const raw = String(formData.get(field) ?? "").trim();
  const v = raw === "" ? null : parseSheetNumber(raw);
  if (raw !== "" && v === null) return { ok: false, error: `Enter a number for ${label}, or clear the box.` };
  if (v !== null && v < 0) return { ok: false, error: `${label} cannot be negative.` };
  const data: Record<string, unknown> = { [field]: v, recordedBy: guard.user?.name ?? null };

  if (field === "actualPerUnit") {
    // Typing the rate makes it HIS: a re-import fills the blank lines and
    // leaves this one standing. Clearing the box hands it back to the sheet.
    data.actualPerUnitManual = v !== null;
  } else if (field === "sheetsUsed") {
    // Typing the job's nested sheets by hand overrides the SHEET's per-unit
    // rate, so that one must not survive it — left standing, the tab would
    // show a rate that no longer divides into the figure beside it. Cleared,
    // the rate falls back to this number over the units, which is exactly
    // what was just typed. A rate he typed himself is his own statement and
    // stays: he can clear it in its own box if he wants the division back.
    const was = await prisma.materialUsage.findUnique({ where: { id }, select: { actualPerUnitManual: true } });
    if (!was) return { ok: false, error: "That material line is gone — refresh the page." };
    if (!was.actualPerUnitManual) data.actualPerUnit = null;
  }

  await prisma.materialUsage.update({ where: { id }, data });
  revalidateMaterial();
  return { ok: true };
}

export async function setActualPerUnit(formData: FormData): Promise<MaterialActionResult> {
  return setCell(formData, "actualPerUnit", "sheets for one unit");
}

export async function setSheetsUsed(formData: FormData): Promise<MaterialActionResult> {
  return setCell(formData, "sheetsUsed", "sheets actually nested");
}

export async function setProducedQty(formData: FormData): Promise<MaterialActionResult> {
  return setCell(formData, "producedQty", "units produced");
}

export async function deleteMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  await prisma.materialUsage.delete({ where: { id } });
  revalidateMaterial();
  return { ok: true };
}

/** Wipe a whole month's lines — the planner re-imports a month from a fresh
 *  sheet, or filed one under the wrong month. Cannot be undone. */
export async function deleteMaterialMonth(formData: FormData): Promise<MaterialActionResult & { deleted?: number }> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const month = readMonth(formData.get("month"));
  if (!month || month === "all") return { ok: false, error: "Pick one month to delete." };
  // the caller says how many lines it is looking at; a mismatch means the
  // month changed under them — stop rather than delete something unseen
  const expected = Number(formData.get("expected"));
  const count = await prisma.materialUsage.count({ where: { month } });
  if (Number.isInteger(expected) && expected !== count) {
    return { ok: false, error: `${month} now has ${count} line(s), not ${expected} — reload and try again.` };
  }
  const { count: deleted } = await prisma.materialUsage.deleteMany({ where: { month } });
  revalidateMaterial();
  return { ok: true, deleted };
}

export async function importMaterialAction(formData: FormData): Promise<MaterialImportResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the Nesting Tracker Excel file." };
  const month = readMonth(formData.get("month"));
  if (!month) return { ok: false, error: "Pick the plan month this sheet is for." };
  const preview = formData.get("preview") === "true";
  try {
    const res = await importNestingTracker(await file.arrayBuffer(), month, guard.user?.name ?? null, preview);
    if (res.ok && !preview) revalidateMaterial();
    return res;
  } catch (e) {
    return { ok: false, error: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
