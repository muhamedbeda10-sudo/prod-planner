"use server";

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { getCurrentUser, requirePerm } from "@/lib/server/auth";
import { currentActor } from "@/lib/server/actor";
import { filesOf, storeUploads } from "@/lib/server/uploads";
import { emitEvent } from "@/lib/server/events";
import { ASSIGN_KEY, markTaskNewsRead, roleOf, selfOnlyOf, sendTaskNews, taskDetail, tasksData, type TaskDetail, type TasksData } from "@/lib/server/tasks";
import { MOVE_NEEDS_TEXT, TASK_LIMITS, TASK_MOVE_LABEL, cleanDueDate, isTaskMove, isTaskStatus, moveTask } from "@/lib/domain/tasks";

// Tasks: given by a person with the key for it — by hand or through the
// assistant — and reported on by the people they were given to, until the
// giver approves them or cancels them. Each person reads and acts only on
// the tasks they gave or were given; every move is checked against the
// task's state as it is in the database at that moment, so two people acting
// at once never both win.

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";

type Loaded<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface TaskActionResult {
  ok: boolean;
  error?: string;
}

const idOk = (n: number) => Number.isInteger(n) && n > 0;

/** Everyone on a task — the only people its events may reach. */
const participantsOf = (t: { createdById: number | null; assignees: { userId: number }[] }) =>
  [...new Set([...(t.createdById ? [t.createdById] : []), ...t.assignees.map((a) => a.userId)])];

/** Where it came from: a click, or the assistant acting for the person. */
const viaNow = () => (currentActor() ? "ai" : "app");

/** Give a task to one or more people. Several people get one task each
 *  (made together), or — shared — one task they all report on. */
export async function createTask(fd: FormData): Promise<TaskActionResult & { ids?: number[] }> {
  const guard = await requirePerm(ASSIGN_KEY);
  if (guard.error) return { ok: false, error: guard.error };
  const me = guard.user!;

  const title = String(fd.get("title") ?? "").replace(/\s+/g, " ").trim();
  const details = String(fd.get("details") ?? "").trim();
  const people = [...new Set(String(fd.get("people") ?? "").split(",").map((x) => Number(x.trim())).filter(idOk))];
  const shared = fd.get("shared") === "1" || fd.get("shared") === "true";
  const priority = fd.get("priority") === "urgent" ? "urgent" : "normal";
  const dueRaw = String(fd.get("due") ?? "").trim();
  const moRaw = String(fd.get("mo") ?? "").trim();
  const files = filesOf(fd);

  if (!title || title.length > TASK_LIMITS.title) return { ok: false, error: `Give the task a title (at most ${TASK_LIMITS.title} characters).` };
  if (details.length > TASK_LIMITS.details) return { ok: false, error: `The details are too long (at most ${TASK_LIMITS.details} characters).` };
  if (people.length === 0 || people.length > TASK_LIMITS.people) return { ok: false, error: `Give it to 1 to ${TASK_LIMITS.people} people.` };
  if (files.length > TASK_LIMITS.files) return { ok: false, error: `At most ${TASK_LIMITS.files} photos or files.` };
  const due = dueRaw ? cleanDueDate(dueRaw) : null;
  if (dueRaw && !due) return { ok: false, error: "The due day is not a date." };

  const found = await prisma.user.findMany({ where: { id: { in: people }, active: true }, select: { id: true, name: true } });
  if (found.length !== people.length) return { ok: false, error: "One of them is not an active user." };
  const nameOf = new Map(found.map((u) => [u.id, u.name]));

  let mo: string | null = null;
  if (moRaw) {
    const order = await prisma.masterOrder.findUnique({ where: { mo: moRaw }, select: { mo: true } });
    if (!order) return { ok: false, error: `MO "${moRaw}" is not on the Orders Registry.` };
    mo = order.mo;
  }

  const count = shared ? 1 : people.length;
  const lastHour = await prisma.task.count({ where: { createdById: me.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (lastHour + count > TASK_LIMITS.perHour) return { ok: false, error: `That is more than ${TASK_LIMITS.perHour} tasks in an hour — wait a while.` };

  const stored = await storeUploads(files, "tasks");
  if (!stored.ok) return { ok: false, error: stored.error };

  const via = viaNow();
  const base = {
    title, details, priority, mo, attachments: stored.files as unknown as object, createdById: me.id, createdByName: me.name, via,
    dueDate: due ? new Date(`${due}T00:00:00Z`) : null,
  };
  const groups = shared ? [people] : people.map((p) => [p]);
  const batchId = !shared && people.length > 1 ? randomUUID() : null;
  const made = await prisma.$transaction(
    groups.map((ids) =>
      prisma.task.create({
        data: { ...base, shared: shared && ids.length > 1, batchId, assignees: { create: ids.map((userId) => ({ userId })) } },
        include: { assignees: { select: { userId: true } } },
      }),
    ),
  );
  for (const t of made) {
    await sendTaskNews(t, "create", me.name, "", me.id);
    await emitEvent({ type: "task.given", subject: `Task #${t.id}`, summary: `Gave “${t.title}” to ${t.assignees.map((a) => nameOf.get(a.userId) ?? `#${a.userId}`).join(", ")}`, participants: participantsOf(t), data: { taskId: t.id } });
  }
  return { ok: true, ids: made.map((t) => t.id) };
}

/** A note on a task, or a move — start, mark done, approve, return, cancel,
 *  reopen — with what is said with it and any photos. */
export async function postTaskUpdate(fd: FormData): Promise<TaskActionResult & { status?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const id = Number(fd.get("id"));
  const moveRaw = String(fd.get("move") ?? "note");
  const body = String(fd.get("body") ?? "").trim();
  const files = filesOf(fd);
  if (!idOk(id)) return { ok: false, error: "Invalid task." };
  if (!isTaskMove(moveRaw)) return { ok: false, error: "Invalid move." };
  const move = moveRaw;
  if (body.length > TASK_LIMITS.update) return { ok: false, error: `Too long (at most ${TASK_LIMITS.update} characters).` };
  if (files.length > TASK_LIMITS.files) return { ok: false, error: `At most ${TASK_LIMITS.files} photos or files.` };
  if (MOVE_NEEDS_TEXT.has(move) && !body && (move !== "note" || files.length === 0)) {
    return { ok: false, error: move === "note" ? "Write something or add a photo." : `Say why — it goes to them with the task (${TASK_MOVE_LABEL[move].toLowerCase()}).` };
  }

  const t = await prisma.task.findUnique({ where: { id }, include: { assignees: { select: { userId: true } } } });
  if (!t) return { ok: false, error: "That task is not there any more." };
  if (!isTaskStatus(t.status)) return { ok: false, error: "The task is in a state the app does not know." };
  const role = roleOf(me, t);
  const decided = moveTask(t.status, move, role, { selfOnly: selfOnlyOf(t) });
  if ("error" in decided) return { ok: false, error: decided.error };

  const lastHour = await prisma.taskUpdate.count({ where: { authorId: me.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (lastHour >= TASK_LIMITS.updatesPerHour) return { ok: false, error: "That is a lot of updates in an hour — wait a while." };

  const stored = await storeUploads(files, "tasks");
  if (!stored.ok) return { ok: false, error: stored.error };

  const now = new Date();
  const next = decided.next;
  try {
    await prisma.$transaction(async (tx) => {
      // only from the state it was read in: someone else's move in between wins
      const r = await tx.task.updateMany({
        where: { id, status: t.status },
        data: {
          status: next,
          activityAt: now,
          ...(next === "submitted" ? { submittedAt: now } : {}),
          ...(next === "done" || next === "cancelled" ? { closedAt: now } : {}),
          ...(move === "reopen" ? { closedAt: null } : {}),
        },
      });
      if (r.count !== 1) throw new Error("conflict");
      await tx.taskUpdate.create({
        data: { taskId: id, authorId: me.id, authorName: me.name, kind: move, body, attachments: stored.files as unknown as object, via: viaNow() },
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "conflict") return { ok: false, error: "The task changed meanwhile — it is shown again as it is now." };
    throw e;
  }
  // what was said carries the news; a photo alone says so
  const said = body || (stored.files.length > 0 ? `(${stored.files.length} photo${stored.files.length > 1 ? "s" : ""} or file${stored.files.length > 1 ? "s" : ""})` : "");
  await sendTaskNews(t, move === "submit" && next === "done" ? "approve" : move, me.name, said, me.id);
  await markTaskNewsRead(me.id, id);
  const happened = next === "done" ? "task.approved" : next === "submitted" ? "task.done" : move === "return" ? "task.returned" : null;
  if (happened) {
    const verb = happened === "task.approved" ? "Approved" : happened === "task.done" ? "Marked done" : "Returned for rework";
    await emitEvent({ type: happened, subject: `Task #${t.id}`, summary: `${verb} “${t.title}”${body ? ` — ${body.slice(0, 200)}` : ""}`, participants: participantsOf(t), data: { taskId: t.id } });
  }
  return { ok: true, status: next };
}

/** Take back tasks given by mistake — the undo of giving them through the
 *  assistant. One nobody acted on yet goes, with its news; one already
 *  started is cancelled instead, its thread kept. Only the giver's own. */
export async function withdrawTasks(ids: number[]): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > TASK_LIMITS.people || !ids.every(idOk)) return { ok: false, error: "Invalid tasks." };
  const tasks = await prisma.task.findMany({ where: { id: { in: ids }, createdById: me.id }, include: { assignees: { select: { userId: true } }, _count: { select: { updates: true } } } });
  if (tasks.length === 0) return { ok: false, error: "Those tasks are not there any more." };
  for (const t of tasks) {
    if (t.status === "open" && t._count.updates === 0) {
      await prisma.task.deleteMany({ where: { id: t.id, status: "open", updates: { none: {} } } });
      continue;
    }
    if (t.status === "done" || t.status === "cancelled") continue;
    const r = await prisma.task.updateMany({ where: { id: t.id, status: t.status }, data: { status: "cancelled", closedAt: new Date(), activityAt: new Date() } });
    if (r.count !== 1) continue;
    await prisma.taskUpdate.create({ data: { taskId: t.id, authorId: me.id, authorName: me.name, kind: "cancel", body: "Taken back — given by mistake.", via: viaNow() } });
    await sendTaskNews(t, "cancel", me.name, "Taken back — given by mistake.", me.id);
  }
  return { ok: true };
}

/** The person opened the task: its news is read. */
export async function markTaskSeen(id: number): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!idOk(id)) return { ok: false, error: "Invalid task." };
  await markTaskNewsRead(me.id, id);
  return { ok: true };
}

export async function loadTasks(): Promise<Loaded<TasksData>> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  return { ok: true, ...(await tasksData(me)) };
}

export async function loadTask(id: number): Promise<Loaded<{ task: TaskDetail }>> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!idOk(id)) return { ok: false, error: "Invalid task." };
  const task = await taskDetail(me, id);
  if (!task) return { ok: false, error: "That task is not yours, or it is not there any more." };
  return { ok: true, task };
}

/** The people a task can be given to — for the giver's form. */
export async function loadAssignable(): Promise<Loaded<{ people: { id: number; name: string }[] }>> {
  const guard = await requirePerm(ASSIGN_KEY);
  if (guard.error) return { ok: false, error: guard.error };
  const people = await prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return { ok: true, people };
}
