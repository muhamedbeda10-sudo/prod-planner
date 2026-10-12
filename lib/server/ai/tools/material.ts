import "server-only";
import { hasPerm } from "@/lib/server/auth";
import { withLine } from "@/lib/server/line";
import { readMaterialRows, restoreMaterialRows, type MaterialRowSnapshot } from "@/lib/server/rowSnapshots";
import { deleteMaterialLine, setActualPerUnit, setProducedQty, setSheetsUsed, setUtilization, updateMaterialLine } from "@/app/material/actions";
import { linePermKey } from "@/lib/domain/permissions";
import type { ProductLine } from "@/lib/domain/lines";
import { cell } from "@/lib/domain/aiActions";
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

export const MATERIAL_TOOLS = [setMaterialCellsTool, updateMaterialLineTool, deleteMaterialLinesTool, restoreMaterialRowsTool] as const;
