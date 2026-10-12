"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/server/auth";
import { aiModel, AI_MODELS } from "@/lib/domain/ai";
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

export async function setAiModel(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const id = String(fd.get("model") ?? "");
  if (!AI_MODELS.some((m) => m.id === id)) return { ok: false, error: "Unknown model." };
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { model: id, updatedBy: g.user!.name } });
  return done(`New chats use ${aiModel(id).label}.`);
}

function usdOf(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? Math.round(n * 100) / 100 : null;
}

export async function setAiPlantCap(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const usd = usdOf(fd.get("usd"));
  if (usd === null) return { ok: false, error: "Enter an amount in dollars (0 = no cap)." };
  await getAiSettings();
  await prisma.aiSettings.update({ where: { id: 1 }, data: { monthlyUsd: usd, updatedBy: g.user!.name } });
  return done(usd > 0 ? `The plant's monthly cap is $${usd}.` : "No monthly cap for the plant.");
}

/** One person's access and monthly allowance. */
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
  if (usd === null) return { ok: false, error: "Enter an amount in dollars (0 = no cap of their own)." };
  await prisma.aiAccess.upsert({ where: { userId }, create: { userId, enabled, monthlyUsd: usd }, update: { enabled, monthlyUsd: usd } });
  return done();
}

/** The owner's brakes: stop every change by the assistant (nothing it
 *  prepared can be approved, nothing small runs on its own), or every
 *  automation — and start them again. */
export async function setAiPause(fd: FormData): Promise<AiActionResult> {
  const g = await requireOwner();
  if (g.error) return { ok: false, error: g.error };
  const what = String(fd.get("what") ?? "");
  const paused = fd.get("paused") === "true";
  if (what !== "actions" && what !== "automations") return { ok: false, error: "Unknown switch." };
  await getAiSettings();
  await prisma.aiSettings.update({
    where: { id: 1 },
    data: { ...(what === "actions" ? { actionsPaused: paused } : { automationsPaused: paused }), updatedBy: g.user!.name },
  });
  if (what === "actions") return done(paused ? "Paused — the assistant can only read and advise now; nothing it prepared can run." : "The assistant's changes run again (each still waits for its approval).");
  return done(paused ? "Paused — no automation fires until you start them again." : "Automations run again.");
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
