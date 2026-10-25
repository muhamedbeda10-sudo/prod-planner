import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { User, WatchSettings } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hiddenTabsOf } from "@/lib/server/auth";
import { callDenied } from "@/lib/server/ai/tools";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { handleWriteCall } from "@/lib/server/ai/changes";
import { createTaskTool } from "@/lib/server/ai/tools/tasks";
import { deliverToInbox } from "@/lib/server/inbox";
import { offDays } from "@/lib/server/automations/store";
import { getOrderEtas, getStageDays } from "@/lib/server/eta";
import { costUsd, writesArabic } from "@/lib/domain/ai";
import { factoryClockHHMM, factoryDayISO, toISODate } from "@/lib/domain/dates";
/** Days a recorded absence still speaks for this morning. */
const ABSENCE_FRESH_DAYS = 4;
/** Findings kept for the assistant to read, in days. */
const KEEP_DAYS = 120;
import {
  absenceFindings, lateFindings, outputFindings, sortFindings, watchReport,
  type DeptDay, type StageSeries, type WatchFindingDraft, type WatchOptions, type WorkerDays,
} from "@/lib/domain/watchdog";

// The plant's watchdog (lib/domain/watchdog.ts): each working morning from
// its time, once, it reads the forecast, the earned hours and the shift log,
// keeps what it found, and sends the people listed (none: the owner) one
// report — with, for each of the first findings, a task ready to give
// themselves to follow it up (a card that waits for their approval). The
// finding is plain arithmetic; the assistant only adds a few lines over it
// when the owner leaves that on, at Haiku's price, counted like a question.

const STAGE_LABEL: Record<string, string> = { cut: "Fabrication (Cut)", weld: "Welding", finish: "Painting & ShotBlast" };
/** Findings a report offers a task for. */
const TASKS_OFFERED = 6;
const SUMMARY_MODEL = "claude-haiku-5-5";

/** The settings — read every minute by the scheduler, so a read, made once. */
export async function getWatchSettings(): Promise<WatchSettings> {
  return (await prisma.watchSettings.findUnique({ where: { id: 1 } })) ?? prisma.watchSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

export function optionsOf(s: WatchSettings): WatchOptions {
  return { dropPct: s.dropPct, absencePct: s.absencePct, chronicDays: s.chronicDays, chronicOf: s.chronicOf, lateMinDays: s.lateMinDays };
}

/** What the watchdog reads: the orders' forecast, the stages' recent days,
 *  and the shift log's last weeks. */
async function gather(now: Date): Promise<{ orders: Parameters<typeof lateFindings>[0]; series: StageSeries[]; deptDays: DeptDay[]; workers: WorkerDays[] }> {
  const since = new Date(now.getTime() - 35 * 86_400_000);
  const [etas, stageDays, groups, rows] = await Promise.all([
    getOrderEtas(),
    getStageDays(15),
    prisma.shiftEntry.groupBy({ by: ["date", "dept", "present"], where: { date: { gte: since } }, _count: { _all: true } }),
    prisma.shiftEntry.findMany({
      where: { date: { gte: since }, worker: { active: true } },
      select: { workerId: true, date: true, present: true, dept: true, worker: { select: { name: true } } },
      orderBy: { date: "desc" },
    }),
  ]);
  const orders = [...etas.byMo.entries()].map(([mo, e]) => ({ mo, dueISO: e.dueISO, etaISO: e.etaISO, late: e.late, done: e.done, blockedBy: e.blockedBy }));
  const series: StageSeries[] = (["cut", "weld", "finish"] as const).map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    days: stageDays.map((d) => ({ dateISO: d.dateISO, hours: d.hours[stage] })),
  }));
  const dayMap = new Map<string, DeptDay>();
  for (const g of groups) {
    const k = `${toISODate(g.date)}|${g.dept}`;
    const d = dayMap.get(k) ?? { dateISO: toISODate(g.date), dept: g.dept, rows: 0, absent: 0 };
    d.rows += g._count._all;
    if (!g.present) d.absent += g._count._all;
    dayMap.set(k, d);
  }
  const byWorker = new Map<number, WorkerDays>();
  for (const r of rows) {
    const w = byWorker.get(r.workerId) ?? { id: r.workerId, name: r.worker.name, dept: r.dept, recent: [] };
    w.recent.push({ dateISO: toISODate(r.date), present: r.present });
    byWorker.set(r.workerId, w);
  }
  return { orders, series, deptDays: [...dayMap.values()], workers: [...byWorker.values()] };
}

/** Everything the watchdog finds today, the urgent first. */
export async function findToday(now: Date, s: WatchSettings): Promise<{ todayISO: string; findings: WatchFindingDraft[]; series: StageSeries[] }> {
  const todayISO = factoryDayISO(now);
  const o = optionsOf(s);
  const g = await gather(now);
  const fromISO = toISODate(new Date(Date.parse(`${todayISO}T00:00:00Z`) - ABSENCE_FRESH_DAYS * 86_400_000));
  const findings = sortFindings([
    ...lateFindings(g.orders, todayISO, o),
    ...outputFindings(g.series, o),
    ...absenceFindings(g.deptDays, g.workers, { ...o, fromISO, beforeISO: todayISO }),
  ]);
  return { todayISO, findings, series: g.series };
}

/** Who gets the report: the people listed who are active, else the owner. */
async function recipientsOf(s: WatchSettings): Promise<User[]> {
  const listed = s.recipientIds.length ? await prisma.user.findMany({ where: { id: { in: s.recipientIds }, active: true } }) : [];
  return listed.length ? listed : prisma.user.findMany({ where: { isOwner: true, active: true } });
}

/** A few lines by the assistant over the findings — in the language the
 *  owner asks it in — or "" when it is off, closed or out of allowance. */
async function summaryOf(findings: readonly WatchFindingDraft[], owner: User | undefined): Promise<string> {
  if (!owner || findings.length === 0) return "";
  const status = await aiStatusFor(owner);
  if (!status.ok) return "";
  const settings = await getAiSettings();
  const apiKey = apiKeyOf(settings);
  if (!apiKey) return "";
  const last = await prisma.aiUsage.findFirst({ where: { userId: owner.id, conversationId: { not: null } }, orderBy: { id: "desc" }, select: { question: true } });
  const language = last && !writesArabic(last.question) ? "English" : "Egyptian Arabic";
  const usage = await prisma.aiUsage.create({ data: { userId: owner.id, model: SUMMARY_MODEL, question: "Watchdog summary" } });
  try {
    // short: the scheduler's minute has automations waiting behind it
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
    const msg = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `You are the production planner's assistant at a transformer-parts factory. Below are this morning's findings, computed from the plant's data. In ${language}, write 3 to 5 short lines for the plant manager: what matters most today, the likely link between findings when there is one (say it is a guess), and the first thing to do. No headings, no greeting, no figures that are not in the findings.\n\n<findings>\n${findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`).join("\n").replace(/[<>]/g, "")}\n</findings>`,
      }],
    });
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    const tokens = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await prisma.aiUsage.update({ where: { id: usage.id }, data: { calls: 1, ...tokens, costUsd: costUsd(SUMMARY_MODEL, tokens), finishedAt: new Date() } });
    return text;
  } catch (e) {
    await prisma.aiUsage.update({ where: { id: usage.id }, data: { error: String(e instanceof Error ? e.message : e).slice(0, 1000), finishedAt: new Date() } }).catch(() => {});
    console.error("watchdog: the summary could not be written", e);
    return "";
  }
}

/** For one person: a task to themselves ready for each of the first findings
 *  — cards that wait for their approval. None when they may not give tasks. */
async function taskCards(user: User, findings: readonly WatchFindingDraft[], todayISO: string): Promise<number[]> {
  const settings = await getAiSettings();
  if (settings.actionsPaused) return [];
  const hidden = hiddenTabsOf(user);
  // no right to give tasks: no cards at all
  if (callDenied(user, hidden, createTaskTool, {})) return [];
  const ids: number[] = [];
  for (const f of findings.slice(0, TASKS_OFFERED)) {
    const r = await handleWriteCall(
      createTaskTool,
      {
        title: f.title.slice(0, 120),
        details: `${f.detail}\n\nFound by the watchdog on ${todayISO}.`,
        to: [user.name],
        due: todayISO,
        ...(f.severity === "critical" ? { priority: "urgent" } : {}),
        ...(f.mo ? { mo: f.mo } : {}),
      },
      { user, hidden, now: new Date(), todayISO, conversationId: null, automationId: null },
      { toolUseId: null, settings, via: "automation", allowAuto: false },
    ).catch(() => null);
    // one the app refuses (an order not on the registry …) leaves the others
    if (r?.view) ids.push(r.view.id);
  }
  return ids;
}

export interface WatchRun {
  ran: boolean;
  /** Findings new today, sent. */
  found: number;
  reason?: string;
}

/** Today's watch, once, from its time on a working day — or now, when the
 *  owner asks (force): then what is new is sent even if the day was run. */
export async function runWatch(o: { now: Date; force?: boolean }): Promise<WatchRun> {
  const s = await getWatchSettings();
  const today = factoryDayISO(o.now);
  if (!o.force) {
    // the cheap checks first: this runs every minute
    if (!s.enabled) return { ran: false, found: 0, reason: "off" };
    if (s.lastRunISO === today) return { ran: false, found: 0, reason: "done today" };
    if (factoryClockHHMM(o.now) < s.at || (await offDays(o.now))(today)) return { ran: false, found: 0, reason: "not yet" };
    // claim the day: a second tick finds it taken
    const claimed = await prisma.watchSettings.updateMany({ where: { id: 1, OR: [{ lastRunISO: null }, { lastRunISO: { not: today } }] }, data: { lastRunISO: today } });
    if (claimed.count === 0) return { ran: false, found: 0, reason: "done today" };
  }
  try {
    return await watchOnce(o.now, s);
  } catch (e) {
    // a failure before the report went out gives the day back to the next tick
    if (!o.force) await prisma.watchSettings.updateMany({ where: { id: 1, lastRunISO: today }, data: { lastRunISO: s.lastRunISO } }).catch(() => {});
    throw e;
  }
}

async function watchOnce(now: Date, s: WatchSettings): Promise<WatchRun> {
  const { todayISO, findings, series } = await findToday(now, s);
  // only what was never said: a finding's key carries the day or the
  // forecast it is about, and the insert itself decides — two runs at once
  // cannot both send the same finding
  const said = findings.length
    ? new Set((await prisma.watchFinding.findMany({ where: { key: { in: findings.map((f) => f.key) } }, select: { key: true } })).map((f) => f.key))
    : new Set<string>();
  const unsaid = findings.filter((f) => !said.has(f.key));
  const inserted = unsaid.length
    ? await prisma.watchFinding.createManyAndReturn({
        data: unsaid.map((f) => ({ dayISO: todayISO, key: f.key, kind: f.kind, severity: f.severity, title: f.title, detail: f.detail, mo: f.mo ?? null })),
        skipDuplicates: true,
        select: { key: true },
      })
    : [];
  const added = new Set(inserted.map((r) => r.key));
  const fresh = unsaid.filter((f) => added.has(f.key));
  await prisma.watchSettings.update({ where: { id: 1 }, data: { lastRunAt: new Date(), lastFindings: fresh.length } });
  await prisma.watchFinding.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_DAYS * 86_400_000) } } });
  if (fresh.length === 0) return { ran: true, found: 0 };

  const people = await recipientsOf(s);
  const summary = s.aiSummary ? await summaryOf(fresh, people.find((p) => p.isOwner) ?? people[0]) : "";
  const body = watchReport({ todayISO, findings: fresh, series, summary });
  const critical = fresh.filter((f) => f.severity === "critical").length;
  const items = [];
  for (const p of people) {
    items.push({
      userId: p.id,
      kind: "report" as const,
      title: `Watchdog — ${todayISO}: ${fresh.length} to look at${critical ? `, ${critical} urgent` : ""}`,
      body,
      fromName: "The plant's watchdog",
      actionIds: await taskCards(p, fresh, todayISO),
    });
  }
  await deliverToInbox(items);
  return { ran: true, found: fresh.length };
}

/** The findings of the last days, for the assistant and the settings page. */
export async function recentFindings(days: number): Promise<{ dayISO: string; kind: string; severity: string; title: string; detail: string; mo: string | null }[]> {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000);
  return prisma.watchFinding.findMany({
    where: { createdAt: { gte: since } },
    orderBy: [{ dayISO: "desc" }, { id: "asc" }],
    take: 200,
    select: { dayISO: true, kind: true, severity: true, title: true, detail: true, mo: true },
  });
}
