"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getActiveLine } from "@/lib/server/line";
import { MANUAL_SORT, importNestingTracker, type MaterialImportResult } from "@/lib/server/material";
import { normalizeMaterialType, normalizeSheetSize, parseSheetNumber, partNameFor, rateIsTyped } from "@/lib/domain/material";
import { monthLabelFromInput } from "@/lib/domain/dates";
import { isUniqueViolation, userMessage } from "@/lib/server/errors";

// The MATERIAL tab's writes. The tab is one living table — no month: every
// line is keyed on its MO × BOM × part × material × thickness × sheet size
// (the month key stays "" — older sheets filed under a plan month keep theirs,
// the archive). Entering the same line twice edits it, it never becomes a
// second row saying something different.

export interface MaterialActionResult {
  ok: boolean;
  error?: string;
}

function revalidateMaterial() {
  revalidatePath("/material");
}

/** The month a line is filed under: "" for the living table (a new line, or
 *  one of it being edited), or an archived sheet's label kept as it was. */
function readMonth(v: FormDataEntryValue | null): string {
  const raw = String(v ?? "").trim();
  return monthLabelFromInput(raw) ?? raw;
}

interface LineFields {
  month: string; bom: string; mo: string; units: number | null; partCode: string; partName: string; materialCode: string;
  material: string; thicknessMm: number | null;
  sheetSize: string; sheetsPerUnit: number | null; actualPerUnit: number | null; sheetsUsed: number | null; producedQty: number | null; note: string | null;
  soi: string; mtr: string; weightKg: number | null; utilization: number | null;
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
    soi: String(formData.get("soi") ?? "").trim().toUpperCase(),
    mtr: String(formData.get("mtr") ?? "").trim().toUpperCase(),
    weightKg: parseSheetNumber(formData.get("weightKg")),
    utilization: parseSheetNumber(formData.get("utilization")),
  };
}

function validate(f: LineFields): string | null {
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
    soi: f.soi, mtr: f.mtr, weightKg: f.weightKg, utilization: f.utilization,
  };
}

const lineLabel = (f: LineFields) => `${f.partCode ? `${f.partCode} ` : ""}${f.material} ${f.thicknessMm}mm ${f.sheetSize}`;


export async function createMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const clash = await prisma.materialUsage.findUnique({ where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: keyOf(f) } });
  if (clash) return { ok: false, error: `${lineLabel(f)} is already on ${f.mo || f.bom} — edit that line instead.` };
  // a typed line goes after the sheet's rows, in the order it was typed
  await prisma.materialUsage.create({ data: { ...dataOf(f, guard.user?.name ?? null, f.actualPerUnit !== null), line: await getActiveLine(), sortOrder: MANUAL_SORT } });
  revalidateMaterial();
  return { ok: true };
}

export async function updateMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const line = await getActiveLine();
  const guard = await requirePerm(linePermKey(line, "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const f = readLine(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const [clash, was] = await Promise.all([
    prisma.materialUsage.findUnique({ where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: keyOf(f) } }),
    // the permission checked is the active line's, so only that line's rows are reachable
    prisma.materialUsage.findFirst({ where: { id, line }, select: { actualPerUnit: true, actualPerUnitManual: true } }),
  ]);
  if (clash && clash.id !== id) return { ok: false, error: `Another line already records ${lineLabel(f)} on ${f.mo || f.bom}.` };
  if (!was) return { ok: false, error: "That material line is gone — refresh the page." };
  await prisma.materialUsage.update({ where: { id }, data: dataOf(f, guard.user?.name ?? null, rateIsTyped(was, f.actualPerUnit)) });
  revalidateMaterial();
  return { ok: true };
}

/** The three cells typed straight into the table. An empty box clears the
 *  value — "not nested yet" / "nothing produced yet" / "no rate of its own" —
 *  which is not zero. */
async function setCell(formData: FormData, field: "actualPerUnit" | "sheetsUsed" | "producedQty" | "utilization", label: string): Promise<MaterialActionResult> {
  const line = await getActiveLine();
  const guard = await requirePerm(linePermKey(line, "material"));
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
    const was = await prisma.materialUsage.findFirst({ where: { id, line }, select: { actualPerUnitManual: true } });
    if (!was) return { ok: false, error: "That material line is gone — refresh the page." };
    if (!was.actualPerUnitManual) data.actualPerUnit = null;
  }

  // the permission checked is the active line's, so only that line's rows are reachable
  const res = await prisma.materialUsage.updateMany({ where: { id, line }, data });
  if (res.count === 0) return { ok: false, error: "That material line is gone — refresh the page." };
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

export async function setUtilization(formData: FormData): Promise<MaterialActionResult> {
  return setCell(formData, "utilization", "average utilization");
}

/** The fields an SOI group's head row writes to EVERY line under it. They
 *  are the order's, not the sheet's per-material figures — those stay on
 *  each line. */
const GROUP_FIELDS = ["mtr", "soi", "mo", "bom", "units", "utilization", "producedQty", "note"] as const;
type GroupField = (typeof GROUP_FIELDS)[number];

function readIds(v: FormDataEntryValue | null): number[] | null {
  const ids = String(v ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
  return ids.length > 0 && ids.length <= 2000 ? [...new Set(ids)] : null;
}

/** The head row of an SOI group, edited like any line: what is typed there
 *  lands on every line of the group. Only the fields sent change; an empty
 *  box clears the field (a number "not typed yet", a blank MTR / SOI / note),
 *  except the keys and the units a line cannot be without. */
export async function updateMaterialGroup(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const ids = readIds(formData.get("ids"));
  if (!ids) return { ok: false, error: "Invalid material lines." };
  const data: Record<string, unknown> = {};
  for (const field of GROUP_FIELDS as readonly GroupField[]) {
    if (!formData.has(field)) continue;
    const raw = String(formData.get(field) ?? "").trim();
    switch (field) {
      case "mtr": case "soi": data[field] = raw.toUpperCase(); break;
      case "note": data.note = raw || null; break;
      case "mo": data.mo = raw; break;
      case "bom": {
        const bom = raw.replace(/[\r\n]/g, "").toUpperCase();
        if (!bom) return { ok: false, error: "Enter the BOM reference." };
        data.bom = bom;
        break;
      }
      default: {
        const v = raw === "" ? null : parseSheetNumber(raw);
        if (raw !== "" && v === null) return { ok: false, error: "Enter a number, or clear the box." };
        if (v !== null && v < 0) return { ok: false, error: "A quantity cannot be negative." };
        if (field === "units" && v === null) return { ok: false, error: "Enter the quantity of units." };
        data[field] = v;
      }
    }
  }
  if (Object.keys(data).length === 0) return { ok: true };
  data.recordedBy = guard.user?.name ?? null;
  const line = await getActiveLine();
  try {
    const res = await prisma.materialUsage.updateMany({ where: { id: { in: ids }, line }, data });
    if (res.count === 0) return { ok: false, error: "Those material lines are gone — refresh the page." };
  } catch (e) {
    // a new MO / BOM can collide with a line already recorded under it
    if (isUniqueViolation(e)) return { ok: false, error: "A line with the same part, material, thickness and size is already on that MO / BOM — edit or delete it first." };
    throw e;
  }
  revalidateMaterial();
  return { ok: true };
}

/** Delete every line of an SOI group at once (its head row's menu). */
export async function deleteMaterialLines(formData: FormData): Promise<MaterialActionResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const ids = readIds(formData.get("ids"));
  if (!ids) return { ok: false, error: "Invalid material lines." };
  await prisma.materialUsage.deleteMany({ where: { id: { in: ids }, line: await getActiveLine() } });
  revalidateMaterial();
  return { ok: true };
}

export async function deleteMaterialLine(formData: FormData): Promise<MaterialActionResult> {
  const line = await getActiveLine();
  const guard = await requirePerm(linePermKey(line, "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid material line." };
  const res = await prisma.materialUsage.deleteMany({ where: { id, line } });
  if (res.count === 0) return { ok: false, error: "That material line is gone — refresh the page." };
  revalidateMaterial();
  return { ok: true };
}

export async function importMaterialAction(formData: FormData): Promise<MaterialImportResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the material sheet (Excel)." };
  const preview = formData.get("preview") === "true";
  const prune = formData.get("prune") === "on" || formData.get("prune") === "true";
  try {
    const res = await importNestingTracker(await file.arrayBuffer(), guard.user?.name ?? null, preview, prune);
    if (res.ok && !preview) revalidateMaterial();
    return res;
  } catch (e) {
    return { ok: false, error: userMessage(e, "import the sheet") };
  }
}

/** LV: every thickness row of ONE panel order in one go. `rows` is the JSON
 *  the form built — material, thickness, sheet size, sheets per unit; the
 *  BOM and the planned qty come from the order itself. */
export async function createLvOrderLines(formData: FormData): Promise<MaterialActionResult & { added?: number; skipped?: number }> {
  const line = await getActiveLine();
  if (line !== "LV") return { ok: false, error: "Switch the line to LV panels first." };
  const guard = await requirePerm(linePermKey(line, "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const month = ""; // the living table
  const mo = String(formData.get("mo") ?? "").trim().toUpperCase();
  if (!mo) return { ok: false, error: "Pick the panel order (MO)." };
  const order = await prisma.masterOrder.findUnique({ where: { mo }, select: { bom: true, planQty: true, line: true } });
  if (!order || order.line !== "LV") return { ok: false, error: `${mo} is not an LV panel order.` };

  let parsed: unknown;
  try { parsed = JSON.parse(String(formData.get("rows") ?? "[]")); } catch { return { ok: false, error: "The rows could not be read — try again." }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, error: "Add at least one thickness row." };
  const rows: { material: string; thicknessMm: number; sheetSize: string; sheetsPerUnit: number }[] = [];
  for (const raw of parsed as Record<string, unknown>[]) {
    const thicknessMm = parseSheetNumber(raw.thicknessMm);
    const sheetsPerUnit = parseSheetNumber(raw.sheetsPerUnit);
    if (thicknessMm === null || thicknessMm <= 0) continue; // an empty spare row
    if (sheetsPerUnit === null || sheetsPerUnit < 0) return { ok: false, error: `${thicknessMm} mm: enter the sheets ONE unit needs.` };
    rows.push({
      material: normalizeMaterialType(raw.material) || "Galvanized steel",
      thicknessMm,
      sheetSize: normalizeSheetSize(raw.sheetSize) || "1220*2440",
      sheetsPerUnit,
    });
  }
  if (rows.length === 0) return { ok: false, error: "Add at least one thickness row with its sheets per unit." };

  let added = 0, skipped = 0;
  const by = guard.user?.name ?? null;
  for (const r of rows) {
    const key = { month, bom: order.bom, mo, partCode: "", material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize };
    const clash = await prisma.materialUsage.findUnique({ where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: key } });
    if (clash) { skipped += 1; continue; }
    await prisma.materialUsage.create({ data: { ...key, units: order.planQty, sheetsPerUnit: r.sheetsPerUnit, recordedBy: by, line, sortOrder: MANUAL_SORT } });
    added += 1;
  }
  revalidateMaterial();
  return { ok: true, added, skipped };
}
