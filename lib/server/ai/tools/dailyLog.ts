import "server-only";
import type { HandoverEntry } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { getPlanWindows, getSettings } from "@/lib/server/data";
import { getDefaultPlanForDate } from "@/lib/server/handover";
import { resolveWorkerByEmpId } from "@/lib/server/workers";
import { bulkDeleteHandover, bulkSetHandoverDate, updateHandover } from "@/app/handover/actions";
import { recordOutput } from "@/app/worklist/actions";
import { ledgerPermKey } from "@/lib/domain/permissions";
import { DEPTS, ITEMS, deptLabel, isDept, stageItemError } from "@/lib/domain/constants";
import { LV_ITEM, LV_STAGES } from "@/lib/domain/lv";
import { TANK_ITEM } from "@/lib/domain/tanks";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import { formOf, type ActionAnswer, type WriteTool } from "./types";

// The Daily log for the assistant: recording output (what a production sheet
// or a photo of one says was made), correcting a row's quantity or day,
// moving rows to another day, deleting rows — through the screens' own
// actions, so the chain check, the tanks behind a welding row and the Odoo
// row behind a painting row all follow exactly as when the person does it.
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

// ------------------------------------------------------------------ record

interface OutputRow {
  date: string;
  dept: string;
  mo?: string;
  bom?: string;
  item: string;
  qty: number;
  welder?: string;
}

interface OutputInput {
  rows: OutputRow[];
}

/** How far back output may be recorded here: a date older than this on a
 *  sheet is far likelier a misread than a late record. */
const OUTPUT_DAYS_BACK = 62;
/** The order the stages are recorded in, so an upstream stage of the same
 *  batch is in the log before the one downstream is checked against it. */
const STAGE_ORDER = ["Cut", "Punching", "Bending", "Welding", "Painting"];
const stageRank = (dept: string) => STAGE_ORDER.indexOf(dept);
const scopeOf = (r: { mo?: string; bom?: string }) => (r.mo ? { mo: r.mo } : { bom: r.bom! });
const groupKey = (r: OutputRow) => `${r.mo || `bom:${r.bom}`}|${r.item}|${r.dept}`;

interface PlannedOutput {
  row: OutputRow;
  bom: string;
  workerId: number | null;
}

/** Every row checked as the worklist checks it, and resolved: the order's
 *  BOM, who welded a tank. What is wrong with the first row that fails. */
async function planOutput(i: OutputInput, todayISO: string, user: Parameters<typeof hasPerm>[0]): Promise<PlannedOutput[] | { error: string }> {
  const tankTracking = (await getSettings()).tankTracking;
  const earliest = addDaysISO(todayISO, -OUTPUT_DAYS_BACK);
  const out: PlannedOutput[] = [];
  for (const r of i.rows) {
    const what = `${r.mo || r.bom} ${r.item} ${r.dept} ${r.date}`;
    const panel = r.item === LV_ITEM;
    if (panel ? !(LV_STAGES as readonly string[]).includes(r.dept) : !isDept(r.dept)) {
      return { error: `${what}: ${panel ? "a panel is recorded at Punching, Bending, Welding or Painting" : `a part is recorded at ${DEPTS.join(", ")}`}.` };
    }
    if (!hasPerm(user, ledgerPermKey(r.dept, r.item))) return { error: `${what}: you do not have the permission to record ${panel ? "panels" : deptLabel(r.dept)} output — the owner ticks it on Users & Permissions.` };
    const pair = panel ? null : stageItemError(r.dept, r.item);
    if (pair) return { error: `${what}: ${pair}` };
    if (r.date > todayISO) return { error: `${what}: that day has not come yet.` };
    if (r.date < earliest) return { error: `${what}: that is more than ${OUTPUT_DAYS_BACK} days back — check the date; an old record goes on the Daily log by hand.` };
    if (tankTracking && r.item === TANK_ITEM && r.dept === "Painting") return { error: `${what}: tanks are painted from the Painting worklist, tank by tank — not as a quantity.` };
    if ((panel || (tankTracking && r.item === TANK_ITEM && r.dept === "Welding")) && !Number.isInteger(r.qty)) return { error: `${what}: ${panel ? "panels" : "tanks"} are recorded by the piece — a whole number.` };
    let bom = r.bom ?? "";
    if (r.mo) {
      const order = await prisma.masterOrder.findUnique({ where: { mo: r.mo }, select: { bom: true, line: true } });
      if (!order) return { error: `${what}: ${r.mo} is not in the orders registry — check the MO.` };
      if (bom && bom !== order.bom) return { error: `${what}: ${r.mo} is BOM ${order.bom}, not ${bom}.` };
      if (panel !== (order.line === "LV")) return { error: `${what}: ${r.mo} is ${order.line === "LV" ? "an LV panel order — its item is PNL" : "a transformer order"}.` };
      bom = order.bom;
    } else {
      if (panel) return { error: `${what}: a panel is recorded on its MO.` };
      if (!(await prisma.handoverEntry.findFirst({ where: { bom }, select: { id: true } }))) return { error: `${what}: the BOM ${bom} has no history — record it on its MO.` };
    }
    let workerId: number | null = null;
    if (tankTracking && r.item === TANK_ITEM && r.dept === "Welding") {
      if (!r.mo) return { error: `${what}: a tank needs its MO to carry its serial.` };
      if (!r.welder) return { error: `${what}: welding tanks names who welded them — give the welder's badge number.` };
      const w = await resolveWorkerByEmpId(r.welder, "Welding");
      if (!w.worker) return { error: `${what}: ${w.error ?? "no such welder"}` };
      workerId = w.worker.id;
    }
    out.push({ row: r, bom, workerId });
  }
  // each order × item × stage checked once, with everything the batch adds to it
  const groups = new Map<string, PlannedOutput[]>();
  for (const p of out) groups.set(groupKey(p.row), [...(groups.get(groupKey(p.row)) ?? []), p]);
  for (const [, ps] of [...groups].sort(([, a], [, b]) => stageRank(a[0].row.dept) - stageRank(b[0].row.dept))) {
    const r = ps[0].row;
    const chain = await checkOutputChain({ dept: r.dept, bom: ps[0].bom, mo: r.mo || null, item: r.item, qty: ps.reduce((s, p) => s + p.row.qty, 0) });
    if (chain) return { error: `${chain}${groups.size > 1 ? " (When the same order's earlier stage is on this sheet too, record that stage first, then this one.)" : ""}` };
  }
  return out;
}

/** The plan a day's output is booked to, as the Daily log's form picks it:
 *  the plan covering the day, else the newest, else the setup bucket. */
async function planNoFor(dateISO: string): Promise<number> {
  const covering = await getDefaultPlanForDate(new Date(`${dateISO}T00:00:00.000Z`));
  if (covering !== null) return covering;
  const windows = await getPlanWindows();
  return windows.length ? Math.max(...windows.map((w) => w.planNo)) : 0;
}

async function stageTotal(r: OutputRow): Promise<number> {
  const a = await prisma.handoverEntry.aggregate({ where: { ...scopeOf(r), item: r.item, dept: r.dept }, _sum: { qty: true } });
  return a._sum.qty ?? 0;
}

export const recordOutputTool: WriteTool<OutputInput> = {
  kind: "write",
  name: "record_output",
  title: "Record output in the Daily log",
  description:
    "Record what was made — the rows of a production sheet, or a photo of one — in the Daily log, as the worklists record it: each row a day, a stage (Cut, Welding, Painting for transformer parts; Punching, Bending, Welding, Painting for panels, item PNL), the order's MO (or a BOM-level line's BOM), the item and the quantity made that day. The chain is checked (painted ≤ welded ≤ cut ≤ the order). Welding tanks while tanks are tracked names the welder's badge and mints their serials. Undo deletes the rows it made.",
  area: "tracker",
  risk: "high",
  tabs: ["handover"],
  schema: {
    type: "object",
    properties: {
      rows: {
        type: "array",
        minItems: 1,
        maxItems: 60,
        items: {
          type: "object",
          properties: {
            date: { type: "string", format: "date", description: "The day it was made." },
            dept: { type: "string", enum: [...new Set([...DEPTS, ...LV_STAGES])], description: "The stage." },
            mo: { type: "string", maxLength: 80, description: "The order's MO." },
            bom: { type: "string", maxLength: 80, description: "Only for a line recorded on its BOM without an MO." },
            item: { type: "string", enum: [...ITEMS, LV_ITEM], description: "CF, TC, TN, CB, AR, MB — or PNL for an LV panel." },
            qty: { type: "number", minimum: 0.001, maximum: 100000 },
            welder: { type: "string", maxLength: 40, description: "Welding tanks while tanks are tracked: the welder's badge number." },
          },
          required: ["date", "dept", "item", "qty"],
          additionalProperties: false,
        },
      },
    },
    required: ["rows"],
    additionalProperties: false,
  },
  parse(r) {
    const rows = (r.rows as OutputRow[]).map((x) => ({
      ...x,
      mo: x.mo?.trim().toUpperCase() || undefined,
      bom: x.bom?.trim().toUpperCase() || undefined,
      item: x.item.toUpperCase(),
      welder: x.welder?.trim() || undefined,
    }));
    const bare = rows.find((x) => !x.mo && !x.bom);
    if (bare) return `Name the MO (or the BOM) of the ${bare.item} ${bare.dept} row of ${bare.date}.`;
    const seen = new Set<string>();
    for (const x of rows) {
      const k = `${x.date}|${groupKey(x)}`;
      if (seen.has(k)) return `${x.mo || x.bom} ${x.item} ${x.dept} on ${x.date} is listed twice — give it once, with the sum.`;
      seen.add(k);
    }
    return { rows: rows.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as unknown as OutputRow) };
  },
  async describe(i, ctx) {
    const plan = await planOutput(i, ctx.todayISO, ctx.user);
    if ("error" in plan) return plan;
    const groups = new Map<string, OutputRow[]>();
    for (const p of plan) groups.set(groupKey(p.row), [...(groups.get(groupKey(p.row)) ?? []), p.row]);
    const totals: { key: string; total: number }[] = [];
    const changes: AiChange[] = [];
    for (const [key, rows] of groups) {
      const r = rows[0];
      const total = await stageTotal(r);
      const add = rows.reduce((s, x) => s + x.qty, 0);
      totals.push({ key, total });
      changes.push({
        label: `${r.mo || r.bom} ${r.item} ${r.item === LV_ITEM ? r.dept : deptLabel(r.dept)}`,
        before: cell(total),
        after: `${cell(total + add)} (+${cell(add)} on ${[...new Set(rows.map((x) => x.date))].sort().join(", ")})`,
      });
    }
    const pieces = i.rows.reduce((s, x) => s + x.qty, 0);
    return {
      title: `Record ${i.rows.length} output row(s)`,
      summary: `Record ${i.rows.length} row(s) of output in the Daily log — ${cell(pieces)} piece(s) over ${groups.size} order line(s) and stage(s).`,
      changes,
      snapshot: totals,
    };
  },
  async execute(i, ctx) {
    const plan = await planOutput(i, ctx.todayISO, ctx.user);
    if ("error" in plan) return { ok: false, error: plan.error };
    const ordered = [...plan].sort((a, b) => stageRank(a.row.dept) - stageRank(b.row.dept));
    const ids: number[] = [];
    const serials: string[] = [];
    for (const p of ordered) {
      const r = p.row;
      const res = await recordOutput(formOf({ date: r.date, dept: r.dept, bom: p.bom, mo: r.mo ?? "", item: r.item, qty: r.qty, planNo: await planNoFor(r.date), workerId: p.workerId }));
      if (!res.ok || !res.ledgerId) {
        const why = `${r.mo || r.bom} ${r.item} ${r.dept} ${r.date}: ${res.error ?? "refused"}`;
        if (ids.length === 0) return { ok: false, error: why };
        return { ok: true, message: `Recorded ${ids.length} of ${ordered.length} row(s) — stopped at ${why}.`, undo: { tool: "delete_log_entries", input: { ids } } };
      }
      ids.push(res.ledgerId);
      serials.push(...(res.serials ?? []));
    }
    return {
      ok: true,
      message: `Recorded ${ids.length} row(s) in the Daily log.${serials.length ? ` Tank serials to write on the steel: ${serials.join(", ")}.` : ""}`,
      undo: { tool: "delete_log_entries", input: { ids } },
    };
  },
};

export const DAILY_LOG_TOOLS = [recordOutputTool, updateLogEntryTool, setLogDatesTool, deleteLogEntriesTool] as const;
