"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, requirePerm } from "@/lib/server/auth";
import { currentActor } from "@/lib/server/actor";
import { filesOf, storeUploads } from "@/lib/server/uploads";
import { emitEvent } from "@/lib/server/events";
import { offDays } from "@/lib/server/automations/store";
import {
  ASSIGN_KEY, canGive, giveTask, markTaskNewsRead, participantsOf, roleOf, ruleOf, selfOnlyOf, sendTaskNews, taskDetail, tasksData, type TaskDetail, type TasksData,
} from "@/lib/server/tasks";
import { factoryDayISO } from "@/lib/domain/dates";
import {
  MOVE_NEEDS_TEXT, REPEAT_LIMITS, TASK_LIMITS, TASK_MOVE_LABEL, checklistOf, cleanChecklist, cleanDueDate, cleanRepeat, isClosed, isTaskMove, isTaskStatus, moveTask, nextRepeatDay, tickItem, workingDaysAfter,
} from "@/lib/domain/tasks";

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

/** A form field holding JSON — parsed, or the raw text when it is not JSON (a checklist typed as lines). */
function jsonOr(v: FormDataEntryValue | null): unknown {
  if (v === null || v === "") return null;
  try {
    return JSON.parse(String(v));
  } catch {
    return String(v);
  }
}

const TEMPLATE_NAME_MAX = 60;
const TEMPLATES_PER_OWNER = 50;

/** Where it came from: a click, or the assistant acting for the person. */
const viaNow = () => (currentActor() ? "ai" : "app");

/** Give a task to one or more people. Several people get one task each
 *  (made together), or — shared — one task they all report on. With
 *  `repeat`, it is also kept to be given again by itself (the first one is
 *  given now); with `templateName`, kept as a template to give again by hand. */
export async function createTask(fd: FormData): Promise<TaskActionResult & { ids?: number[]; repeatId?: number }> {
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
  const checklist = cleanChecklist(jsonOr(fd.get("checklist")));
  const repeatRaw = jsonOr(fd.get("repeat"));
  const templateName = String(fd.get("templateName") ?? "").replace(/\s+/g, " ").trim();

  if (!title || title.length > TASK_LIMITS.title) return { ok: false, error: `Give the task a title (at most ${TASK_LIMITS.title} characters).` };
  if (details.length > TASK_LIMITS.details) return { ok: false, error: `The details are too long (at most ${TASK_LIMITS.details} characters).` };
  if (people.length === 0 || people.length > TASK_LIMITS.people) return { ok: false, error: `Give it to 1 to ${TASK_LIMITS.people} people.` };
  if (files.length > TASK_LIMITS.files) return { ok: false, error: `At most ${TASK_LIMITS.files} photos or files.` };
  if ("error" in checklist) return { ok: false, error: checklist.error };
  const repeat = repeatRaw ? cleanRepeat(repeatRaw) : null;
  if (repeat && "error" in repeat) return { ok: false, error: repeat.error };
  if (templateName.length > TEMPLATE_NAME_MAX) return { ok: false, error: `A template's name is at most ${TEMPLATE_NAME_MAX} characters.` };
  const due = dueRaw ? cleanDueDate(dueRaw) : null;
  if (dueRaw && !due) return { ok: false, error: "The due day is not a date." };

  let mo: string | null = null;
  if (moRaw) {
    const order = await prisma.masterOrder.findUnique({ where: { mo: moRaw }, select: { mo: true } });
    if (!order) return { ok: false, error: `MO "${moRaw}" is not on the Orders Registry.` };
    mo = order.mo;
  }
  if (repeat && (await prisma.taskRepeat.count({ where: { ownerId: me.id } })) >= REPEAT_LIMITS.perOwner) {
    return { ok: false, error: `You keep ${REPEAT_LIMITS.perOwner} repeating tasks already — delete one first.` };
  }
  if (templateName && (await prisma.taskTemplate.count({ where: { ownerId: me.id } })) >= TEMPLATES_PER_OWNER) {
    return { ok: false, error: `You keep ${TEMPLATES_PER_OWNER} templates already — delete one first.` };
  }
  // who it goes to and the hour's cap, before anything is stored
  const via = viaNow();
  const can = await canGive(me, people, shared, via);
  if (!can.ok) return { ok: false, error: can.error };

  const stored = await storeUploads(files, "tasks");
  if (!stored.ok) return { ok: false, error: stored.error };

  // a repeating one: kept first, the first one given now and the next booked after today
  let repeatId: number | null = null;
  let firstDue = due;
  if (repeat) {
    const now = new Date();
    const today = factoryDayISO(now);
    const offDay = await offDays(now);
    // the first one is due as the next ones will be, unless a day was given
    firstDue = due ?? workingDaysAfter(today, repeat.dueDays, offDay);
    const next = nextRepeatDay(repeat, new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), offDay);
    const r = await prisma.taskRepeat.create({
      data: {
        ownerId: me.id, title, details, checklist: checklist as unknown as object, priority, people, shared: shared && people.length > 1, mo,
        every: repeat.every, weekdays: repeat.weekdays, monthDay: repeat.monthDay, dueDays: repeat.dueDays,
        nextOn: next ? new Date(`${next}T00:00:00Z`) : null, lastGivenOn: new Date(`${today}T00:00:00Z`),
      },
    });
    repeatId = r.id;
  }
  // a repeating one that did not give its first task is taken back — it never starts on its own
  const undoRepeat = async () => {
    if (repeatId) await prisma.taskRepeat.deleteMany({ where: { id: repeatId, ownerId: me.id } });
  };
  let given: Awaited<ReturnType<typeof giveTask>>;
  try {
    given = await giveTask(me, { title, details, people, shared, priority, dueISO: firstDue, mo, checklist, attachments: stored.files, repeatId }, via);
  } catch (e) {
    await undoRepeat();
    throw e;
  }
  if (!given.ok) {
    await undoRepeat();
    return { ok: false, error: given.error };
  }
  if (templateName) {
    await prisma.taskTemplate.create({
      data: { ownerId: me.id, name: templateName, title, details, checklist: checklist.map((x) => x.text) as unknown as object, priority, people, shared: shared && people.length > 1 },
    });
  }
  return { ok: true, ids: given.ids, ...(repeatId ? { repeatId } : {}) };
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

/** Tick or untick a step of a task's checklist — its giver or its people,
 *  while it is open. Written only over the checklist as it was read, so two
 *  people ticking at once never lose each other's tick. */
export async function tickTaskStep(fd: FormData): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const id = Number(fd.get("id"));
  const itemId = String(fd.get("item") ?? "");
  const done = fd.get("done") === "true";
  if (!idOk(id) || !itemId) return { ok: false, error: "Invalid step." };
  const t = await prisma.task.findUnique({ where: { id }, include: { assignees: { select: { userId: true } } } });
  if (!t) return { ok: false, error: "That task is not there any more." };
  const role = roleOf(me, t);
  if (!role.giver && !role.doer) return { ok: false, error: "This task is not yours." };
  if (!isTaskStatus(t.status) || isClosed(t.status)) return { ok: false, error: "The task is closed — reopen it to change its steps." };
  const items = checklistOf(t.checklist);
  const next = tickItem(items, itemId, done, me.name, new Date().toISOString());
  if ("error" in next) return { ok: false, error: next.error };
  const r = await prisma.task.updateMany({ where: { id, updatedAt: t.updatedAt }, data: { checklist: next as unknown as object, activityAt: new Date() } });
  if (r.count !== 1) return { ok: false, error: "Someone changed the task meanwhile — it is shown again as it is now." };
  // the others hear when the last step is ticked; each tick stays on the task
  if (done && next.every((x) => x.done)) {
    const step = items.find((x) => x.id === itemId)!.text;
    await sendTaskNews(t, "tick", me.name, `Ticked “${step}” — every step is ticked.`, me.id);
  }
  return { ok: true };
}

/** The giver changes a task's checklist — the steps already ticked stay ticked. */
export async function setTaskChecklist(fd: FormData): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const id = Number(fd.get("id"));
  if (!idOk(id)) return { ok: false, error: "Invalid task." };
  const t = await prisma.task.findUnique({ where: { id }, include: { assignees: { select: { userId: true } } } });
  if (!t) return { ok: false, error: "That task is not there any more." };
  if (!roleOf(me, t).giver) return { ok: false, error: "Only the one who gave the task changes its steps." };
  if (!isTaskStatus(t.status) || isClosed(t.status)) return { ok: false, error: "The task is closed — reopen it to change its steps." };
  const had = checklistOf(t.checklist);
  // a new step never takes the id — and so the tick — of one that was removed
  const cleaned = cleanChecklist(jsonOr(fd.get("checklist")), { taken: had.map((x) => x.id) });
  if ("error" in cleaned) return { ok: false, error: cleaned.error };
  const was = new Map(had.map((x) => [x.id, x]));
  const next = cleaned.map((x) => (was.has(x.id) ? { ...x, done: was.get(x.id)!.done, by: was.get(x.id)!.by ?? null, at: was.get(x.id)!.at ?? null } : { ...x, done: false, by: null, at: null }));
  const r = await prisma.task.updateMany({ where: { id, updatedAt: t.updatedAt }, data: { checklist: next as unknown as object, activityAt: new Date() } });
  if (r.count !== 1) return { ok: false, error: "The task changed meanwhile — try again." };
  return { ok: true };
}

/** Delete one of the person's own task templates. */
export async function deleteTaskTemplate(fd: FormData): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const id = Number(fd.get("id"));
  if (!idOk(id)) return { ok: false, error: "Invalid template." };
  const r = await prisma.taskTemplate.deleteMany({ where: { id, ownerId: me.id } });
  return r.count === 1 ? { ok: true } : { ok: false, error: "That template is not yours, or it is gone." };
}

/** Pause a repeating task, or turn it back on (it gives next on its next day from today). */
export async function setTaskRepeatEnabled(fd: FormData): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const id = Number(fd.get("id"));
  const enabled = fd.get("enabled") === "true";
  if (!idOk(id)) return { ok: false, error: "Invalid repeating task." };
  const r = await prisma.taskRepeat.findFirst({ where: { id, ownerId: me.id } });
  if (!r) return { ok: false, error: "That repeating task is not yours, or it is gone." };
  if (!enabled) {
    await prisma.taskRepeat.update({ where: { id }, data: { enabled: false } });
    return { ok: true };
  }
  if (!hasPerm(me, ASSIGN_KEY)) return { ok: false, error: "You may no longer give tasks." };
  const now = new Date();
  const today = factoryDayISO(now);
  const from = r.lastGivenOn && r.lastGivenOn.toISOString().slice(0, 10) === today ? new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : today;
  const next = nextRepeatDay(ruleOf(r), from, await offDays(now));
  await prisma.taskRepeat.update({ where: { id }, data: { enabled: true, lastError: null, nextOn: next ? new Date(`${next}T00:00:00Z`) : null } });
  return { ok: true };
}

/** Stop a repeating task for good — the tasks it gave stay. */
export async function deleteTaskRepeat(fd: FormData): Promise<TaskActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const id = Number(fd.get("id"));
  if (!idOk(id)) return { ok: false, error: "Invalid repeating task." };
  const r = await prisma.taskRepeat.deleteMany({ where: { id, ownerId: me.id } });
  return r.count === 1 ? { ok: true } : { ok: false, error: "That repeating task is not yours, or it is gone." };
}
