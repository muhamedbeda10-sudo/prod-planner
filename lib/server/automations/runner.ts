import "server-only";
import type { Automation, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { effectiveUser, hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { ask, questionMessages } from "@/lib/server/ai/agent";
import { expireProposals } from "@/lib/server/ai/changes";
import { toolsFor } from "@/lib/server/ai/tools";
import { pruneAiFiles } from "@/lib/server/ai/files";
import { getPlaybookText } from "@/lib/server/ai/playbook";
import { deliverToInbox } from "@/lib/server/inbox";
import { automationWindowOf, configOf, nextRunOf, offDays, ownerDenied, runCondition } from "./store";
import { runDailyReviews } from "./review";
import { AI_DENY_TEXT, automationContext, costUsd } from "@/lib/domain/ai";
import { AI_DELETE_KEY, AI_NOCONFIRM_KEY, type AiArea } from "@/lib/domain/aiActions";
import { AUTOMATION_LIMITS, describeWindow, freshRows, inAutomationWindow, recipientsOf, renderMessage, rowsTable, type AutomationConfig } from "@/lib/domain/automations";
import { factoryDayISO } from "@/lib/domain/dates";

// Running automations: the ones due, each claimed so two ticks never run it
// twice, run as its owner with the owner's permissions as they stand now —
// and what it sent, prepared and cost kept on its run. A condition checked
// with nothing new is not a run; it only moves its keys and its next check.
// Five failures in a row stop an automation and tell its owner.

/** How long one run may hold an automation before another tick may take it. */
const LOCK_MS = 10 * 60_000;
/** Automations taken per tick; what is left waits for the next one. */
const MAX_PER_TICK = 10;

export interface TickResult {
  ran: number;
  checked: number;
  /** Why nothing ran at all, when nothing did. */
  skipped?: string;
}

const fromName = (owner: User, a: Pick<Automation, "name">) => `${owner.name}'s automation “${a.name}”`;

/** Run what is due now — until the deadline, then the rest waits. */
export async function runDueAutomations(o: { now?: Date; deadline?: number } = {}): Promise<TickResult> {
  const now = o.now ?? new Date();
  const deadline = o.deadline ?? now.getTime() + 240_000;
  const settings = await getAiSettings();
  // housekeeping once an hour, paused or not
  if (now.getUTCMinutes() === 7) await pruneOld(now).catch((e) => console.error("automations: housekeeping failed", e));
  if (settings.automationsPaused) return { ran: 0, checked: 0, skipped: "The owner has paused the automations." };
  // outside the owner's hours: a schedule that falls due now is skipped to
  // its next time; a condition waits, and its next check inside the hours
  // still finds what started matching meanwhile. The morning review waits too.
  const window = automationWindowOf(settings);
  if (!inAutomationWindow(now, window)) {
    await skipOutsideWindow(now, describeWindow(window)).catch((e) => console.error("automations: could not skip what fell outside the hours", e));
    return { ran: 0, checked: 0, skipped: "Outside the automations' hours." };
  }
  await expireProposals(now);
  const due = await prisma.automation.findMany({
    where: { enabled: true, deletedAt: null, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    orderBy: { nextRunAt: "asc" },
    take: MAX_PER_TICK,
  });
  const result: TickResult = { ran: 0, checked: 0 };
  try {
    await runAll(due, deadline, result);
  } finally {
    // the morning reviews, with what time is left
    if (Date.now() < deadline) await runDailyReviews({ now, deadline }).catch((e) => console.error("review: failed", e));
  }
  return result;
}

/** The schedules due while automations may not run: each moved on to its
 *  next time, the skip kept on a run of its own. */
async function skipOutsideWindow(now: Date, hours: string): Promise<void> {
  const due = await prisma.automation.findMany({
    where: { trigger: "schedule", enabled: true, deletedAt: null, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    take: 50,
  });
  if (due.length === 0) return;
  const offDay = await offDays(now);
  const note = `Skipped — outside the automations' hours (${hours}).`;
  for (const a of due) {
    // moved only if no other tick moved it first
    const moved = await prisma.automation.updateMany({
      where: { id: a.id, nextRunAt: a.nextRunAt },
      data: { nextRunAt: nextRunOf(configOf(a), now, offDay), lastStatus: "skipped", lastNote: note },
    });
    if (moved.count === 1) await prisma.automationRun.create({ data: { automationId: a.id, cause: "schedule", startedAt: now, finishedAt: now, status: "skipped", summary: note } });
  }
}

async function runAll(due: Automation[], deadline: number, result: TickResult): Promise<void> {
  for (const a of due) {
    if (Date.now() > deadline) break;
    const claim = await prisma.automation.updateMany({
      where: { id: a.id, enabled: true, deletedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
    });
    if (claim.count === 0) continue;
    try {
      const fired = await runAutomation(a, { cause: a.trigger === "schedule" ? "schedule" : "condition", now: new Date() });
      if (fired) result.ran++;
      else result.checked++;
    } catch (e) {
      // the run records its own failures; this is the last guard
      console.error(`automation ${a.id} failed`, e);
      await prisma.automation.update({ where: { id: a.id }, data: { lockedUntil: null } }).catch(() => {});
    }
  }
}

/** How long a run's record, and an inbox item, are kept. */
const KEEP_RUNS_DAYS = 180;
const KEEP_READ_DAYS = 180;
const KEEP_UNREAD_DAYS = 365;

/** Old runs, and old inbox items, go — read ones after half a year, the rest
 *  after a year. What they proposed stays on the assistant's record. */
async function pruneOld(now: Date): Promise<void> {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await prisma.automationRun.deleteMany({ where: { startedAt: { lt: ago(KEEP_RUNS_DAYS) } } });
  await prisma.aiInboxItem.deleteMany({ where: { OR: [{ readAt: { not: null }, createdAt: { lt: ago(KEEP_READ_DAYS) } }, { createdAt: { lt: ago(KEEP_UNREAD_DAYS) } }] } });
  await pruneAiFiles(now);
}

interface RunOptions {
  cause: "schedule" | "condition" | "manual";
  now: Date;
  /** A condition's keys as this check found them — kept once the run is through. */
  keys?: string[];
  /** A test run: everything goes to this person alone, marked as a test, and
   *  the schedule and the condition's keys are left as they are. */
  testTo?: User;
}

/** Run one automation. True when it fired (sent or prepared something, or
 *  failed trying); false for a condition check that found nothing new. */
export async function runAutomation(a: Automation, o: RunOptions): Promise<boolean> {
  const test = !!o.testTo;
  const offDay = await offDays(o.now);
  const config = configOf(a);
  const next = test ? a.nextRunAt : nextRunOf(config, o.now, offDay);
  const ownerRow = await prisma.user.findUnique({ where: { id: a.ownerId } });
  if (!ownerRow) return false;
  const owner = effectiveUser(ownerRow);

  // an owner who may no longer keep it: it stops, and says why
  const denied = ownerDenied(owner, config);
  if (denied && !test) {
    await prisma.automation.update({ where: { id: a.id }, data: { enabled: false, lockedUntil: null, lastStatus: "skipped", lastNote: `Stopped: ${denied}` } });
    await deliverToInbox([{ userId: owner.id, kind: "message", title: `Automation stopped: ${a.name}`, body: `Your automation **${a.name}** stopped: ${denied}`, automationId: a.id }]);
    return true;
  }
  if (denied) return failRun(a, null, o, `${denied}`, next);

  // a condition: what is new since the last check. The keys move on when the
  // run is done (or skipped); a run that fails keeps the old ones, so the
  // same rows are tried again at the next check instead of being lost.
  let rows: Record<string, unknown>[] = [];
  if (config.trigger === "condition") {
    const r = await runCondition(owner, config.conditionSql!);
    if (!r.ok) return failRun(a, null, o, r.error, next);
    if (test) rows = r.rows;
    else {
      const { keys, fresh } = freshRows(a.lastKeys, r.rows);
      if (fresh.length === 0) {
        await prisma.automation.update({ where: { id: a.id }, data: { lastKeys: keys, lastCheckAt: o.now, nextRunAt: next, lockedUntil: null } });
        return false;
      }
      o = { ...o, keys };
      rows = fresh;
    }
  }

  const run = await prisma.automationRun.create({ data: { automationId: a.id, cause: o.cause, startedAt: o.now } });
  const recipients = test ? [o.testTo!.id] : recipientsOf(config, owner.id);
  const title = `${test ? "[Test] " : ""}${a.name}${config.trigger === "condition" ? ` — ${rows.length} new` : ""}`;
  const from = fromName(owner, a);

  try {
    if (config.action === "notify") {
      const body = renderMessage(config.message!, { name: a.name, rows });
      const inboxIds = await deliverToInbox(recipients.map((userId) => ({ userId, kind: "message" as const, title, body, fromName: from, automationId: a.id, runId: run.id })));
      return finishRun(a, run.id, o, { summary: `Sent to ${inboxIds.length} person(s).`, inboxIds }, next);
    }

    // the assistant: open to the owner, within the month's caps
    const status = await aiStatusFor(owner);
    if (!status.ok) return skipRun(a, run.id, o, `The assistant is not available to ${owner.name}: ${AI_DENY_TEXT[status.reason!]}`, next);
    const settings = await getAiSettings();
    const apiKey = apiKeyOf(settings);
    if (!apiKey) return skipRun(a, run.id, o, "The stored Claude API key cannot be read — the owner enters it again on AI assistant settings.", next);
    if (config.action === "act" && settings.actionsPaused) return skipRun(a, run.id, o, "The owner has paused every change by the assistant.", next);

    const hidden = hiddenTabsOf(owner);
    // a report reads only; act gets the owner's write tools too
    const tools = toolsFor(owner, { hidden, actionsPaused: config.action === "report" ? true : settings.actionsPaused, unattended: true });
    const areas = [...new Set(tools.flatMap((t) => (t.kind === "write" ? [t.area] : [])))] as AiArea[];
    const people = await prisma.user.findMany({ where: { id: { in: recipients } }, select: { id: true, name: true } });
    const context = automationContext({
      name: a.name, owner: owner.name, now: o.now, action: config.action, recipients: people.map((p) => p.name),
      areas, canDelete: hasPerm(owner, AI_DELETE_KEY), noconfirm: hasPerm(owner, AI_NOCONFIRM_KEY),
    });
    const instruction = rows.length > 0 ? `${config.prompt}\n\nThese rows started matching the automation's condition:\n\n${rowsTable(rows, AUTOMATION_LIMITS.conditionRows)}` : config.prompt!;
    const usage = await prisma.aiUsage.create({ data: { userId: owner.id, model: settings.autoModel, question: `Automation: ${a.name}`.slice(0, 500) } });
    const actionIds: number[] = [];
    const answer = await ask({
      apiKey,
      model: settings.autoModel,
      effort: settings.autoEffort,
      history: [],
      question: questionMessages(instruction, context),
      tools,
      ctx: { user: owner, hidden, now: o.now, todayISO: factoryDayISO(o.now), conversationId: null, automationId: a.id },
      settings,
      playbook: await getPlaybookText(),
      events: { status: () => {}, text: () => {}, action: (v) => actionIds.push(v.id) },
      via: "automation",
      maxCalls: settings.maxCalls,
    });
    const cost = costUsd(settings.autoModel, answer.tokens);
    await prisma.aiUsage.update({
      where: { id: usage.id },
      data: { calls: answer.calls, queries: answer.queries, ...answer.tokens, costUsd: cost, error: answer.error?.slice(0, 1000) ?? null, finishedAt: new Date() },
    });
    if (answer.error) return failRun(a, run.id, o, `The assistant could not finish: ${answer.error}`, next, cost);
    const text = answer.text.trim() || "(The assistant wrote nothing.)";
    const suggestion = config.action === "act" && actionIds.length > 0;
    const inboxIds = await deliverToInbox(recipients.map((userId) => ({
      userId, kind: suggestion ? ("suggestion" as const) : ("report" as const), title, body: text, fromName: from, automationId: a.id, runId: run.id,
      actionIds: userId === owner.id ? actionIds : [],
    })));
    return finishRun(a, run.id, o, { summary: suggestion ? `Prepared ${actionIds.length} change(s).` : `Sent to ${inboxIds.length} person(s).`, inboxIds, actionIds, cost }, next);
  } catch (e) {
    return failRun(a, run.id, o, e instanceof Error ? e.message : String(e), next);
  }
}

async function finishRun(a: Automation, runId: number, o: RunOptions, r: { summary: string; inboxIds: number[]; actionIds?: number[]; cost?: number }, next: Date | null): Promise<boolean> {
  await prisma.automationRun.update({
    where: { id: runId },
    data: { status: "ok", finishedAt: new Date(), summary: r.summary, inboxIds: r.inboxIds, actionIds: r.actionIds ?? [], costUsd: r.cost ?? 0 },
  });
  await prisma.automation.update({
    where: { id: a.id },
    data: o.testTo ? { lockedUntil: null } : { lastRunAt: o.now, lastStatus: "ok", lastNote: r.summary, failures: 0, nextRunAt: next, lockedUntil: null, ...keysOf(o) },
  });
  return true;
}

const keysOf = (o: RunOptions) => (o.keys ? { lastKeys: o.keys, lastCheckAt: o.now } : {});

async function skipRun(a: Automation, runId: number, o: RunOptions, why: string, next: Date | null): Promise<boolean> {
  await prisma.automationRun.update({ where: { id: runId }, data: { status: "skipped", finishedAt: new Date(), summary: why.slice(0, 1000) } });
  await prisma.automation.update({
    where: { id: a.id },
    data: o.testTo ? { lockedUntil: null } : { lastRunAt: o.now, lastStatus: "skipped", lastNote: why.slice(0, 1000), nextRunAt: next, lockedUntil: null, ...keysOf(o) },
  });
  return true;
}

/** A failure: kept on the run; the fifth in a row stops the automation and
 *  tells its owner. */
async function failRun(a: Automation, runId: number | null, o: RunOptions, error: string, next: Date | null, cost = 0): Promise<boolean> {
  const err = error.slice(0, 2000);
  if (runId) await prisma.automationRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), error: err, costUsd: cost } });
  else await prisma.automationRun.create({ data: { automationId: a.id, cause: o.cause, startedAt: o.now, finishedAt: new Date(), status: "failed", error: err } });
  if (o.testTo) {
    await prisma.automation.update({ where: { id: a.id }, data: { lockedUntil: null } });
    return true;
  }
  const failures = a.failures + 1;
  const stop = failures >= AUTOMATION_LIMITS.failures;
  await prisma.automation.update({
    where: { id: a.id },
    data: { lastRunAt: o.now, lastStatus: "failed", lastNote: err.slice(0, 1000), failures, nextRunAt: next, lockedUntil: null, ...(stop ? { enabled: false } : {}) },
  });
  if (stop) {
    await deliverToInbox([{
      userId: a.ownerId, kind: "message", title: `Automation stopped: ${a.name}`, automationId: a.id,
      body: `Your automation **${a.name}** failed ${failures} times in a row and has stopped. The last error:\n\n> ${err.replace(/\n/g, " ")}\n\nAsk the assistant to fix it, then turn it back on from Automations.`,
    }]);
  }
  return true;
}

/** Run an automation now for a test: everything goes to `to` alone. */
export async function testAutomation(a: Automation, to: User): Promise<{ ok: boolean; error?: string }> {
  const claim = await prisma.automation.updateMany({ where: { id: a.id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, data: { lockedUntil: new Date(Date.now() + LOCK_MS) } });
  if (claim.count === 0) return { ok: false, error: "It is running right now — try again in a minute." };
  await runAutomation(a, { cause: "manual", now: new Date(), testTo: to });
  const last = await prisma.automationRun.findFirst({ where: { automationId: a.id }, orderBy: { id: "desc" }, select: { status: true, error: true, summary: true } });
  if (last?.status === "failed") return { ok: false, error: last.error ?? "It failed." };
  if (last?.status === "skipped") return { ok: false, error: last.summary ?? "It was skipped." };
  return { ok: true };
}

export type { AutomationConfig };
