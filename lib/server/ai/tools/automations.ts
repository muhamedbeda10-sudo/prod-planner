import "server-only";
import { prisma } from "@/lib/db";
import { automationFor, configOf, prepareAutomation } from "@/lib/server/automations/store";
import { automationViews } from "@/lib/server/automations/views";
import { deleteAutomation, restoreAutomation, runAutomationNow, saveAutomation, setAutomationEnabled, setAutomationTiming } from "@/app/automations/actions";
import { retractInboxMessages, sendInboxMessage } from "@/app/inbox/actions";
import {
  AUTOMATION_ACTIONS, AUTOMATION_LIMITS, CHECK_EVERY, describeAction, describeTrigger, retimeAutomation, SCHEDULE_DAYS, type AutomationConfig, type AutomationInput, type AutomationTiming,
} from "@/lib/domain/automations";
import { formatDateTime } from "@/lib/domain/format";
import { APP_EVENTS, APP_EVENT_TYPES } from "@/lib/domain/appEvents";
import type { AiChange } from "@/lib/domain/aiActions";
import type { ObjectSchema } from "@/lib/domain/aiInput";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// Automations for the assistant — the person's own: listed, made, changed,
// paused, retimed, deleted — and a message sent to colleagues now. The app's
// owner, as on AI assistant settings, also sees everyone's and pauses,
// retimes or deletes any (what one does stays its owner's to change). Each
// goes through the Automations page's own actions as the person (AI —
// automations), and each is undone by putting it back. Making or changing one
// always waits for the person's approval: it will run again and again, and
// may tell others.

const HHMM = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" } as const;
const PEOPLE = { type: "array", maxItems: AUTOMATION_LIMITS.recipients, items: { type: "string", minLength: 1, maxLength: 80 }, description: "Who receives it, by their name on the users list; leave out for the person alone. Include the person too if they want it as well." } as const;

const CONFIG_PROPS: ObjectSchema["properties"] = {
  name: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.name, description: "A short name the person will know it by." },
  trigger: { type: "string", enum: ["schedule", "condition", "event"], description: "schedule = at times of day; condition = when a query finds new rows; event = the moment something happens in the app (eventTypes)." },
  eventTypes: {
    type: "array", minItems: 1, maxItems: AUTOMATION_LIMITS.eventTypes, items: { type: "string", enum: [...APP_EVENT_TYPES] },
    description: `event: what fires it, the moment it happens — ${APP_EVENT_TYPES.map((t) => `${t} (${APP_EVENTS[t].desc})`).join("; ")}`,
  },
  eventActors: { type: "array", maxItems: AUTOMATION_LIMITS.eventActors, items: { type: "string", minLength: 1, maxLength: 80 }, description: "event: only when one of these people does it, by their names on the users list; leave out for anyone." },
  eventActorIds: { type: "array", maxItems: AUTOMATION_LIMITS.eventActors, items: { type: "integer", minimum: 1 }, description: "Instead of eventActors: the same people by their user ids." },
  eventMatch: { type: "string", maxLength: AUTOMATION_LIMITS.eventMatch, description: "event: only when the event mentions these words — an MO, a department (Welding), a tank serial. Case does not matter." },
  times: { type: "array", minItems: 1, maxItems: AUTOMATION_LIMITS.times, items: HHMM, description: "schedule: times of day on the factory clock (Cairo), HH:MM." },
  days: { type: "string", enum: SCHEDULE_DAYS, description: "schedule: working (not Friday, not a holiday), every, or weekdays." },
  weekdays: { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 }, description: "days = weekdays: 0 = Sunday … 6 = Saturday." },
  conditionSql: {
    type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.sql,
    description: "condition: ONE read-only SELECT (as query_database runs it) returning the rows that matter now — e.g. the orders on hold. It fires for rows that were not in the result at the previous check. Give each row a stable \"key\" column (e.g. the MO) so a row is recognised from one check to the next; at most 200 rows. Test it with query_database first.",
  },
  checkEveryMin: { type: "integer", minimum: CHECK_EVERY[0], maximum: CHECK_EVERY[CHECK_EVERY.length - 1], description: `condition: how often to check, in minutes — one of ${CHECK_EVERY.join(", ")}.` },
  activeFrom: { ...HHMM, description: "condition: check only from this time (Cairo) on working days — with activeTo." },
  activeTo: { ...HHMM, description: "condition: until this time." },
  action: { type: "string", enum: AUTOMATION_ACTIONS, description: "notify = send the message as written (no AI, no cost); report = you write a report from the live data each time; act = you prepare changes, which wait in the person's inbox for approval." },
  message: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.text, description: "notify: the message, Markdown. {count} = how many rows fired, {rows} = them as a table (listed under it when not placed), {name} = the automation's name. For an event: {who} did it, {what} happened, {about} what it was about (an MO, a tank, a task), {detail} the app's sentence, {when}." },
  prompt: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.text, description: "report / act: your instruction for each run, complete on its own — you will not have this conversation then. For a condition, the rows that fired are added to it." },
  recipients: PEOPLE,
  recipientIds: { type: "array", maxItems: AUTOMATION_LIMITS.recipients, items: { type: "integer", minimum: 1 }, description: "Instead of recipients: the same people by their user ids." },
};

interface ConfigInput {
  name?: string;
  trigger?: "schedule" | "condition" | "event";
  eventTypes?: string[];
  eventActors?: string[];
  eventActorIds?: number[];
  eventMatch?: string;
  times?: string[];
  days?: string;
  weekdays?: number[];
  conditionSql?: string;
  checkEveryMin?: number;
  activeFrom?: string;
  activeTo?: string;
  action?: string;
  message?: string;
  prompt?: string;
  recipients?: string[];
  recipientIds?: number[];
  includeCurrent?: boolean;
}

/** People by their names on the users list — each one active and unmistakable. */
export async function peopleNamed(names: readonly string[]): Promise<{ ids: number[]; names: string[] } | { error: string }> {
  const ids: number[] = [];
  const shown: string[] = [];
  for (const n of names) {
    const hits = await prisma.user.findMany({ where: { active: true, name: { equals: n.trim(), mode: "insensitive" } }, select: { id: true, name: true } });
    const found = hits.length > 0 ? hits : await prisma.user.findMany({ where: { active: true, name: { contains: n.trim(), mode: "insensitive" } }, select: { id: true, name: true }, take: 5 });
    if (found.length === 0) return { error: `No active user is called ${n}.` };
    if (found.length > 1) return { error: `"${n}" could be ${found.map((f) => f.name).join(", ")} — say which.` };
    if (!ids.includes(found[0].id)) {
      ids.push(found[0].id);
      shown.push(found[0].name);
    }
  }
  return { ids, names: shown };
}

const namesOf = async (ids: readonly number[]) => (ids.length ? (await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } })).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((u) => u.name) : []);

/** The configuration the input stands for, over the one it changes (if any). */
async function configFrom(i: ConfigInput, base: AutomationConfig | null): Promise<{ input: AutomationInput; recipients: string[] } | { error: string }> {
  if (i.recipients && i.recipientIds) return { error: "Name the recipients one way — by name or by id." };
  let recipientIds = base?.recipientIds ?? [];
  if (i.recipients) {
    const p = await peopleNamed(i.recipients);
    if ("error" in p) return p;
    recipientIds = p.ids;
  } else if (i.recipientIds) {
    recipientIds = [...new Set(i.recipientIds)];
  }
  const recipients = await namesOf(recipientIds);
  if (i.eventActors && i.eventActorIds) return { error: "Name the people watched one way — by name or by id." };
  let eventActorIds = base?.eventActorIds ?? [];
  if (i.eventActorIds) eventActorIds = [...new Set(i.eventActorIds)];
  if (i.eventActors) {
    const p = await peopleNamed(i.eventActors);
    if ("error" in p) return p;
    eventActorIds = p.ids;
  }
  const pick = <K extends keyof AutomationConfig>(k: K, v: AutomationConfig[K] | undefined): AutomationConfig[K] | undefined => (v !== undefined ? v : base?.[k]);
  const trigger = i.trigger ?? base?.trigger;
  return {
    recipients,
    input: {
      name: i.name ?? base?.name, trigger, action: i.action ?? base?.action,
      times: pick("times", i.times), days: i.days ?? base?.days, weekdays: pick("weekdays", i.weekdays),
      conditionSql: pick("conditionSql", i.conditionSql), checkEveryMin: pick("checkEveryMin", i.checkEveryMin),
      // working hours belong to a condition: given together, or kept together
      activeFrom: i.activeFrom !== undefined || i.activeTo !== undefined ? i.activeFrom ?? null : base?.activeFrom ?? null,
      activeTo: i.activeFrom !== undefined || i.activeTo !== undefined ? i.activeTo ?? null : base?.activeTo ?? null,
      eventTypes: pick("eventTypes", i.eventTypes), eventActorIds, eventMatch: i.eventMatch !== undefined ? i.eventMatch : base?.eventMatch ?? null,
      message: pick("message", i.message), prompt: pick("prompt", i.prompt), recipientIds,
    },
  };
}

/** The card's rows for a configuration (and what it was, for a change). */
function configChanges(
  c: AutomationConfig,
  recipients: string[],
  o: { was?: { c: AutomationConfig; recipients: string[]; actors?: string[] }; actors?: string[]; matchingNow?: number; includeCurrent?: boolean; next?: Date | null },
): AiChange[] {
  const rows: [string, string, string][] = [
    ["Name", o.was?.c.name ?? "—", c.name],
    ["When", o.was ? describeTrigger(o.was.c, o.was.actors ?? []) : "—", describeTrigger(c, o.actors ?? [])],
    ["What", o.was ? describeAction(o.was.c, o.was.recipients) : "—", describeAction(c, recipients)],
    [c.action === "notify" ? "Message" : "Instruction", o.was ? (o.was.c.message ?? o.was.c.prompt ?? "—") : "—", c.message ?? c.prompt ?? "—"],
  ];
  if (c.conditionSql) rows.push(["Query", o.was?.c.conditionSql ?? "—", c.conditionSql]);
  const out = rows.filter(([, a, b]) => !o.was || a !== b).map(([label, before, after]) => ({ label, before: before.slice(0, 300), after: after.slice(0, 300) }));
  if (c.trigger === "condition" && o.matchingNow !== undefined) {
    out.push({ label: "Matching now", before: "—", after: o.includeCurrent ? `${o.matchingNow} row(s) — told at the first check` : `${o.matchingNow} row(s) — not told; only rows that start matching later` });
  }
  if (o.next) out.push({ label: "First run", before: "—", after: formatDateTime(o.next) });
  return out;
}

// ------------------------------------------------------------------ read

export const listAutomationsTool: ReadTool<{ everyone?: boolean }> = {
  kind: "read",
  name: "list_automations",
  title: "Looking at the automations",
  description: "The person's own automations: each one's id, name, whether it is on, when it runs and what it does (the query, message or instruction), who receives it, its next run, and how its last runs went. The app's owner may list everyone's (everyone: true), each with whose it is.",
  schema: { type: "object", properties: { everyone: { type: "boolean", description: "The app's owner only: every person's automations." } }, additionalProperties: false },
  async run(i, ctx) {
    if (i.everyone && !ctx.user.isOwner) return { ok: false, text: "Only the app's owner sees everyone's automations." };
    const views = (await automationViews(i.everyone ? {} : { ownerId: ctx.user.id })).filter((a) => !a.deleted);
    return {
      ok: true,
      text: JSON.stringify(views.map((a) => ({
        id: a.id, name: a.name, ...(i.everyone ? { owner: a.owner } : {}), on: a.enabled, when: a.trigger, what: a.action, ...(a.conditionSql ? { query: a.conditionSql } : {}), text: a.text,
        next: a.nextRunAt, last: a.lastStatus ? { status: a.lastStatus, note: a.lastNote, at: a.lastRunAt } : null,
        runs: a.runs.slice(0, 3).map((r) => ({ at: r.startedAt, status: r.status, note: r.error ?? r.summary })),
      }))),
    };
  },
};

// ------------------------------------------------------------- writes

/** Why an automation is not one this person may run the timing of, pause or delete. */
const notTheirs = (id: number, ctx: ToolCtx) => (ctx.user.isOwner ? `No automation #${id}.` : `No automation #${id} of ${ctx.user.name}'s.`);

const CREATE_SCHEMA: ObjectSchema = {
  type: "object",
  properties: {
    ...CONFIG_PROPS,
    includeCurrent: { type: "boolean", description: "condition: also tell about the rows that match already (default: only rows that start matching later)." },
  },
  required: ["name", "trigger", "action"],
  additionalProperties: false,
};

export const createAutomationTool: WriteTool<ConfigInput> = {
  kind: "write",
  name: "create_automation",
  title: "Make an automation",
  description:
    "Make an automation for the person: WHEN — a schedule (times of day, Cairo, on working days / every day / weekdays), a condition (a read-only query: it fires for rows that start matching, checked every so many minutes), or an event (the moment something happens in the app — an order closed or held, output recorded, a leak test or quality check failed, a task marked done … — optionally only by certain people or mentioning certain words; an instant alert); WHAT — notify (their message, as written), report (you write a report from the live data), or act (you prepare changes that wait for their approval). It runs as the person, with their permissions. Settle every detail with them first — the time, the days, who receives it, the exact message or instruction — and test a condition's query with query_database.",
  area: "automations",
  risk: "high",
  schema: CREATE_SCHEMA,
  async describe(i, ctx) {
    const built = await configFrom(i, null);
    if ("error" in built) return built;
    const p = await prepareAutomation(ctx.user, built.input, { includeCurrent: i.includeCurrent === true, now: ctx.now });
    if (!p.ok) return { error: p.error };
    const c = p.prepared.config;
    return {
      title: `New automation: ${c.name}`,
      summary: `${c.name}: ${describeTrigger(c)} — ${describeAction(c, built.recipients)}.`,
      changes: configChanges(c, built.recipients, { actors: await namesOf(c.eventActorIds), matchingNow: p.prepared.matchingNow.length, includeCurrent: i.includeCurrent, next: p.prepared.nextRunAt }),
      snapshot: { config: c },
    };
  },
  async execute(i) {
    const built = await configFrom(i, null);
    if ("error" in built) return { ok: false, error: built.error };
    const r = await saveAutomation(formOf({ config: JSON.stringify({ ...built.input, includeCurrent: i.includeCurrent === true }) }));
    if (!r.ok || !r.id) return { ok: false, error: r.error };
    return { ok: true, message: `Automation #${r.id} is on — it is on the Automations page.`, undo: { tool: "delete_automation", input: { id: r.id } } };
  },
};

interface UpdateInput extends ConfigInput {
  id: number;
}

export const updateAutomationTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_automation",
  title: "Change an automation",
  description: "Change one of the person's automations (by id — list_automations): only the fields given change; recipients given replace the old ones. A changed condition starts watching afresh from what matches now.",
  area: "automations",
  risk: "high",
  schema: { ...CREATE_SCHEMA, properties: { id: { type: "integer", minimum: 1 }, ...CREATE_SCHEMA.properties }, required: ["id"] },
  async describe(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a || a.ownerId !== ctx.user.id) return { error: `No automation #${i.id} of ${ctx.user.name}'s.` };
    const was = { c: configOf(a), recipients: await namesOf(a.recipientIds) };
    const built = await configFrom(i, was.c);
    if ("error" in built) return built;
    const p = await prepareAutomation(ctx.user, built.input, { id: a.id, includeCurrent: i.includeCurrent === true, now: ctx.now });
    if (!p.ok) return { error: p.error };
    const changes = configChanges(p.prepared.config, built.recipients, {
      was: { ...was, actors: await namesOf(was.c.eventActorIds) }, actors: await namesOf(p.prepared.config.eventActorIds), matchingNow: p.prepared.matchingNow.length, includeCurrent: i.includeCurrent,
    });
    if (changes.length === 0) return { error: "It reads so already." };
    return { title: `Change automation: ${a.name}`, summary: `Change the automation "${a.name}": ${describeTrigger(p.prepared.config)} — ${describeAction(p.prepared.config, built.recipients)}.`, changes, snapshot: { id: a.id, updatedAt: a.updatedAt.toISOString() } };
  },
  async execute(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a) return { ok: false, error: `No automation #${i.id}.` };
    const was = configOf(a);
    const built = await configFrom(i, was);
    if ("error" in built) return { ok: false, error: built.error };
    const r = await saveAutomation(formOf({ id: a.id, config: JSON.stringify({ ...built.input, includeCurrent: i.includeCurrent === true }) }));
    if (!r.ok) return { ok: false, error: r.error };
    const back: UpdateInput = {
      id: a.id, name: was.name, trigger: was.trigger, action: was.action, recipientIds: was.recipientIds,
      ...(was.trigger === "schedule"
        ? { times: was.times, days: was.days, ...(was.days === "weekdays" ? { weekdays: was.weekdays } : {}) }
        : was.trigger === "event"
          ? { eventTypes: was.eventTypes, eventActorIds: was.eventActorIds, eventMatch: was.eventMatch ?? "" }
          : { conditionSql: was.conditionSql!, checkEveryMin: was.checkEveryMin, ...(was.activeFrom ? { activeFrom: was.activeFrom, activeTo: was.activeTo! } : {}) }),
      ...(was.action === "notify" ? { message: was.message! } : { prompt: was.prompt! }),
    };
    return { ok: true, message: `Automation #${a.id} changed.`, undo: { tool: "update_automation", input: back as unknown as Record<string, unknown> } };
  },
};

export const setAutomationEnabledTool: WriteTool<{ id: number; enabled: boolean }> = {
  kind: "write",
  name: "set_automation_enabled",
  title: "Pause or resume an automation",
  description: "Pause one of the person's automations, or turn it back on (a condition then watches afresh from what matches now). The app's owner may pause anyone's.",
  area: "automations",
  risk: "low",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false },
  async describe(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a) return { error: notTheirs(i.id, ctx) };
    if (a.enabled === i.enabled) return { error: `"${a.name}" is ${a.enabled ? "on" : "paused"} already.` };
    return {
      title: `${i.enabled ? "Turn on" : "Pause"} "${a.name}"`,
      summary: `${i.enabled ? "Turn the automation back on" : "Pause the automation"} "${a.name}".`,
      changes: [{ label: a.name, before: a.enabled ? "on" : "paused", after: i.enabled ? "on" : "paused" }],
      snapshot: { id: a.id, enabled: a.enabled },
    };
  },
  async execute(i) {
    const r = await setAutomationEnabled(formOf({ id: i.id, enabled: i.enabled }));
    return r.ok ? { ok: true, message: i.enabled ? "On again." : "Paused.", undo: { tool: "set_automation_enabled", input: { id: i.id, enabled: !i.enabled } } } : { ok: false, error: r.error };
  },
};

interface TimingInput {
  id: number;
  times?: string[];
  days?: string;
  weekdays?: number[];
  checkEveryMin?: number;
  activeFrom?: string;
  activeTo?: string;
  /** condition: checked at any hour — the hours dropped. */
  anyHour?: boolean;
}

/** An automation's timing as the screen's timing editor holds it. */
function timingOf(c: AutomationConfig): AutomationTiming {
  return c.trigger === "schedule"
    ? { times: c.times, days: c.days, ...(c.days === "weekdays" ? { weekdays: c.weekdays } : {}) }
    : { checkEveryMin: c.checkEveryMin, activeFrom: c.activeFrom ?? null, activeTo: c.activeTo ?? null };
}

/** The timing asked for, over the one it has — a field left out stays. */
function timingFrom(i: TimingInput, c: AutomationConfig): AutomationTiming {
  const was = timingOf(c);
  return c.trigger === "schedule"
    ? { times: i.times ?? was.times, days: (i.days ?? was.days) as AutomationTiming["days"], ...((i.days ?? was.days) === "weekdays" ? { weekdays: i.weekdays ?? c.weekdays } : {}) }
    : i.anyHour
      ? { checkEveryMin: i.checkEveryMin ?? was.checkEveryMin, activeFrom: null, activeTo: null }
      : { checkEveryMin: i.checkEveryMin ?? was.checkEveryMin, activeFrom: i.activeFrom ?? was.activeFrom ?? null, activeTo: i.activeTo ?? was.activeTo ?? null };
}

/** The input that puts an automation's timing back as it is now. */
function timingInputOf(id: number, c: AutomationConfig): TimingInput {
  if (c.trigger === "schedule") return { id, times: [...c.times], days: c.days, ...(c.days === "weekdays" ? { weekdays: [...c.weekdays] } : {}) };
  return c.activeFrom && c.activeTo ? { id, checkEveryMin: c.checkEveryMin, activeFrom: c.activeFrom, activeTo: c.activeTo } : { id, checkEveryMin: c.checkEveryMin, anyHour: true };
}

export const setAutomationTimingTool: WriteTool<TimingInput> = {
  kind: "write",
  name: "set_automation_timing",
  title: "Change when an automation runs",
  description:
    "Change only WHEN an automation runs, as the screen's timing editor does — a schedule's times and days, or how often a condition is checked and in which hours; what it does stays. For the person's own, and for the app's owner anyone's (list_automations everyone: true). Fields left out stay as they are.",
  area: "automations",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      times: CONFIG_PROPS.times,
      days: CONFIG_PROPS.days,
      weekdays: CONFIG_PROPS.weekdays,
      checkEveryMin: CONFIG_PROPS.checkEveryMin,
      activeFrom: CONFIG_PROPS.activeFrom,
      activeTo: CONFIG_PROPS.activeTo,
      anyHour: { type: "boolean", description: "condition: true = check at any hour (its hours dropped)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  parse: (r) => (Object.keys(r).length > 1 ? (r as unknown as TimingInput) : "Say what changes in when it runs."),
  async describe(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a) return { error: notTheirs(i.id, ctx) };
    const c = configOf(a);
    const asked = c.trigger === "schedule" ? [i.checkEveryMin, i.activeFrom, i.activeTo, i.anyHour] : [i.times, i.days, i.weekdays];
    if (asked.some((v) => v !== undefined)) return { error: `"${a.name}" runs ${c.trigger === "schedule" ? "on a schedule — give times and days" : "when its condition finds rows — give how often and in which hours"}.` };
    const r = retimeAutomation(c, timingFrom(i, c));
    if (!r.ok) return { error: r.error };
    const before = describeTrigger(c);
    const after = describeTrigger(r.config);
    if (before === after) return { error: `"${a.name}" runs so already.` };
    const whose = a.ownerId === ctx.user.id ? "" : ` (${(await prisma.user.findUnique({ where: { id: a.ownerId }, select: { name: true } }))?.name ?? "another person"}'s)`;
    return {
      title: `Retime "${a.name}"`,
      summary: `Run the automation "${a.name}"${whose} ${after} instead of ${before}.`,
      changes: [{ label: a.name, before, after }],
      snapshot: { id: a.id, updatedAt: a.updatedAt.toISOString() },
    };
  },
  async execute(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a) return { ok: false, error: notTheirs(i.id, ctx) };
    const c = configOf(a);
    const r = await setAutomationTiming(formOf({ id: a.id, timing: JSON.stringify(timingFrom(i, c)) }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `"${a.name}" is retimed.`, undo: { tool: "set_automation_timing", input: timingInputOf(a.id, c) as unknown as Record<string, unknown> } };
  },
};

export const deleteAutomationTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_automation",
  title: "Delete an automation",
  description: "Delete one of the person's automations — it stops and leaves the list; its record and runs stay, and Undo brings it back. The app's owner may delete anyone's.",
  area: "automations",
  risk: "destructive",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a) return { error: notTheirs(i.id, ctx) };
    return {
      title: `Delete "${a.name}"`,
      summary: `Delete the automation "${a.name}" (${describeTrigger(configOf(a))}).`,
      changes: [{ label: a.name, before: a.enabled ? "on" : "paused", after: "deleted" }],
      snapshot: { id: a.id, enabled: a.enabled },
    };
  },
  async execute(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a) return { ok: false, error: `No automation #${i.id}.` };
    const r = await deleteAutomation(formOf({ id: a.id }));
    return r.ok ? { ok: true, message: `"${a.name}" is deleted.`, undo: { tool: "restore_automation", input: { id: a.id, enabled: a.enabled } } } : { ok: false, error: r.error };
  },
};

/** The undo of a deletion — never offered to the model. */
export const restoreAutomationTool: WriteTool<{ id: number; enabled: boolean }> = {
  kind: "write",
  name: "restore_automation",
  internal: true,
  title: "Bring an automation back",
  description: "Bring a deleted automation back, on or paused as it was (the undo of a deletion).",
  area: "automations",
  risk: "low",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false },
  async describe(i, ctx) {
    const a = await automationFor(ctx.user, i.id, { deleted: true });
    if (!a) return { error: `Automation #${i.id} is not among the deleted ones.` };
    return { title: `Bring back "${a.name}"`, summary: `Bring the automation "${a.name}" back${i.enabled ? ", on" : ", paused"}.`, changes: [{ label: a.name, before: "deleted", after: i.enabled ? "on" : "paused" }], snapshot: { id: a.id, deletedAt: a.deletedAt?.toISOString() ?? null } };
  },
  async execute(i) {
    const r = await restoreAutomation(formOf({ id: i.id, enabled: i.enabled }));
    return r.ok ? { ok: true, message: "It is back." } : { ok: false, error: r.error };
  },
};

interface MessageInput {
  to: string[];
  title: string;
  text: string;
}

export const sendMessageTool: WriteTool<MessageInput> = {
  kind: "write",
  name: "send_message",
  title: "Send a message",
  description: "Send a message now to colleagues' inboxes (the bell) and to their phones where they turned notifications on — from the person, written as they asked. Markdown; charts allowed. Use only when the person asks for something to be sent.",
  area: "automations",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      to: { ...PEOPLE, minItems: 1, description: "Who it goes to, by their names on the users list." },
      title: { type: "string", minLength: 1, maxLength: 120 },
      text: { type: "string", minLength: 1, maxLength: 4000 },
    },
    required: ["to", "title", "text"],
    additionalProperties: false,
  },
  async describe(i) {
    const p = await peopleNamed(i.to);
    if ("error" in p) return p;
    return {
      title: `Message to ${p.names.join(", ")}`,
      summary: `Send "${i.title}" to ${p.names.join(", ")} now — to their inbox, and their phones where notifications are on.`,
      changes: [{ label: i.title, before: "—", after: `${i.text.slice(0, 200)}${i.text.length > 200 ? "…" : ""}` }],
      snapshot: { to: p.ids },
    };
  },
  async execute(i) {
    const p = await peopleNamed(i.to);
    if ("error" in p) return { ok: false, error: p.error };
    const r = await sendInboxMessage(formOf({ to: p.ids.join(","), title: i.title, body: i.text }));
    if (!r.ok || !r.ids) return { ok: false, error: r.error };
    return { ok: true, message: `Sent to ${p.names.join(", ")}.`, undo: { tool: "retract_message", input: { ids: r.ids } } };
  },
};

/** The undo of a message — never offered to the model: it leaves their inboxes. */
export const retractMessageTool: WriteTool<{ ids: number[] }> = {
  kind: "write",
  name: "retract_message",
  internal: true,
  title: "Take a message back",
  description: "Take a message sent through the assistant back out of the inboxes it went to (a notification already shown on a phone stays shown).",
  area: "automations",
  risk: "low",
  schema: { type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: 20, items: { type: "integer", minimum: 1 } } }, required: ["ids"], additionalProperties: false },
  async describe(i, ctx: ToolCtx) {
    const items = await prisma.aiInboxItem.findMany({ where: { id: { in: i.ids }, fromUserId: ctx.user.id }, select: { id: true, title: true, readAt: true, user: { select: { name: true } } } });
    if (items.length === 0) return { error: "Those messages are not in anyone's inbox any more." };
    return {
      title: `Take back "${items[0].title}"`,
      summary: `Take the message "${items[0].title}" back out of ${items.map((x) => x.user.name).join(", ")}'s inbox${items.some((x) => x.readAt) ? " — some have read it already" : ""}. A notification already shown on a phone stays.`,
      changes: items.map((x) => ({ label: x.user.name, before: x.readAt ? "read" : "not read yet", after: "taken back" })),
      snapshot: items.map((x) => x.id),
    };
  },
  async execute(i) {
    const r = await retractInboxMessages(i.ids);
    return r.ok ? { ok: true, message: "Taken back." } : { ok: false, error: r.error };
  },
};

export const testAutomationTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "test_automation",
  title: "Test-run an automation",
  description:
    "Run one of the person's automations once now, as the Automations page's ▶ does — a test: what it would send comes to the person alone, marked [Test] (its recipients get nothing), an act automation's changes wait for approval as usual, and its schedule and what its condition has seen stay as they are. A report or act run is an assistant run and counts against the month.",
  area: "automations",
  risk: "low",
  liveOnly: true,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a || a.ownerId !== ctx.user.id) return { error: `No automation #${i.id} of ${ctx.user.name}'s.` };
    const c = configOf(a);
    return {
      title: `Test "${a.name}"`,
      summary: `Run "${a.name}" once now as a test (${describeAction(c, [ctx.user.name])}) — the result comes to ${ctx.user.name} alone.`,
      changes: [{ label: a.name, before: describeTrigger(c), after: "one test run now" }],
      snapshot: { id: a.id, config: c },
    };
  },
  async execute(i, ctx) {
    const a = await automationFor(ctx.user, i.id);
    if (!a || a.ownerId !== ctx.user.id) return { ok: false, error: `No automation #${i.id} of ${ctx.user.name}'s.` };
    const r = await runAutomationNow(formOf({ id: a.id }));
    return r.ok ? { ok: true, message: `"${a.name}" ran as a test — the result is in ${ctx.user.name}'s inbox.` } : { ok: false, error: r.error };
  },
};

export const AUTOMATION_TOOLS = [
  listAutomationsTool,
  createAutomationTool,
  updateAutomationTool,
  setAutomationEnabledTool,
  setAutomationTimingTool,
  deleteAutomationTool,
  testAutomationTool,
  sendMessageTool,
  restoreAutomationTool,
  retractMessageTool,
] as const;

