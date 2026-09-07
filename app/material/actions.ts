"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { importNestingTracker, type MaterialImportResult } from "@/lib/server/material";
import { normalizeMaterialType, normalizeSheetSize, parseSheetNumber } from "@/lib/domain/material";
import { monthLabelFromInput } from "@/lib/domain/dates";

// The MATERIAL tab's writes. Every line is keyed on month × BOM × order ×
// material × thickness × sheet size — entering the same line twice edits it,
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
  month: string; bom: string; mo: string; units: number | null; material: string; thicknessMm: number | null;
  sheetSize: string; sheetsPerUnit: number | null; sheetsUsed: number | null; producedQty: number | null; note: string | null;
}

function readLine(formData: FormData): LineFields {
  const note = String(formData.get("note") ?? "").trim();
  return {
    month: readMonth(formData.get("month")),
    bom: String(formData.get("bom") ?? "").replace(/[\r\n]/g, "").trim().toUpperCase(),
    mo: String(formData.get("mo") ?? "").trim(),
    units: parseSheetNumber(formData.get("units")),
    material: normalizeMaterialType(formData.get("material")),
    thicknessMm: parseSheetNumber(formData.get("thicknessMm")),
    sheetSize: normalizeSheetSize(formData.get("sheetSize")),
    sheetsPerUnit: parseSheetNumber(formData.get("sheetsPerUnit")),
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
  if (f.sheetsUsed !== null && f.sheetsUsed < 0) return "Sheets actually nested cannot be negative.";
  if (f.producedQty !== null && f.producedQty < 0) return "Units produced cannot be negative.";
  return null;
}

function keyOf(f: LineFields) {
  return { month: f.month, bom: f.bom, mo: f.mo, material: f.material, thicknessMm: f.thicknessMm!, sheetSize: f.sheetSize };
}

function dataOf(f: LineFields, by: string | null) {
  return {
    ...keyOf(f), units: f.units!, sheetsPerUnit: f.sheetsPerUnit!, sheetsUsed: f.sheetsUsed,
    producedQty: f.producedQty, note: f.note, recordedBy: by,
  };
}

export async function createMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const clash = await prisma.materialUsage.findUnique({ where: { month_bom_mo_material_thicknessMm_sheetSize: keyOf(f) } });
  if (clash) return { ok: false, error: `${f.material} ${f.thicknessMm}mm ${f.sheetSize} is already on ${f.bom} for ${f.month} — edit that line instead.` };
  await prisma.materialUsage.create({ data: dataOf(f, guard.user?.name ?? null) });
  revalidateMaterial();
  return { ok: true };
}

export async function updateMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const clash = await prisma.materialUsage.findUnique({ where: { month_bom_mo_material_thicknessMm_sheetSize: keyOf(f) } });
  if (clash && clash.id !== id) return { ok: false, error: `Another line already records ${f.material} ${f.thicknessMm}mm ${f.sheetSize} on ${f.bom} for ${f.month}.` };
  await prisma.materialUsage.update({ where: { id }, data: dataOf(f, guard.user?.name ?? null) });
  revalidateMaterial();
  return { ok: true };
}

/** The two cells typed straight into the table. An empty box clears the
 *  value — "not nested yet" / "nothing produced yet" — which is not zero. */
async function setCell(formData: FormData, field: "sheetsUsed" | "producedQty", label: string): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const raw = String(formData.get(field) ?? "").trim();
  const v = raw === "" ? null : parseSheetNumber(raw);
  if (raw !== "" && v === null) return { ok: false, error: `Enter a number for ${label}, or clear the box.` };
  if (v !== null && v < 0) return { ok: false, error: `${label} cannot be negative.` };
  await prisma.materialUsage.update({ where: { id }, data: { [field]: v, recordedBy: guard.user?.name ?? null } });
  revalidateMaterial();
  return { ok: true };
}

export async function setSheetsUsed(formData: FormData): Promise<MaterialActionResult> {
  return setCell(formData, "sheetsUsed", "sheets actually nested");
}

export async function setProducedQty(formData: FormData): Promise<MaterialActionResult> {
  return setCell(formData, "producedQty", "units produced");
}

export async function deleteMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  await prisma.materialUsage.delete({ where: { id } });
  revalidateMaterial();
  return { ok: true };
}

export async function importMaterialAction(formData: FormData): Promise<MaterialImportResult> {
  const guard = await requirePerm("material.edit");
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
