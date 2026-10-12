import "server-only";
import type { HandoverEntry } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { bulkDeleteHandover, bulkSetHandoverDate, updateHandover } from "@/app/handover/actions";
import { ledgerPermKey } from "@/lib/domain/permissions";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import { formOf, type ActionAnswer, type WriteTool } from "./types";

// The Daily log for the assistant: correcting a row's quantity or day, moving
// rows to another day, deleting rows — through the log's own actions, so the
// chain check, the tanks behind a welding row and the Odoo row behind a
// painting row all follow exactly as when the person does it on /handover.
// The rows are found with query_database ("HandoverEntry", by "id").

const day = (d: Date) => d.toISOString().slice(0, 10);
const rowLabel = (e: HandoverEntry) => `#${e.id} ${day(e.date)} ${e.dept} ${e.mo ?? e.bom} ${e.item}`;
const NO_RIGHT = "You do not have the permission to edit these Daily log rows — the owner ticks it on Users & Permissions.";

async function entriesOf(ids: readonly number[]): Promise<{ rows: HandoverEntry[] } | { error: string }> {
  const rows = await prisma.handoverEntry.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: "asc" } });
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length > 0) return { error: `No Daily log row ${missing.slice(0, 10).map((i) => `#${i}`).join(", ")}.` };
  return { rows };
}

interface UpdateInput {
  id: number;
  qty: number;
  date?: string;
}

export const updateLogEntryTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_log_entry",
  title: "Correct a Daily log row",
  description:
    "Correct one Daily log row (\"HandoverEntry\" by id): its quantity, and optionally its day. The chain is re-checked; a welding row's tanks and a painting row's Odoo row follow. Find the id with query_database first.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description: "The row's id." },
      qty: { type: "number", minimum: 0, maximum: 1000000, description: "The corrected quantity (0 keeps the row at nothing — delete it instead to remove it)." },
      date: { type: "string", format: "date", description: "The corrected day, YYYY-MM-DD; leave out to keep it." },
    },
    required: ["id", "qty"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const e = await prisma.handoverEntry.findUnique({ where: { id: i.id } });
    if (!e) return { error: `No Daily log row #${i.id}.` };
    if (!hasPerm(ctx.user, ledgerPermKey(e.dept, e.item))) return { error: NO_RIGHT };
    const sameDay = !i.date || i.date === day(e.date);
    if (e.qty === i.qty && sameDay) return { error: `Row #${i.id} reads so already.` };
    const chain = await checkOutputChain({ dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: i.qty, excludeId: e.id });
    if (chain) return { error: chain };
    const changes: AiChange[] = [];
    if (e.qty !== i.qty) changes.push({ label: `${rowLabel(e)} qty`, before: cell(e.qty), after: cell(i.qty) });
    if (!sameDay) changes.push({ label: `${rowLabel(e)} day`, before: day(e.date), after: i.date! });
    return {
      title: `Correct log row #${e.id}`,
      summary: `Correct the ${e.dept} row of ${e.mo ?? e.bom} ${e.item} on ${day(e.date)}: ${changes.map((c) => `${c.before} → ${c.after}`).join(", ")}.`,
      changes,
      snapshot: { id: e.id, qty: e.qty, date: day(e.date) },
    };
  },
  async execute(i) {
    const e = await prisma.handoverEntry.findUnique({ where: { id: i.id } });
    if (!e) return { ok: false, error: `No Daily log row #${i.id}.` };
    const r: ActionAnswer = await updateHandover(formOf({ id: i.id, qty: i.qty, date: i.date ?? "" }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `Row #${i.id} corrected.`, undo: { tool: "update_log_entry", input: { id: i.id, qty: e.qty, date: day(e.date) } } };
  },
};

interface DatesInput {
  items: { id: number; date: string }[];
}

export const setLogDatesTool: WriteTool<DatesInput> = {
  kind: "write",
  name: "set_log_dates",
  title: "Move Daily log rows to another day",
  description: "Move Daily log rows to the day each should be on (rows recorded on the wrong day). Quantities are untouched, so the chain does not change.",
  area: "tracker",
  risk: (i) => (i.items.length > 1 ? "high" : "low"),
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "object", properties: { id: { type: "integer", minimum: 1 }, date: { type: "string", format: "date", description: "YYYY-MM-DD" } }, required: ["id", "date"], additionalProperties: false },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as DatesInput;
    if (new Set(i.items.map((x) => x.id)).size !== i.items.length) return "items: a row is listed twice.";
    return i;
  },
  async describe(i, ctx) {
    const found = await entriesOf(i.items.map((x) => x.id));
    if ("error" in found) return found;
    if (found.rows.some((e) => !hasPerm(ctx.user, ledgerPermKey(e.dept, e.item)))) return { error: NO_RIGHT };
    const want = new Map(i.items.map((x) => [x.id, x.date]));
    const moving = found.rows.filter((e) => day(e.date) !== want.get(e.id));
    if (moving.length === 0) return { error: "They are on those days already." };
    return {
      title: moving.length === 1 ? `Move log row #${moving[0].id} to ${want.get(moving[0].id)}` : `Move ${moving.length} log rows`,
      summary: `Move ${moving.length} Daily log row(s) to another day: ${moving.map((e) => `#${e.id} ${day(e.date)} → ${want.get(e.id)}`).join(", ")}.`,
      changes: moving.map((e) => ({ label: rowLabel(e), before: day(e.date), after: want.get(e.id)! })),
      snapshot: found.rows.map((e) => ({ id: e.id, date: day(e.date) })),
    };
  },
  async execute(i) {
    const found = await entriesOf(i.items.map((x) => x.id));
    if ("error" in found) return { ok: false, error: found.error };
    const was = new Map(found.rows.map((e) => [e.id, day(e.date)]));
    // the log's bulk action sets ONE day for a set of rows — one call per day
    const byDay = new Map<string, number[]>();
    for (const x of i.items) if (was.get(x.id) !== x.date) byDay.set(x.date, [...(byDay.get(x.date) ?? []), x.id]);
    const moved: number[] = [];
    const failed: string[] = [];
    for (const [d, ids] of byDay) {
      const r: ActionAnswer = await bulkSetHandoverDate(formOf({ date: d, ids: ids.join(",") }));
      if (r.ok) moved.push(...ids);
      else failed.push(`${ids.map((x) => `#${x}`).join(", ")}: ${r.error}`);
    }
    if (moved.length === 0) return { ok: false, error: failed.join(" · ") || "Nothing moved." };
    return {
      ok: true,
      message: `Moved ${moved.length} row(s).${failed.length ? ` Not moved: ${failed.join(" · ")}` : ""}`,
      undo: { tool: "set_log_dates", input: { items: moved.map((id) => ({ id, date: was.get(id)! })) } },
    };
  },
};

interface DeleteInput {
  ids: number[];
}

export const deleteLogEntriesTool: WriteTool<DeleteInput> = {
  kind: "write",
  name: "delete_log_entries",
  title: "Delete Daily log rows",
  description:
    "Delete Daily log rows by id — at most 50 at once, always with the person's explicit approval. The chain is re-checked for the batch as a whole; a welding row's tanks and a painting row's Odoo row follow. What was deleted stays in the assistant's log. Use only when the person asked for the rows to go.",
  area: "tracker",
  risk: "destructive",
  schema: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 50, description: "The rows' ids." } },
    required: ["ids"],
    additionalProperties: false,
  },
  parse: (r) => ({ ids: [...new Set((r.ids as number[]))] }),
  async describe(i, ctx) {
    const found = await entriesOf(i.ids);
    if ("error" in found) return found;
    if (found.rows.some((e) => !hasPerm(ctx.user, ledgerPermKey(e.dept, e.item)))) return { error: NO_RIGHT };
    // one check per scope the batch touches, the rows leaving together
    const scopes = new Map<string, HandoverEntry>();
    for (const e of found.rows) scopes.set(`${(e.mo ?? "").trim() || `bom:${e.bom}`}|${e.item}`, e);
    for (const e of scopes.values()) {
      const chain = await checkOutputChain({ dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: 0, excludeIds: i.ids });
      if (chain) return { error: chain };
    }
    return {
      title: `Delete ${found.rows.length} Daily log row${found.rows.length === 1 ? "" : "s"}`,
      summary: `Delete ${found.rows.length} Daily log row(s): ${found.rows.map((e) => `${rowLabel(e)} qty ${cell(e.qty)}`).join("; ")}.`,
      changes: found.rows.map((e) => ({ label: rowLabel(e), before: `qty ${cell(e.qty)}${e.createdBy ? ` · by ${e.createdBy}` : ""}`, after: "deleted" })),
      // the rows themselves: what was removed stays readable in the log
      snapshot: found.rows.map((e) => ({ ...e, date: day(e.date), createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() })),
    };
  },
  async execute(i) {
    const r = await bulkDeleteHandover(formOf({ ids: i.ids.join(",") }));
    return r.ok ? { ok: true, message: `Deleted ${r.deleted ?? i.ids.length} row(s).` } : { ok: false, error: r.error };
  },
};

export const DAILY_LOG_TOOLS = [updateLogEntryTool, setLogDatesTool, deleteLogEntriesTool] as const;
