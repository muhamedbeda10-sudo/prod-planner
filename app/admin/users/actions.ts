"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { hashPassword, requireOwner } from "@/lib/server/auth";
import { isAiPerm, serializePerms, withoutAiChange } from "@/lib/domain/permissions";
import { TABS, serializeHiddenTabs } from "@/lib/domain/tabs";

export interface UserActionResult {
  ok: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

/** The AI assistant's tick and monthly allowance from the form — undefined
 *  for a form without that section. */
function aiFromForm(formData: FormData): { enabled: boolean; monthlyUsd: number } | undefined | "bad" {
  if (formData.get("aiForm") !== "1") return undefined;
  const raw = String(formData.get("aiUsd") ?? "").trim();
  const usd = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(usd) || usd < 0 || usd > 100_000) return "bad";
  return { enabled: formData.get("aiEnabled") === "on", monthlyUsd: Math.round(usd * 100) / 100 };
}

async function saveAi(userId: number, ai: { enabled: boolean; monthlyUsd: number } | undefined): Promise<void> {
  if (!ai) return;
  await prisma.aiAccess.upsert({ where: { userId }, create: { userId, ...ai }, update: ai });
}

/** The keys ticked on the form. The assistant's keys are kept on AI
 *  assistant settings, so this form leaves them as they are — unless it says
 *  it carries them ("aiKeys": the assistant's own users tool, which sends a
 *  person's whole set). */
function permsFromForm(formData: FormData, stored = ""): string {
  const ticked = formData.getAll("perms").map(String);
  if (formData.get("aiKeys") === "1") return serializePerms(ticked);
  return withoutAiChange(stored, ticked.filter((k) => !isAiPerm(k)));
}

/** The screens left UNticked are the hidden ones. A form without the
 *  screens section leaves them as they were (undefined). */
function hiddenTabsFromForm(formData: FormData): string | undefined {
  if (formData.get("tabsForm") !== "1") return undefined;
  const seen = new Set(formData.getAll("tabs").map(String));
  return serializeHiddenTabs(TABS.filter((t) => !seen.has(t.id)).map((t) => t.id));
}

export async function createUser(formData: FormData): Promise<UserActionResult> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const isAdmin = formData.get("isAdmin") === "on";

  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email." };
  if (!name) return { ok: false, error: "Enter the person's name." };
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  if (await prisma.user.findUnique({ where: { email } })) return { ok: false, error: "An account with this email already exists." };
  const ai = aiFromForm(formData);
  if (ai === "bad") return { ok: false, error: "Enter the AI monthly limit in dollars (empty = none)." };

  const created = await prisma.user.create({
    data: { email, name, passwordHash: hashPassword(password), isAdmin, perms: permsFromForm(formData), hiddenTabs: hiddenTabsFromForm(formData) ?? "" },
  });
  await saveAi(created.id, ai);
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function updateUserPerms(formData: FormData): Promise<UserActionResult> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid user." };
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "User not found." };

  // the owner's own account keeps its standing; only its subscriptions change
  const isAdmin = target.isOwner ? target.isAdmin : formData.get("isAdmin") === "on";
  // the owner always has the assistant — nothing of theirs to save there
  const ai = target.isOwner ? undefined : aiFromForm(formData);
  if (ai === "bad") return { ok: false, error: "Enter the AI monthly limit in dollars (empty = none)." };

  await prisma.user.update({ where: { id }, data: { isAdmin, perms: permsFromForm(formData, target.perms), hiddenTabs: hiddenTabsFromForm(formData) } });
  await saveAi(id, ai);
  revalidatePath("/admin/users");
  revalidatePath("/admin/ai");
  return { ok: true };
}

export async function setUserActive(formData: FormData): Promise<UserActionResult> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  const active = String(formData.get("active")) === "true";
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid user." };
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "User not found." };
  if (target.id === guard.user!.id || target.isOwner) return { ok: false, error: "The owner's account cannot be deactivated." };

  await prisma.user.update({ where: { id }, data: { active } });
  if (!active) await prisma.session.deleteMany({ where: { userId: id } }); // kick them out now
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function deleteUser(formData: FormData): Promise<UserActionResult> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid user." };
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "User not found." };
  if (target.id === guard.user!.id || target.isOwner) return { ok: false, error: "The owner's account cannot be deleted." };

  await prisma.user.delete({ where: { id } }); // sessions go with it (cascade)
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function resetUserPassword(formData: FormData): Promise<UserActionResult> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  const password = String(formData.get("password") ?? "");
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid user." };
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "User not found." };

  await prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(password) } });
  await prisma.session.deleteMany({ where: { userId: id } }); // old sessions die with the old password
  revalidatePath("/admin/users");
  return { ok: true };
}
