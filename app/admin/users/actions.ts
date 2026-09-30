"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { hashPassword, requireOwner } from "@/lib/server/auth";
import { serializePerms } from "@/lib/domain/permissions";

export interface UserActionResult {
  ok: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function permsFromForm(formData: FormData): string {
  return serializePerms(formData.getAll("perms").map(String));
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

  await prisma.user.create({
    data: { email, name, passwordHash: hashPassword(password), isAdmin, perms: permsFromForm(formData) },
  });
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

  await prisma.user.update({ where: { id }, data: { isAdmin, perms: permsFromForm(formData) } });
  revalidatePath("/admin/users");
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
