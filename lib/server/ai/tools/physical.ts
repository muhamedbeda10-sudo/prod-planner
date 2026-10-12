import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { readPhysicalRows, restorePhysicalRows, type PhysicalRowSnapshot } from "@/lib/server/rowSnapshots";
import { createPhysicalItem, deletePhysicalItem, updatePhysicalCell } from "@/app/physical/actions";
import { cell } from "@/lib/domain/aiActions";
import { snapshotRows } from "./odoo";
import { answerOf, formOf, type WriteTool } from "./types";

// PHYSICAL MATERIAL for the assistant — the store's count beside Odoo's stock:
// any cell of an item, a new item, items deleted. Each runs the tab's own
// action as the person (stock.edit); each is undone by putting the items back
// exactly as they were. Items are found with query_database ("PhysicalStock").

const TABS = ["physical"] as const;
const PERM = "stock.edit";
const NO_RIGHT = "Editing the physical stock needs the Physical material permission — the owner ticks it on Users & Permissions.";
const label = (r: PhysicalRowSnapshot) => `#${r.id} ${r.code}${r.name ? ` ${r.name}` : ""}`;
const FIELDS = ["code", "name", "uom", "note", "physical", "odoo"] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, string> = { code: "Code", name: "Name", uom: "UOM", note: "Note", physical: "Physical count", odoo: "Odoo stock" };

const restoreUndo = (rows: PhysicalRowSnapshot[]) => ({ tool: "restore_physical_rows", input: { rows: JSON.stringify(rows) } });

async function rowsFor(ids: readonly number[]): Promise<{ rows: PhysicalRowSnapshot[] } | { error: string }> {
  const rows = await readPhysicalRows([...new Set(ids)]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length > 0) return { error: `No physical stock item ${missing.slice(0, 10).map((i) => `#${i}`).join(", ")}.` };
  return { rows };
}

/** A cell as the table stores it — what the person would see after typing it. */
function stored(field: Field, value: string): string | number | null {
  const t = value.replace(/\s+/g, " ").trim();
  if (field === "physical" || field === "odoo") return Number(t.replace(/,/g, ""));
  if (field === "uom") return t.toUpperCase().slice(0, 20);
  if (field === "note") return t.slice(0, 500) || null;
  if (field === "name") return t.slice(0, 300);
  return t;
}

interface CellsInput {
  changes: { id: number; field: Field; value: string }[];
}

export const updatePhysicalItemsTool: WriteTool<CellsInput> = {
  kind: "write",
  name: "update_physical_items",
  title: "Edit physical stock items",
  description: "Edit cells of the physical stock, as the table does: code, name, uom, note, physical (the store's count) or odoo (Odoo's stock) — counts as numbers of 0 or more.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          properties: { id: { type: "integer", minimum: 1 }, field: { type: "string", enum: FIELDS }, value: { type: "string", maxLength: 500 } },
          required: ["id", "field", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
  parse(r) {
    const changes = (r.changes as CellsInput["changes"]).map((c) => ({ ...c, value: String(c.value) }));
    const bad = changes.find((c) => (c.field === "physical" || c.field === "odoo") && !(Number.isFinite(stored(c.field, c.value) as number) && (stored(c.field, c.value) as number) >= 0));
    if (bad) return `The ${FIELD_LABEL[bad.field].toLowerCase()} of #${bad.id} must be a number of 0 or more.`;
    const blankCode = changes.find((c) => c.field === "code" && !c.value.trim());
    if (blankCode) return `The code of #${blankCode.id} cannot be empty.`;
    return { changes };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const got = await rowsFor(i.changes.map((c) => c.id));
    if ("error" in got) return got;
    const byId = new Map(got.rows.map((r) => [r.id, r]));
    const changes = i.changes
      .filter((c) => byId.get(c.id)![c.field] !== stored(c.field, c.value))
      .map((c) => ({ label: `${label(byId.get(c.id)!)} · ${FIELD_LABEL[c.field]}`, before: cell(byId.get(c.id)![c.field]), after: cell(stored(c.field, c.value)) }));
    if (changes.length === 0) return { error: "Every cell reads so already." };
    return { title: `${changes.length} physical stock cell(s)`, summary: `Edit ${changes.length} cell(s) of the physical stock.`, changes, snapshot: got.rows };
  },
  async execute(i) {
    const before = await readPhysicalRows([...new Set(i.changes.map((c) => c.id))]);
    let done = 0;
    for (const c of i.changes) {
      const res = await answerOf(() => updatePhysicalCell(formOf({ id: c.id, field: c.field, value: c.value })));
      if (!res.ok) {
        if (done === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Edited ${done} of ${i.changes.length} cell(s) — stopped at #${c.id}: ${res.error ?? "refused"}.`, undo: restoreUndo(before) };
      }
      done++;
    }
    return { ok: true, message: `${done} cell(s) edited.`, undo: restoreUndo(before) };
  },
};

interface AddInput {
  code: string;
  name?: string;
  uom?: string;
  physical?: number;
  odoo?: number;
}

export const addPhysicalItemTool: WriteTool<AddInput> = {
  kind: "write",
  name: "add_physical_item",
  title: "Add a physical stock item",
  description: "Add an item to the physical stock: its Odoo product code, name, UOM, the store's count and Odoo's stock.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: 80 },
      name: { type: "string", maxLength: 300 },
      uom: { type: "string", maxLength: 20 },
      physical: { type: "number", minimum: 0, maximum: 100000000 },
      odoo: { type: "number", minimum: 0, maximum: 100000000 },
    },
    required: ["code"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const clash = await prisma.physicalStock.findFirst({ where: { code: { equals: i.code.trim(), mode: "insensitive" } }, select: { id: true, code: true } });
    if (clash) return { error: `${clash.code} is on the table already (#${clash.id}) — edit its row instead.` };
    return {
      title: `New stock item ${i.code.trim()}`,
      summary: `Add ${i.code.trim()}${i.name ? ` ${i.name}` : ""} to the physical stock — counted ${i.physical ?? 0}${i.uom ? ` ${i.uom.toUpperCase()}` : ""}, Odoo ${i.odoo ?? 0}.`,
      changes: [{ label: i.code.trim(), before: "—", after: `physical ${i.physical ?? 0} · Odoo ${i.odoo ?? 0}` }],
      snapshot: { code: i.code.trim().toUpperCase() },
    };
  },
  async execute(i) {
    const r = await createPhysicalItem(formOf({ code: i.code, name: i.name ?? "", uom: i.uom ?? "", physical: i.physical ?? 0, odoo: i.odoo ?? 0 }));
    if (!r.ok) return { ok: false, error: r.error };
    const row = await prisma.physicalStock.findFirst({ where: { code: { equals: i.code.replace(/\s+/g, " ").trim(), mode: "insensitive" } }, select: { id: true } });
    return { ok: true, message: `Added ${i.code.trim()}.`, ...(row ? { undo: { tool: "delete_physical_items", input: { ids: [row.id] } } } : {}) };
  },
};

export const deletePhysicalItemsTool: WriteTool<{ ids: number[] }> = {
  kind: "write",
  name: "delete_physical_items",
  title: "Delete physical stock items",
  description: "Delete items of the physical stock. The assistant's record keeps every column, and Undo puts them back under their own ids.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: 200, items: { type: "integer", minimum: 1 } } }, required: ["ids"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const got = await rowsFor(i.ids);
    if ("error" in got) return got;
    return {
      title: `Delete ${got.rows.length} stock item(s)`,
      summary: `Delete ${got.rows.length} item(s) of the physical stock.`,
      changes: got.rows.map((r) => ({ label: label(r), before: `physical ${r.physical} · Odoo ${r.odoo}`, after: "deleted" })),
      snapshot: got.rows,
    };
  },
  async execute(i) {
    const before = await readPhysicalRows(i.ids);
    const deleted: PhysicalRowSnapshot[] = [];
    for (const r of before) {
      const res = await answerOf(() => deletePhysicalItem(formOf({ id: r.id })));
      if (!res.ok) {
        if (deleted.length === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Deleted ${deleted.length} of ${before.length} item(s) — stopped at #${r.id}: ${res.error ?? "refused"}.`, undo: restoreUndo(deleted) };
      }
      deleted.push(r);
    }
    return { ok: true, message: `${deleted.length} item(s) deleted.`, undo: restoreUndo(deleted) };
  },
};

/** The undo of every physical-stock change above — never offered to the model. */
export const restorePhysicalRowsTool: WriteTool<{ rows: string }> = {
  kind: "write",
  name: "restore_physical_rows",
  internal: true,
  title: "Put stock items back",
  description: "Put physical stock items back exactly as they were before a change (the undo of a physical-stock change).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { rows: { type: "string", maxLength: 2_000_000 } }, required: ["rows"], additionalProperties: false },
  parse: (r) => (snapshotRows(r.rows) ? { rows: String(r.rows) } : "The items to put back cannot be read."),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const back = snapshotRows(i.rows)! as PhysicalRowSnapshot[];
    const now = await readPhysicalRows(back.map((r) => r.id));
    return {
      title: `Put ${back.length} stock item(s) back`,
      summary: `Put ${back.length} physical stock item(s) back as they were.`,
      changes: back.map((r) => ({ label: label(r), before: now.some((n) => n.id === r.id) ? "changed" : "deleted", after: "as it was" })),
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restorePhysicalRows(snapshotRows(i.rows)! as PhysicalRowSnapshot[]);
    return r.ok ? { ok: true, message: "The stock items are back as they were." } : { ok: false, error: r.error };
  },
};

export const PHYSICAL_TOOLS = [updatePhysicalItemsTool, addPhysicalItemTool, deletePhysicalItemsTool, restorePhysicalRowsTool] as const;
