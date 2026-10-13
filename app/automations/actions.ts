"use server";

import { revalidatePath } from "next/cache";
import type { Automation, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { effectiveUser, getCurrentUser, hasPerm, requirePerm } from "@/lib/server/auth";
import { AUTOMATIONS_KEY, automationFor, configOf, nextRunOf, offDays, ownerDenied, prepareAutomation, runCondition } from "@/lib/server/automations/store";
import { testAutomation } from "@/lib/server/automations/runner";
import { freshRows, retimeAutomation, type AutomationInput, type AutomationTiming } from "@/lib/domain/automations";

// The automations' writes — from the Automations page and from the
// assistant's tools alike. A person keeps their own (AI — automations); the
// app's owner may also pause, delete or test anyone's, but changes only
// their own: an automation runs as its owner, so what it does is theirs to
// say. Deleting keeps it on record, off, with its runs.

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";

export interface AutomationActionResult {
  ok: boolean;
  error?: string;
  id?: number;
}

function revalidate() {
  revalidatePath("/automations");
  revalidatePath("/admin/ai");
}

const idOf = (v: FormDataEntryValue | null): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Save an automation: a new one, or (with an id) a change to one of yours.
 *  `config` is the configuration as JSON (lib/domain/automations.ts), with
 *  includeCurrent for a condition that should also tell about what matches
 *  already. A change starts a condition's watch afresh. */
export async function saveAutomation(fd: FormData): Promise<AutomationActionResult> {
  const guard = await requirePerm(AUTOMATIONS_KEY);
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;
  let input: AutomationInput & { includeCurrent?: unknown };
  try {
    input = JSON.parse(String(fd.get("config") ?? ""));
    if (!input || typeof input !== "object") throw new Error();
  } catch {
    return { ok: false, error: "The automation could not be read." };
  }
  const id = fd.get("id") ? idOf(fd.get("id")) : undefined;
  if (id === null) return { ok: false, error: "Invalid automation." };
  let existing: Automation | null = null;
  if (id !== undefined) {
    existing = await automationFor(user, id);
    if (!existing || existing.ownerId !== user.id) return { ok: false, error: "That automation is not yours to change." };
  }
  const p = await prepareAutomation(user, input, { id, includeCurrent: input.includeCurrent === true });
  if (!p.ok) return { ok: false, error: p.error };
  const c = p.prepared.config;
  const data = {
    name: c.name, trigger: c.trigger, times: c.times, days: c.days, weekdays: c.weekdays, conditionSql: c.conditionSql, checkEveryMin: c.checkEveryMin,
    activeFrom: c.activeFrom, activeTo: c.activeTo, eventTypes: c.eventTypes, eventActorIds: c.eventActorIds, eventMatch: c.eventMatch,
    action: c.action, message: c.message, prompt: c.prompt, recipientIds: c.recipientIds,
    lastKeys: p.prepared.baselineKeys, nextRunAt: p.prepared.nextRunAt, failures: 0, updatedBy: user.name,
  };
  const saved = existing
    ? await prisma.automation.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.automation.create({ data: { ...data, ownerId: user.id, createdBy: user.name }, select: { id: true } });
  revalidate();
  return { ok: true, id: saved.id };
}

/** The account an automation runs as, as the app treats it. */
async function ownerOf(a: Automation): Promise<User | null> {
  const u = await prisma.user.findUnique({ where: { id: a.ownerId } });
  return u ? effectiveUser(u) : null;
}

/** Turn an automation on again: its owner must still be allowed it, and a
 *  condition starts its watch afresh from what matches now. */
async function onAgain(a: Automation): Promise<{ ok: true; data: { nextRunAt: Date | null; lastKeys?: string[] } } | { ok: false; error: string }> {
  const owner = await ownerOf(a);
  const config = configOf(a);
  const denied = owner ? ownerDenied(owner, config) : "Its owner is not on the users list any more.";
  if (denied) return { ok: false, error: denied };
  const now = new Date();
  const nextRunAt = nextRunOf(config, now, await offDays(now));
  if (config.trigger !== "condition") return { ok: true, data: { nextRunAt } };
  const r = await runCondition(owner!, config.conditionSql!);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: { nextRunAt, lastKeys: freshRows([], r.rows).keys } };
}

/** Pause an automation, or turn it back on. */
export async function setAutomationEnabled(fd: FormData): Promise<AutomationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const id = idOf(fd.get("id"));
  const a = id ? await automationFor(user, id) : null;
  if (!a) return { ok: false, error: "That automation is not yours." };
  const enabled = fd.get("enabled") === "true";
  if (a.enabled === enabled) return { ok: true, id: a.id };
  if (!enabled) {
    await prisma.automation.update({ where: { id: a.id }, data: { enabled: false, updatedBy: user.name } });
  } else {
    const on = await onAgain(a);
    if (!on.ok) return { ok: false, error: on.error };
    await prisma.automation.update({ where: { id: a.id }, data: { enabled: true, failures: 0, ...on.data, updatedBy: user.name } });
  }
  revalidate();
  return { ok: true, id: a.id };
}

/** Delete an automation: it stops and leaves the list; it and its runs stay on record. */
export async function deleteAutomation(fd: FormData): Promise<AutomationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const id = idOf(fd.get("id"));
  const a = id ? await automationFor(user, id) : null;
  if (!a) return { ok: false, error: "That automation is not yours." };
  await prisma.automation.update({ where: { id: a.id }, data: { deletedAt: new Date(), enabled: false, updatedBy: user.name } });
  revalidate();
  return { ok: true, id: a.id };
}

/** Bring a deleted automation back — on or off, as `enabled` says. */
export async function restoreAutomation(fd: FormData): Promise<AutomationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const id = idOf(fd.get("id"));
  const a = id ? await automationFor(user, id, { deleted: true }) : null;
  if (!a) return { ok: false, error: "That automation is not in the deleted ones." };
  const enabled = fd.get("enabled") === "true";
  let extra = {};
  if (enabled) {
    const on = await onAgain(a);
    if (!on.ok) return { ok: false, error: on.error };
    extra = { failures: 0, ...on.data };
  }
  await prisma.automation.update({ where: { id: a.id }, data: { deletedAt: null, enabled, ...extra, updatedBy: user.name } });
  revalidate();
  return { ok: true, id: a.id };
}

/** Run an automation now as a test — whatever it sends goes to you alone,
 *  marked as a test; its schedule and its watch stay as they are. */
export async function runAutomationNow(fd: FormData): Promise<AutomationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const id = idOf(fd.get("id"));
  const a = id ? await automationFor(user, id) : null;
  if (!a) return { ok: false, error: "That automation is not yours." };
  const r = await testAutomation(a, user);
  revalidate();
  revalidatePath("/inbox");
  return r.ok ? { ok: true, id: a.id } : { ok: false, error: r.error };
}

/** Change when an automation runs — its times and days, or how often its
 *  condition is checked and in which hours — from the screen. What it does
 *  stays as it was (that is asked of the assistant). Its owner may, and the
 *  app's owner: when it runs is the plant's call too. */
export async function setAutomationTiming(fd: FormData): Promise<AutomationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const id = idOf(fd.get("id"));
  const a = id ? await automationFor(user, id) : null;
  if (!a) return { ok: false, error: "That automation is not yours." };
  if (a.ownerId === user.id && !user.isOwner && !hasPerm(user, AUTOMATIONS_KEY)) return { ok: false, error: "You no longer have automations." };
  let timing: AutomationTiming;
  try {
    timing = JSON.parse(String(fd.get("timing") ?? ""));
    if (!timing || typeof timing !== "object") throw new Error();
  } catch {
    return { ok: false, error: "The timing could not be read." };
  }
  const r = retimeAutomation(configOf(a), timing);
  if (!r.ok) return { ok: false, error: r.error };
  const c = r.config;
  const now = new Date();
  const nextRunAt = nextRunOf(c, now, await offDays(now));
  if (c.trigger === "schedule" && !nextRunAt) return { ok: false, error: "That schedule never comes round — check its days." };
  await prisma.automation.update({
    where: { id: a.id },
    data: { times: c.times, days: c.days, weekdays: c.weekdays, checkEveryMin: c.checkEveryMin, activeFrom: c.activeFrom, activeTo: c.activeTo, nextRunAt, updatedBy: user.name },
  });
  revalidate();
  return { ok: true, id: a.id };
}
