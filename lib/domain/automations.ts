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
//              once, and again only if it is released and held again.
// WHAT — an action:
//   notify     a message the person wrote (with the rows, for a condition),
//              to them and whoever they name — no AI, no cost;
//   report     the assistant writes a report from the live data, sent to
//              them and whoever they name;
//   act        the assistant prepares changes; they wait in the person's
//              inbox for approval (small ones run on their own only if the
//              person opted into that).

import { parseISODate, toISODate, factoryClockHHMM, factoryDayISO, factoryTimeAt } from "./dates";
import { jsonSafe, prepareSql } from "./ai";

export const AUTOMATION_TRIGGERS = ["schedule", "condition"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_ACTIONS = ["notify", "report", "act"] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];
export const SCHEDULE_DAYS = ["working", "every", "weekdays"] as const;
export type ScheduleDays = (typeof SCHEDULE_DAYS)[number];
/** How often a condition may be checked, in minutes. */
export const CHECK_EVERY = [15, 30, 60, 120, 240, 480, 1440] as const;

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
  action: AutomationAction;
  /** notify: the message; {count} {rows} {name} are filled in. */
  message: string | null;
  /** report / act: what the assistant is to do. */
  prompt: string | null;
  /** Who receives it — user ids, the owner among them only if named; none =
   *  the owner alone. Never for act: its changes are the owner's to approve. */
  recipientIds: number[];
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
  action?: string;
  message?: string | null;
  prompt?: string | null;
  recipientIds?: readonly number[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const clean = (s: unknown) => String(s ?? "").replace(/\r\n/g, "\n").trim();

/** A configuration cleaned, or what is wrong with it. */
export function checkAutomation(i: AutomationInput): { ok: true; config: AutomationConfig } | { ok: false; error: string } {
  const L = AUTOMATION_LIMITS;
  const name = clean(i.name).replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give the automation a name." };
  if (name.length > L.name) return { ok: false, error: `Keep the name under ${L.name} characters.` };
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(i.trigger ?? "")) return { ok: false, error: "The trigger is a schedule or a condition." };
  if (!(AUTOMATION_ACTIONS as readonly string[]).includes(i.action ?? "")) return { ok: false, error: "The action is notify, report or act." };
  const trigger = i.trigger as AutomationTrigger;
  const action = i.action as AutomationAction;

  let times: string[] = [];
  let days: ScheduleDays = "working";
  let weekdays: number[] = [];
  let conditionSql: string | null = null;
  let checkEveryMin = 30;
  let activeFrom: string | null = null;
  let activeTo: string | null = null;

  if (trigger === "schedule") {
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

  const message = action === "notify" ? clean(i.message) : null;
  const prompt = action === "notify" ? null : clean(i.prompt);
  if (action === "notify" && !message) return { ok: false, error: "Write the message to send." };
  if (action !== "notify" && !prompt) return { ok: false, error: "Say what the assistant is to do each time." };
  if ((message ?? prompt ?? "").length > L.text) return { ok: false, error: `Keep the text under ${L.text} characters.` };

  const recipientIds = [...new Set(i.recipientIds ?? [])];
  if (recipientIds.some((r) => !Number.isInteger(r) || r <= 0)) return { ok: false, error: "A recipient is not a person on the users list." };
  if (recipientIds.length > L.recipients) return { ok: false, error: `At most ${L.recipients} recipients.` };
  if (action === "act" && recipientIds.length > 0) return { ok: false, error: "Changes an automation prepares are its owner's to approve — they go to no one else." };

  return { ok: true, config: { name, trigger, times, days, weekdays, conditionSql, checkEveryMin, activeFrom, activeTo, action, message, prompt, recipientIds } };
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

/** A notify automation's message with its blanks filled in: {name}, {count}
 *  and {rows} (a table of the rows that fired; a condition's message that
 *  names no {rows} gets the table under it). */
export function renderMessage(template: string, o: { name: string; rows?: readonly Record<string, unknown>[] }): string {
  const rows = o.rows ?? [];
  const table = rowsTable(rows);
  const body = template.replace(/\{name\}/g, o.name).replace(/\{count\}/g, String(rows.length)).replace(/\{rows\}/g, table);
  return rows.length > 0 && !template.includes("{rows}") ? `${body}\n\n${table}` : body;
}

/** The trigger as a person reads it. */
export function describeTrigger(c: Pick<AutomationConfig, "trigger" | "times" | "days" | "weekdays" | "checkEveryMin" | "activeFrom" | "activeTo">): string {
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
export function describeAction(c: Pick<AutomationConfig, "action">, recipients: readonly string[]): string {
  const to = recipients.length > 0 ? ` to ${recipients.join(", ")}` : " to its owner";
  if (c.action === "notify") return `sends a message${to}`;
  if (c.action === "report") return `the assistant writes a report${to}`;
  return "the assistant prepares changes for approval";
}

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
  const day = parseISODate(factoryDayISO(now))!.getUTCDay();
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
