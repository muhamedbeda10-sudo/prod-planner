import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { withLine } from "@/lib/server/line";
import { readMaterialRows, restoreMaterialRows, type MaterialRowSnapshot } from "@/lib/server/rowSnapshots";
import {
  createLvOrderLines, createMaterialLine, deleteMaterialLine, setActualPerUnit, setProducedQty, setSheetsUsed, setUtilization, updateMaterialGroup, updateMaterialLine,
} from "@/app/material/actions";
import { normalizeMaterialType, normalizeSheetSize, partNameFor } from "@/lib/domain/material";
import { linePermKey } from "@/lib/domain/permissions";
import type { ProductLine } from "@/lib/domain/lines";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import { snapshotRows } from "./odoo";
import { answerOf, formOf, type ActionAnswer, type WriteTool } from "./types";

// The MATERIAL tab for the assistant — the nesting's lines: the cells typed
// into the table day by day (the sheets nested for the job, the units
// produced, the sheets one unit takes, the utilization), the rest of a
// line's figures, and deleting lines. Each runs the tab's own action on the
// line's own product line (TR or LV) as the person; each is undone by putting
// the lines back exactly as they were. Lines are found with query_database
// ("MaterialUsage" by "id").

const TABS = ["material"] as const;
const NO_RIGHT = "You do not have the MATERIAL permission for these lines' product line — the owner ticks it on Users & Permissions.";
const label = (r: MaterialRowSnapshot) => `#${r.id} ${r.mo || r.bom} ${r.partCode ? `${r.partCode} ` : ""}${r.material} ${r.thicknessMm}mm ${r.sheetSize}`;
const num = (v: number | null) => (v === null ? "—" : String(Math.round(v * 1000) / 1000));

async function rowsFor(ids: readonly number[], user: Parameters<typeof hasPerm>[0]): Promise<{ rows: MaterialRowSnapshot[] } | { error: string }> {
  const rows = await readMaterialRows([...new Set(ids)]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length > 0) return { error: `No MATERIAL line ${missing.slice(0, 10).map((i) => `#${i}`).join(", ")}.` };
  if (rows.some((r) => !hasPerm(user, linePermKey(r.line, "material")))) return { error: NO_RIGHT };
  return { rows };
}

const restoreUndo = (rows: MaterialRowSnapshot[]) => ({ tool: "restore_material_rows", input: { rows: JSON.stringify(rows) } });

const CELLS = {
  sheetsUsed: { label: "Sheets nested for the job", action: setSheetsUsed },
  producedQty: { label: "Units produced", action: setProducedQty },
  actualPerUnit: { label: "Sheets for one unit", action: setActualPerUnit },
  utilization: { label: "Utilization", action: setUtilization },
} as const;
type CellField = keyof typeof CELLS;

interface CellsInput {
  changes: { id: number; field: CellField; value: number | null }[];
}

export const setMaterialCellsTool: WriteTool<CellsInput> = {
  kind: "write",
  name: "set_material_cells",
  title: "Fill MATERIAL cells",
  description:
    "Type figures into MATERIAL lines, as the table does: sheetsUsed (sheets actually nested for the job), producedQty (units produced so far), actualPerUnit (sheets one unit takes — typed, it is kept over a re-import), utilization (average utilization). null clears the cell (\"not yet\", which is not 0). Typing sheetsUsed clears a per-unit rate that came from the sheet, as the table does.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            id: { type: "integer", minimum: 1 },
            field: { type: "string", enum: ["sheetsUsed", "producedQty", "actualPerUnit", "utilization"] },
            value: { type: ["number", "null"], minimum: 0, maximum: 1000000 },
          },
          required: ["id", "field", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const got = await rowsFor(i.changes.map((c) => c.id), ctx.user);
    if ("error" in got) return got;
    const byId = new Map(got.rows.map((r) => [r.id, r]));
    const changes = i.changes
      .filter((c) => byId.get(c.id)![c.field] !== c.value)
      .map((c) => ({ label: `${label(byId.get(c.id)!)} · ${CELLS[c.field].label}`, before: num(byId.get(c.id)![c.field]), after: num(c.value) }));
    if (changes.length === 0) return { error: "Every cell reads so already." };
    return { title: `${changes.length} MATERIAL cell(s)`, summary: `Fill ${changes.length} cell(s) on ${new Set(i.changes.map((c) => c.id)).size} MATERIAL line(s).`, changes, snapshot: got.rows };
  },
  async execute(i) {
    const ids = [...new Set(i.changes.map((c) => c.id))];
    const before = await readMaterialRows(ids);
    const lineOf = new Map(before.map((r) => [r.id, r.line as ProductLine]));
    let done = 0;
    for (const c of i.changes) {
      const line = lineOf.get(c.id);
      const res: ActionAnswer = line
        ? await answerOf(() => withLine(line, () => CELLS[c.field].action(formOf({ id: c.id, [c.field]: c.value ?? "" }))))
        : { ok: false, error: `No MATERIAL line #${c.id}.` };
      if (!res.ok) {
        if (done === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Filled ${done} of ${i.changes.length} cell(s) — stopped at line #${c.id}: ${res.error ?? "refused"}.`, undo: restoreUndo(before) };
      }
      done++;
    }
    return { ok: true, message: `${done} cell(s) filled.`, undo: restoreUndo(before) };
  },
};

interface UpdateInput {
  id: number;
  units?: number;
  partName?: string;
  materialCode?: string;
  sheetsPerUnit?: number;
  weightKg?: number | null;
  soi?: string;
  mtr?: string;
  note?: string | null;
}

const FIELD_LABEL: Record<Exclude<keyof UpdateInput, "id">, string> = {
  units: "Units", partName: "Part name", materialCode: "Material code", sheetsPerUnit: "Sheets per unit (BOM)", weightKg: "Weight of a sheet (kg)",
  soi: "SOI", mtr: "MTR", note: "Note",
};

export const updateMaterialLineTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_material_line",
  title: "Correct a MATERIAL line",
  description:
    "Correct one MATERIAL line's other figures: units (quantity of units), partName, materialCode, sheetsPerUnit (sheets one unit needs per the nesting BOM), weightKg (one sheet), soi, mtr, note — only the fields given change. The line's identity (BOM, MO, part, material, thickness, sheet size) stays: to change it, delete the line and have it entered again.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      units: { type: "number", minimum: 0, maximum: 1000000 },
      partName: { type: "string", maxLength: 80 },
      materialCode: { type: "string", maxLength: 80 },
      sheetsPerUnit: { type: "number", minimum: 0, maximum: 100000 },
      weightKg: { type: ["number", "null"], minimum: 0, maximum: 100000 },
      soi: { type: "string", maxLength: 40 },
      mtr: { type: "string", maxLength: 40 },
      note: { type: ["string", "null"], maxLength: 500 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const got = await rowsFor([i.id], ctx.user);
    if ("error" in got) return got;
    const r = got.rows[0];
    const n = mergedLine(r, i);
    const changes = (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[])
      .filter((k) => i[k] !== undefined && n[k] !== r[k])
      .map((k) => ({ label: `${label(r)} · ${FIELD_LABEL[k]}`, before: cell(r[k] as string | number | null), after: cell(n[k] as string | number | null) }));
    if (changes.length === 0) return { error: `Line #${r.id} reads so already.` };
    return { title: `Correct MATERIAL line #${r.id}`, summary: `Correct ${label(r)}: ${changes.map((c) => `${c.label.split(" · ")[1]} ${c.before} → ${c.after}`).join("; ")}.`, changes, snapshot: got.rows };
  },
  async execute(i) {
    const before = await readMaterialRows([i.id]);
    if (before.length === 0) return { ok: false, error: `No MATERIAL line #${i.id}.` };
    const r = before[0];
    const n = mergedLine(r, i);
    const res = await withLine(r.line as ProductLine, () => updateMaterialLine(formOf({
      id: r.id, month: r.month, bom: r.bom, mo: r.mo, units: n.units, partCode: r.partCode, partName: n.partName, materialCode: n.materialCode,
      material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, sheetsPerUnit: n.sheetsPerUnit, actualPerUnit: r.actualPerUnit ?? "",
      sheetsUsed: r.sheetsUsed ?? "", producedQty: r.producedQty ?? "", note: n.note ?? "", soi: n.soi, mtr: n.mtr, weightKg: n.weightKg ?? "",
      utilization: r.utilization ?? "",
    })));
    return res.ok ? { ok: true, message: `Line #${r.id} corrected.`, undo: restoreUndo(before) } : { ok: false, error: res.error };
  },
};

function mergedLine(r: MaterialRowSnapshot, i: UpdateInput) {
  return {
    units: i.units ?? r.units,
    partName: i.partName === undefined ? r.partName : i.partName.trim().toUpperCase(),
    materialCode: i.materialCode === undefined ? r.materialCode : i.materialCode.trim().toUpperCase(),
    sheetsPerUnit: i.sheetsPerUnit ?? r.sheetsPerUnit,
    weightKg: i.weightKg === undefined ? r.weightKg : i.weightKg,
    soi: i.soi === undefined ? r.soi : i.soi.trim().toUpperCase(),
    mtr: i.mtr === undefined ? r.mtr : i.mtr.trim().toUpperCase(),
    note: i.note === undefined ? r.note : i.note?.trim() || null,
  };
}

export const deleteMaterialLinesTool: WriteTool<{ ids: number[] }> = {
  kind: "write",
  name: "delete_material_lines",
  title: "Delete MATERIAL lines",
  description: "Delete lines of the MATERIAL tab. The assistant's record keeps every column, and Undo puts them back under their own ids.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: 200, items: { type: "integer", minimum: 1 } } }, required: ["ids"], additionalProperties: false },
  async describe(i, ctx) {
    const got = await rowsFor(i.ids, ctx.user);
    if ("error" in got) return got;
    return {
      title: `Delete ${got.rows.length} MATERIAL line(s)`,
      summary: `Delete ${got.rows.length} line(s) of the MATERIAL tab.`,
      changes: got.rows.map((r) => ({ label: label(r), before: `${r.units} unit(s), ${num(r.sheetsUsed)} sheet(s) nested`, after: "deleted" })),
      snapshot: got.rows,
    };
  },
  async execute(i) {
    const before = await readMaterialRows(i.ids);
    const deleted: MaterialRowSnapshot[] = [];
    for (const r of before) {
      const res = await answerOf(() => withLine(r.line as ProductLine, () => deleteMaterialLine(formOf({ id: r.id }))));
      if (!res.ok) {
        if (deleted.length === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Deleted ${deleted.length} of ${before.length} line(s) — stopped at #${r.id}: ${res.error ?? "refused"}.`, undo: restoreUndo(deleted) };
      }
      deleted.push(r);
    }
    return { ok: true, message: `${deleted.length} line(s) deleted.`, undo: restoreUndo(deleted) };
  },
};

/** The undo of every MATERIAL change above — never offered to the model. */
export const restoreMaterialRowsTool: WriteTool<{ rows: string }> = {
  kind: "write",
  name: "restore_material_rows",
  internal: true,
  title: "Put MATERIAL lines back",
  description: "Put MATERIAL lines back exactly as they were before a change (the undo of a MATERIAL change).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { rows: { type: "string", maxLength: 2_000_000 } }, required: ["rows"], additionalProperties: false },
  parse: (r) => (snapshotRows(r.rows) ? { rows: String(r.rows) } : "The lines to put back cannot be read."),
  async describe(i, ctx) {
    const back = snapshotRows(i.rows)! as MaterialRowSnapshot[];
    if (back.some((r) => !hasPerm(ctx.user, linePermKey(r.line, "material")))) return { error: NO_RIGHT };
    const now = await readMaterialRows(back.map((r) => r.id));
    return {
      title: `Put ${back.length} MATERIAL line(s) back`,
      summary: `Put ${back.length} MATERIAL line(s) back as they were.`,
      changes: back.map((r) => ({ label: label(r), before: now.some((n) => n.id === r.id) ? "changed" : "deleted", after: "as it was" })),
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreMaterialRows(snapshotRows(i.rows)! as MaterialRowSnapshot[]);
    return r.ok ? { ok: true, message: "The MATERIAL lines are back as they were." } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------ new lines

/** A line's identity on the tab — one line per BOM/MO, part and sheet. */
interface LineKey {
  bom: string;
  mo: string;
  partCode: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
}

const keyWhere = (k: LineKey) => ({ month_bom_mo_partCode_material_thicknessMm_sheetSize: { month: "", ...k } });
const keyLabel = (k: LineKey) => `${k.mo || k.bom} ${k.partCode ? `${k.partCode} ` : ""}${k.material} ${k.thicknessMm}mm ${k.sheetSize}`;
const deleteUndo = (ids: number[]) => ({ tool: "delete_material_lines", input: { ids } });

interface AddLineInput extends LineKey {
  line: ProductLine;
  units: number;
  sheetsPerUnit: number;
  partName?: string;
  materialCode?: string;
  actualPerUnit?: number;
  sheetsUsed?: number;
  producedQty?: number;
  weightKg?: number;
  utilization?: number;
  soi?: string;
  mtr?: string;
  note?: string;
}

const NUM = (max: number, description?: string) => ({ type: "number", minimum: 0, maximum: max, ...(description ? { description } : {}) }) as const;

export const addMaterialLineTool: WriteTool<AddLineInput> = {
  kind: "write",
  name: "add_material_line",
  title: "Add a MATERIAL line",
  description:
    "Add a line to the MATERIAL tab by hand, as its ➕ does: the product line (TR / LV), the BOM and MO, the part, the sheet (material, thickness, size), the units and the sheets one unit needs per the nesting, with whatever else is known. The same BOM/MO, part and sheet twice is one line — correct that one instead (update_material_line). Undo deletes it.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      line: { type: "string", enum: ["TR", "LV"], description: "The product line: TR transformers, LV panels." },
      bom: { type: "string", minLength: 1, maxLength: 60 },
      mo: { type: "string", maxLength: 60, description: "The order's MO (\"\" for a BOM-level line)." },
      partCode: { type: "string", maxLength: 20, description: "The part (CF, TC, TN, CB …), \"\" for the whole job." },
      partName: { type: "string", maxLength: 80 },
      materialCode: { type: "string", maxLength: 80 },
      material: { type: "string", minLength: 1, maxLength: 60, description: "Steel, Stainless steel, Galvanized steel …" },
      thicknessMm: { type: "number", minimum: 0.1, maximum: 200 },
      sheetSize: { type: "string", minLength: 3, maxLength: 40, description: "e.g. 1250*2500." },
      units: NUM(1000000, "The quantity of units."),
      sheetsPerUnit: NUM(100000, "Sheets ONE unit needs per the nesting BOM."),
      actualPerUnit: NUM(100000, "Sheets actually nested for one unit, when known."),
      sheetsUsed: NUM(1000000, "Sheets actually nested for the job, when known."),
      producedQty: NUM(1000000, "Units produced so far."),
      weightKg: NUM(100000, "One sheet's weight."),
      utilization: NUM(100),
      soi: { type: "string", maxLength: 40 },
      mtr: { type: "string", maxLength: 40 },
      note: { type: "string", maxLength: 500 },
    },
    required: ["line", "bom", "material", "thicknessMm", "sheetSize", "units", "sheetsPerUnit"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as AddLineInput;
    const partCode = String(i.partCode ?? "").trim().toUpperCase();
    const out: AddLineInput = {
      ...i,
      bom: i.bom.replace(/[\r\n]/g, "").trim().toUpperCase(),
      mo: String(i.mo ?? "").trim(),
      partCode,
      partName: String(i.partName ?? "").trim().toUpperCase() || partNameFor(partCode),
      materialCode: String(i.materialCode ?? "").trim().toUpperCase(),
      material: normalizeMaterialType(i.material),
      sheetSize: normalizeSheetSize(i.sheetSize),
      soi: String(i.soi ?? "").trim().toUpperCase(),
      mtr: String(i.mtr ?? "").trim().toUpperCase(),
      ...(i.note?.trim() ? { note: i.note.trim() } : { note: undefined }),
    };
    if (!out.material) return "Name the sheet's material.";
    if (!out.sheetSize) return "Give the sheet size, e.g. 1250*2500.";
    return out;
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, linePermKey(i.line, "material"))) return { error: NO_RIGHT };
    const key: LineKey = { bom: i.bom, mo: i.mo, partCode: i.partCode, material: i.material, thicknessMm: i.thicknessMm, sheetSize: i.sheetSize };
    const clash = await prisma.materialUsage.findUnique({ where: keyWhere(key), select: { id: true } });
    if (clash) return { error: `${keyLabel(key)} is a line already (#${clash.id}) — correct that one instead.` };
    return {
      title: `MATERIAL: add ${keyLabel(key)}`,
      summary: `Add ${keyLabel(key)} to the ${i.line} MATERIAL tab: ${cell(i.units)} unit(s), ${cell(i.sheetsPerUnit)} sheet(s) a unit${i.sheetsUsed !== undefined ? `, ${cell(i.sheetsUsed)} nested` : ""}.`,
      changes: [{ label: keyLabel(key), before: "—", after: `${cell(i.units)} unit(s) × ${cell(i.sheetsPerUnit)} sheet(s)` }],
      snapshot: { clash: null },
    };
  },
  async execute(i) {
    const key: LineKey = { bom: i.bom, mo: i.mo, partCode: i.partCode, material: i.material, thicknessMm: i.thicknessMm, sheetSize: i.sheetSize };
    const r = await withLine(i.line, () => createMaterialLine(formOf({
      bom: i.bom, mo: i.mo, units: i.units, partCode: i.partCode, partName: i.partName, materialCode: i.materialCode, material: i.material, thicknessMm: i.thicknessMm,
      sheetSize: i.sheetSize, sheetsPerUnit: i.sheetsPerUnit, actualPerUnit: i.actualPerUnit, sheetsUsed: i.sheetsUsed, producedQty: i.producedQty, note: i.note,
      soi: i.soi, mtr: i.mtr, weightKg: i.weightKg, utilization: i.utilization,
    })));
    if (!r.ok) return { ok: false, error: r.error };
    const made = await prisma.materialUsage.findUnique({ where: keyWhere(key), select: { id: true } });
    return { ok: true, message: `${keyLabel(key)} is on the MATERIAL tab.`, ...(made ? { undo: deleteUndo([made.id]) } : {}) };
  },
};

interface LvRowsInput {
  mo: string;
  rows: { material?: string; thicknessMm: number; sheetSize?: string; sheetsPerUnit: number }[];
}

/** The LV form's rows as it saves them — its defaults filled in — with the BOM, and which are there already. */
async function lvPlan(i: LvRowsInput): Promise<{ bom: string; planQty: number; rows: (LineKey & { sheetsPerUnit: number; there: number | null })[] } | { error: string }> {
  const order = await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { bom: true, planQty: true, line: true } });
  if (!order || order.line !== "LV") return { error: `${i.mo} is not an LV panel order.` };
  const rows = [];
  for (const r of i.rows) {
    const key: LineKey = { bom: order.bom, mo: i.mo, partCode: "", material: normalizeMaterialType(r.material) || "Galvanized steel", thicknessMm: r.thicknessMm, sheetSize: normalizeSheetSize(r.sheetSize) || "1220*2440" };
    const clash = await prisma.materialUsage.findUnique({ where: keyWhere(key), select: { id: true } });
    rows.push({ ...key, sheetsPerUnit: r.sheetsPerUnit, there: clash?.id ?? null });
  }
  return { bom: order.bom, planQty: order.planQty, rows };
}

export const addLvOrderMaterialTool: WriteTool<LvRowsInput> = {
  kind: "write",
  name: "add_lv_order_material",
  title: "Add an LV order's sheets to MATERIAL",
  description:
    "LV panels: every sheet thickness ONE panel order needs, in one go, as the MATERIAL tab's LV form does — each row its material (default Galvanized steel), thickness, sheet size (default 1220*2440) and the sheets one panel needs; the BOM and the units come from the order. A sheet already on the order is skipped. Undo deletes the lines it added.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      mo: { type: "string", minLength: 1, maxLength: 60, description: "The panel order's MO." },
      rows: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            material: { type: "string", maxLength: 60 },
            thicknessMm: { type: "number", minimum: 0.1, maximum: 200 },
            sheetSize: { type: "string", maxLength: 40 },
            sheetsPerUnit: NUM(100000, "Sheets ONE panel needs."),
          },
          required: ["thicknessMm", "sheetsPerUnit"],
          additionalProperties: false,
        },
      },
    },
    required: ["mo", "rows"],
    additionalProperties: false,
  },
  parse(r) {
    const rows = r.rows as LvRowsInput["rows"];
    // the form's own defaults decide when two rows are the same sheet
    const keys = rows.map((x) => `${normalizeMaterialType(x.material) || "Galvanized steel"}|${x.thicknessMm}|${normalizeSheetSize(x.sheetSize) || "1220*2440"}`);
    const twice = keys.find((k, n) => keys.indexOf(k) !== n);
    if (twice) return `${twice.split("|").join(" ")} is listed twice — give it once.`;
    return { mo: String(r.mo).trim().toUpperCase(), rows };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, linePermKey("LV", "material"))) return { error: NO_RIGHT };
    const plan = await lvPlan(i);
    if ("error" in plan) return plan;
    const fresh = plan.rows.filter((r) => r.there === null);
    if (fresh.length === 0) return { error: `Every one of those sheets is on ${i.mo} already.` };
    return {
      title: `MATERIAL: ${fresh.length} sheet(s) of ${i.mo}`,
      summary: `Add ${fresh.length} sheet line(s) of ${i.mo} (BOM ${plan.bom}, ${cell(plan.planQty)} unit(s)) to the LV MATERIAL tab${plan.rows.length > fresh.length ? ` — ${plan.rows.length - fresh.length} already there, skipped` : ""}.`,
      changes: plan.rows.map((r): AiChange => ({ label: keyLabel(r), before: r.there === null ? "—" : `line #${r.there}`, after: r.there === null ? `${cell(r.sheetsPerUnit)} sheet(s) a panel` : "skipped — there already" })),
      snapshot: plan.rows.map((r) => r.there),
    };
  },
  async execute(i) {
    const plan = await lvPlan(i);
    if ("error" in plan) return { ok: false, error: plan.error };
    const r = await withLine("LV", () => createLvOrderLines(formOf({ mo: i.mo, rows: JSON.stringify(i.rows) })));
    if (!r.ok) return { ok: false, error: r.error };
    const ids: number[] = [];
    for (const row of plan.rows.filter((x) => x.there === null)) {
      const made = await prisma.materialUsage.findUnique({ where: keyWhere(row), select: { id: true } });
      if (made) ids.push(made.id);
    }
    return { ok: true, message: `Added ${r.added ?? ids.length} sheet line(s) of ${i.mo}.`, ...(ids.length ? { undo: deleteUndo(ids) } : {}) };
  },
};

const GROUP_TEXT = ["mtr", "soi", "mo", "bom", "note"] as const;
const GROUP_NUM = ["units", "utilization", "producedQty"] as const;
const GROUP_LABEL: Record<(typeof GROUP_TEXT)[number] | (typeof GROUP_NUM)[number], string> = {
  mtr: "MTR", soi: "SOI", mo: "MO", bom: "BOM", note: "Note", units: "Units", utilization: "Utilization", producedQty: "Units produced",
};

interface GroupInput {
  ids: number[];
  mtr?: string;
  soi?: string;
  mo?: string;
  bom?: string;
  note?: string | null;
  units?: number;
  utilization?: number | null;
  producedQty?: number | null;
}

/** A group line's value once the head's edit lands on it — as the action stores it. */
function groupValue(field: keyof typeof GROUP_LABEL, v: string | number | null): string | number | null {
  if (v === null) return null;
  if (field === "mtr" || field === "soi" || field === "bom") return String(v).trim().toUpperCase();
  if (field === "note") return String(v).trim() || null;
  if (field === "mo") return String(v).trim();
  return v;
}

export const updateMaterialGroupTool: WriteTool<GroupInput> = {
  kind: "write",
  name: "update_material_group",
  title: "Edit an SOI group on MATERIAL",
  description:
    "An SOI group's head row on the MATERIAL tab, edited as the tab does: what is given lands on EVERY line of the group — MTR, SOI, MO, BOM, units, utilization, units produced, note (null clears a number or the note). Each line keeps its own sheet figures. Undo puts the lines back.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, maxItems: 500, items: { type: "integer", minimum: 1 }, description: "The group's lines (\"MaterialUsage\".\"id\")." },
      mtr: { type: "string", maxLength: 40 },
      soi: { type: "string", maxLength: 40 },
      mo: { type: "string", maxLength: 60 },
      bom: { type: "string", minLength: 1, maxLength: 60 },
      note: { type: ["string", "null"], maxLength: 500 },
      units: NUM(1000000),
      utilization: { type: ["number", "null"], minimum: 0, maximum: 100 },
      producedQty: { type: ["number", "null"], minimum: 0, maximum: 1000000 },
    },
    required: ["ids"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as GroupInput;
    if (![...GROUP_TEXT, ...GROUP_NUM].some((k) => i[k] !== undefined)) return "Say what changes on the group.";
    return { ...i, ids: [...new Set(i.ids)] };
  },
  async describe(i, ctx) {
    const got = await rowsFor(i.ids, ctx.user);
    if ("error" in got) return got;
    const lines = new Set(got.rows.map((r) => r.line));
    if (lines.size > 1) return { error: "Those lines are on both product lines — a group is one line's." };
    const changes: AiChange[] = [];
    for (const r of got.rows) {
      for (const k of [...GROUP_TEXT, ...GROUP_NUM]) {
        if (i[k] === undefined) continue;
        const next = groupValue(k, i[k] as string | number | null);
        if (next !== (r[k] as string | number | null)) changes.push({ label: `${label(r)} · ${GROUP_LABEL[k]}`, before: cell(r[k]), after: cell(next) });
      }
    }
    if (changes.length === 0) return { error: "The group reads so already." };
    return {
      title: `Edit a MATERIAL group of ${got.rows.length} line(s)`,
      summary: `On ${got.rows.length} MATERIAL line(s): ${[...GROUP_TEXT, ...GROUP_NUM].filter((k) => i[k] !== undefined).map((k) => `${GROUP_LABEL[k]} → ${cell(groupValue(k, i[k] as string | number | null))}`).join("; ")}.`,
      changes,
      snapshot: got.rows,
    };
  },
  async execute(i) {
    const before = await readMaterialRows(i.ids);
    if (before.length === 0) return { ok: false, error: "Those MATERIAL lines are gone." };
    const fields = Object.fromEntries([...GROUP_TEXT, ...GROUP_NUM].filter((k) => i[k] !== undefined).map((k) => [k, i[k] === null ? "" : i[k]]));
    const r = await withLine(before[0].line as ProductLine, () => updateMaterialGroup(formOf({ ids: i.ids.join(","), ...fields })));
    return r.ok ? { ok: true, message: `${before.length} MATERIAL line(s) edited.`, undo: restoreUndo(before) } : { ok: false, error: r.error };
  },
};

export const MATERIAL_TOOLS = [setMaterialCellsTool, updateMaterialLineTool, addMaterialLineTool, addLvOrderMaterialTool, updateMaterialGroupTool, deleteMaterialLinesTool, restoreMaterialRowsTool] as const;
