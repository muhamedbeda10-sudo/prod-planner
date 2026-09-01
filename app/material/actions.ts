"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { normalizeMaterialType, normalizeSheetSize, parseSheetNumber } from "@/lib/domain/material";
import { parseISODate } from "@/lib/domain/dates";

// The MATERIAL tab's writes — a record of what an order ACTUALLY consumed.
// Everything is keyed on the material line's identity (BOM × order × material ×
// thickness × sheet size) — entering the same line twice edits it, it never
// becomes a second row saying something different, which is how the workbook's
// duplicates happened.

export interface MaterialActionResult {
  ok: boolean;
  error?: string;
}

function revalidateMaterial() {
  revalidatePath("/material");
}

interface LineFields {
  bom: string;
  mo: string;
  material: string;
  thicknessMm: number | null;
  sheetSize: string;
  workedAt: Date | null;
  sheetsUsed: number | null;
  sheetsPerUnit: number | null;
  unitsOverride: number | null;
  note: string | null;
}

function readLine(formData: FormData): LineFields {
  const note = String(formData.get("note") ?? "").trim();
  return {
    bom: String(formData.get("bom") ?? "").replace(/[\r\n]/g, "").trim().toUpperCase(),
    mo: String(formData.get("mo") ?? "").trim(),
    material: normalizeMaterialType(formData.get("material")),
    thicknessMm: parseSheetNumber(formData.get("thicknessMm")),
    sheetSize: normalizeSheetSize(formData.get("sheetSize")),
    workedAt: parseISODate(String(formData.get("workedAt") ?? "")),
    sheetsUsed: parseSheetNumber(formData.get("sheetsUsed")),
    sheetsPerUnit: parseSheetNumber(formData.get("sheetsPerUnit")),
    unitsOverride: parseSheetNumber(formData.get("unitsOverride")),
    note: note || null,
  };
}

/** Shared validation — the same message whether the line is new or edited. */
function validate(f: LineFields): string | null {
  if (!f.bom) return "Enter the BOM reference.";
  if (!f.material) return "Enter the material type (Steel, Stainless steel, …).";
  if (f.thicknessMm === null || f.thicknessMm <= 0) return "Enter the sheet thickness in mm.";
  if (!f.sheetSize) return "Enter the sheet size, e.g. 1220*2440.";
  if (!f.workedAt) return "Enter the date this material was worked.";
  if (f.sheetsUsed === null || f.sheetsUsed < 0) return "Enter how many sheets were actually used — that is what this line records.";
  if (f.sheetsPerUnit !== null && f.sheetsPerUnit < 0) return "Sheets per unit cannot be negative.";
  if (f.unitsOverride !== null && f.unitsOverride < 0) return "Quantity of units cannot be negative.";
  return null;
}

export async function createMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };

  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };

  const clash = await prisma.materialUsage.findUnique({
    where: {
      bom_mo_material_thicknessMm_sheetSize: {
        bom: f.bom, mo: f.mo, material: f.material, thicknessMm: f.thicknessMm!, sheetSize: f.sheetSize,
      },
    },
  });
  if (clash) {
    return {
      ok: false,
      error: `${f.material} ${f.thicknessMm}mm ${f.sheetSize} is already on ${f.bom}${f.mo ? ` / ${f.mo}` : ""} — edit that line instead of adding it twice.`,
    };
  }

  await prisma.materialUsage.create({
    data: {
      bom: f.bom, mo: f.mo, material: f.material, thicknessMm: f.thicknessMm!, sheetSize: f.sheetSize,
      workedAt: f.workedAt!, sheetsUsed: f.sheetsUsed!, sheetsPerUnit: f.sheetsPerUnit,
      unitsOverride: f.unitsOverride, note: f.note, recordedBy: guard.user?.name ?? null,
    },
  });
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

  const clash = await prisma.materialUsage.findUnique({
    where: {
      bom_mo_material_thicknessMm_sheetSize: {
        bom: f.bom, mo: f.mo, material: f.material, thicknessMm: f.thicknessMm!, sheetSize: f.sheetSize,
      },
    },
  });
  if (clash && clash.id !== id) {
    return { ok: false, error: `Another line already records ${f.material} ${f.thicknessMm}mm ${f.sheetSize} on ${f.bom}.` };
  }

  await prisma.materialUsage.update({
    where: { id },
    data: {
      bom: f.bom, mo: f.mo, material: f.material, thicknessMm: f.thicknessMm!, sheetSize: f.sheetSize,
      workedAt: f.workedAt!, sheetsUsed: f.sheetsUsed!, sheetsPerUnit: f.sheetsPerUnit,
      unitsOverride: f.unitsOverride, note: f.note, recordedBy: guard.user?.name ?? null,
    },
  });
  revalidateMaterial();
  return { ok: true };
}

/** The one-field save behind the "Sheets used" cell — correcting the number in
 *  place, straight from the table, without opening the whole line. */
export async function setSheetsUsed(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const used = parseSheetNumber(formData.get("sheetsUsed"));
  if (used === null) return { ok: false, error: "Enter how many sheets were actually used." };
  if (used < 0) return { ok: false, error: "Sheets used cannot be negative." };

  await prisma.materialUsage.update({
    where: { id },
    data: { sheetsUsed: used, recordedBy: guard.user?.name ?? null },
  });
  revalidateMaterial();
  return { ok: true };
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
