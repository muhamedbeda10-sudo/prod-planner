import "server-only";
import type { Worker } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getCustomDepartments } from "@/lib/server/consumables";
import { checkIssueLimits } from "@/lib/server/consumableLimits";
import { createConsumableIssue, deleteConsumableIssue, restoreConsumableRevision, updateConsumableIssue } from "@/app/consumables/actions";
import { canEditIssue, departmentLabel, matchCatalogueItem, resolveDepartment, workerProblem } from "@/lib/domain/consumables";
import { describeBreach } from "@/lib/domain/consumableLimits";
import { parseWorkerSections } from "@/lib/domain/workers";
import { normalizeEmpId } from "@/lib/domain/tanks";
import { cell } from "@/lib/domain/aiActions";
import { formOf, type ToolCtx, type WriteTool } from "./types";

// CONSUMABLES for the assistant — the store's hand-out log, by the tab's own
// rules: recording needs consumables.edit; a row is corrected by the person
// who recorded it or an admin; deleting it, and bringing it back, is the
// admin's. A hand-out that would take a limit over needs the reason, as on
// the tab. Every change writes the row's own revision there too. Rows are
// found with query_database ("ConsumableIssue" by "id").

const TABS = ["consumables"] as const;
const NO_RIGHT = "Recording hand-outs needs the Consumables permission — the owner ticks it on Users & Permissions.";
const ADMIN_ONLY = "Deleting a hand-out, and bringing one back, is an admin's.";
const WHO = { type: "string", minLength: 1, maxLength: 80, description: "Who asked for it / collected it: the worker's badge ID or exact name." } as const;

async function findWorker(who: string): Promise<Worker | null> {
  return (await prisma.worker.findUnique({ where: { empId: normalizeEmpId(who) } })) ?? prisma.worker.findFirst({ where: { name: { equals: who.trim(), mode: "insensitive" } } });
}

/** The catalogue item a text names (an active one, or the row's own), or null —
 *  then it is recorded as typed and no limit counts it. */
async function catalogueItem(text: string, keepId: number | null = null) {
  const offered = await prisma.consumableItem.findMany({ where: { OR: [{ active: true }, ...(keepId ? [{ id: keepId }] : [])] }, select: { id: true, name: true, code: true } });
  return matchCatalogueItem(text, offered);
}

/** The limits a hand-out would take over, as the tab words them. */
async function breachesOf(itemId: number | null, department: string, qty: number, dayISO: string, excludeIssueId?: number): Promise<string[]> {
  return (await checkIssueLimits({ itemId, department, workerIds: [], qty, dayISO, excludeIssueId })).map(describeBreach);
}

const needReason = (lines: string[]) => `This takes a limit over — ${lines.join("; ")}. Ask the person for the reason and pass it as overLimitReason; it is recorded with the hand-out.`;

interface RecordInput {
  item: string;
  qty: number;
  department: string;
  receivedBy: string;
  notes?: string;
  overLimitReason?: string;
}

export const recordConsumableIssueTool: WriteTool<RecordInput> = {
  kind: "write",
  name: "record_consumable_issue",
  title: "Record a consumables hand-out",
  description:
    "Record a hand-out from the store, as the Consumables tab does: the item (its catalogue name or code — anything else is recorded as typed, with no limit counting it), the quantity, the department it is for (a worker section such as WeldingTX, or a department the log already uses, e.g. Maintenance), who asked for it / collected it, and notes. One over a limit needs overLimitReason.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      item: { type: "string", minLength: 1, maxLength: 120 },
      qty: { type: "number", minimum: 0.001, maximum: 1000000 },
      department: { type: "string", minLength: 1, maxLength: 60 },
      receivedBy: WHO,
      notes: { type: "string", maxLength: 500 },
      overLimitReason: { type: "string", maxLength: 300 },
    },
    required: ["item", "qty", "department", "receivedBy"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "consumables.edit")) return { error: NO_RIGHT };
    const hit = await catalogueItem(i.item);
    const department = resolveDepartment(i.department, await getCustomDepartments());
    const w = await findWorker(i.receivedBy);
    const bad = workerProblem(w ? { ...w, sections: parseWorkerSections(w.depts) } : null, department);
    if (bad) return { error: bad };
    const breaches = await breachesOf(hit?.id ?? null, department, i.qty, ctx.todayISO);
    if (breaches.length > 0 && !i.overLimitReason?.trim()) return { error: needReason(breaches) };
    const item = hit?.name ?? i.item.trim();
    return {
      title: `Hand-out: ${i.qty} × ${item}`,
      summary: `Record ${i.qty} × ${item} for ${departmentLabel(department)}, collected by ${w!.empId} ${w!.name}${hit ? "" : " (not in the catalogue — recorded as typed, no limit counts it)"}${breaches.length ? ` — over a limit, because: ${i.overLimitReason}` : ""}.`,
      changes: [{ label: `${i.qty} × ${item}`, before: "—", after: `${departmentLabel(department)} · ${w!.empId} ${w!.name}${i.notes ? ` · “${i.notes}”` : ""}` }],
      snapshot: { itemId: hit?.id ?? null, department, workerId: w!.id, breaches },
    };
  },
  async execute(i, ctx) {
    const w = await findWorker(i.receivedBy);
    if (!w) return { ok: false, error: `No worker ${i.receivedBy} on the list.` };
    const r = await createConsumableIssue(formOf({ item: i.item, qty: i.qty, department: i.department, receivedById: w.id, notes: i.notes ?? "", overLimitReason: i.overLimitReason ?? "" }));
    if (!r.ok) return { ok: false, error: r.needsReason && r.breaches ? needReason(r.breaches) : r.error };
    // taking a row off the log is the admin's, so only an admin's hand-out
    // can be undone from the chat; anyone else corrects it
    return { ok: true, message: `Recorded (hand-out #${r.id}).`, ...(r.id && ctx.user.isAdmin ? { undo: { tool: "delete_consumable_issue", input: { id: r.id } } } : {}) };
  },
};

interface CorrectInput {
  id: number;
  item?: string;
  qty?: number;
  department?: string;
  receivedBy?: string;
  notes?: string | null;
  overLimitReason?: string;
}

async function loadIssue(id: number) {
  return prisma.consumableIssue.findUnique({ where: { id }, include: { worker: { select: { empId: true, name: true } } } });
}

export const correctConsumableIssueTool: WriteTool<CorrectInput> = {
  kind: "write",
  name: "correct_consumable_issue",
  title: "Correct a consumables hand-out",
  description: "Correct a recorded hand-out — its item, quantity, department, who collected it, or notes; only the fields given change. Only its recorder or an admin may; the moment it was handed out stays.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      item: { type: "string", minLength: 1, maxLength: 120 },
      qty: { type: "number", minimum: 0.001, maximum: 1000000 },
      department: { type: "string", minLength: 1, maxLength: 60 },
      receivedBy: WHO,
      notes: { type: ["string", "null"], maxLength: 500 },
      overLimitReason: { type: "string", maxLength: 300 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const row = await loadIssue(i.id);
    if (!row || row.deletedAt) return { error: `No hand-out #${i.id} on the log.` };
    if (!canEditIssue({ id: ctx.user.id, isAdmin: ctx.user.isAdmin, canRecord: hasPerm(ctx.user, "consumables.edit") }, row)) {
      return { error: "Only the person who recorded it, or an admin, can correct this hand-out." };
    }
    const next = await mergedIssue(row, i);
    if ("error" in next) return { error: next.error };
    const changes = [
      ["Item", row.item, next.item],
      ["Qty", String(row.qty.toNumber()), String(next.qty)],
      ["Department", departmentLabel(row.department), departmentLabel(next.department)],
      ["Collected by", row.worker ? `${row.worker.empId} ${row.worker.name}` : "—", `${next.worker.empId} ${next.worker.name}`],
      ["Notes", row.notes ?? "", next.notes ?? ""],
    ].filter(([, a, b]) => a !== b).map(([label, a, b]) => ({ label: `#${row.id} ${label}`, before: cell(a), after: cell(b) }));
    if (changes.length === 0) return { error: `Hand-out #${row.id} reads so already.` };
    const breaches = await breachesOf(next.itemId, next.department, next.qty, row.issuedAt.toISOString().slice(0, 10), row.id);
    if (breaches.length > 0 && !i.overLimitReason?.trim() && !(row.overLimit && row.overLimitReason)) return { error: needReason(breaches) };
    return { title: `Correct hand-out #${row.id}`, summary: `Correct hand-out #${row.id}: ${changes.map((c) => `${c.label.replace(/^#\d+ /, "")} ${c.before} → ${c.after}`).join("; ")}.`, changes, snapshot: { id: row.id, updatedAt: row.updatedAt.toISOString() } };
  },
  async execute(i) {
    const row = await loadIssue(i.id);
    if (!row || row.deletedAt) return { ok: false, error: `No hand-out #${i.id} on the log.` };
    const next = await mergedIssue(row, i);
    if ("error" in next) return { ok: false, error: next.error };
    const r = await updateConsumableIssue(formOf({
      id: row.id, version: row.updatedAt.toISOString(), item: next.item, ...(next.itemId !== null && next.item === row.item ? { itemId: next.itemId } : {}),
      qty: next.qty, department: next.department, receivedById: next.worker.id, notes: next.notes ?? "", overLimitReason: i.overLimitReason ?? "",
    }));
    if (!r.ok) return { ok: false, error: r.needsReason && r.breaches ? needReason(r.breaches) : r.error };
    return {
      ok: true,
      message: `Hand-out #${row.id} corrected.`,
      undo: { tool: "correct_consumable_issue", input: { id: row.id, item: row.item, qty: row.qty.toNumber(), department: row.department, ...(row.worker ? { receivedBy: row.worker.empId } : {}), notes: row.notes, ...(row.overLimitReason ? { overLimitReason: row.overLimitReason } : {}) } },
    };
  },
};

interface MergedIssue {
  item: string;
  itemId: number | null;
  qty: number;
  department: string;
  worker: Worker;
  notes: string | null;
}

async function mergedIssue(row: NonNullable<Awaited<ReturnType<typeof loadIssue>>>, i: CorrectInput): Promise<MergedIssue | { error: string }> {
  let item = row.item;
  let itemId = row.itemId;
  if (i.item !== undefined && i.item.trim() !== row.item) {
    const hit = await catalogueItem(i.item, row.itemId);
    item = hit?.name ?? i.item.trim();
    itemId = hit?.id ?? null;
  }
  const department = i.department === undefined ? row.department : resolveDepartment(i.department, await getCustomDepartments());
  const w = i.receivedBy === undefined ? (row.workerId ? await prisma.worker.findUnique({ where: { id: row.workerId } }) : null) : await findWorker(i.receivedBy);
  if (!w) return { error: i.receivedBy === undefined ? "Name who collected it (receivedBy) — the row names nobody." : `No worker ${i.receivedBy} on the list.` };
  return { item, itemId, qty: i.qty ?? row.qty.toNumber(), department, worker: w, notes: i.notes === undefined ? row.notes : i.notes?.trim() || null };
}

export const deleteConsumableIssueTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_consumable_issue",
  title: "Take a hand-out off the log",
  description: "Admin only. Take a recorded hand-out off the Consumables log — it stays in the table with its history, and Undo (or the tab's history) brings it back.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const row = await loadIssue(i.id);
    if (!row || row.deletedAt) return { error: `No hand-out #${i.id} on the log.` };
    return {
      title: `Take hand-out #${row.id} off the log`,
      summary: `Take hand-out #${row.id} (${row.qty.toNumber()} × ${row.item}, ${departmentLabel(row.department)}) off the Consumables log.`,
      changes: [{ label: `#${row.id} ${row.qty.toNumber()} × ${row.item}`, before: `${departmentLabel(row.department)} · ${row.issuedAt.toISOString().slice(0, 10)}`, after: "off the log" }],
      snapshot: { id: row.id, updatedAt: row.updatedAt.toISOString() },
    };
  },
  async execute(i) {
    const row = await loadIssue(i.id);
    if (!row || row.deletedAt) return { ok: false, error: `No hand-out #${i.id} on the log.` };
    const r = await deleteConsumableIssue(formOf({ id: row.id, version: row.updatedAt.toISOString() }));
    return r.ok ? { ok: true, message: `Hand-out #${row.id} is off the log.`, undo: { tool: "restore_consumable_issue", input: { id: row.id } } } : { ok: false, error: r.error };
  },
};

/** The undo of a deletion — never offered to the model: the row back on the
 *  log from the revision its deletion wrote. */
export const restoreConsumableIssueTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "restore_consumable_issue",
  internal: true,
  title: "Bring a hand-out back",
  description: "Bring a hand-out taken off the log back, as it was (the undo of a deletion).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx: ToolCtx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const row = await prisma.consumableIssue.findUnique({ where: { id: i.id }, select: { id: true, item: true, deletedAt: true, updatedAt: true } });
    if (!row || !row.deletedAt) return { error: `Hand-out #${i.id} is not off the log.` };
    return {
      title: `Bring hand-out #${row.id} back`,
      summary: `Bring hand-out #${row.id} (${row.item}) back onto the Consumables log.`,
      changes: [{ label: `#${row.id} ${row.item}`, before: "off the log", after: "on the log" }],
      snapshot: { id: row.id, updatedAt: row.updatedAt.toISOString() },
    };
  },
  async execute(i) {
    const row = await prisma.consumableIssue.findUnique({ where: { id: i.id }, select: { updatedAt: true } });
    const rev = await prisma.consumableIssueRevision.findFirst({ where: { issueId: i.id, action: "delete" }, orderBy: { id: "desc" }, select: { id: true } });
    if (!row || !rev) return { ok: false, error: "Its deletion is not on record — bring it back from the tab's history." };
    const r = await restoreConsumableRevision(formOf({ revisionId: rev.id, version: row.updatedAt.toISOString() }));
    return r.ok ? { ok: true, message: `Hand-out #${i.id} is back on the log.` } : { ok: false, error: r.error };
  },
};

export const CONSUMABLE_TOOLS = [recordConsumableIssueTool, correctConsumableIssueTool, deleteConsumableIssueTool, restoreConsumableIssueTool] as const;
