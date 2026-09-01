"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { normalizeMaterialType, normalizeSheetSize, parseSheetNumber } from "@/lib/domain/material";

// The MATERIAL tab's writes. Everything is keyed on the material line's
// identity (BOM × order × material × thickness × sheet size) — entering the
// same line twice edits it, it never becomes a second row saying something
// different, which is how the workbook's duplicates happened.

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
  sheetsPerUnit: number | null;
  sheetsUsed: number | null;
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
    sheetsPerUnit: parseSheetNumber(formData.get("sheetsPerUnit")),
    sheetsUsed: parseSheetNumber(formData.get("sheetsUsed")),
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
  if (f.sheetsPerUnit === null || f.sheetsPerUnit < 0) return "Enter how many sheets ONE unit needs.";
  if (f.sheetsUsed !== null && f.sheetsUsed < 0) return "Sheets actually nested cannot be negative.";
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
      sheetsPerUnit: f.sheetsPerUnit!, sheetsUsed: f.sheetsUsed, unitsOverride: f.unitsOverride, note: f.note,
      recordedBy: guard.user?.name ?? null,
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
      sheetsPerUnit: f.sheetsPerUnit!, sheetsUsed: f.sheetsUsed, unitsOverride: f.unitsOverride, note: f.note,
      recordedBy: guard.user?.name ?? null,
    },
  });
  revalidateMaterial();
  return { ok: true };
}

/** The one-field save behind the "Actual nesting" cell — the entry the nester
 *  makes every day. An empty box means "not laid out yet", not zero sheets. */
export async function setSheetsUsed(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const raw = String(formData.get("sheetsUsed") ?? "").trim();
  const used = raw === "" ? null : parseSheetNumber(raw);
  if (raw !== "" && used === null) return { ok: false, error: "Enter a number of sheets, or clear the box." };
  if (used !== null && used < 0) return { ok: false, error: "Sheets actually nested cannot be negative." };

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

/** Copy every BOM-wide material line from one BOM onto another — the family
 *  variants (…E18M18 / E19 / E20) share one nesting BOM and differ only in
 *  how many units are ordered. */
export async function copyMaterialFromBom(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm("material.edit");
  if (guard.error) return { ok: false, error: guard.error };

  const from = String(formData.get("fromBom") ?? "").trim().toUpperCase();
  const to = String(formData.get("toBom") ?? "").trim().toUpperCase();
  if (!from || !to) return { ok: false, error: "Pick the BOM to copy from." };
  if (from === to) return { ok: false, error: "Pick a different BOM to copy from." };

  const source = await prisma.materialUsage.findMany({ where: { bom: from, mo: "" } });
  if (source.length === 0) return { ok: false, error: `${from} has no material lines to copy.` };

  // The actual nesting is NOT copied: it is this job's own record, and the
  // whole point of the difference column is that it stays empty until nested.
  let copied = 0;
  for (const s of source) {
    const created = await prisma.materialUsage.createMany({
      data: [{
        bom: to, mo: "", material: s.material, thicknessMm: s.thicknessMm, sheetSize: s.sheetSize,
        sheetsPerUnit: s.sheetsPerUnit, note: s.note, recordedBy: guard.user?.name ?? null,
      }],
      skipDuplicates: true, // a line already on the target BOM is left as it is
    });
    copied += created.count;
  }
  revalidateMaterial();
  return copied > 0 ? { ok: true } : { ok: false, error: `${to} already has every material line of ${from}.` };
}
