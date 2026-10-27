import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { AI_SCHEMA_TEXT } from "@/lib/server/ai/schemaText.generated";
import { CONFIG_PROPS } from "@/lib/server/ai/tools/automations";
import { deliverToInbox } from "@/lib/server/inbox";
import { hiddenTabsOf } from "@/lib/server/auth";
import { configOf, offDays, ownerDenied, runCondition } from "./store";
import { AI_DENY_TEXT, blockedTableIn, blockedTablesFor, costUsd } from "@/lib/domain/ai";
import { APP_EVENTS, EVENT_TAB, isAppEventType } from "@/lib/domain/appEvents";
import { AUTOMATION_RECIPES, describeAction, describeTrigger } from "@/lib/domain/automations";
import { IDEA_GROUPS, IDEA_LIMITS, IDEAS_AT, IDEAS_PER_ROUND, IDEAS_REMEMBERED, cleanIdea, ideaKey, ideasFor, ideaWeekISO, type IdeaDraft, type IdeaView } from "@/lib/domain/automationIdeas";
import { factoryClockHHMM, factoryDayISO } from "@/lib/domain/dates";

// The assistant's automation ideas (lib/domain/automationIdeas.ts): once a
// week — the first working day, from IDEAS_AT, inside the automations' hours —
// it reads what happened in the plant over the last month, the automations
// people keep, the ready-made ones and what it suggested before, and writes a
// few new automations worth having. Each one is checked like one a person
// saves (a condition's query is run once) before it is kept; they wait above
// the ready-made automations for anyone to turn on. Haiku, counted on the
// owner's spend like the morning review.

const IDEAS_MODEL = "claude-haiku-5-5";
/** Suggestions asked for — more than are kept, as some fail their checks. */
const ASKED = 6;

/** The tool the suggestions come back in. An idea's automation is written in
 *  the assistant's own automation fields, without the people (the person
 *  picks them) and never one that changes data by itself. Made when needed:
 *  the assistant's tools import the automations' runner, which imports this. */
const suggestTool = (): Anthropic.Tool => ({
  name: "suggest_automations",
  description: "The automations you suggest to the plant.",
  input_schema: {
    type: "object",
    properties: {
      ideas: {
        type: "array",
        maxItems: ASKED,
        items: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: IDEA_LIMITS.title, description: "What it does, as a card title — e.g. “A tank fails its leak test → a repair task”." },
            desc: { type: "string", maxLength: IDEA_LIMITS.desc, description: "One or two plain sentences: when it fires and what it does." },
            why: { type: "string", maxLength: IDEA_LIMITS.why, description: "What in the plant's last month makes it worth having — with the figure." },
            group: { type: "string", enum: [...IDEA_GROUPS] },
            config: { type: "object", properties: ideaConfigProps(), required: ["name", "trigger", "action"] },
          },
          required: ["title", "desc", "why", "group", "config"],
        },
      },
    },
    required: ["ideas"],
  },
});

const ideaConfigProps = () => Object.fromEntries(
  Object.entries(CONFIG_PROPS)
    .filter(([k]) => !["recipients", "recipientIds", "eventActors", "eventActorIds"].includes(k))
    .map(([k, v]) => (k === "action" ? [k, { ...v, enum: ["notify", "report", "task"] }] : [k, v])),
);

/** The ideas one person sees — each fit for them: a screen hidden from them,
 *  or a task they may not give, stays out. */
export async function ideasForUser(user: User, now = new Date()): Promise<IdeaView[]> {
  const [rows, live] = await Promise.all([
    prisma.automationIdea.findMany({ orderBy: { id: "desc" }, take: IDEAS_REMEMBERED }),
    prisma.automation.findMany({ where: { ownerId: user.id, deletedAt: null }, select: { name: true } }),
  ]);
  const hidden = hiddenTabsOf(user);
  const closed = blockedTablesFor(hidden);
  return ideasFor(rows, { viewerId: user.id, liveNames: live.map((a) => a.name), now }).filter(({ config: c }) =>
    !ownerDenied(user, c)
    && !(c.conditionSql && blockedTableIn(c.conditionSql, closed))
    && (user.isOwner || !c.eventTypes.some((t) => isAppEventType(t) && EVENT_TAB[t] && hidden.has(EVENT_TAB[t]!))));
}

/** The weekly round, from the automations' tick: on a working day from
 *  IDEAS_AT, once a week — a round that failed (the API down, the month's cap
 *  reached) tries again the next working day of the same week. The day's try
 *  is claimed first, so a busy scheduler never runs it twice. */
export async function suggestWeeklyIdeas(now: Date): Promise<void> {
  if (factoryClockHHMM(now) < IDEAS_AT) return;
  const todayISO = factoryDayISO(now);
  if ((await offDays(now))(todayISO)) return;
  const weekISO = ideaWeekISO(todayISO);
  const tried = `${weekISO}@${todayISO}`;
  const claimed = await prisma.aiSettings.updateMany({ where: { id: 1, OR: [{ ideasWeekISO: null }, { ideasWeekISO: { notIn: [weekISO, tried] } }] }, data: { ideasWeekISO: tried } });
  if (claimed.count === 0) return;
  const r = await suggestIdeas(now, { retries: 1 });
  if ("error" in r) console.error("automation ideas: the weekly round failed —", r.error);
  else await prisma.aiSettings.update({ where: { id: 1 }, data: { ideasWeekISO: weekISO } });
}

/** One round of ideas now: the ones kept, told to the plant's owners. */
export async function suggestIdeas(now: Date, o: { retries?: number } = {}): Promise<{ made: number } | { error: string }> {
  const owner = await prisma.user.findFirst({ where: { isOwner: true, active: true }, orderBy: { id: "asc" } });
  if (!owner) return { error: "The plant has no active owner." };
  const status = await aiStatusFor(owner);
  if (!status.ok) return { error: `The assistant is not available to ${owner.name}: ${AI_DENY_TEXT[status.reason!]}` };
  const apiKey = apiKeyOf(await getAiSettings());
  if (!apiKey) return { error: "The assistant has no API key." };

  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [events, automations, earlier] = await Promise.all([
    prisma.appEvent.groupBy({ by: ["type"], where: { at: { gte: since } }, _count: { _all: true } }),
    prisma.automation.findMany({ where: { deletedAt: null } }),
    prisma.automationIdea.findMany({ orderBy: { id: "desc" }, take: IDEAS_REMEMBERED, select: { title: true } }),
  ]);
  const counts = events.filter((e) => isAppEventType(e.type)).map((e) => `- ${e.type} (${APP_EVENTS[e.type as keyof typeof APP_EVENTS].label}): ${e._count._all}`);
  const kept = automations.map(configOf).map((c) => `- ${c.name}: ${describeTrigger(c)}, ${describeAction(c, [])}${c.conditionSql ? ` — query: ${c.conditionSql.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  const untag = (t: string) => t.replace(/<\/?(events_last_30_days|automations_kept|ideas_already_given|schema)>/gi, "");
  const taken = [...AUTOMATION_RECIPES.map((r) => r.title), ...earlier.map((e) => e.title)];

  const prompt = `You help the production planner of a transformer-parts factory (tanks, top covers, core frames, cable boxes; departments Cut, Welding, Painting, Oven; LV panels) get more from the app's automations. An automation fires on a schedule (times of day, Cairo), on a condition (a read-only SQL query; it fires for rows that start matching), or on an event in the app — and sends a message, has the assistant write a report, or gives a task.

Suggest up to ${ASKED} NEW automations that would help this plant now, the most useful first — each one different from the automations kept and the ideas already given below. Base them on what actually happens (the events' counts) and on the data (the schema): late orders, held orders, stops, rework, quality failures, absence, stores, tasks left open, plans. Prefer a message or a task (no cost) to a report, unless a report adds real judgement. A condition's query must run as written on the schema below (PostgreSQL, quoted "Table"/"column" names), return a stable "key" column and only the rows that matter now (at most 200). Write in plain English.

<events_last_30_days>
${counts.join("\n") || "(none recorded)"}
</events_last_30_days>

<automations_kept>
${untag(kept.join("\n")) || "(none yet)"}
</automations_kept>

<ideas_already_given>
${untag(taken.map((t) => `- ${t}`).join("\n"))}
</ideas_already_given>

<schema>
${AI_SCHEMA_TEXT}
</schema>`;

  const usage = await prisma.aiUsage.create({ data: { userId: owner.id, model: IDEAS_MODEL, question: "Automation ideas" } });
  let raw: unknown[] = [];
  try {
    // one try inside a minute when the owner's "Suggest new ones" waits on it
    const client = new Anthropic({ apiKey, maxRetries: o.retries ?? 0, timeout: 55_000 });
    const msg = await client.messages.create({
      model: IDEAS_MODEL,
      max_tokens: 4000,
      tools: [suggestTool()],
      tool_choice: { type: "tool", name: "suggest_automations" },
      messages: [{ role: "user", content: prompt }],
    });
    const tokens = {
      inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    await prisma.aiUsage.update({ where: { id: usage.id }, data: { calls: 1, ...tokens, costUsd: costUsd(IDEAS_MODEL, tokens), finishedAt: new Date() } });
    const call = msg.content.find((b) => b.type === "tool_use");
    const ideas = call && (call.input as { ideas?: unknown }).ideas;
    raw = Array.isArray(ideas) ? ideas : [];
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e).slice(0, 1000);
    await prisma.aiUsage.update({ where: { id: usage.id }, data: { error, finishedAt: new Date() } }).catch(() => {});
    return { error };
  }

  const keep = await checkedIdeas(raw, owner, [...taken, ...automations.map((a) => a.name)]);
  if (keep.length === 0) return { made: 0 };
  const weekISO = ideaWeekISO(factoryDayISO(now));
  await prisma.automationIdea.createMany({
    data: keep.map((i) => ({ weekISO, title: i.title, desc: i.desc, why: i.why, group: i.group, config: JSON.parse(JSON.stringify(i.config)) })),
  });
  const owners = await prisma.user.findMany({ where: { isOwner: true, active: true }, select: { id: true } });
  await deliverToInbox(owners.map((o) => ({
    userId: o.id,
    kind: "message" as const,
    fromName: "Automations",
    title: `${keep.length} new automation idea${keep.length === 1 ? "" : "s"}`,
    body: `The assistant suggests:\n\n${keep.map((i) => `- **${i.title}** — ${i.desc}`).join("\n")}\n\nTurn one on from [Automations → Ready-made](/automations).`,
  })));
  return { made: keep.length };
}

/** The suggestions worth keeping: valid, new (not a ready-made one, an
 *  earlier idea or an automation kept, nor twice in one round), and — for a
 *  condition — a query that runs and is not too broad. */
async function checkedIdeas(raw: readonly unknown[], owner: User, taken: readonly string[]): Promise<IdeaDraft[]> {
  const seen = new Set(taken.map(ideaKey));
  const out: IdeaDraft[] = [];
  for (const r of raw) {
    if (out.length === IDEAS_PER_ROUND) break;
    const c = cleanIdea(r);
    if (!c.ok) continue;
    const keys = [ideaKey(c.idea.title), ideaKey(c.idea.config.name)];
    if (keys.some((k) => seen.has(k))) continue;
    if (c.idea.config.trigger === "condition") {
      const run = await runCondition(owner, c.idea.config.conditionSql!);
      if (!run.ok) continue;
    }
    keys.forEach((k) => seen.add(k));
    out.push(c.idea);
  }
  return out;
}
