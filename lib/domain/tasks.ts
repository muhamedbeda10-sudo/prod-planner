// Tasks — pure rules, for the server and the screens alike: what a task's
// states are, who may do what to it in which state, and what that moves it
// to. The server action checks every move against these before it writes.

export const TASK_STATUSES = ["open", "in_progress", "submitted", "returned", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "To do",
  in_progress: "In progress",
  submitted: "Waiting for review",
  returned: "Returned for rework",
  done: "Done",
  cancelled: "Cancelled",
};

/** The pill each state wears. */
export const TASK_STATUS_TONE: Record<TaskStatus, string> = {
  open: "pill-muted",
  in_progress: "pill-info",
  submitted: "pill-warn",
  returned: "pill-bad",
  done: "pill-ok",
  cancelled: "pill-muted",
};

export const TASK_PRIORITIES = ["normal", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** What can happen on a task: a note, or a move with what was said with it. */
export const TASK_MOVES = ["note", "start", "submit", "approve", "return", "cancel", "reopen"] as const;
export type TaskMove = (typeof TASK_MOVES)[number];

export const TASK_MOVE_LABEL: Record<TaskMove, string> = {
  note: "Update",
  start: "Started",
  submit: "Marked done",
  approve: "Approved",
  return: "Returned for rework",
  cancel: "Cancelled",
  reopen: "Reopened",
};

export const TASK_LIMITS = {
  title: 120,
  details: 4000,
  update: 2000,
  /** People one task (or one batch) goes to. */
  people: 20,
  /** Photos and files on one task or one update. */
  files: 6,
  /** Tasks one person may give in an hour — each one reaches phones. */
  perHour: 60,
  /** Updates one person may post on tasks in an hour. */
  updatesPerHour: 200,
} as const;

/** Over: done or cancelled — nothing more happens unless it is reopened. */
export const isClosed = (s: TaskStatus): boolean => s === "done" || s === "cancelled";

/** Where a person stands on a task. */
export interface TaskRole {
  /** They gave it (or, its giver gone, they are the owner). */
  giver: boolean;
  /** It was given to them. */
  doer: boolean;
}

/**
 * The state a move takes a task to — or why it may not be made, by this
 * person, now. A note changes nothing but is still checked: only the task's
 * people write on it, and not once it is closed.
 *
 * The giver who is also its only doer (a task they gave themselves) closes it
 * by marking it done: there is no one else to approve it.
 */
export function moveTask(status: TaskStatus, move: TaskMove, role: TaskRole, o: { selfOnly?: boolean } = {}): { next: TaskStatus } | { error: string } {
  if (!role.giver && !role.doer) return { error: "This task is not yours — only the one who gave it and the people it was given to can act on it." };
  switch (move) {
    case "note":
      if (isClosed(status)) return { error: `The task is ${TASK_STATUS_LABEL[status].toLowerCase()} — reopen it to write on it.` };
      // a word from its people on a task not started yet: they are on it
      return { next: role.doer && status === "open" ? "in_progress" : status };
    case "start":
      if (!role.doer) return { error: "Only the people it was given to start it." };
      if (status !== "open") return { error: `It is ${TASK_STATUS_LABEL[status].toLowerCase()} already.` };
      return { next: "in_progress" };
    case "submit":
      if (!role.doer) return { error: "Only the people it was given to mark it done." };
      if (status !== "open" && status !== "in_progress" && status !== "returned") return { error: `It cannot be marked done while it is ${TASK_STATUS_LABEL[status].toLowerCase()}.` };
      return { next: role.giver && o.selfOnly ? "done" : "submitted" };
    case "approve":
      if (!role.giver) return { error: "Only the one who gave the task approves it." };
      if (status !== "submitted") return { error: "Only a task marked done and waiting for review can be approved." };
      return { next: "done" };
    case "return":
      if (!role.giver) return { error: "Only the one who gave the task returns it." };
      if (status !== "submitted") return { error: "Only a task marked done and waiting for review can be returned." };
      return { next: "returned" };
    case "cancel":
      if (!role.giver) return { error: "Only the one who gave the task cancels it." };
      if (isClosed(status)) return { error: `It is ${TASK_STATUS_LABEL[status].toLowerCase()} already.` };
      return { next: "cancelled" };
    case "reopen":
      if (!role.giver) return { error: "Only the one who gave the task reopens it." };
      if (!isClosed(status)) return { error: "Only a task that is done or cancelled can be reopened." };
      return { next: "returned" };
  }
}

/** Moves that must say something: why it goes back, what to redo. */
export const MOVE_NEEDS_TEXT: ReadonlySet<TaskMove> = new Set(["note", "return", "reopen"]);

/** The moves this person may make on the task now — the buttons it shows. */
export function movesFor(status: TaskStatus, role: TaskRole, o: { selfOnly?: boolean } = {}): TaskMove[] {
  return TASK_MOVES.filter((m) => m !== "note" && "next" in moveTask(status, m, role, o));
}

/** Past its due day and still in its people's hands. A task waiting for
 *  review is in the giver's, so it is not counted late. */
export function isOverdue(status: TaskStatus, dueISO: string | null, todayISO: string): boolean {
  if (!dueISO) return false;
  if (status !== "open" && status !== "in_progress" && status !== "returned") return false;
  return dueISO < todayISO;
}

/** A due day typed or sent ("2026-10-20"): the day itself, or null when it is not one. */
export function cleanDueDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === raw.trim() ? raw.trim() : null;
}

export const isTaskStatus = (s: string): s is TaskStatus => (TASK_STATUSES as readonly string[]).includes(s);
export const isTaskMove = (s: string): s is TaskMove => (TASK_MOVES as readonly string[]).includes(s);
