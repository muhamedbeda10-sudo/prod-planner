import "server-only";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { deliverToInbox } from "@/lib/server/inbox";
import { storedFilesOf, type StoredFile } from "@/lib/server/uploads";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDate } from "@/lib/domain/format";
import { isOverdue, isTaskStatus, movesFor, type TaskMove, type TaskRole, type TaskStatus } from "@/lib/domain/tasks";

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
  submittedAt: string | null;
  closedAt: string | null;
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

export interface TasksData {
  /** Given to this person. */
  mine: TaskSummary[];
  /** Given by this person. */
  sent: TaskSummary[];
  canAssign: boolean;
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

/** A person's tasks: given to them, and given by them. */
export async function tasksData(me: User, now = new Date()): Promise<TasksData> {
  const today = factoryDayISO(now);
  const [mine, sent, unread] = await Promise.all([
    listOf({ assignees: { some: { userId: me.id } } }),
    listOf({ createdById: me.id }),
    unreadByTask(me.id),
  ]);
  return {
    mine: mine.map((t) => summaryOf(t, unread.get(t.id) ?? 0, today)),
    sent: sent.map((t) => summaryOf(t, unread.get(t.id) ?? 0, today)),
    canAssign: hasPerm(me, ASSIGN_KEY),
  };
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
  return {
    ...summary,
    details: t.details,
    attachments: storedFilesOf(t.attachments),
    via: t.via,
    submittedAt: t.submittedAt?.toISOString() ?? null,
    closedAt: t.closedAt?.toISOString() ?? null,
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

/** What a move tells the others on the task: the notification's title and its body. */
export function newsOf(t: NewsTask, move: TaskMove | "create" | "overdue", by: string, text: string): { title: string; body: string } {
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
  }
}

/** Tell everyone on the task but `exceptId` what just happened. */
export async function sendTaskNews(t: NewsTask, move: TaskMove | "create" | "overdue", by: string, text: string, exceptId: number | null): Promise<void> {
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
