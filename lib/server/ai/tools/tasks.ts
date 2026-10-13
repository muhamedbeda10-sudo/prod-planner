import "server-only";
import type { AiFile } from "@prisma/client";
import { prisma } from "@/lib/db";
import { chatFile, uploadOf } from "@/lib/server/ai/files";
import { createTask, postTaskUpdate, withdrawTasks } from "@/app/tasks/actions";
import { ASSIGN_KEY, roleOf, selfOnlyOf, taskDetail, tasksData, type TaskSummary } from "@/lib/server/tasks";
import { MOVE_NEEDS_TEXT, TASK_LIMITS, TASK_MOVES, TASK_MOVE_LABEL, TASK_STATUS_LABEL, cleanDueDate, isTaskStatus, moveTask, type TaskMove } from "@/lib/domain/tasks";
import { formatDate } from "@/lib/domain/format";
import { peopleNamed } from "./automations";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// Tasks for the assistant: reading the person's own (given to them, given by
// them, each with its thread), giving a task for a person who may give them,
// and the person's own moves on one — a word on how far they got, marking it
// done, or, as its giver, approving it or returning it for rework. Each runs
// through the Tasks tab's own action, as the person, after their approval:
// what it sends reaches colleagues' phones.

/** Files attached in this chat — photos, PDFs, sheets — to go with a task or an update. */
async function chatFiles(ids: readonly number[], ctx: ToolCtx): Promise<AiFile[] | { error: string }> {
  const out: AiFile[] = [];
  for (const id of ids) {
    const f = await chatFile(ctx, id);
    if ("error" in f) return f;
    out.push(f);
  }
  return out;
}

const FILES = { type: "array", items: { type: "integer", minimum: 1 }, maxItems: TASK_LIMITS.files, description: "Files attached in this chat (photos, PDF, Excel), by file number." } as const;

const brief = (t: TaskSummary) => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.dueDate, overdue: t.overdue || undefined, mo: t.mo ?? undefined,
  from: t.createdByName, to: t.assignees.map((a) => a.name), shared: t.shared || undefined, unread: t.unread || undefined,
  last: t.last ? `${t.last.authorName}: ${TASK_MOVE_LABEL[t.last.kind as TaskMove] ?? t.last.kind}${t.last.body ? ` — ${t.last.body}` : ""} (${t.last.at})` : undefined,
});

// ------------------------------------------------------------------ read

export const listTasksTool: ReadTool<{ id?: number; which?: "mine" | "given" | "both"; closed?: boolean }> = {
  kind: "read",
  name: "list_tasks",
  title: "Looking at the tasks",
  description:
    "The person's tasks: those given to them (mine) and those they gave (given) — each with its id, title, state (open, in_progress, submitted = marked done and waiting for the giver's review, returned = sent back for rework, done, cancelled), due day, who gave it and to whom, and its latest update. With an id: that one task in full with its whole thread (every update, photo and move, who and when). Only the person's own tasks.",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description: "One task, with its thread." },
      which: { type: "string", enum: ["mine", "given", "both"], description: "Given to the person, given by them, or both (default)." },
      closed: { type: "boolean", description: "Include done and cancelled ones (default: only those still going)." },
    },
    additionalProperties: false,
  },
  async run(i, ctx) {
    if (i.id) {
      const t = await taskDetail(ctx.user, i.id, ctx.now);
      if (!t) return { ok: false, text: `No task #${i.id} of ${ctx.user.name}'s — given to them or by them.` };
      return {
        ok: true,
        text: JSON.stringify({
          ...brief(t), details: t.details || undefined, files: t.attachments.map((f) => f.name),
          you: t.role.giver && t.role.doer ? "giver and doer" : t.role.giver ? "giver" : "doer", may: t.moves,
          others_made_with_it: t.batch.length ? t.batch.map((b) => ({ id: b.id, to: b.assignee, status: b.status })) : undefined,
          thread: t.updates.map((u) => ({ by: u.authorName, what: u.kind, text: u.body || undefined, files: u.attachments.length ? u.attachments.map((f) => f.name) : undefined, at: u.createdAt })),
        }),
      };
    }
    const d = await tasksData(ctx.user, ctx.now);
    const keep = (t: TaskSummary) => i.closed || (t.status !== "done" && t.status !== "cancelled");
    const which = i.which ?? "both";
    return {
      ok: true,
      text: JSON.stringify({
        ...(which !== "given" ? { mine: d.mine.filter(keep).map(brief) } : {}),
        ...(which !== "mine" ? { given: d.sent.filter(keep).map(brief) } : {}),
        may_give_tasks: d.canAssign,
      }),
    };
  },
};

// ------------------------------------------------------------- writes

interface CreateInput {
  title: string;
  details?: string;
  to: string[];
  shared?: boolean;
  priority?: "normal" | "urgent";
  due?: string;
  mo?: string;
  files?: number[];
}

export const createTaskTool: WriteTool<CreateInput> = {
  kind: "write",
  name: "create_task",
  title: "Give a task",
  description:
    "Give colleagues a task, from the person: a title, what to do, who (by their names on the users list), an optional due day, priority and order (MO), and files attached in this chat. Several people get one task EACH by default — each reports and is approved on their own; shared: true makes ONE task they all work on together, done when the giver approves it once. They get it in their inbox's Tasks tab and on their phones, report on it there (text and photos) and mark it done; the giver approves it or returns it for rework. Only when the person asks for a task to be given.",
  area: "tasks",
  risk: "high",
  needs: ASSIGN_KEY,
  schema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: TASK_LIMITS.title, description: "Short — what is to be done." },
      details: { type: "string", maxLength: TASK_LIMITS.details, description: "Markdown: the steps, what counts as done, what to send back (e.g. a photo of the result)." },
      to: { type: "array", minItems: 1, maxItems: TASK_LIMITS.people, items: { type: "string", minLength: 1, maxLength: 80 }, description: "Who it is given to, by their names on the users list." },
      shared: { type: "boolean", description: "One task all of them work on together (default: one each)." },
      priority: { type: "string", enum: ["normal", "urgent"] },
      due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The factory day it is due by, YYYY-MM-DD." },
      mo: { type: "string", maxLength: 60, description: "The order it is about (its MO on the Orders Registry)." },
      files: FILES,
    },
    required: ["title", "to"],
    additionalProperties: false,
  },
  parse(r) {
    const due = r.due ? cleanDueDate(String(r.due)) : null;
    if (r.due && !due) return "The due day is not a date.";
    return {
      title: String(r.title).replace(/\s+/g, " ").trim(),
      ...(String(r.details ?? "").trim() ? { details: String(r.details).trim() } : {}),
      to: r.to as string[],
      ...(r.shared ? { shared: true } : {}),
      ...(r.priority === "urgent" ? { priority: "urgent" as const } : {}),
      ...(due ? { due } : {}),
      ...(String(r.mo ?? "").trim() ? { mo: String(r.mo).trim() } : {}),
      ...(Array.isArray(r.files) && r.files.length ? { files: [...new Set(r.files as number[])] } : {}),
    };
  },
  async describe(i, ctx) {
    const p = await peopleNamed(i.to);
    if ("error" in p) return p;
    if (i.due && i.due < ctx.todayISO) return { error: `${formatDate(i.due)} has passed — give a day from today on.` };
    if (i.mo && !(await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { mo: true } }))) return { error: `${i.mo} is not on the Orders Registry.` };
    const files = await chatFiles(i.files ?? [], ctx);
    if ("error" in files) return files;
    const shared = !!i.shared && p.ids.length > 1;
    const how = p.ids.length === 1 ? "" : shared ? " — one task they share" : " — one each";
    const extras = [i.priority === "urgent" ? "urgent" : "", i.due ? `due ${formatDate(i.due)}` : "", i.mo ?? "", files.length ? `📎×${files.length}` : ""].filter(Boolean).join(" · ");
    return {
      title: `${i.priority === "urgent" ? "Urgent task" : "Task"} for ${p.names.join(", ")}`,
      summary: `Give "${i.title}" to ${p.names.join(", ")}${how}${extras ? ` (${extras})` : ""} — to their Tasks tab and their phones.`,
      changes: (shared ? [p.names.join(", ")] : p.names).map((n) => ({ label: n, before: "—", after: `${i.title}${extras ? ` · ${extras}` : ""}` })),
      snapshot: { to: p.ids, files: files.map((f) => f.sha256) },
    };
  },
  async execute(i, ctx) {
    const p = await peopleNamed(i.to);
    if ("error" in p) return { ok: false, error: p.error };
    const files = await chatFiles(i.files ?? [], ctx);
    if ("error" in files) return { ok: false, error: files.error };
    const fd = formOf({ title: i.title, details: i.details ?? "", people: p.ids.join(","), shared: i.shared ? "1" : "0", priority: i.priority ?? "normal", due: i.due ?? "", mo: i.mo ?? "" });
    for (const f of files) fd.append("files", uploadOf(f));
    const r = await createTask(fd);
    if (!r.ok || !r.ids) return { ok: false, error: r.error ?? "Not given." };
    return {
      ok: true,
      message: `Given to ${p.names.join(", ")} (task${r.ids.length > 1 ? "s" : ""} #${r.ids.join(", #")}).`,
      undo: { tool: "withdraw_tasks", input: { ids: r.ids } },
    };
  },
};

/** The undo of giving tasks — never offered to the model. */
export const withdrawTasksTool: WriteTool<{ ids: number[] }> = {
  kind: "write",
  name: "withdraw_tasks",
  internal: true,
  title: "Take tasks back",
  description: "Take back tasks given by mistake: one nobody acted on yet goes; one already started is cancelled, its thread kept.",
  area: "tasks",
  risk: "low",
  schema: { type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: TASK_LIMITS.people, items: { type: "integer", minimum: 1 } } }, required: ["ids"], additionalProperties: false },
  async describe(i, ctx) {
    const tasks = await prisma.task.findMany({ where: { id: { in: i.ids }, createdById: ctx.user.id }, select: { id: true, title: true, status: true, assignees: { select: { user: { select: { name: true } } } } } });
    if (tasks.length === 0) return { error: "Those tasks are not there any more." };
    return {
      title: `Take back "${tasks[0].title}"`,
      summary: `Take back the task "${tasks[0].title}" from ${tasks.flatMap((t) => t.assignees.map((a) => a.user.name)).join(", ")} — those not started go, the rest are cancelled.`,
      changes: tasks.map((t) => ({ label: t.assignees.map((a) => a.user.name).join(", "), before: isTaskStatus(t.status) ? TASK_STATUS_LABEL[t.status] : t.status, after: "taken back" })),
      snapshot: tasks.map((t) => [t.id, t.status]),
    };
  },
  async execute(i) {
    const r = await withdrawTasks(i.ids);
    return r.ok ? { ok: true, message: "Taken back." } : { ok: false, error: r.error };
  },
};

interface UpdateInput {
  id: number;
  move: TaskMove;
  text?: string;
  files?: number[];
}

export const updateTaskTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_task",
  title: "Act on a task",
  description:
    "The person's own move on one of their tasks, as the Tasks tab makes it: note = a word on how far they got (with files attached in this chat, e.g. a photo of the work); start; submit = mark it done for the giver to review; and as its giver: approve, return (send it back for rework — say what to fix), cancel, reopen (a done or cancelled one, with what to redo). Read the task with list_tasks first: `may` lists the moves open to the person now.",
  area: "tasks",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      move: { type: "string", enum: [...TASK_MOVES] },
      text: { type: "string", maxLength: TASK_LIMITS.update, description: "What goes with it — needed for note, return and reopen." },
      files: FILES,
    },
    required: ["id", "move"],
    additionalProperties: false,
  },
  parse(r) {
    const text = String(r.text ?? "").trim();
    const files = Array.isArray(r.files) ? [...new Set(r.files as number[])] : [];
    const move = r.move as TaskMove;
    if (MOVE_NEEDS_TEXT.has(move) && !text && (move !== "note" || files.length === 0)) return move === "note" ? "Say what to write, or attach a photo." : "Say why — it goes to them with the task.";
    return { id: Number(r.id), move, ...(text ? { text } : {}), ...(files.length ? { files } : {}) };
  },
  async describe(i, ctx) {
    const t = await prisma.task.findUnique({ where: { id: i.id }, include: { assignees: { select: { userId: true, user: { select: { name: true } } } } } });
    const role = t ? roleOf(ctx.user, t) : null;
    if (!t || !role || (!role.giver && !role.doer)) return { error: `No task #${i.id} of ${ctx.user.name}'s — given to them or by them.` };
    if (!isTaskStatus(t.status)) return { error: "The task is in a state the app does not know." };
    const decided = moveTask(t.status, i.move, role, { selfOnly: selfOnlyOf(t) });
    if ("error" in decided) return decided;
    const files = await chatFiles(i.files ?? [], ctx);
    if ("error" in files) return files;
    const others = [...new Set([t.createdByName, ...t.assignees.map((a) => a.user.name)])].filter((n) => n !== ctx.user.name);
    const what = i.move === "note" ? "Update on" : TASK_MOVE_LABEL[i.move];
    return {
      title: `${what} — “${t.title}”`,
      summary: `${what} the task "${t.title}" as ${ctx.user.name}${i.text ? `: "${i.text}"` : ""}${files.length ? ` — with ${files.map((f) => f.name).join(", ")}` : ""}.${others.length ? ` ${others.join(", ")} ${others.length > 1 ? "are" : "is"} told.` : ""}`,
      changes: [{ label: t.title, before: TASK_STATUS_LABEL[t.status], after: TASK_STATUS_LABEL[decided.next] }],
      snapshot: { status: t.status, files: files.map((f) => f.sha256) },
    };
  },
  async execute(i, ctx) {
    const files = await chatFiles(i.files ?? [], ctx);
    if ("error" in files) return { ok: false, error: files.error };
    const fd = formOf({ id: i.id, move: i.move, body: i.text ?? "" });
    for (const f of files) fd.append("files", uploadOf(f));
    const r = await postTaskUpdate(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "Not done." };
    return { ok: true, message: `Task #${i.id}: ${r.status && isTaskStatus(r.status) ? TASK_STATUS_LABEL[r.status].toLowerCase() : "updated"}.` };
  },
};

export const TASK_TOOLS = [listTasksTool, createTaskTool, withdrawTasksTool, updateTaskTool];
