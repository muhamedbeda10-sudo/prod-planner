import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { effectiveUser, hasPerm } from "@/lib/server/auth";
import { emitEvent } from "@/lib/server/events";
import { deliverToInbox } from "@/lib/server/inbox";
import { storedFilesOf, type StoredFile } from "@/lib/server/uploads";
import { offDays } from "@/lib/server/automations/store";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDate } from "@/lib/domain/format";
import {
  TASK_ESCALATE_LATE_DAYS, TASK_LIMITS, checklistOf, checklistProgress, describeRepeat, isOverdue, isTaskStatus, lateBy, movesFor, nextRepeatDay, teamLoad, workingDaysAfter,
  type ChecklistItem, type PersonLoad, type RepeatRule, type TaskMove, type TaskRole, type TaskStatus,
} from "@/lib/domain/tasks";

// Tasks as their screens and the assistant read them, and the news each move
// sends: to everyone on the task but the one who made it, into the Tasks tab
// of their inbox and onto their devices. Every read here is one person's own:
// the tasks given to them and the tasks they gave.

export const ASSIGN_KEY = "tasks.assign";

export interface TaskPerson {
  id: number;
  name: string;
}

export interface TaskSummary {
  id: number;
  title: string;
  status: TaskStatus;
  priority: "normal" | "urgent";
  dueDate: string | null;
  mo: string | null;
  shared: boolean;
  batchId: string | null;
  createdById: number | null;
  createdByName: string;
  assignees: TaskPerson[];
  createdAt: string;
  activityAt: string;
  /** This person's task news on it not read yet. */
  unread: number;
  overdue: boolean;
  /** The latest entry of its thread, for the list's second line. */
  last: { authorName: string; kind: string; body: string; at: string } | null;
  /** Its checklist's steps ticked of all (0 of 0: none). */
  steps: { done: number; total: number };
  /** Given by a repeating task. */
  repeatId: number | null;
  submittedAt: string | null;
  closedAt: string | null;
}

export interface TaskUpdateView {
  id: number;
  authorId: number | null;
  authorName: string;
  kind: TaskMove;
  body: string;
  attachments: StoredFile[];
  via: string;
  createdAt: string;
}

export interface TaskDetail extends TaskSummary {
  details: string;
  attachments: StoredFile[];
  via: string;
  checklist: ChecklistItem[];
  /** The repeating task it came from, as its giver sees it. */
  repeat: { id: number; text: string; enabled: boolean } | null;
  updates: TaskUpdateView[];
  role: TaskRole;
  /** Who is looking — their own entries sit on the other side of the thread. */
  viewerId: number;
  /** A task its giver gave only themselves: marking it done closes it. */
  selfOnly: boolean;
  /** What this person may do on it now. */
  moves: TaskMove[];
  /** The others made with it as "one each" — the giver's view of the batch. */
  batch: { id: number; status: TaskStatus; assignee: string }[];
}

export interface TaskTemplateView {
  id: number;
  name: string;
  title: string;
  details: string;
  checklist: string[];
  priority: "normal" | "urgent";
  people: number[];
  shared: boolean;
}

export interface TaskRepeatView {
  id: number;
  title: string;
  text: string;
  enabled: boolean;
  people: TaskPerson[];
  nextOn: string | null;
  lastGivenOn: string | null;
  lastError: string | null;
}

export interface TasksData {
  /** Given to this person. */
  mine: TaskSummary[];
  /** Given by this person. */
  sent: TaskSummary[];
  canAssign: boolean;
  templates: TaskTemplateView[];
  repeats: TaskRepeatView[];
  /** The load of the people this person gives tasks to (the owner: everyone's) — null for someone who gives none. */
  team: PersonLoad[] | null;
  /** The team is everyone's (the app's owner), not only the people this person gives tasks to. */
  teamAll: boolean;
}

const SUMMARY_INCLUDE = {
  assignees: { select: { user: { select: { id: true, name: true } } }, orderBy: { id: "asc" } },
  updates: { orderBy: { id: "desc" }, take: 1, select: { authorName: true, kind: true, body: true, createdAt: true } },
} satisfies Prisma.TaskInclude;

type SummaryRow = Prisma.TaskGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

function summaryOf(t: SummaryRow, unread: number, todayISO: string): TaskSummary {
  const status: TaskStatus = isTaskStatus(t.status) ? t.status : "open";
  const due = dayOf(t.dueDate);
  const last = t.updates[0];
  return {
    id: t.id, title: t.title, status, priority: t.priority === "urgent" ? "urgent" : "normal", dueDate: due, mo: t.mo, shared: t.shared, batchId: t.batchId,
    createdById: t.createdById, createdByName: t.createdByName, assignees: t.assignees.map((a) => a.user),
    createdAt: t.createdAt.toISOString(), activityAt: t.activityAt.toISOString(), unread, overdue: isOverdue(status, due, todayISO),
    last: last ? { authorName: last.authorName, kind: last.kind, body: last.body.slice(0, 200), at: last.createdAt.toISOString() } : null,
    steps: checklistProgress(checklistOf(t.checklist)), repeatId: t.repeatId,
    submittedAt: t.submittedAt?.toISOString() ?? null, closedAt: t.closedAt?.toISOString() ?? null,
  };
}

/** The unread task news of a person, by task. */
async function unreadByTask(userId: number, taskIds?: number[]): Promise<Map<number, number>> {
  const rows = await prisma.aiInboxItem.groupBy({
    by: ["taskId"],
    where: { userId, kind: "task", readAt: null, taskId: taskIds ? { in: taskIds } : { not: null } },
    _count: { _all: true },
  });
  return new Map(rows.flatMap((r) => (r.taskId ? [[r.taskId, r._count._all] as const] : [])));
}

/** Open tasks all, closed ones the latest few — newest activity first. */
const LIST_OPEN = 200;
const LIST_CLOSED = 40;

async function listOf(where: Prisma.TaskWhereInput): Promise<SummaryRow[]> {
  const [open, closed] = await Promise.all([
    prisma.task.findMany({ where: { ...where, status: { notIn: ["done", "cancelled"] } }, include: SUMMARY_INCLUDE, orderBy: { activityAt: "desc" }, take: LIST_OPEN }),
    prisma.task.findMany({ where: { ...where, status: { in: ["done", "cancelled"] } }, include: SUMMARY_INCLUDE, orderBy: { activityAt: "desc" }, take: LIST_CLOSED }),
  ]);
  return [...open, ...closed];
}

/** A person's tasks: given to them, and given by them — with their
 *  templates, their repeating tasks, and the load of the people they give
 *  tasks to (the owner sees everyone's). */
export async function tasksData(me: User, now = new Date()): Promise<TasksData> {
  const today = factoryDayISO(now);
  const canAssign = hasPerm(me, ASSIGN_KEY);
  const [mine, sent, unread, templates, repeats] = await Promise.all([
    listOf({ assignees: { some: { userId: me.id } } }),
    listOf({ createdById: me.id }),
    unreadByTask(me.id),
    prisma.taskTemplate.findMany({ where: { ownerId: me.id }, orderBy: { name: "asc" }, take: 100 }),
    prisma.taskRepeat.findMany({ where: { ownerId: me.id }, orderBy: [{ enabled: "desc" }, { title: "asc" }], take: 100 }),
  ]);
  const names = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(repeats.flatMap((r) => r.people))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    mine: mine.map((t) => summaryOf(t, unread.get(t.id) ?? 0, today)),
    sent: sent.map((t) => summaryOf(t, unread.get(t.id) ?? 0, today)),
    canAssign,
    templates: templates.map((t) => ({
      id: t.id, name: t.name, title: t.title, details: t.details, checklist: checklistOf(t.checklist).map((x) => x.text),
      priority: t.priority === "urgent" ? "urgent" : "normal", people: t.people, shared: t.shared,
    })),
    repeats: repeats.map((r) => ({
      id: r.id, title: r.title, text: describeRepeat(ruleOf(r)), enabled: r.enabled,
      people: r.people.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
      nextOn: dayOf(r.nextOn), lastGivenOn: dayOf(r.lastGivenOn), lastError: r.lastError,
    })),
    team: me.isOwner || canAssign || sent.length > 0 ? await teamOf(me, today) : null,
    teamAll: me.isOwner,
  };
}

/** The load of the people a person gives tasks to — the owner's is everyone's. */
export async function teamOf(me: User, todayISO: string): Promise<PersonLoad[]> {
  const since = new Date(`${todayISO}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 31);
  const rows = await prisma.task.findMany({
    where: {
      ...(me.isOwner ? {} : { createdById: me.id }),
      OR: [{ status: { in: ["open", "in_progress", "returned", "submitted"] } }, { closedAt: { gte: since } }],
    },
    select: { status: true, dueDate: true, createdAt: true, submittedAt: true, closedAt: true, assignees: { select: { user: { select: { id: true, name: true } } } } },
    orderBy: { activityAt: "desc" },
    take: 3000,
  });
  return teamLoad(rows.map((t) => ({
    status: isTaskStatus(t.status) ? t.status : "open", dueDate: dayOf(t.dueDate), createdAt: t.createdAt.toISOString(),
    submittedAt: t.submittedAt?.toISOString() ?? null, closedAt: t.closedAt?.toISOString() ?? null, assignees: t.assignees.map((a) => a.user),
  })), todayISO);
}

/** A stored repeating task's rule. */
export function ruleOf(r: { every: string; weekdays: number[]; monthDay: number | null; dueDays: number }): RepeatRule {
  return { every: r.every === "week" || r.every === "month" ? r.every : "day", weekdays: r.weekdays, monthDay: r.monthDay, dueDays: r.dueDays };
}

/** Where a person stands on a task — its giver (the owner stands in for a
 *  giver whose account is gone), one of its people, both, or neither. */
export function roleOf(me: User, t: { createdById: number | null; assignees: { userId: number }[] }): TaskRole {
  return {
    giver: t.createdById === me.id || (t.createdById === null && me.isOwner),
    doer: t.assignees.some((a) => a.userId === me.id),
  };
}

export const selfOnlyOf = (t: { createdById: number | null; assignees: { userId: number }[] }): boolean =>
  t.assignees.length === 1 && t.assignees[0].userId === t.createdById;

/** One task as its giver or one of its people sees it — null for anyone else. */
export async function taskDetail(me: User, id: number, now = new Date()): Promise<TaskDetail | null> {
  const t = await prisma.task.findUnique({
    where: { id },
    include: {
      ...SUMMARY_INCLUDE,
      updates: { orderBy: { id: "asc" }, take: 500 },
    },
  });
  if (!t) return null;
  const people = t.assignees.map((a) => ({ userId: a.user.id }));
  const role = roleOf(me, { createdById: t.createdById, assignees: people });
  if (!role.giver && !role.doer) return null;
  const unread = await unreadByTask(me.id, [t.id]);
  const lastRow = t.updates.at(-1);
  const summary = summaryOf({ ...t, updates: lastRow ? [lastRow] : [] }, unread.get(t.id) ?? 0, factoryDayISO(now));
  const selfOnly = selfOnlyOf({ createdById: t.createdById, assignees: people });
  const batch = role.giver && t.batchId
    ? (await prisma.task.findMany({
        where: { batchId: t.batchId, id: { not: t.id } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, assignees: { select: { user: { select: { name: true } } }, take: 1 } },
      })).map((b) => ({ id: b.id, status: (isTaskStatus(b.status) ? b.status : "open") as TaskStatus, assignee: b.assignees[0]?.user.name ?? "—" }))
    : [];
  const repeat = role.giver && t.repeatId ? await prisma.taskRepeat.findUnique({ where: { id: t.repeatId } }) : null;
  return {
    ...summary,
    details: t.details,
    attachments: storedFilesOf(t.attachments),
    via: t.via,
    checklist: checklistOf(t.checklist),
    repeat: repeat ? { id: repeat.id, text: describeRepeat(ruleOf(repeat)), enabled: repeat.enabled } : null,
    updates: t.updates.map((u) => ({
      id: u.id, authorId: u.authorId, authorName: u.authorName, kind: u.kind as TaskMove, body: u.body,
      attachments: storedFilesOf(u.attachments), via: u.via, createdAt: u.createdAt.toISOString(),
    })),
    role,
    viewerId: me.id,
    selfOnly,
    moves: movesFor(summary.status, role, { selfOnly }),
    batch,
  };
}

// ---- the news ----

interface NewsTask {
  id: number;
  title: string;
  dueDate: Date | null;
  priority: string;
  details: string;
  createdById: number | null;
  createdByName: string;
  assignees: { userId: number }[];
}

const quote = (text: string) => text.trim().split("\n").map((l) => `> ${l}`).join("\n");

type News = TaskMove | "create" | "overdue" | "due" | "tick";

/** What a move tells the others on the task: the notification's title and its body. */
export function newsOf(t: NewsTask, move: News, by: string, text: string): { title: string; body: string } {
  const said = text.trim() ? `\n\n${quote(text)}` : "";
  const due = t.dueDate ? ` — due ${formatDate(dayOf(t.dueDate))}` : "";
  switch (move) {
    case "create":
      return {
        title: `${t.priority === "urgent" ? "Urgent task" : "New task"}: ${t.title}`,
        body: `**${by}** gave you a task${due}.${t.details.trim() ? `\n\n${t.details.trim()}` : ""}`,
      };
    case "note":
      return { title: `${by} on “${t.title}”`, body: text.trim() || "(a photo or a file)" };
    case "start":
      return { title: `Started: ${t.title}`, body: `**${by}** started it.${said}` };
    case "submit":
      return { title: `Done — to review: ${t.title}`, body: `**${by}** marked it done.${said}` };
    case "approve":
      return { title: `Approved: ${t.title}`, body: `**${by}** approved it.${said}` };
    case "return":
      return { title: `Returned for rework: ${t.title}`, body: `**${by}** returned it:${said}` };
    case "cancel":
      return { title: `Cancelled: ${t.title}`, body: `**${by}** cancelled it.${said}` };
    case "reopen":
      return { title: `Reopened: ${t.title}`, body: `**${by}** reopened it:${said}` };
    case "overdue":
      return { title: `Overdue: ${t.title}`, body: `It was due ${formatDate(dayOf(t.dueDate))} and is not done yet.` };
    case "due":
      return { title: `Due today: ${t.title}`, body: `It is due today, ${formatDate(dayOf(t.dueDate))}.` };
    case "tick":
      return { title: `${by} on “${t.title}”`, body: text };
  }
}

/** Tell everyone on the task but `exceptId` what just happened. */
export async function sendTaskNews(t: NewsTask, move: News, by: string, text: string, exceptId: number | null): Promise<void> {
  const to = new Set<number>(t.assignees.map((a) => a.userId));
  if (t.createdById) to.add(t.createdById);
  if (exceptId) to.delete(exceptId);
  if (to.size === 0) return;
  const news = newsOf(t, move, by, text);
  await deliverToInbox([...to].map((userId) => ({ userId, kind: "task" as const, title: news.title, body: news.body, fromName: by, taskId: t.id })));
}

/** Each task past its due day, still in its people's hands, tells them and
 *  its giver — once. The minute tick calls it inside the plant's hours. */
export async function remindOverdueTasks(now: Date): Promise<number> {
  const today = factoryDayISO(now);
  const due = await prisma.task.findMany({
    where: {
      status: { in: ["open", "in_progress", "returned"] },
      dueDate: { lt: new Date(`${today}T00:00:00Z`) },
      overdueSentAt: null,
    },
    include: { assignees: { select: { userId: true } } },
    orderBy: { dueDate: "asc" },
    take: 100,
  });
  let sent = 0;
  for (const t of due) {
    // claimed first, so two ticks never send it twice
    const claim = await prisma.task.updateMany({ where: { id: t.id, overdueSentAt: null }, data: { overdueSentAt: now } });
    if (claim.count !== 1) continue;
    await sendTaskNews(t, "overdue", "Tasks", "", null);
    sent++;
  }
  return sent;
}

/** Read a person's news on a task — they opened it. */
export async function markTaskNewsRead(userId: number, taskId: number): Promise<void> {
  await prisma.aiInboxItem.updateMany({ where: { userId, taskId, readAt: null }, data: { readAt: new Date() } });
}

// ---- giving tasks ----

export interface GiveInput {
  title: string;
  details: string;
  people: number[];
  shared: boolean;
  priority: "normal" | "urgent";
  dueISO: string | null;
  mo: string | null;
  checklist: ChecklistItem[];
  attachments?: StoredFile[];
  repeatId?: number | null;
}

/** Whether `me` may give these people a task now: all of them active, and —
 *  by hand — within the hourly cap (a repeating task, bounded by its own
 *  limits, does not use up its giver's hour). */
export async function canGive(me: User, people: number[], shared: boolean, via: string): Promise<{ ok: true; names: Map<number, string> } | { ok: false; error: string; code?: "inactive" }> {
  const found = await prisma.user.findMany({ where: { id: { in: people }, active: true }, select: { id: true, name: true } });
  if (found.length !== people.length) return { ok: false, error: "One of them is not an active user.", code: "inactive" };
  if (via !== "repeat") {
    const count = shared ? 1 : people.length;
    const lastHour = await prisma.task.count({ where: { createdById: me.id, via: { not: "repeat" }, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (lastHour + count > TASK_LIMITS.perHour) return { ok: false, error: `That is more than ${TASK_LIMITS.perHour} tasks in an hour — wait a while.` };
  }
  return { ok: true, names: new Map(found.map((u) => [u.id, u.name])) };
}

/** Everyone on a task — the only people its events may reach. */
export const participantsOf = (t: { createdById: number | null; assignees: { userId: number }[] }) =>
  [...new Set([...(t.createdById ? [t.createdById] : []), ...t.assignees.map((a) => a.userId)])];

/** Give a task as `me` — already allowed to: one each (made together) or one
 *  shared, its people told and its event recorded. The people must all be
 *  active; the hourly cap holds. Used by the giver's form, the assistant (as
 *  the person) and a repeating task (as its giver). */
export async function giveTask(me: User, i: GiveInput, via: string): Promise<{ ok: true; ids: number[] } | { ok: false; error: string; code?: "inactive" }> {
  const checked = await canGive(me, i.people, i.shared, via);
  if (!checked.ok) return checked;
  const nameOf = checked.names;

  const base = {
    title: i.title, details: i.details, priority: i.priority, mo: i.mo, attachments: (i.attachments ?? []) as unknown as object, createdById: me.id, createdByName: me.name, via,
    dueDate: i.dueISO ? new Date(`${i.dueISO}T00:00:00Z`) : null, checklist: i.checklist as unknown as object, repeatId: i.repeatId ?? null,
  };
  const groups = i.shared ? [i.people] : i.people.map((p) => [p]);
  const batchId = !i.shared && i.people.length > 1 ? randomUUID() : null;
  const made = await prisma.$transaction(
    groups.map((ids) =>
      prisma.task.create({
        data: { ...base, shared: i.shared && ids.length > 1, batchId, assignees: { create: ids.map((userId) => ({ userId })) } },
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

// ---- what the minute tick does for tasks ----

/** Each task due today, still in its people's hands, reminds them that
 *  morning — once. */
export async function remindDueToday(now: Date): Promise<number> {
  const today = factoryDayISO(now);
  const due = await prisma.task.findMany({
    where: { status: { in: ["open", "in_progress", "returned"] }, dueDate: new Date(`${today}T00:00:00Z`), dueSoonSentAt: null },
    include: { assignees: { select: { userId: true } } },
    take: 200,
  });
  let sent = 0;
  for (const t of due) {
    // not one given today — its people have just heard of it
    if (factoryDayISO(t.createdAt) >= today) continue;
    const claim = await prisma.task.updateMany({ where: { id: t.id, dueSoonSentAt: null }, data: { dueSoonSentAt: now } });
    if (claim.count !== 1) continue;
    // its people only — the giver hears when it is late
    await sendTaskNews({ ...t, createdById: null }, "due", "Tasks", "", null);
    sent++;
  }
  return sent;
}

/** Markdown's own characters in a name or a title, written as themselves. */
const plain = (s: string) => s.replace(/[\\`*_[\]<>#|~]/g, "\\$&");

/** How far back a late task is still sent up — the ones late for longer
 *  (before this existed) are long known, and never flood the owner at once. */
const ESCALATE_WITHIN_DAYS = 14;

/** A task late by so many days goes up to the app's owner(s) — once — with
 *  who has it and who gave it. A task someone gave only themselves is their
 *  own business and stays with them. */
export async function escalateLateTasks(now: Date): Promise<number> {
  const today = factoryDayISO(now);
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - TASK_ESCALATE_LATE_DAYS);
  const oldest = new Date(`${today}T00:00:00Z`);
  oldest.setUTCDate(oldest.getUTCDate() - ESCALATE_WITHIN_DAYS);
  const late = await prisma.task.findMany({
    where: { status: { in: ["open", "in_progress", "returned"] }, dueDate: { lte: cutoff, gte: oldest }, escalatedAt: null },
    include: { assignees: { select: { user: { select: { id: true, name: true } } } } },
    orderBy: { dueDate: "asc" },
    take: 50,
  });
  const owners = await prisma.user.findMany({ where: { isOwner: true, active: true }, select: { id: true } });
  let sent = 0;
  for (const t of late) {
    if (!lateBy(isTaskStatus(t.status) ? t.status : "open", dayOf(t.dueDate), today, TASK_ESCALATE_LATE_DAYS)) continue;
    if (selfOnlyOf({ createdById: t.createdById, assignees: t.assignees.map((a) => ({ userId: a.user.id })) })) continue;
    const claim = await prisma.task.updateMany({ where: { id: t.id, escalatedAt: null }, data: { escalatedAt: now } });
    if (claim.count !== 1) continue;
    const people = plain(t.assignees.map((a) => a.user.name).join(", "));
    const onIt = new Set(t.assignees.map((a) => a.user.id));
    const to = owners.map((o) => o.id).filter((id) => id !== t.createdById && !onIt.has(id));
    if (to.length > 0) {
      await deliverToInbox(to.map((userId) => ({
        userId, kind: "message" as const, fromName: "Tasks",
        title: `Late task: ${t.title}`,
        body: `Task #${t.id} “${plain(t.title)}”, given by **${plain(t.createdByName)}** to **${people}**, was due ${formatDate(dayOf(t.dueDate))} and is still not done.`,
      })));
    }
    sent++;
  }
  return sent;
}

/** Give each repeating task due today (or missed since) — once a day, as
 *  its giver, while they may still give tasks; its next day booked first,
 *  so two ticks never give it twice. */
export async function giveRepeatingTasks(now: Date): Promise<number> {
  const today = factoryDayISO(now);
  const todayDate = new Date(`${today}T00:00:00Z`);
  const due = await prisma.taskRepeat.findMany({ where: { enabled: true, nextOn: { lte: todayDate } }, include: { owner: true }, orderBy: { id: "asc" }, take: 50 });
  if (due.length === 0) return 0;
  const offDay = await offDays(now);
  let given = 0;
  for (const r of due) {
    const tomorrow = new Date(todayDate.getTime() + 86_400_000).toISOString().slice(0, 10);
    const next = nextRepeatDay(ruleOf(r), tomorrow, offDay);
    const claim = await prisma.taskRepeat.updateMany({ where: { id: r.id, nextOn: r.nextOn }, data: { nextOn: next ? new Date(`${next}T00:00:00Z`) : null } });
    if (claim.count !== 1) continue;
    const owner = effectiveUser(r.owner);
    const stop = async (why: string) => {
      await prisma.taskRepeat.update({ where: { id: r.id }, data: { enabled: false, lastError: why } });
      await deliverToInbox([{ userId: r.ownerId, kind: "message", fromName: "Tasks", title: `Repeating task stopped: ${r.title}`, body: `Your repeating task **${r.title}** stopped: ${why}` }]);
    };
    if (!owner.active || !hasPerm(owner, ASSIGN_KEY)) {
      await stop("you may no longer give tasks.");
      continue;
    }
    let r2: Awaited<ReturnType<typeof giveTask>>;
    try {
      r2 = await giveTask(owner, {
        title: r.title, details: r.details, people: r.people, shared: r.shared, priority: r.priority === "urgent" ? "urgent" : "normal",
        dueISO: workingDaysAfter(today, r.dueDays, offDay), mo: r.mo, checklist: checklistOf(r.checklist).map((x) => ({ ...x, done: false, by: null, at: null })), repeatId: r.id,
      }, "repeat");
    } catch (e) {
      // kept on it for its giver to see; the next one comes on its next day
      await prisma.taskRepeat.update({ where: { id: r.id }, data: { lastError: `Not given on ${formatDate(today)} — something went wrong.` } }).catch(() => {});
      console.error(`tasks: repeating task ${r.id} failed`, e);
      continue;
    }
    if (!r2.ok) {
      // someone it goes to has left: it stops and says so; anything else waits for the next day
      if (r2.code === "inactive") await stop("one of its people is no longer an active user — stop it and give it again to the right people.");
      else await prisma.taskRepeat.update({ where: { id: r.id }, data: { lastError: r2.error } });
      continue;
    }
    await prisma.taskRepeat.update({ where: { id: r.id }, data: { lastGivenOn: todayDate, lastError: null } });
    given++;
  }
  return given;
}
