import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { withLine } from "@/lib/server/line";
import { readOdooRows, restoreOdooRows, type OdooRowSnapshot } from "@/lib/server/rowSnapshots";
import { addOdooNote, createOdooEntry, deleteOdooEntry, deleteOdooNote, setOdooMo, setOdooStatus, updateOdooEntry } from "@/app/odoo/actions";
import { linePermKey } from "@/lib/domain/permissions";
import { ODOO_STATUSES } from "@/lib/domain/odoo";
import { cell } from "@/lib/domain/aiActions";
import { answerOf, formOf, type WriteTool } from "./types";

// The ODOO log for the assistant — the daily log of close attempts: a row's
// status and Odoo MO, a correction, a note, a new row, a row deleted. Each
// runs the tab's own action as the person (the line's ODOO permission); each
// is undone by putting the rows back exactly as they were, notes and the
// moment a row was closed included. Rows are found with query_database
// ("OdooEntry" by "id").

const TABS = ["odoo"] as const;
const day = (iso: string) => iso.slice(0, 10);
const rowLabel = (r: OdooRowSnapshot) => `#${r.id} ${day(r.date)} ${r.odooMo || "(no MO)"} ${r.product} ×${r.qty}`;
const NO_RIGHT = "You do not have the ODOO permission for these rows' line — the owner ticks it on Users & Permissions.";
const IDS = { type: "array", minItems: 1, maxItems: 200, items: { type: "integer", minimum: 1 }, description: "The rows' ids (\"OdooEntry\".\"id\")." } as const;
const STATUS = { type: "string", minLength: 1, maxLength: 40, description: `The status: ${ODOO_STATUSES.join(", ")} (or the plant's own wording).` } as const;

/** The rows, every one found and the person allowed on each one's line. */
async function rowsFor(ids: readonly number[], user: Parameters<typeof hasPerm>[0]): Promise<{ rows: OdooRowSnapshot[] } | { error: string }> {
  const rows = await readOdooRows([...new Set(ids)]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length > 0) return { error: `No ODOO row ${missing.slice(0, 10).map((i) => `#${i}`).join(", ")}.` };
  if (rows.some((r) => !hasPerm(user, linePermKey(r.line, "odoo")))) return { error: NO_RIGHT };
  return { rows };
}

/** The undo of any change to existing rows: those rows as they were. */
const restoreUndo = (rows: OdooRowSnapshot[]) => ({ tool: "restore_odoo_rows", input: { rows: JSON.stringify(rows) } });

export const setOdooStatusTool: WriteTool<{ ids: number[]; status: string }> = {
  kind: "write",
  name: "set_odoo_status",
  title: "Set the status of ODOO rows",
  description: "Move the status of one or more ODOO log rows (Done closes them now; a row Done already keeps the moment it was closed).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { ids: IDS, status: STATUS }, required: ["ids", "status"], additionalProperties: false },
  async describe(i, ctx) {
    const got = await rowsFor(i.ids, ctx.user);
    if ("error" in got) return got;
    const moving = got.rows.filter((r) => r.status !== i.status);
    if (moving.length === 0) return { error: `Every row is ${i.status} already.` };
    return {
      title: `${moving.length} ODOO row(s) → ${i.status}`,
      summary: `Set ${moving.length} ODOO row(s) to "${i.status}".`,
      changes: moving.map((r) => ({ label: rowLabel(r), before: r.status, after: i.status })),
      snapshot: got.rows,
    };
  },
  async execute(i) {
    const before = await readOdooRows(i.ids);
    const ids = before.filter((r) => r.status !== i.status).map((r) => r.id);
    const r = await setOdooStatus(formOf({ ids: ids.join(","), status: i.status }));
    return r.ok ? { ok: true, message: `${ids.length} row(s) set to ${i.status}.`, undo: restoreUndo(before) } : { ok: false, error: r.error };
  },
};

export const setOdooMoTool: WriteTool<{ ids: number[]; odooMo: string }> = {
  kind: "write",
  name: "set_odoo_mo",
  title: "Fill the Odoo MO of ODOO rows",
  description: "Type Odoo's MO number onto one or more ODOO log rows — a row born from a closing waits for it.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { ids: IDS, odooMo: { type: "string", minLength: 1, maxLength: 60, description: "Odoo's MO, e.g. SF01/MO/06234." } }, required: ["ids", "odooMo"], additionalProperties: false },
  parse: (r) => ({ ids: r.ids as number[], odooMo: String(r.odooMo).trim().toUpperCase() }),
  async describe(i, ctx) {
    const got = await rowsFor(i.ids, ctx.user);
    if ("error" in got) return got;
    const moving = got.rows.filter((r) => r.odooMo !== i.odooMo);
    if (moving.length === 0) return { error: `Every row has ${i.odooMo} already.` };
    return {
      title: `Odoo MO ${i.odooMo} on ${moving.length} row(s)`,
      summary: `Put the Odoo MO ${i.odooMo} on ${moving.length} ODOO row(s).`,
      changes: moving.map((r) => ({ label: rowLabel(r), before: cell(r.odooMo), after: i.odooMo })),
      snapshot: got.rows,
    };
  },
  async execute(i) {
    const before = await readOdooRows(i.ids);
    const r = await setOdooMo(formOf({ ids: i.ids.join(","), odooMo: i.odooMo }));
    return r.ok ? { ok: true, message: `MO ${i.odooMo} is on ${i.ids.length} row(s).`, undo: restoreUndo(before) } : { ok: false, error: r.error };
  },
};

interface UpdateInput {
  id: number;
  date?: string;
  soi?: string | null;
  product?: string;
  odooMo?: string;
  qty?: number;
  status?: string;
}

export const updateOdooEntryTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_odoo_entry",
  title: "Correct an ODOO row",
  description: "Correct one ODOO log row: its day, SOI, product, Odoo MO, quantity or status — only the fields given change.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      date: { type: "string", format: "date" },
      soi: { type: ["string", "null"], maxLength: 40 },
      product: { type: "string", minLength: 1, maxLength: 60 },
      odooMo: { type: "string", maxLength: 60 },
      qty: { type: "number", minimum: 0, maximum: 1000000 },
      status: STATUS,
    },
    required: ["id"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const got = await rowsFor([i.id], ctx.user);
    if ("error" in got) return got;
    const r = got.rows[0];
    const next = merged(r, i);
    const changes = [
      ["Day", day(r.date), next.date],
      ["SOI", r.soi ?? "", next.soi ?? ""],
      ["Product", r.product, next.product],
      ["Odoo MO", r.odooMo, next.odooMo],
      ["Qty", String(r.qty), String(next.qty)],
      ["Status", r.status, next.status],
    ].filter(([, a, b]) => a !== b).map(([label, a, b]) => ({ label: `#${r.id} ${label}`, before: cell(a), after: cell(b) }));
    if (changes.length === 0) return { error: `Row #${r.id} reads so already.` };
    return { title: `Correct ODOO row #${r.id}`, summary: `Correct ODOO row ${rowLabel(r)}: ${changes.map((c) => `${c.label.replace(/^#\d+ /, "")} ${c.before} → ${c.after}`).join("; ")}.`, changes, snapshot: got.rows };
  },
  async execute(i) {
    const before = await readOdooRows([i.id]);
    if (before.length === 0) return { ok: false, error: `No ODOO row #${i.id}.` };
    const n = merged(before[0], i);
    const r = await updateOdooEntry(formOf({ id: i.id, date: n.date, soi: n.soi ?? "", product: n.product, odooMo: n.odooMo, qty: n.qty, status: n.status }));
    return r.ok ? { ok: true, message: `Row #${i.id} corrected.`, undo: restoreUndo(before) } : { ok: false, error: r.error };
  },
};

function merged(r: OdooRowSnapshot, i: UpdateInput) {
  return {
    date: i.date ?? day(r.date),
    soi: i.soi === undefined ? r.soi : i.soi?.trim().toUpperCase() || null,
    product: i.product?.trim() ?? r.product,
    odooMo: i.odooMo === undefined ? r.odooMo : i.odooMo.trim().toUpperCase(),
    qty: i.qty ?? r.qty,
    status: i.status?.trim() ?? r.status,
  };
}

interface AddInput {
  line: "TR" | "LV";
  date: string;
  soi?: string;
  product: string;
  odooMo: string;
  qty: number;
  status?: string;
}

export const addOdooEntryTool: WriteTool<AddInput> = {
  kind: "write",
  name: "add_odoo_entry",
  title: "Add an ODOO row",
  description: "Add a row to the ODOO log — one close attempt: the day, the product, Odoo's MO and the quantity (status MO to be close unless said).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      line: { type: "string", enum: ["TR", "LV"], description: "Transformers or LV panels." },
      date: { type: "string", format: "date" },
      soi: { type: "string", maxLength: 40 },
      product: { type: "string", minLength: 1, maxLength: 60, description: "Tank, Top Cover, Core Frame, Cable Box …" },
      odooMo: { type: "string", minLength: 1, maxLength: 60 },
      qty: { type: "number", minimum: 0, maximum: 1000000 },
      status: STATUS,
    },
    required: ["line", "date", "product", "odooMo", "qty"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, linePermKey(i.line, "odoo"))) return { error: NO_RIGHT };
    const twin = await prisma.odooEntry.count({ where: { odooMo: i.odooMo.trim().toUpperCase(), date: new Date(`${i.date}T00:00:00Z`) } });
    return {
      title: `New ODOO row ${i.odooMo.toUpperCase()}`,
      summary: `Add an ODOO row (${i.line}): ${i.date} ${i.product} ${i.odooMo.toUpperCase()} ×${i.qty}, ${i.status ?? "MO to be close"}${twin ? ` — the log has ${twin} row(s) of this MO on that day already` : ""}.`,
      changes: [{ label: `${i.date} ${i.odooMo.toUpperCase()}`, before: "—", after: `${i.product} ×${i.qty} · ${i.status ?? "MO to be close"}` }],
      snapshot: { twin },
    };
  },
  async execute(i) {
    const r = await withLine(i.line, () => createOdooEntry(formOf({ line: i.line, date: i.date, soi: i.soi ?? "", product: i.product, odooMo: i.odooMo, qty: i.qty, status: i.status ?? "" })));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The row was not added." };
    return { ok: true, message: `Added ODOO row #${r.id}.`, undo: { tool: "delete_odoo_entries", input: { ids: [r.id] } } };
  },
};

export const addOdooNoteTool: WriteTool<{ id: number; text: string }> = {
  kind: "write",
  name: "add_odoo_note",
  title: "Add a note to an ODOO row",
  description: "Add one note to an ODOO log row (it keeps its time and author).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, text: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["id", "text"], additionalProperties: false },
  async describe(i, ctx) {
    const got = await rowsFor([i.id], ctx.user);
    if ("error" in got) return got;
    const r = got.rows[0];
    return { title: `Note on ODOO row #${r.id}`, summary: `Add the note "${i.text}" to ODOO row ${rowLabel(r)}.`, changes: [{ label: rowLabel(r), before: `${r.notes.length} note(s)`, after: `+ "${i.text}"` }], snapshot: got.rows };
  },
  async execute(i) {
    const r = await addOdooNote(formOf({ id: i.id, text: i.text }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The note was not added." };
    return { ok: true, message: `Note added to row #${i.id}.`, undo: { tool: "delete_odoo_note", input: { noteId: r.id } } };
  },
};

export const deleteOdooNoteTool: WriteTool<{ noteId: number }> = {
  kind: "write",
  name: "delete_odoo_note",
  title: "Delete a note of an ODOO row",
  description: "Delete one note of an ODOO log row (\"OdooNote\".\"id\"); the row and its other notes stay.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { noteId: { type: "integer", minimum: 1 } }, required: ["noteId"], additionalProperties: false },
  async describe(i, ctx) {
    const note = await prisma.odooNote.findUnique({ where: { id: i.noteId }, select: { entryId: true, text: true } });
    if (!note) return { error: `No ODOO note #${i.noteId}.` };
    const got = await rowsFor([note.entryId], ctx.user);
    if ("error" in got) return got;
    return { title: `Delete a note of ODOO row #${note.entryId}`, summary: `Delete the note "${note.text}" of ODOO row ${rowLabel(got.rows[0])}.`, changes: [{ label: rowLabel(got.rows[0]), before: `"${note.text}"`, after: "deleted" }], snapshot: got.rows };
  },
  async execute(i) {
    const note = await prisma.odooNote.findUnique({ where: { id: i.noteId }, select: { entryId: true } });
    if (!note) return { ok: false, error: `No ODOO note #${i.noteId}.` };
    const before = await readOdooRows([note.entryId]);
    const r = await deleteOdooNote(formOf({ noteId: i.noteId }));
    return r.ok ? { ok: true, message: "Note deleted.", undo: restoreUndo(before) } : { ok: false, error: r.error };
  },
};

export const deleteOdooEntriesTool: WriteTool<{ ids: number[] }> = {
  kind: "write",
  name: "delete_odoo_entries",
  title: "Delete ODOO rows",
  description: "Delete rows of the ODOO log, with their notes. The assistant's record keeps every column, and Undo puts them back under their own ids.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { ids: IDS }, required: ["ids"], additionalProperties: false },
  async describe(i, ctx) {
    const got = await rowsFor(i.ids, ctx.user);
    if ("error" in got) return got;
    return {
      title: `Delete ${got.rows.length} ODOO row(s)`,
      summary: `Delete ${got.rows.length} row(s) of the ODOO log${got.rows.some((r) => r.notes.length) ? ", with their notes" : ""}.`,
      changes: got.rows.map((r) => ({ label: rowLabel(r), before: `${r.status}${r.notes.length ? ` · ${r.notes.length} note(s)` : ""}`, after: "deleted" })),
      snapshot: got.rows,
    };
  },
  async execute(i) {
    const before = await readOdooRows(i.ids);
    const deleted: OdooRowSnapshot[] = [];
    for (const r of before) {
      const res = await answerOf(() => deleteOdooEntry(formOf({ id: r.id })));
      if (!res.ok) {
        // what was deleted stays deleted — recorded, with its undo, and the
        // message says where it stopped
        if (deleted.length === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Deleted ${deleted.length} of ${before.length} row(s) — stopped at #${r.id}: ${res.error ?? "refused"}.`, undo: restoreUndo(deleted) };
      }
      deleted.push(r);
    }
    return { ok: true, message: `${deleted.length} row(s) deleted.`, undo: restoreUndo(deleted) };
  },
};

/** The undo of every ODOO change above — never offered to the model. */
export const restoreOdooRowsTool: WriteTool<{ rows: string }> = {
  kind: "write",
  name: "restore_odoo_rows",
  internal: true,
  title: "Put ODOO rows back",
  description: "Put ODOO log rows back exactly as they were before a change, notes included (the undo of an ODOO change).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { rows: { type: "string", maxLength: 2_000_000 } }, required: ["rows"], additionalProperties: false },
  parse: (r) => (snapshotRows(r.rows) ? { rows: String(r.rows) } : "The rows to put back cannot be read."),
  async describe(i, ctx) {
    const back = snapshotRows(i.rows)! as OdooRowSnapshot[];
    if (back.some((r) => !hasPerm(ctx.user, linePermKey(r.line, "odoo")))) return { error: NO_RIGHT };
    const now = await readOdooRows(back.map((r) => r.id));
    return {
      title: `Put ${back.length} ODOO row(s) back`,
      summary: `Put ${back.length} ODOO row(s) back as they were.`,
      changes: back.map((r) => ({ label: rowLabel(r), before: now.some((n) => n.id === r.id) ? "changed" : "deleted", after: "as it was" })),
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreOdooRows(snapshotRows(i.rows)! as OdooRowSnapshot[]);
    return r.ok ? { ok: true, message: "The ODOO rows are back as they were." } : { ok: false, error: r.error };
  },
};

/** A snapshot's rows out of their JSON — each with its id — or null. */
export function snapshotRows(raw: unknown): { id: number }[] | null {
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r === "object" && Number.isInteger((r as { id?: unknown }).id)) ? (v as { id: number }[]) : null;
  } catch {
    return null;
  }
}

export const ODOO_TOOLS = [
  setOdooStatusTool,
  setOdooMoTool,
  updateOdooEntryTool,
  addOdooEntryTool,
  addOdooNoteTool,
  deleteOdooNoteTool,
  deleteOdooEntriesTool,
  restoreOdooRowsTool,
] as const;
