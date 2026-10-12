import "server-only";
import type { AiSettings, Automation, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { runAiRows } from "@/lib/server/ai/reader";
import { blockedTableIn, blockedTablesFor } from "@/lib/domain/ai";
import { toISODate } from "@/lib/domain/dates";
import {
  ALL_WEEKDAYS, AUTOMATION_LIMITS, checkAutomation, freshRows, nextConditionCheck, nextScheduleRun, type AutomationConfig, type AutomationInput, type AutomationWindow, type OffDay,
} from "@/lib/domain/automations";

// Automations as the app keeps them: a configuration checked against the
// people, the permissions and the data before it is saved — the screen's
// actions and the assistant's tools both go through here — and when each one
// runs next.

export const AUTOMATIONS_KEY = "ai.automations";
export const AUTOMATIONS_ACT_KEY = "ai.automations.act";

/** The hours and days the owner lets automations run in. */
export function automationWindowOf(s: Pick<AiSettings, "autoFrom" | "autoTo" | "autoWeekdays">): AutomationWindow {
  return { from: s.autoFrom, to: s.autoTo, weekdays: s.autoWeekdays.length ? s.autoWeekdays : [...ALL_WEEKDAYS] };
}

/** Fridays, and the holidays on the calendar from a little before today. */
export async function offDays(now = new Date()): Promise<OffDay> {
  const from = new Date(now.getTime() - 2 * 86_400_000);
  const rows = await prisma.holiday.findMany({ where: { date: { gte: from } }, select: { date: true } });
  const holidays = new Set(rows.map((r) => toISODate(r.date)));
  return (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5 || holidays.has(iso);
}

/** When an automation runs next after `after` (null: never, for a schedule
 *  whose days never come). */
export function nextRunOf(c: AutomationConfig, after: Date, offDay: OffDay): Date | null {
  return c.trigger === "schedule" ? nextScheduleRun(after, c, offDay) : nextConditionCheck(after, c, offDay);
}

/** A stored automation as its configuration. */
export function configOf(a: Automation): AutomationConfig {
  return {
    name: a.name, trigger: a.trigger as AutomationConfig["trigger"], times: a.times, days: a.days as AutomationConfig["days"], weekdays: a.weekdays,
    conditionSql: a.conditionSql, checkEveryMin: a.checkEveryMin, activeFrom: a.activeFrom, activeTo: a.activeTo,
    action: a.action as AutomationConfig["action"], message: a.message, prompt: a.prompt, recipientIds: a.recipientIds,
  };
}

/** Why this person may not keep this automation, or null. */
export function ownerDenied(owner: User, c: Pick<AutomationConfig, "action">): string | null {
  if (!owner.active) return "The account is no longer active.";
  if (!hasPerm(owner, AUTOMATIONS_KEY)) return "Automations need the AI — automations permission (Users & Permissions).";
  if (c.action === "act" && !hasPerm(owner, AUTOMATIONS_ACT_KEY)) return "An automation that changes data needs the AI — automations may change data permission.";
  return null;
}

/** A condition's query run for its owner: the screens hidden from them stay
 *  closed, at most the limit of rows. */
export async function runCondition(owner: User, sql: string): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const closed = blockedTableIn(sql, blockedTablesFor(hiddenTabsOf(owner)));
  if (closed) return { ok: false, error: `"${closed}" belongs to a screen that is not opened for ${owner.name}.` };
  const r = await runAiRows(sql, AUTOMATION_LIMITS.conditionRows);
  if (!r.ok) return { ok: false, error: `The query failed: ${r.error}` };
  if (r.truncated) return { ok: false, error: `The query matches more than ${AUTOMATION_LIMITS.conditionRows} rows — too broad to watch; narrow it.` };
  return { ok: true, rows: r.rows };
}

export interface PreparedAutomation {
  config: AutomationConfig;
  /** The people it goes to, by name. */
  recipients: { id: number; name: string }[];
  /** A condition: what it matches now, and so does not fire for (unless asked). */
  matchingNow: Record<string, unknown>[];
  baselineKeys: string[];
  nextRunAt: Date | null;
}

/** A configuration checked for its owner before it is saved: the rules, the
 *  permissions, the people it goes to, the owner's number of automations, and
 *  a condition's query run once (it must work, and what it finds now is the
 *  baseline — it fires only for what starts matching later, unless
 *  `includeCurrent`). */
export async function prepareAutomation(owner: User, input: AutomationInput, o: { id?: number; includeCurrent?: boolean; now?: Date } = {}): Promise<{ ok: true; prepared: PreparedAutomation } | { ok: false; error: string }> {
  const checked = checkAutomation(input);
  if (!checked.ok) return checked;
  const c = checked.config;
  const denied = ownerDenied(owner, c);
  if (denied) return { ok: false, error: denied };
  if (o.id === undefined) {
    const kept = await prisma.automation.count({ where: { ownerId: owner.id, deletedAt: null } });
    if (kept >= AUTOMATION_LIMITS.perOwner) return { ok: false, error: `${owner.name} keeps ${kept} automations already — delete one first (at most ${AUTOMATION_LIMITS.perOwner}).` };
  }
  const people = c.recipientIds.length ? await prisma.user.findMany({ where: { id: { in: c.recipientIds }, active: true }, select: { id: true, name: true } }) : [];
  if (people.length !== c.recipientIds.length) return { ok: false, error: "One of the recipients is not an active user." };
  let matchingNow: Record<string, unknown>[] = [];
  let baselineKeys: string[] = [];
  if (c.trigger === "condition") {
    const r = await runCondition(owner, c.conditionSql!);
    if (!r.ok) return r;
    matchingNow = r.rows;
    baselineKeys = o.includeCurrent ? [] : freshRows([], r.rows).keys;
  }
  const now = o.now ?? new Date();
  // a condition told to include what matches now checks at once
  const nextRunAt = c.trigger === "condition" && o.includeCurrent ? now : nextRunOf(c, now, await offDays(now));
  if (c.trigger === "schedule" && !nextRunAt) return { ok: false, error: "That schedule never comes round — check its days." };
  return { ok: true, prepared: { config: c, recipients: people.sort((a, b) => c.recipientIds.indexOf(a.id) - c.recipientIds.indexOf(b.id)), matchingNow, baselineKeys, nextRunAt } };
}

/** A person's own automation (not deleted), or one the app's owner looks
 *  after; null when it is not theirs to change. */
export async function automationFor(user: User, id: number, o: { deleted?: boolean } = {}): Promise<Automation | null> {
  const a = await prisma.automation.findUnique({ where: { id } });
  if (!a || (o.deleted ? !a.deletedAt : !!a.deletedAt)) return null;
  return a.ownerId === user.id || user.isOwner ? a : null;
}
