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
import { remindOverdueTasks } from "@/lib/server/tasks";
import { runAsActor } from "@/lib/server/actor";
import { createTask } from "@/app/tasks/actions";
import { TASK_LIMITS } from "@/lib/domain/tasks";
import { getCockpit, recordKpiSnapshot } from "@/lib/server/kpis";
import { withLine } from "@/lib/server/line";
import { automationWindowOf, configOf, eventReaches, nextRunOf, offDays, ownerDenied, runCondition } from "./store";
import { runDailyReviews } from "./review";
import { runWatch } from "@/lib/server/watchdog";
import { AI_DENY_TEXT, automationContext, costUsd } from "@/lib/domain/ai";
import { AI_DELETE_KEY, AI_NOCONFIRM_KEY, type AiArea } from "@/lib/domain/aiActions";
import {
  AUTOMATION_LIMITS, describeWindow, escalationStep, freshRows, inAutomationWindow, minutesText, recipientsOf, renderMessage, rowKey, rowsTable, taskDueISO, taskFromTemplate,
  type AutomationConfig, type OffDay,
} from "@/lib/domain/automations";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDateTime } from "@/lib/domain/format";
import { EVENT_TAB, eventMatches, eventRow, isTaskEvent, type AppEventView } from "@/lib/domain/appEvents";

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

/** A name set in a line of other words, keeping its own direction — an
 *  Arabic name in an English title (or the other way round) does not pull
 *  the words around it into its order. */
const isolate = (s: string) => `\u2068${s}\u2069`;

const fromName = (owner: User, a: Pick<Automation, "name">) => `${owner.name}'s automation “${isolate(a.name)}”`;

/** Run what is due now — until the deadline, then the rest waits. */
export async function runDueAutomations(o: { now?: Date; deadline?: number } = {}): Promise<TickResult> {
  const now = o.now ?? new Date();
  const deadline = o.deadline ?? now.getTime() + 240_000;
  const settings = await getAiSettings();
  // housekeeping once an hour, paused or not
  if (now.getUTCMinutes() === 7) {
    await pruneOld(now).catch((e) => console.error("automations: housekeeping failed", e));
    // the cockpit's trend gets its point for the day, opened or not
    await withLine("TR", () => getCockpit(now)).then(recordKpiSnapshot).catch((e) => console.error("kpis: snapshot failed", e));
  }
  const window = automationWindowOf(settings);
  const inHours = inAutomationWindow(now, window);
  // the tasks past their due day tell their people — inside the plant's
  // hours (no phone buzzes at night), whether the automations are paused or not
  if (inHours) await remindOverdueTasks(now).catch((e) => console.error("tasks: overdue reminders failed", e));
  // the watchdog keeps its own switch and time — it is plain arithmetic, so
  // the automations' pause does not hold it
  await runWatch({ now }).catch((e) => console.error("watchdog: failed", e));
  if (settings.automationsPaused) return { ran: 0, checked: 0, skipped: "The owner has paused the automations." };
  // outside the owner's hours: a schedule that falls due now is skipped to
  // its next time; a condition waits, and its next check inside the hours
  // still finds what started matching meanwhile. The morning review waits too.
  if (!inHours) {
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
    // the claim is for the row AS FETCHED: a tick that overlapped this one may
    // have run it already and moved nextRunAt on — then it is not due any more
    const claim = await prisma.automation.updateMany({
      where: { id: a.id, enabled: true, deletedAt: null, nextRunAt: a.nextRunAt, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
    });
    if (claim.count === 0) continue;
    try {
      const fired = await runAutomation(a, { cause: a.trigger === "schedule" ? "schedule" : "condition", now: new Date(), deadline });
      if (fired) result.ran++;
      else result.checked++;
    } catch (e) {
      // the run records its own failures; this is the last guard
      console.error(`automation ${a.id} failed`, e);
      await prisma.automation.update({ where: { id: a.id }, data: { lockedUntil: null } }).catch(() => {});
    }
  }
}

/** Fire the "on event" automations an event matches — the moment it was
 *  recorded (lib/server/events.ts). A message goes at any hour, at most so
 *  many an hour per automation; a report or a change, which cost, only
 *  inside the automations' hours and at most every so many minutes, each
 *  claimed so two events never run it at once. Paused, nothing fires. A
 *  task's event reaches only the automations of people on the task, and an
 *  event from a screen hidden from the owner none of theirs. A task goes like
 *  a message. */
export async function runEventAutomations(e: AppEventView, now = new Date()): Promise<number> {
  const settings = await getAiSettings();
  if (settings.automationsPaused) return 0;
  const rules = await prisma.automation.findMany({ where: { trigger: "event", enabled: true, deletedAt: null, eventTypes: { has: e.type } }, orderBy: { id: "asc" }, take: 100 });
  const inHours = inAutomationWindow(now, automationWindowOf(settings));
  let fired = 0;
  for (const a of rules) {
    if (!eventMatches(a, e)) continue;
    // a task an automation gave never sets off another — no task begets tasks in a loop
    if (a.action === "task" && e.byAutomation) continue;
    if (isTaskEvent(e.type) && !(e.participants ?? []).includes(a.ownerId)) continue;
    if (EVENT_TAB[e.type]) {
      const owner = await prisma.user.findUnique({ where: { id: a.ownerId }, select: { id: true, hiddenTabs: true, isOwner: true } });
      if (!owner || !eventReaches(e.type, e.participants, owner)) continue;
    }
    // a message or a task costs nothing; a report or a change uses the assistant
    const ai = a.action === "report" || a.action === "act";
    if (ai) {
      if (!inHours) continue;
      if (a.lastRunAt && now.getTime() - a.lastRunAt.getTime() < AUTOMATION_LIMITS.eventAiEveryMin * 60_000) continue;
      const claim = await prisma.automation.updateMany({ where: { id: a.id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }, data: { lockedUntil: new Date(now.getTime() + LOCK_MS) } });
      if (claim.count === 0) continue;
    } else {
      const lastHour = await prisma.automationRun.count({ where: { automationId: a.id, startedAt: { gte: new Date(now.getTime() - 3_600_000) } } });
      if (lastHour >= AUTOMATION_LIMITS.eventNotifiesPerHour) continue;
    }
    try {
      if (await runAutomation(a, { cause: "event", now, event: e })) fired++;
    } catch (err) {
      console.error(`automation ${a.id} failed on event ${e.id}`, err);
      if (ai) await prisma.automation.update({ where: { id: a.id }, data: { lockedUntil: null } }).catch(() => {});
    }
  }
  return fired;
}

/** How long a run's record, and an inbox item, are kept. */
const KEEP_RUNS_DAYS = 180;
const KEEP_READ_DAYS = 180;
const KEEP_UNREAD_DAYS = 365;
/** How long the app's events are kept — what fired an automation is on its run. */
const KEEP_EVENTS_DAYS = 90;

/** Old runs, and old inbox items, go — read ones after half a year, the rest
 *  after a year. What they proposed stays on the assistant's record. */
async function pruneOld(now: Date): Promise<void> {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await prisma.automationRun.deleteMany({ where: { startedAt: { lt: ago(KEEP_RUNS_DAYS) } } });
  await prisma.appEvent.deleteMany({ where: { at: { lt: ago(KEEP_EVENTS_DAYS) } } });
  await prisma.aiInboxItem.deleteMany({ where: { OR: [{ readAt: { not: null }, createdAt: { lt: ago(KEEP_READ_DAYS) } }, { createdAt: { lt: ago(KEEP_UNREAD_DAYS) } }] } });
  await pruneAiFiles(now);
}

interface RunOptions {
  cause: "schedule" | "condition" | "event" | "manual";
  now: Date;
  /** event: what happened — the run is about it alone. */
  event?: AppEventView;
  /** A condition's keys as this check found them — kept once the run is through. */
  keys?: string[];
  /** A condition's escalation bookkeeping after this check. */
  escalation?: { keySeenAt: Record<string, string>; escalatedKeys: string[] };
  /** A run that failed part-way: the keys to keep all the same — the rows it
   *  did see to — so only the rest are tried again. */
  retryKeys?: string[];
  /** A test run: everything goes to this person alone, marked as a test, and
   *  the schedule and the condition's keys are left as they are. */
  testTo?: User;
  /** The tick's deadline (ms since the epoch): a run started late in the tick
   *  is given less time to think, so its result and cost are always written
   *  before the function's own life ends. */
  deadline?: number;
}

/** How long the assistant may take for one run: the tick's own default (ask's
 *  240 s), or what is left of the tick plus the minute the route keeps in hand
 *  (app/api/automations/tick/route.ts: maxDuration − 60 s), less the seconds
 *  the run needs to write its result. */
function askTimeout(o: RunOptions): number | undefined {
  if (o.deadline === undefined) return undefined;
  return Math.max(20_000, Math.min(240_000, o.deadline + 50_000 - Date.now()));
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
    await deliverToInbox([{ userId: owner.id, kind: "message", title: `Automation stopped: ${isolate(a.name)}`, body: `Your automation **${a.name}** stopped: ${denied}`, automationId: a.id }]);
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
      // what is still there after a while goes up to the plant's owner — on
      // a check with nothing new as well
      if (config.escalateAfterMin) {
        const step = escalationStep((a.keySeenAt ?? {}) as Record<string, string>, a.escalatedKeys ?? [], keys, o.now, config.escalateAfterMin);
        if (step.due.length > 0) {
          const due = new Set(step.due);
          await escalate(a, owner, r.rows.filter((row) => due.has(rowKey(row))), config.escalateAfterMin);
        }
        o = { ...o, escalation: { keySeenAt: step.seen, escalatedKeys: step.escalated } };
      }
      if (fresh.length === 0) {
        await endRun(a, { lastKeys: keys, lastCheckAt: o.now, ...escalationOf(o) }, { nextRunAt: next });
        return false;
      }
      o = { ...o, keys };
      rows = fresh;
    }
  }

  // an event: the one that happened (a test run has none — it says so)
  let fields: Record<string, string> | undefined;
  if (config.trigger === "event") {
    const e = o.event;
    const at = e ? formatDateTime(e.at) : formatDateTime(o.now);
    rows = e ? [eventRow(e, at)] : [{ when: at, who: "—", what: "(a test run — no event happened)", about: "", detail: "" }];
    fields = { who: e?.actorName ?? "—", what: String(rows[0].what), about: e?.subject ?? "", detail: e?.summary ?? "(a test run)", when: at };
  }

  const run = await prisma.automationRun.create({ data: { automationId: a.id, cause: o.cause, startedAt: o.now } });
  const recipients = test ? [o.testTo!.id] : recipientsOf(config, owner.id);
  const title = `${test ? "[Test] " : ""}${isolate(a.name)}${config.trigger === "condition" ? ` — ${rows.length} new` : config.trigger === "event" && o.event ? ` — ${isolate(`${o.event.actorName}: ${o.event.summary}`)}` : ""}`;
  const from = fromName(owner, a);

  try {
    if (config.action === "notify") {
      const body = renderMessage(config.message!, { name: a.name, rows, fields });
      const inboxIds = await deliverToInbox(recipients.map((userId) => ({ userId, kind: "message" as const, title, body, fromName: from, automationId: a.id, runId: run.id })));
      return finishRun(a, run.id, o, { summary: `Sent to ${inboxIds.length} person(s).`, inboxIds }, next);
    }
    if (config.action === "task") {
      // a test run gives the task to the tester alone
      const given = await giveTasks(owner, config, { name: a.name, rows, fields, people: test ? [o.testTo!.id] : recipients, todayISO: factoryDayISO(o.now), offDay, test });
      if (!given.ok) {
        // the rows already given a task are done; the rest are tried again at the next check
        const left = new Set(rows.slice(given.given).map(rowKey));
        const keep = given.given > 0 && o.keys ? { ...o, retryKeys: o.keys.filter((k) => !left.has(k)) } : o;
        return failRun(a, run.id, keep, given.ids.length ? `Gave ${given.ids.length} task(s): #${given.ids.join(", #")}; then: ${given.error}` : given.error, next);
      }
      return finishRun(a, run.id, o, { summary: `Gave ${given.ids.length} task(s): #${given.ids.join(", #")}.`, inboxIds: [] }, next);
    }
    if (config.action !== "report" && config.action !== "act") return failRun(a, run.id, o, `Unknown action "${config.action}".`, next);

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
    const instruction =
      config.trigger === "event"
        ? `${config.prompt}\n\nWhat just happened in the app, which fired this automation:\n\n${rowsTable(rows, 1)}`
        : rows.length > 0 ? `${config.prompt}\n\nThese rows started matching the automation's condition:\n\n${rowsTable(rows, AUTOMATION_LIMITS.conditionRows)}` : config.prompt!;
    const usage = await prisma.aiUsage.create({ data: { userId: owner.id, model: settings.autoModel, question: `Automation: ${a.name}`.slice(0, 500) } });
    const actionIds: number[] = [];
    const timeoutMs = askTimeout(o);
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
      // a test run never changes data on its own — every change waits for the
      // click, as the morning review's do; the real run follows the owner's
      // "small changes without asking"
      ...(o.testTo ? { allowAuto: false } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
  if (o.testTo) await prisma.automation.update({ where: { id: a.id }, data: { lockedUntil: null } });
  else await endRun(a, { lastRunAt: o.now, lastStatus: "ok", lastNote: r.summary, failures: 0, ...keysOf(o) }, { nextRunAt: next });
  return true;
}

const escalationOf = (o: RunOptions) => o.escalation ?? {};
const keysOf = (o: RunOptions) => ({ ...(o.keys ? { lastKeys: o.keys, lastCheckAt: o.now } : {}), ...escalationOf(o) });

/** The tasks a "task" automation gives, as its owner (their right to give
 *  tasks applies, and the task names them as its giver): one for each new
 *  row of a condition — past the limit, one that lists them — else one. */
async function giveTasks(
  owner: User,
  c: AutomationConfig,
  o: { name: string; rows: Record<string, unknown>[]; fields?: Record<string, string>; people: number[]; todayISO: string; offDay: OffDay; test: boolean },
): Promise<{ ok: true; ids: number[] } | { ok: false; error: string; ids: number[]; given: number }> {
  const due = taskDueISO(o.todayISO, c.taskDueDays, o.offDay);
  const each = c.trigger === "condition" && o.rows.length > 0 && o.rows.length <= AUTOMATION_LIMITS.tasksPerRun;
  let drafts: { title: string; details: string }[];
  if (each) drafts = o.rows.map((row) => taskFromTemplate(c.message!, { name: o.name, count: o.rows.length, row, fields: o.fields }));
  else {
    const one = taskFromTemplate(c.message!, { name: o.name, count: o.rows.length, fields: o.fields });
    // the rows listed under it, cut to what a task's details may hold
    if (c.trigger === "condition" && o.rows.length > 0) one.details = `${one.details}\n\n${rowsTable(o.rows)}`.trim().slice(0, TASK_LIMITS.details);
    drafts = [one];
  }
  const ids: number[] = [];
  for (const [given, d] of drafts.entries()) {
    const fd = new FormData();
    fd.set("title", `${o.test ? "[Test] " : ""}${d.title}`.slice(0, 120));
    fd.set("details", d.details);
    fd.set("people", o.people.join(","));
    fd.set("priority", c.taskUrgent ? "urgent" : "normal");
    fd.set("due", due);
    const r = await runAsActor(owner, "automation", () => createTask(fd));
    if (!r.ok || !r.ids) return { ok: false, error: r.error ?? "The task was not given.", ids, given };
    ids.push(...r.ids);
  }
  return { ok: true, ids };
}

/** Rows still matching after the automation's escalation time: to the
 *  plant's owner(s), the automation's owner told it went up. */
async function escalate(a: Automation, owner: User, rows: Record<string, unknown>[], afterMin: number): Promise<void> {
  if (rows.length === 0) return;
  const after = minutesText(afterMin);
  const owners = await prisma.user.findMany({ where: { isOwner: true, active: true }, select: { id: true } });
  const to = [...new Set([...owners.map((u) => u.id), owner.id])];
  await deliverToInbox(to.map((userId) => ({
    userId,
    kind: "message" as const,
    title: `Escalation: ${isolate(a.name)} — ${rows.length} still there after ${after}`,
    body: `**${a.name}** (${owner.name}'s automation) still finds ${rows.length === 1 ? "this" : `these ${rows.length}`} after ${after}:\n\n${rowsTable(rows)}`,
    fromName: fromName(owner, a),
    automationId: a.id,
  })));
}

/** The end-of-run write. The run's own record (when, how it went, which rows
 *  a condition has now reported) is always written; the SCHEDULE (the next
 *  run) only while the row still reads as it did when the run was claimed — a
 *  new time saved meanwhile stands, instead of being put back by a run that
 *  was computed from the old one. */
async function endRun(a: Automation, status: Record<string, unknown>, schedule: Record<string, unknown>): Promise<void> {
  const kept = await prisma.automation.updateMany({ where: { id: a.id, nextRunAt: a.nextRunAt }, data: { ...status, ...schedule, lockedUntil: null } });
  if (kept.count === 0) await prisma.automation.update({ where: { id: a.id }, data: { ...status, lockedUntil: null } });
}

async function skipRun(a: Automation, runId: number, o: RunOptions, why: string, next: Date | null): Promise<boolean> {
  await prisma.automationRun.update({ where: { id: runId }, data: { status: "skipped", finishedAt: new Date(), summary: why.slice(0, 1000) } });
  if (o.testTo) await prisma.automation.update({ where: { id: a.id }, data: { lockedUntil: null } });
  else await endRun(a, { lastRunAt: o.now, lastStatus: "skipped", lastNote: why.slice(0, 1000), ...keysOf(o) }, { nextRunAt: next });
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
  // what was sent up stays sent up, failed or not; the keys stay as they were
  // (tried again next time) but for rows a partial run did see to
  await endRun(a, {
    lastRunAt: o.now, lastStatus: "failed", lastNote: err.slice(0, 1000), failures, ...(stop ? { enabled: false } : {}),
    ...escalationOf(o), ...(o.retryKeys ? { lastKeys: o.retryKeys, lastCheckAt: o.now } : {}),
  }, { nextRunAt: next });
  if (stop) {
    await deliverToInbox([{
      userId: a.ownerId, kind: "message", title: `Automation stopped: ${isolate(a.name)}`, automationId: a.id,
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
