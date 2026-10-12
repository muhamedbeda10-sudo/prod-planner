"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/server/auth";
import { AI_CALLS_RANGE, AI_EFFORT_LABEL, AI_MODELS, aiModel, isAiEffort } from "@/lib/domain/ai";
import { checkWindow } from "@/lib/domain/automations";
import { isAiPerm, permDef, withAiPerms } from "@/lib/domain/permissions";
import { apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { encryptSecret } from "@/lib/server/ai/secret";
import { testReader } from "@/lib/server/ai/reader";
import { apiErrorText } from "@/lib/server/ai/agent";
import { removeScheduler, setupScheduler, tickUrlFor } from "@/lib/server/automations/scheduler";

// The AI assistant's settings — the owner's alone, like Users & Permissions:
// the Claude API key, who may use it and how much of the month's spend.

export interface AiActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

function done(message?: string): AiActionResult {
  revalidatePath("/admin/ai");
  // the AI button in everyone's bar follows the switch and the ticks
  revalidatePath("/", "layout");
  return { ok: true, message };
}

/** Asks Claude to list its models — free, and proves the key works. */
async function checkKey(apiKey: string): Promise<{ ok: boolean; refused: boolean; text: string }> {
  try {
    await new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 });
    return { ok: true, refused: false, text: "Claude accepted the key." };
  } catch (e) {
    return { ok: false, refused: e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError, text: apiErrorText(e) };
  }
}

export async function saveAiKey(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const key = String(fd.get("apiKey") ?? "").trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) return { ok: false, error: "That does not look like a Claude API key — it starts with sk-ant-." };
  const check = await checkKey(key);
  if (check.refused) return { ok: false, error: `Claude refused this key: ${check.text}` };
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { apiKeyEnc: encryptSecret(key), apiKeyHint: key.slice(-4), updatedBy: g.user!.name } });
  return done(check.ok ? "Key saved — Claude accepted it." : `Key saved, but it could not be checked now (${check.text}).`);
}

export async function removeAiKey(): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { apiKeyEnc: "", apiKeyHint: "", updatedBy: g.user!.name } });
  return done("Key removed — the assistant is off until a key is added.");
}

/** The whole chain: the key with Claude, and the read-only database login. */
export async function testAi(): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const s = await getAiSettings();
  const key = apiKeyOf(s);
  const lines: string[] = [];
  let ok = true;
  if (!s.apiKeyEnc) {
    ok = false;
    lines.push("No API key yet.");
  } else if (!key) {
    ok = false;
    lines.push("The stored key cannot be read any more — enter it again.");
  } else {
    const c = await checkKey(key);
    ok &&= c.ok;
    lines.push(c.text);
  }
  const db = await testReader();
  ok &&= db.ok;
  lines.push(db.text);
  return ok ? { ok: true, message: lines.join(" ") } : { ok: false, error: lines.join(" ") };
}

export async function setAiEnabled(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const on = fd.get("on") === "true";
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { enabled: on, updatedBy: g.user!.name } });
  return done(on ? "The assistant is open to the people ticked below." : "The assistant is closed to everyone but you.");
}

/** The model and effort of the chat, or of the automations and the morning
 *  review. A chat keeps the model it started on; effort holds from the next question. */
export async function setAiModel(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const scope = String(fd.get("scope") ?? "chat");
  const id = String(fd.get("model") ?? "");
  const effort = fd.get("effort");
  if (scope !== "chat" && scope !== "auto") return { ok: false, error: "Unknown setting." };
  if (!AI_MODELS.some((m) => m.id === id)) return { ok: false, error: "Unknown model." };
  if (!isAiEffort(effort)) return { ok: false, error: "Unknown effort." };
  await getAiSettings();
  await prisma.aiSettings.update({
    where: { id: 1 },
    data: { ...(scope === "chat" ? { model: id, effort } : { autoModel: id, autoEffort: effort }), updatedBy: g.user!.name },
  });
  return done(`${scope === "chat" ? "Chat" : "Automations"}: ${aiModel(id).label}, ${AI_EFFORT_LABEL[effort]} effort.`);
}

function usdOf(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? Math.round(n * 100) / 100 : null;
}

/** The plant's caps — a day and a month, in dollars (0 = none) — and the
 *  model calls one question may take. */
export async function setAiLimits(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const monthly = usdOf(fd.get("monthlyUsd"));
  const daily = usdOf(fd.get("dailyUsd"));
  const calls = Number(fd.get("maxCalls"));
  if (monthly === null || daily === null) return { ok: false, error: "Enter amounts in dollars (empty = no cap)." };
  if (monthly > 0 && daily > monthly) return { ok: false, error: "The daily cap cannot be more than the monthly one." };
  if (!Number.isInteger(calls) || calls < AI_CALLS_RANGE.min || calls > AI_CALLS_RANGE.max) {
    return { ok: false, error: `Steps per question: a whole number from ${AI_CALLS_RANGE.min} to ${AI_CALLS_RANGE.max}.` };
  }
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { monthlyUsd: monthly, dailyUsd: daily, maxCalls: calls, updatedBy: g.user!.name } });
  return done("Limits saved.");
}

/** One person's access and allowances — a month's and a day's. */
export async function setAiUserAccess(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const userId = Number(fd.get("userId"));
  if (!Number.isInteger(userId)) return { ok: false, error: "Invalid user." };
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { isOwner: true } });
  if (!target) return { ok: false, error: "User not found." };
  if (target.isOwner) return { ok: false, error: "The owner always has the assistant." };
  const enabled = fd.get("enabled") === "true";
  const usd = usdOf(fd.get("usd"));
  const dayUsd = usdOf(fd.get("dayUsd"));
  if (usd === null || dayUsd === null) return { ok: false, error: "Enter amounts in dollars (empty = no cap of their own)." };
  if (usd > 0 && dayUsd > usd) return { ok: false, error: "The daily cap cannot be more than the monthly one." };
  await prisma.aiAccess.upsert({
    where: { userId },
    create: { userId, enabled, monthlyUsd: usd, dailyUsd: dayUsd },
    update: { enabled, monthlyUsd: usd, dailyUsd: dayUsd },
  });
  return done();
}

/** What the assistant may do for one person — its keys alone; the person's
 *  other permissions stay as they are. It never does more than the person
 *  may do themselves: every change also needs their own key for it. The
 *  owner holds every right already; only their two choices (small changes
 *  without asking, the morning review) are theirs to tick. */
export async function setAiUserRights(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const userId = Number(fd.get("userId"));
  if (!Number.isInteger(userId)) return { ok: false, error: "Invalid user." };
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { isOwner: true, perms: true } });
  if (!target) return { ok: false, error: "User not found." };
  const keys = [...new Set(fd.getAll("keys").map(String))];
  if (keys.some((k) => !isAiPerm(k))) return { ok: false, error: "Unknown AI right." };
  const allowed = target.isOwner ? keys.filter((k) => permDef(k)?.notify || permDef(k)?.optIn) : keys;
  await prisma.user.update({ where: { id: userId }, data: { perms: withAiPerms(target.perms, allowed) } });
  revalidatePath("/admin/users");
  return done("Saved.");
}

/** The owner's switches: every change by the assistant (off: nothing it
 *  prepared can be approved, nothing small runs on its own), every
 *  automation, and the morning review — off and on again. */
export async function setAiPause(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const what = String(fd.get("what") ?? "");
  const paused = fd.get("paused") === "true";
  const data =
    what === "actions" ? { actionsPaused: paused } : what === "automations" ? { automationsPaused: paused } : what === "review" ? { reviewPaused: paused } : null;
  if (!data) return { ok: false, error: "Unknown switch." };
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { ...data, updatedBy: g.user!.name } });
  if (what === "actions") return done(paused ? "Changes paused — the assistant only reads and advises." : "Changes on again.");
  if (what === "review") return done(paused ? "Morning review off." : "Morning review on.");
  return done(paused ? "Automations off." : "Automations on.");
}

/** When automations may run (hours and weekdays on the factory clock), and
 *  when the morning review goes out. */
export async function setAutomationHours(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const allDay = fd.get("allDay") === "true";
  const weekdays = String(fd.get("weekdays") ?? "").split(",").filter(Boolean).map(Number);
  const w = checkWindow({ from: allDay ? null : String(fd.get("from") ?? ""), to: allDay ? null : String(fd.get("to") ?? ""), weekdays });
  if (!w.ok) return { ok: false, error: w.error };
  const reviewAt = String(fd.get("reviewAt") ?? "").trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(reviewAt)) return { ok: false, error: "The review time is written HH:MM, e.g. 07:30." };
  await getAiSettings();
  await prisma.aiSettings.update({
    where: { id: 1 },
    data: { autoFrom: w.window.from, autoTo: w.window.to, autoWeekdays: w.window.weekdays, reviewAt, updatedBy: g.user!.name },
  });
  revalidatePath("/automations");
  return done("Schedule saved.");
}

/** Set the automations' clock up in the database (Supabase pg_cron + pg_net,
 *  the secret in Vault) — or again, with a new secret. */
export async function setupAutomationClock(): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const h = await headers();
  const url = tickUrlFor(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
  if (!url) return { ok: false, error: "The app's https address could not be worked out — open the settings from the live site (https) and try again." };
  await getAiSettings();
  const r = await setupScheduler(url);
  if (!r.ok) return { ok: false, error: `${r.error} — on Supabase, the two extensions can also be turned on by hand (Database → Extensions: pg_cron and pg_net); then try again.` };
  return done(`Set up: the database calls ${url} every minute.`);
}

/** Take the clock away — automations then run only while the app is open somewhere. */
export async function removeAutomationClock(): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  await getAiSettings();
  const r = await removeScheduler();
  if (!r.ok) return { ok: false, error: r.error };
  return done("Removed — automations now run only while the app is open somewhere.");
}
