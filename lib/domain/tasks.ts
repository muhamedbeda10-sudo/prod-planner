// Tasks — pure rules, for the server and the screens alike: what a task's
// states are, who may do what to it in which state, and what that moves it
// to. The server action checks every move against these before it writes.

import { factoryDayISO } from "./dates";

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

// ---- Tasks 2.0: checklists, templates, repeats, reminders, the team's load ----

/** One step of a task's checklist: ticked by its giver or its people. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** Who ticked it, and when — kept so the thread can say so. */
  by?: string | null;
  at?: string | null;
}

export const CHECKLIST_LIMITS = { items: 30, text: 200 } as const;

/** A checklist as given (lines of text, or items) — cleaned: blank lines
 *  dropped, each step cut to size, at most so many, every step unticked (a
 *  tick is only ever made by tickItem). An item keeps an id it was given;
 *  a new step gets one that clashes with none given here nor any in `taken`
 *  (the ids a task had — so a new step never inherits a removed one's tick). */
export function cleanChecklist(raw: unknown, o: { taken?: Iterable<string> } = {}): ChecklistItem[] | { error: string } {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : null;
  if (!list) return { error: "The checklist could not be read." };
  const steps: { text: string; id: string }[] = [];
  for (const x of list) {
    const obj = typeof x === "object" && x !== null ? (x as { text?: unknown; id?: unknown }) : null;
    const text = (typeof x === "string" ? x : typeof obj?.text === "string" ? obj.text : "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > CHECKLIST_LIMITS.text) return { error: `A checklist step is at most ${CHECKLIST_LIMITS.text} characters.` };
    if (steps.length >= CHECKLIST_LIMITS.items) return { error: `At most ${CHECKLIST_LIMITS.items} checklist steps.` };
    steps.push({ text, id: typeof obj?.id === "string" ? obj.id.slice(0, 40) : "" });
  }
  const used = new Set<string>(o.taken ?? []);
  const kept = new Set<string>();
  for (const st of steps) if (st.id && !kept.has(st.id)) kept.add(st.id);
  for (const id of kept) used.add(id);
  let n = 1;
  const seen = new Set<string>();
  return steps.map((st) => {
    let id = st.id && !seen.has(st.id) ? st.id : "";
    if (!id) {
      while (used.has(`s${n}`)) n++;
      id = `s${n}`;
      used.add(id);
    }
    seen.add(id);
    return { id, text: st.text, done: false, by: null, at: null };
  });
}

/** A stored checklist read back — whatever does not read is left out; a
 *  tick keeps who (a name) and when (a date) only when they read as such. */
export function checklistOf(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ChecklistItem[] = [];
  for (const x of raw.slice(0, CHECKLIST_LIMITS.items)) {
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.text !== "string" || !r.text.trim()) continue;
    const done = r.done === true;
    const by = done && typeof r.by === "string" ? r.by.slice(0, 80) : null;
    const at = done && typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : null;
    out.push({ id: r.id.slice(0, 40), text: r.text.slice(0, CHECKLIST_LIMITS.text), done, by, at });
  }
  return out;
}

/** How far a checklist is: steps ticked of all. */
export function checklistProgress(items: readonly ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((x) => x.done).length, total: items.length };
}

/** A step ticked or unticked — by whom and when — or why it cannot be. */
export function tickItem(items: readonly ChecklistItem[], itemId: string, done: boolean, by: string, at: string): ChecklistItem[] | { error: string } {
  if (!items.some((x) => x.id === itemId)) return { error: "That step is not on the checklist any more." };
  return items.map((x) => (x.id === itemId ? { ...x, done, by: done ? by : null, at: done ? at : null } : x));
}

// ---- repeating tasks ----

export const REPEAT_EVERY = ["day", "week", "month"] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];

export const REPEAT_LIMITS = { perOwner: 30, dueDays: 30 } as const;

/** How a task repeats: each working day, on certain weekdays, or on a day of
 *  the month (a short month's last day standing in for 29–31). */
export interface RepeatRule {
  every: RepeatEvery;
  /** week: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** month: 1–31. */
  monthDay: number | null;
  /** Working days after the day it is given that it is due (0 = the same day). */
  dueDays: number;
}

export function cleanRepeat(raw: unknown): RepeatRule | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "How it repeats could not be read." };
  const r = raw as Record<string, unknown>;
  const every = r.every;
  if (!REPEAT_EVERY.includes(every as RepeatEvery)) return { error: "Repeat it each day, each week or each month." };
  const dueDays = r.dueDays === undefined || r.dueDays === null ? 0 : Number(r.dueDays);
  if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > REPEAT_LIMITS.dueDays) return { error: `Due 0 to ${REPEAT_LIMITS.dueDays} working days after it is given.` };
  if (every === "week") {
    const days = Array.isArray(r.weekdays) ? [...new Set(r.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b) : [];
    if (days.length === 0) return { error: "Choose the days of the week it comes on." };
    return { every, weekdays: days, monthDay: null, dueDays };
  }
  if (every === "month") {
    const d = Number(r.monthDay);
    if (!Number.isInteger(d) || d < 1 || d > 31) return { error: "Choose the day of the month it comes on (1–31)." };
    return { every, weekdays: [], monthDay: d, dueDays };
  }
  return { every: "day", weekdays: [], monthDay: null, dueDays };
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Each working day", "Each Sun, Tue", "Each month on the 1st" — and when it is due. */
export function describeRepeat(r: RepeatRule): string {
  const due = r.dueDays === 0 ? "due the same day" : `due in ${r.dueDays} working day${r.dueDays === 1 ? "" : "s"}`;
  if (r.every === "week") return `Each ${r.weekdays.map((d) => WEEKDAY_SHORT[d]).join(", ")} — ${due}`;
  if (r.every === "month") {
    const n = r.monthDay!;
    const th = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `Each month on the ${n}${th} — ${due}`;
  }
  return `Each working day — ${due}`;
}

const isoDay = (iso: string) => new Date(`${iso}T00:00:00Z`);
const plusDays = (iso: string, n: number) => new Date(isoDay(iso).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** The next day a repeating task is given, on or after `fromISO`: a day off
 *  (Friday, a holiday) moves to the working day after it — for a weekly or
 *  monthly one too, so it is never lost. Null only when nothing comes within
 *  a year. */
export function nextRepeatDay(r: RepeatRule, fromISO: string, offDay: (iso: string) => boolean): string | null {
  for (let i = 0; i < 400; i++) {
    const iso = plusDays(fromISO, i);
    const d = isoDay(iso);
    let hit = false;
    if (r.every === "day") hit = true;
    else if (r.every === "week") hit = r.weekdays.includes(d.getUTCDay());
    else {
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      hit = d.getUTCDate() === Math.min(r.monthDay!, last);
    }
    if (!hit) continue;
    let day = iso;
    for (let g = 0; offDay(day) && g < 30; g++) day = plusDays(day, 1);
    if (!offDay(day)) return day;
  }
  return null;
}

/** So many working days after a day (0 = the day itself, moved off a day off). */
export function workingDaysAfter(fromISO: string, days: number, offDay: (iso: string) => boolean): string {
  let iso = fromISO;
  let guard = 0;
  for (let left = days; left > 0 && guard < 90; guard++) {
    iso = plusDays(iso, 1);
    if (!offDay(iso)) left--;
  }
  for (; offDay(iso) && guard < 90; guard++) iso = plusDays(iso, 1);
  return iso;
}

// ---- reminders and escalation ----

/** Days a task may stay late before it goes up to the app's owner. */
export const TASK_ESCALATE_LATE_DAYS = 2;

/** Late by at least `days` calendar days (and still in its people's hands). */
export function lateBy(status: TaskStatus, dueISO: string | null, todayISO: string, days: number): boolean {
  if (!isOverdue(status, dueISO, todayISO)) return false;
  return (isoDay(todayISO).getTime() - isoDay(dueISO!).getTime()) / 86_400_000 >= days;
}

// ---- the views: filters, the board, the calendar ----

export type DueFilter = "any" | "late" | "today" | "week" | "none";

export interface TaskFilter {
  q: string;
  priority: "any" | TaskPriority;
  /** A person on the task (given to them, or by them); null for anyone. */
  person: number | null;
  due: DueFilter;
}

export const NO_FILTER: TaskFilter = { q: "", priority: "any", person: null, due: "any" };

/** Whether a filter narrows anything. */
export const isFiltered = (f: TaskFilter): boolean => f.q.trim() !== "" || f.priority !== "any" || f.person !== null || f.due !== "any";

export interface FilterableTask {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  mo: string | null;
  overdue: boolean;
  createdById: number | null;
  createdByName: string;
  assignees: { id: number; name: string }[];
}

/** The tasks a filter keeps — the search reads the title, the order, the number and the people. */
export function filterTasks<T extends FilterableTask>(list: readonly T[], f: TaskFilter, todayISO: string): T[] {
  const q = f.q.trim().toLowerCase().replace(/^#/, "");
  const weekEnd = plusDays(todayISO, 6);
  return list.filter((t) => {
    if (f.priority !== "any" && t.priority !== f.priority) return false;
    if (f.person !== null && t.createdById !== f.person && !t.assignees.some((a) => a.id === f.person)) return false;
    if (f.due === "late" && !t.overdue) return false;
    if (f.due === "today" && t.dueDate !== todayISO) return false;
    if (f.due === "week" && !(t.dueDate && t.dueDate >= todayISO && t.dueDate <= weekEnd)) return false;
    if (f.due === "none" && t.dueDate) return false;
    if (!q) return true;
    const hay = `${t.id} ${t.title} ${t.mo ?? ""} ${t.createdByName} ${t.assignees.map((a) => a.name).join(" ")}`.toLowerCase();
    return hay.includes(q);
  });
}

/** The board's columns, in the order work moves through them. */
export const BOARD_COLUMNS: readonly { id: string; label: string; statuses: readonly TaskStatus[] }[] = [
  { id: "todo", label: "To do", statuses: ["open", "returned"] },
  { id: "doing", label: "In progress", statuses: ["in_progress"] },
  { id: "review", label: "Waiting for review", statuses: ["submitted"] },
  { id: "done", label: "Done", statuses: ["done"] },
];

/** The weeks (Sunday first) of a month, each day's ISO date — or null for a
 *  day of the month before or after. */
export function monthWeeks(monthISO: string): (string | null)[][] {
  const [y, m] = monthISO.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(first.getUTCDay()).fill(null)];
  for (let d = 1; d <= days; d++) cells.push(new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10));
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The month before or after ("2026-10" → "2026-11"). */
export function shiftMonth(monthISO: string, by: number): string {
  const [y, m] = monthISO.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

// ---- the team's load and record ----

export interface StatTask {
  status: TaskStatus;
  dueDate: string | null;
  createdAt: string;
  submittedAt: string | null;
  closedAt: string | null;
  assignees: { id: number; name: string }[];
}

export interface PersonLoad {
  id: number;
  name: string;
  /** Open in their hands now (to do, in progress, returned). */
  open: number;
  late: number;
  dueThisWeek: number;
  /** Marked done and waiting for the giver. */
  waiting: number;
  /** Approved in the last 30 days. */
  done30: number;
  /** Of those with a due day, the share marked done by it (null: none had one). */
  onTimePct: number | null;
  /** Days from given to approved, on average, over the last 30 days. */
  avgDays: number | null;
}

/** Each person's load now and record over the last 30 days — most loaded first. */
export function teamLoad(tasks: readonly StatTask[], todayISO: string): PersonLoad[] {
  const since = plusDays(todayISO, -30);
  const weekEnd = plusDays(todayISO, 6);
  const by = new Map<number, PersonLoad & { onTime: number; dated: number; spent: number }>();
  for (const t of tasks) {
    for (const p of t.assignees) {
      let r = by.get(p.id);
      if (!r) by.set(p.id, (r = { id: p.id, name: p.name, open: 0, late: 0, dueThisWeek: 0, waiting: 0, done30: 0, onTimePct: null, avgDays: null, onTime: 0, dated: 0, spent: 0 }));
      const inHand = t.status === "open" || t.status === "in_progress" || t.status === "returned";
      if (inHand) {
        r.open++;
        if (isOverdue(t.status, t.dueDate, todayISO)) r.late++;
        if (t.dueDate && t.dueDate >= todayISO && t.dueDate <= weekEnd) r.dueThisWeek++;
      }
      if (t.status === "submitted") r.waiting++;
      if (t.status === "done" && t.closedAt && factoryDayISO(new Date(t.closedAt)) >= since) {
        r.done30++;
        r.spent += (Date.parse(t.closedAt) - Date.parse(t.createdAt)) / 86_400_000;
        if (t.dueDate) {
          r.dated++;
          // marked done (sent for review) by the due day counts as on time
          const finished = factoryDayISO(new Date(t.submittedAt ?? t.closedAt));
          if (finished <= t.dueDate) r.onTime++;
        }
      }
    }
  }
  return [...by.values()]
    .map(({ onTime, dated, spent, ...r }) => ({ ...r, onTimePct: dated ? Math.round((onTime / dated) * 100) : null, avgDays: r.done30 ? Math.round((spent / r.done30) * 10) / 10 : null }))
    .sort((a, b) => b.late - a.late || b.open - a.open || a.name.localeCompare(b.name));
}
