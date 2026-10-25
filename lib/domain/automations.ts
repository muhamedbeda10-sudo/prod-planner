// Automations — what a person asked the assistant to do by itself. Pure: the
// rules a configuration must keep, when it runs next, what is new in a
// condition's rows, and how it reads to a person.
//
// WHEN — a trigger:
//   schedule   at times of day on the factory clock (Cairo), on working days
//              (not Friday, not a holiday), every day, or chosen weekdays;
//   condition  a read-only query, checked every so many minutes (optionally
//              only within working hours): it fires for the rows that match
//              now and did not at the last check — so a held order tells
//              once, and again only if it is released and held again;
//   event      the moment something happens in the app (lib/domain/
//              appEvents.ts) — an order closed, a leak test failed, a task
//              marked done — by anyone or by the people named, optionally
//              only when it mentions some words (an MO, a department).
// WHAT — an action:
//   notify     a message the person wrote (with the rows, for a condition),
//              to them and whoever they name — no AI, no cost;
//   report     the assistant writes a report from the live data, sent to
//              them and whoever they name;
//   task       a task given to the people named (none: the owner) — one
//              for each new row of a condition — due in so many days; no AI;
//   act        the assistant prepares changes; they wait in the person's
//              inbox for approval (small ones run on their own only if the
//              person opted into that).

import { parseISODate, toISODate, factoryClockHHMM, factoryDayISO, factoryTimeAt, factoryToday } from "./dates";
import { jsonSafe, prepareSql } from "./ai";
import { APP_EVENTS, isAppEventType } from "./appEvents";
import { humanizeKey, readableValue } from "./fieldNames";
import { stopDurationLabel } from "./downtime";

export const AUTOMATION_TRIGGERS = ["schedule", "condition", "event"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_ACTIONS = ["notify", "report", "act", "task"] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];
export const SCHEDULE_DAYS = ["working", "every", "weekdays"] as const;
export type ScheduleDays = (typeof SCHEDULE_DAYS)[number];
/** How often a condition may be checked, in minutes. */
export const CHECK_EVERY = [15, 30, 60, 120, 240, 480, 1440] as const;
/** A condition's row still matching this long (minutes) goes up to the
 *  plant's owner — the escalation. */
export const ESCALATE_AFTER = [30, 60, 120, 240, 480, 1440, 2880] as const;

export const AUTOMATION_LIMITS = {
  name: 80,
  times: 6,
  sql: 5000,
  text: 2000,
  recipients: 20,
  /** Automations one person may keep. */
  perOwner: 25,
  /** Failed runs in a row before an automation stops itself. */
  failures: 5,
  /** Rows a condition may match — more means it is too broad to watch. */
  conditionRows: 200,
  /** Rows a message lists. */
  messageRows: 30,
  /** event: the kinds one automation listens for, the people it watches, its words. */
  eventTypes: 16,
  eventActors: 20,
  eventMatch: 80,
  /** event: messages one automation sends in an hour — a busy event cannot flood phones. */
  eventNotifiesPerHour: 30,
  /** event: a report or an act run at most this often, in minutes — each costs. */
  eventAiEveryMin: 15,
  /** task: tasks one run gives at most (one per new row) — past it, one task lists them. */
  tasksPerRun: 10,
  /** task: days until a task is due (0 = the same day). */
  taskDueDays: 30,
} as const;

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface AutomationConfig {
  name: string;
  trigger: AutomationTrigger;
  /** schedule: "HH:MM" on the factory clock, sorted. */
  times: string[];
  days: ScheduleDays;
  /** days = weekdays: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** condition */
  conditionSql: string | null;
  checkEveryMin: number;
  /** Check only between these times on working days; both null = any time. */
  activeFrom: string | null;
  activeTo: string | null;
  /** event: what fires it, by whom (none = anyone), and words it must mention. */
  eventTypes: string[];
  eventActorIds: number[];
  eventMatch: string | null;
  action: AutomationAction;
  /** notify: the message; {count} {rows} {name} are filled in. */
  message: string | null;
  /** report / act: what the assistant is to do. */
  prompt: string | null;
  /** Who receives it — user ids, the owner among them only if named; none =
   *  the owner alone. Never for act: its changes are the owner's to approve.
   *  For task: who the task is given to. */
  recipientIds: number[];
  /** task: days until it is due; urgent or not. */
  taskDueDays: number;
  taskUrgent: boolean;
  /** condition: a row still matching this many minutes after it first did
   *  goes up to the plant's owner; null = never. */
  escalateAfterMin: number | null;
}

/** A configuration as it comes in — from a form or the assistant — before it is checked. */
export interface AutomationInput {
  name?: string;
  trigger?: string;
  times?: readonly string[];
  days?: string;
  weekdays?: readonly number[];
  conditionSql?: string | null;
  checkEveryMin?: number;
  activeFrom?: string | null;
  activeTo?: string | null;
  eventTypes?: readonly string[];
  eventActorIds?: readonly number[];
  eventMatch?: string | null;
  action?: string;
  message?: string | null;
  prompt?: string | null;
  recipientIds?: readonly number[];
  taskDueDays?: number;
  taskUrgent?: boolean;
  escalateAfterMin?: number | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const clean = (s: unknown) => String(s ?? "").replace(/\r\n/g, "\n").trim();

/** A configuration cleaned, or what is wrong with it. */
export function checkAutomation(i: AutomationInput): { ok: true; config: AutomationConfig } | { ok: false; error: string } {
  const L = AUTOMATION_LIMITS;
  const name = clean(i.name).replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give the automation a name." };
  if (name.length > L.name) return { ok: false, error: `Keep the name under ${L.name} characters.` };
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(i.trigger ?? "")) return { ok: false, error: "The trigger is a schedule, a condition or an event." };
  if (!(AUTOMATION_ACTIONS as readonly string[]).includes(i.action ?? "")) return { ok: false, error: "The action is notify, report, act or task." };
  const trigger = i.trigger as AutomationTrigger;
  const action = i.action as AutomationAction;

  let times: string[] = [];
  let days: ScheduleDays = "working";
  let weekdays: number[] = [];
  let conditionSql: string | null = null;
  let checkEveryMin = 30;
  let activeFrom: string | null = null;
  let activeTo: string | null = null;
  let eventTypes: string[] = [];
  let eventActorIds: number[] = [];
  let eventMatch: string | null = null;

  if (trigger === "event") {
    eventTypes = [...new Set((i.eventTypes ?? []).map((t) => clean(t)))];
    if (eventTypes.length === 0) return { ok: false, error: "Say which events fire it." };
    if (eventTypes.length > L.eventTypes) return { ok: false, error: `At most ${L.eventTypes} kinds of event.` };
    const unknown = eventTypes.find((t) => !isAppEventType(t));
    if (unknown) return { ok: false, error: `"${unknown}" is not an event the app records.` };
    eventActorIds = [...new Set(i.eventActorIds ?? [])];
    if (eventActorIds.some((r) => !Number.isInteger(r) || r <= 0)) return { ok: false, error: "A person watched is not one on the users list." };
    if (eventActorIds.length > L.eventActors) return { ok: false, error: `Watch at most ${L.eventActors} people.` };
    eventMatch = clean(i.eventMatch).replace(/\s+/g, " ") || null;
    if (eventMatch && eventMatch.length > L.eventMatch) return { ok: false, error: `Keep the words it looks for under ${L.eventMatch} characters.` };
  } else if (trigger === "schedule") {
    times = [...new Set((i.times ?? []).map((t) => clean(t)))].sort();
    if (times.length === 0) return { ok: false, error: "A schedule needs at least one time of day (HH:MM, Cairo)." };
    if (times.length > L.times) return { ok: false, error: `At most ${L.times} times a day.` };
    if (times.some((t) => !HHMM.test(t))) return { ok: false, error: "A time of day is written HH:MM on a 24-hour clock, e.g. 07:30." };
    if (!(SCHEDULE_DAYS as readonly string[]).includes(i.days ?? "working")) return { ok: false, error: "The days are working days, every day, or chosen weekdays." };
    days = (i.days ?? "working") as ScheduleDays;
    if (days === "weekdays") {
      weekdays = [...new Set(i.weekdays ?? [])].sort((a, b) => a - b);
      if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { ok: false, error: "Name the weekdays, 0 (Sunday) to 6 (Saturday)." };
    }
  } else {
    conditionSql = clean(i.conditionSql);
    if (!conditionSql) return { ok: false, error: "A condition needs its query." };
    if (conditionSql.length > L.sql) return { ok: false, error: `Keep the query under ${L.sql} characters.` };
    const prepared = prepareSql(conditionSql);
    if ("error" in prepared) return { ok: false, error: prepared.error };
    checkEveryMin = i.checkEveryMin ?? 30;
    if (!(CHECK_EVERY as readonly number[]).includes(checkEveryMin)) return { ok: false, error: `A condition is checked every ${CHECK_EVERY.join(", ")} minutes.` };
    activeFrom = i.activeFrom ? clean(i.activeFrom) : null;
    activeTo = i.activeTo ? clean(i.activeTo) : null;
    if ((activeFrom === null) !== (activeTo === null)) return { ok: false, error: "Give both ends of the working hours, or neither." };
    if (activeFrom && (!HHMM.test(activeFrom) || !HHMM.test(activeTo!))) return { ok: false, error: "The working hours are written HH:MM, e.g. 07:00 to 19:00." };
    if (activeFrom && activeFrom >= activeTo!) return { ok: false, error: "The working hours must start before they end." };
  }

  const plain = action === "notify" || action === "task";
  const message = plain ? clean(i.message) : null;
  const prompt = plain ? null : clean(i.prompt);
  if (action === "notify" && !message) return { ok: false, error: "Write the message to send." };
  if (action === "task" && !message) return { ok: false, error: "Write the task: its title on the first line, what to do after it." };
  if (!plain && !prompt) return { ok: false, error: "Say what the assistant is to do each time." };
  if ((message ?? prompt ?? "").length > L.text) return { ok: false, error: `Keep the text under ${L.text} characters.` };

  const recipientIds = [...new Set(i.recipientIds ?? [])];
  if (recipientIds.some((r) => !Number.isInteger(r) || r <= 0)) return { ok: false, error: "A recipient is not a person on the users list." };
  if (recipientIds.length > L.recipients) return { ok: false, error: `At most ${L.recipients} recipients.` };
  if (action === "act" && recipientIds.length > 0) return { ok: false, error: "Changes an automation prepares are its owner's to approve — they go to no one else." };

  const taskDueDays = action === "task" ? Number(i.taskDueDays ?? 1) : 1;
  if (!Number.isInteger(taskDueDays) || taskDueDays < 0 || taskDueDays > L.taskDueDays) return { ok: false, error: `A task is due 0 to ${L.taskDueDays} days after it is given.` };
  const taskUrgent = action === "task" && i.taskUrgent === true;
  const escalateAfterMin = trigger === "condition" && i.escalateAfterMin != null ? Number(i.escalateAfterMin) : null;
  if (escalateAfterMin !== null && !(ESCALATE_AFTER as readonly number[]).includes(escalateAfterMin)) {
    return { ok: false, error: `Escalate after ${ESCALATE_AFTER.map(minutesText).join(", ")}.` };
  }

  return {
    ok: true,
    config: { name, trigger, times, days, weekdays, conditionSql, checkEveryMin, activeFrom, activeTo, eventTypes, eventActorIds, eventMatch, action, message, prompt, recipientIds, taskDueDays, taskUrgent, escalateAfterMin },
  };
}

/** A day the plant does not work: a Friday or a holiday. */
export type OffDay = (iso: string) => boolean;

const addDays = (iso: string, n: number) => toISODate(new Date(parseISODate(iso)!.getTime() + n * 86_400_000));
const weekdayOf = (iso: string) => parseISODate(iso)!.getUTCDay();

function dayCounts(cfg: Pick<AutomationConfig, "days" | "weekdays">, iso: string, offDay: OffDay): boolean {
  if (cfg.days === "every") return true;
  if (cfg.days === "weekdays") return cfg.weekdays.includes(weekdayOf(iso));
  return !offDay(iso);
}

/** The next scheduled run strictly after `after`, or null when none comes in
 *  a year (no day ever counts). */
export function nextScheduleRun(after: Date, cfg: Pick<AutomationConfig, "times" | "days" | "weekdays">, offDay: OffDay): Date | null {
  const today = factoryDayISO(after);
  for (let k = 0; k <= 370; k++) {
    const iso = addDays(today, k);
    if (!dayCounts(cfg, iso, offDay)) continue;
    for (const t of cfg.times) {
      const at = factoryTimeAt(iso, t);
      if (at && at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}

/** The next check of a condition after `after`: so many minutes on — or, when
 *  it watches only working hours, the next moment inside them. */
export function nextConditionCheck(after: Date, cfg: Pick<AutomationConfig, "checkEveryMin" | "activeFrom" | "activeTo">, offDay: OffDay): Date {
  const next = new Date(after.getTime() + cfg.checkEveryMin * 60_000);
  if (!cfg.activeFrom || !cfg.activeTo) return next;
  const today = factoryDayISO(next);
  for (let k = 0; k <= 370; k++) {
    const iso = addDays(today, k);
    if (offDay(iso)) continue;
    const from = factoryTimeAt(iso, cfg.activeFrom)!;
    const to = factoryTimeAt(iso, cfg.activeTo)!;
    if (next.getTime() > to.getTime()) continue;
    return next.getTime() < from.getTime() ? from : next;
  }
  return next;
}

/** The key a condition row is known by: its "key" column when it has one,
 *  else the whole row. */
export function rowKey(row: Record<string, unknown>): string {
  if (row.key !== undefined && row.key !== null) return String(jsonSafe(row.key));
  return JSON.stringify(jsonSafe(row));
}

/** What a condition check found: every key matching now (the next check's
 *  "before"), and the rows that did not match at the last check. */
export function freshRows(lastKeys: readonly string[], rows: readonly Record<string, unknown>[]): { keys: string[]; fresh: Record<string, unknown>[] } {
  const before = new Set(lastKeys);
  const keys: string[] = [];
  const fresh: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
    if (!before.has(k)) fresh.push(r);
  }
  return { keys, fresh };
}

const cellText = (v: unknown) => {
  const j = jsonSafe(v);
  return j === null ? "—" : String(typeof j === "object" ? JSON.stringify(j) : j).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 120);
};

/** Rows as a Markdown table — the first so many, and how many more. */
export function rowsTable(rows: readonly Record<string, unknown>[], max: number = AUTOMATION_LIMITS.messageRows): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]).filter((c) => c !== "key");
  const shown = cols.length > 0 ? cols : Object.keys(rows[0]);
  const lines = [`| ${shown.join(" | ")} |`, `| ${shown.map(() => "---").join(" | ")} |`, ...rows.slice(0, max).map((r) => `| ${shown.map((c) => cellText(r[c])).join(" | ")} |`)];
  if (rows.length > max) lines.push("", `…and ${rows.length - max} more.`);
  return lines.join("\n");
}

/** Text set into Markdown as it is — no marks, no table bars, one line. */
const plainMd = (s: string) => s.replace(/\s+/g, " ").replace(/([\\`*_[\]|<>#])/g, "\\$1");

/** Rows as a person reads them in a message: the columns named in words, the
 *  values as the app writes them, the columns empty on every row left out.
 *  A few rows read best as a short list each; more as a table. (rowsTable
 *  keeps the plain form the assistant reads.) */
export function rowsForPeople(rows: readonly Record<string, unknown>[], o: { max?: number; now?: Date } = {}): string {
  if (rows.length === 0) return "";
  const max = o.max ?? AUTOMATION_LIMITS.messageRows;
  const shown = rows.slice(0, max);
  const all = [...new Set(shown.flatMap((r) => Object.keys(r)))];
  const keyed = all.filter((c) => c !== "key");
  const cols = (keyed.length > 0 ? keyed : all).filter((c) => shown.some((r) => readableValue(r[c], o.now) !== null));
  if (cols.length === 0) return "";
  let out: string;
  if (shown.length <= 3) {
    out = shown
      .map((r) => cols.flatMap((c) => {
        const v = readableValue(r[c], o.now);
        return v === null ? [] : [`- **${plainMd(humanizeKey(c))}:** ${plainMd(v.slice(0, 400))}`];
      }).join("\n"))
      .join("\n\n---\n\n");
  } else {
    out = [
      `| ${cols.map((c) => plainMd(humanizeKey(c))).join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
      ...shown.map((r) => `| ${cols.map((c) => plainMd((readableValue(r[c], o.now) ?? "—").slice(0, 160))).join(" | ")} |`),
    ].join("\n");
  }
  return rows.length > max ? `${out}\n\n…and ${rows.length - max} more.` : out;
}

/** A notify automation's message with its blanks filled in: {name}, {count}
 *  and {rows} (a table of the rows that fired; a condition's message that
 *  names no {rows} gets the table under it), and an event's own fields. */
export function renderMessage(template: string, o: { name: string; rows?: readonly Record<string, unknown>[]; fields?: Readonly<Record<string, string>> }): string {
  const rows = o.rows ?? [];
  const table = rowsForPeople(rows);
  let body = template.replace(/\{name\}/g, o.name).replace(/\{count\}/g, String(rows.length)).replace(/\{rows\}/g, table);
  // an event's own blanks — {who} {what} {about} {detail} {when}
  let usedField = false;
  for (const [k, v] of Object.entries(o.fields ?? {})) {
    if (body.includes(`{${k}}`)) usedField = true;
    body = body.split(`{${k}}`).join(v);
  }
  return rows.length > 0 && !template.includes("{rows}") && !usedField ? `${body}\n\n${table}` : body;
}

/** The trigger as a person reads it — with the names of the people an event one watches. */
export function describeTrigger(
  c: Pick<AutomationConfig, "trigger" | "times" | "days" | "weekdays" | "checkEveryMin" | "activeFrom" | "activeTo"> & Partial<Pick<AutomationConfig, "eventTypes" | "eventActorIds" | "eventMatch">>,
  actorNames: readonly string[] = [],
): string {
  if (c.trigger === "event") {
    const what = (c.eventTypes ?? []).map((t) => (isAppEventType(t) ? APP_EVENTS[t].label.toLowerCase() : t)).join(", ");
    const who = actorNames.length > 0 ? ` by ${actorNames.join(", ")}` : (c.eventActorIds ?? []).length > 0 ? " by the people named" : "";
    return `the moment: ${what}${who}${c.eventMatch ? ` — mentioning “${c.eventMatch}”` : ""}`;
  }
  if (c.trigger === "schedule") {
    const when = c.days === "every" ? "every day" : c.days === "weekdays" ? `every ${c.weekdays.map((d) => WEEKDAY_NAMES[d]).join(", ")}` : "every working day";
    return `${when} at ${c.times.join(", ")} (Cairo)`;
  }
  const every = c.checkEveryMin >= 60 ? `${c.checkEveryMin / 60} hour${c.checkEveryMin === 60 ? "" : "s"}` : `${c.checkEveryMin} minutes`;
  return `when its query finds new rows — checked every ${every}${c.activeFrom ? `, ${c.activeFrom}–${c.activeTo} on working days` : ""}`;
}

/** Who an automation's message or report goes to: the people named, or the
 *  owner when nobody is. */
export function recipientsOf(c: Pick<AutomationConfig, "action" | "recipientIds">, ownerId: number): number[] {
  return c.action === "act" || c.recipientIds.length === 0 ? [ownerId] : [...c.recipientIds];
}

/** The action as a person reads it — `recipients` by name, none = the owner. */
export function describeAction(c: Pick<AutomationConfig, "action"> & Partial<Pick<AutomationConfig, "taskDueDays" | "taskUrgent" | "escalateAfterMin">>, recipients: readonly string[]): string {
  const to = recipients.length > 0 ? ` to ${recipients.join(", ")}` : " to its owner";
  const up = c.escalateAfterMin ? `; still there after ${minutesText(c.escalateAfterMin)}, it goes up to the plant's owner` : "";
  const days = c.taskDueDays ?? 1;
  if (c.action === "task") return `gives ${c.taskUrgent ? "an urgent" : "a"} task${to}, due ${days === 0 ? "the same day" : `in ${days} working day${days === 1 ? "" : "s"}`}${up}`;
  if (c.action === "notify") return `sends a message${to}${up}`;
  if (c.action === "report") return `the assistant writes a report${to}${up}`;
  return `the assistant prepares changes for approval${up}`;
}

/** A span of minutes as people say it: "45 min", "2 h", "1 h 30 min". */
export const minutesText = (min: number): string => stopDurationLabel(min / 60);

// ---- the hours automations may run in (the owner's, for the whole plant) ----

/** When automations may run at all, on the factory clock. from/to null = any
 *  time of day; from after to runs over midnight (22:00–06:00). */
export interface AutomationWindow {
  from: string | null;
  to: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
}

export const ALL_WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** A window cleaned, or what is wrong with it. */
export function checkWindow(i: { from?: string | null; to?: string | null; weekdays?: readonly number[] }): { ok: true; window: AutomationWindow } | { ok: false; error: string } {
  const from = i.from ? clean(i.from) : null;
  const to = i.to ? clean(i.to) : null;
  if ((from === null) !== (to === null)) return { ok: false, error: "Give both ends of the hours, or neither." };
  if (from && (!HHMM.test(from) || !HHMM.test(to!))) return { ok: false, error: "The hours are written HH:MM, e.g. 07:00 to 19:00." };
  if (from && from === to) return { ok: false, error: "The hours must not start and end at the same time." };
  const weekdays = [...new Set(i.weekdays ?? ALL_WEEKDAYS)].sort((a, b) => a - b);
  if (weekdays.length === 0) return { ok: false, error: "Tick at least one day." };
  if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { ok: false, error: "A day is 0 (Sunday) to 6 (Saturday)." };
  return { ok: true, window: { from, to, weekdays } };
}

/** Whether automations may run at this moment: the factory day's weekday is
 *  ticked, and the clock is inside the hours (from included, to not). Over
 *  midnight, the small hours count on the day they fall on. */
export function inAutomationWindow(now: Date, w: AutomationWindow): boolean {
  const day = factoryToday(now).getUTCDay();
  if (!w.weekdays.includes(day)) return false;
  if (!w.from || !w.to) return true;
  const t = factoryClockHHMM(now);
  return w.from < w.to ? t >= w.from && t < w.to : t >= w.from || t < w.to;
}

/** The window as a person reads it: "Sun–Thu, Sat · 07:00–19:00". */
export function describeWindow(w: AutomationWindow): string {
  const days = w.weekdays.length === 7 ? "Every day" : w.weekdays.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(", ");
  return `${days} · ${w.from && w.to ? `${w.from}–${w.to}` : "all day"}`;
}

/** Only the timing of an automation — what its owner (or the app's owner)
 *  changes from the screen; what it does stays as it was. */
export type AutomationTiming = Pick<AutomationInput, "times" | "days" | "weekdays" | "checkEveryMin" | "activeFrom" | "activeTo">;

/** A stored configuration with new timing, checked as a whole. The trigger
 *  stays what it was: a condition needs its query, which the assistant writes. */
export function retimeAutomation(c: AutomationConfig, t: AutomationTiming): ReturnType<typeof checkAutomation> {
  if (c.trigger === "event") return { ok: false, error: "It runs the moment its events happen — it has no timing to change." };
  const input: AutomationInput = { ...c };
  if (c.trigger === "schedule") {
    input.times = t.times;
    input.days = t.days;
    input.weekdays = t.weekdays;
  } else {
    input.checkEveryMin = t.checkEveryMin;
    input.activeFrom = t.activeFrom ?? null;
    input.activeTo = t.activeTo ?? null;
  }
  return checkAutomation(input);
}

// ---- a task from a template ----

/** A task from the automation's text: its first line the title, the rest
 *  what to do — {name} {count} and an event's {who} {what} {about} {detail}
 *  {when} filled in, and for a condition's row each {column} with its value. */
export function taskFromTemplate(template: string, o: { name: string; count?: number; row?: Readonly<Record<string, unknown>>; fields?: Readonly<Record<string, string>> }): { title: string; details: string } {
  let text = template.replace(/\{name\}/g, o.name).replace(/\{count\}/g, String(o.count ?? 1));
  for (const [k, v] of Object.entries(o.fields ?? {})) text = text.split(`{${k}}`).join(v);
  if (o.row) {
    for (const [k, v] of Object.entries(o.row)) {
      const j = jsonSafe(v);
      text = text.split(`{${k}}`).join(j === null ? "—" : String(typeof j === "object" ? JSON.stringify(j) : j));
    }
  }
  const [first, ...rest] = text.split("\n");
  return { title: first.replace(/\s+/g, " ").trim().slice(0, 120) || o.name.slice(0, 120), details: rest.join("\n").trim().slice(0, 4000) };
}

/** The due day of a task given on `todayISO`, so many days on — a Friday or
 *  a holiday moves to the next working day. */
export function taskDueISO(todayISO: string, days: number, offDay: OffDay): string {
  let iso = todayISO;
  let guard = 0;
  // so many working days on — Fridays and holidays are not counted
  for (let left = days; left > 0 && guard < 60; guard++) {
    iso = addDays(iso, 1);
    if (!offDay(iso)) left--;
  }
  // and never due on a day off (given on one, with 0 days: the next working day)
  for (; offDay(iso) && guard < 60; guard++) iso = addDays(iso, 1);
  return iso;
}

// ---- escalation ----

/** One check's escalation bookkeeping: when each matching key was first seen
 *  (keys gone are forgotten, so one that comes back starts again), and the
 *  keys due to go up now — still matching `afterMin` after they first did,
 *  and not sent up before. */
export function escalationStep(
  seenBefore: Readonly<Record<string, string>>,
  escalatedBefore: readonly string[],
  keys: readonly string[],
  now: Date,
  afterMin: number,
): { seen: Record<string, string>; escalated: string[]; due: string[] } {
  const seen: Record<string, string> = {};
  for (const k of keys) seen[k] = seenBefore[k] ?? now.toISOString();
  const was = new Set(escalatedBefore);
  const due = keys.filter((k) => !was.has(k) && now.getTime() - Date.parse(seen[k]) >= afterMin * 60_000);
  const sent = new Set([...was, ...due]);
  const escalated = keys.filter((k) => sent.has(k));
  return { seen, escalated, due };
}

// ---- ready-made automations ----

export interface AutomationRecipe {
  id: string;
  title: string;
  desc: string;
  /** Who it suits — a heading in the gallery. */
  group: "Quality" | "Production" | "Orders" | "Reports" | "Tasks";
  config: AutomationInput;
}

/** Automations the plant often wants, ready to fill in the builder — the
 *  person picks who they go to, and may change anything before saving. */
export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
  {
    id: "leak-failed-task",
    title: "A leak test fails → a repair task",
    desc: "The moment tanks fail their leak test, the people you pick get a task to repair them, due the same day.",
    group: "Quality",
    config: { name: "Leak test failed → repair task", trigger: "event", eventTypes: ["tank.leak_failed"], action: "task", message: "Repair: {about}\n{detail}\nRecorded by {who} at {when}.", taskDueDays: 0, taskUrgent: true },
  },
  {
    id: "qa-failed-message",
    title: "A tank fails quality → a message",
    desc: "Tells you the moment a tank is found not OK at the quality check.",
    group: "Quality",
    config: { name: "Quality check failed", trigger: "event", eventTypes: ["tank.qa_failed", "tank.rewelding"], action: "notify", message: "{what}: {about} — {detail} ({who}, {when})" },
  },
  {
    id: "machine-stop-message",
    title: "A machine stop → a message",
    desc: "Tells you the moment a machine stop is recorded on the shift log, with the hours and why.",
    group: "Production",
    config: { name: "Machine stop recorded", trigger: "event", eventTypes: ["machine.stopped"], action: "notify", message: "Machine stop: {detail} — recorded by {who} at {when}." },
  },
  {
    id: "open-stops-escalate",
    title: "A machine still stopped → a message, then up to the owner",
    desc: "Every 30 minutes on working hours, tells you of each machine stop still open — and sends it up to the plant's owner when it is still open after 2 hours.",
    group: "Production",
    config: {
      name: "Machines still stopped",
      trigger: "condition",
      conditionSql: `SELECT d."id" AS key, COALESCE(m."code", d."customName", '?') AS machine, to_char(d."date", 'YYYY-MM-DD') AS day, d."startTime" AS started, COALESCE(d."reason", d."reasonCode", '') AS reason
FROM "MachineDowntime" d LEFT JOIN "Machine" m ON m."id" = d."machineId"
WHERE d."isOpen" = true`,
      checkEveryMin: 30,
      activeFrom: "07:00",
      activeTo: "19:00",
      action: "notify",
      message: "Still stopped:\n\n{rows}",
      escalateAfterMin: 120,
    },
  },
  {
    id: "order-held-message",
    title: "An order put on hold → a message",
    desc: "Tells you the moment an order is put on hold, and why.",
    group: "Orders",
    config: { name: "Order on hold", trigger: "event", eventTypes: ["order.held"], action: "notify", message: "{who} put {about} on hold: {detail}" },
  },
  {
    id: "task-returned-message",
    title: "A task returned for rework → a message",
    desc: "Tells you when a task you are on is returned for rework.",
    group: "Tasks",
    config: { name: "Task returned", trigger: "event", eventTypes: ["task.returned"], action: "notify", message: "{who} returned “{about}” for rework: {detail}" },
  },
  {
    id: "morning-late-report",
    title: "Every morning: the orders heading late",
    desc: "At 07:30 on working days the assistant lists the orders forecast to finish after their delivery day, worst first, with what holds each.",
    group: "Reports",
    config: {
      name: "Orders heading late — morning",
      trigger: "schedule",
      times: ["07:30"],
      days: "working",
      action: "report",
      prompt: "List the open transformer orders forecast to finish after their delivery day, or at risk, worst first: each with its due day, its forecast, the stage holding it and what to push first. End with up to three priorities for today. Use a chart where it helps.",
    },
  },
  {
    id: "day-end-report",
    title: "Every afternoon: the day's output",
    desc: "At 16:30 on working days the assistant sums up the day's output by department in standard hours against the usual, and what stood out.",
    group: "Reports",
    config: {
      name: "The day's output",
      trigger: "schedule",
      times: ["16:30"],
      days: "working",
      action: "report",
      prompt: "Sum up today's output by department in standard hours against each department's usual (get_kpis), say what stood out — a stage far under, a stop, absence — and what tomorrow should start with. A chart of the departments against their usual.",
    },
  },
  {
    id: "week-plan-report",
    title: "Thursday: the week's plan",
    desc: "At 14:00 on Thursdays the assistant reviews the week's plan: the lines behind, by how much, and what must happen on Saturday.",
    group: "Reports",
    config: {
      name: "The week's plan — Thursday review",
      trigger: "schedule",
      times: ["14:00"],
      days: "weekdays",
      weekdays: [4],
      action: "report",
      prompt: "Review this week's plan adherence (get_kpis and the tracker): the lines behind, by how much in pieces and standard hours, the stage holding each, and what must happen on Saturday to catch up. A chart of plan against done by line.",
    },
  },
  {
    id: "plan-imported-report",
    title: "A plan imported → its summary",
    desc: "When a monthly or weekly plan is imported, the assistant sums it up: totals by item, the orders due first, and anything that looks wrong.",
    group: "Reports",
    config: {
      name: "New plan — summary",
      trigger: "event",
      eventTypes: ["plan.imported"],
      action: "report",
      prompt: "A plan was just imported. Sum it up: the orders and pieces by item, the orders due first, and anything that looks wrong (a quantity far from the usual, a missing BOM or due day).",
    },
  },
];
