"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/server/auth";
import { LOGIN_FAILURE_KEEP_MS, LOGIN_THROTTLED, LOGIN_WINDOW_MS, clientAddress, loginThrottled } from "@/lib/domain/loginThrottle";

// burned on unknown emails so both paths cost the same time
const DUMMY_HASH = hashPassword("timing-equalizer");

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export async function loginAction(formData: FormData): Promise<LoginResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { ok: false, error: "Enter your email and password." };

  // too many wrong passwords lately: wait, before any password is checked
  const h = await headers();
  const ip = clientAddress((name) => h.get(name));
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const [account, address] = await Promise.all([
    prisma.loginFailure.count({ where: { email, ip, at: { gte: since } } }),
    prisma.loginFailure.count({ where: { ip, at: { gte: since } } }),
  ]);
  if (loginThrottled({ account, address })) return { ok: false, error: LOGIN_THROTTLED };

  const user = await prisma.user.findUnique({ where: { email } });
  // same work + same message whether the email exists or not
  const valid = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) {
    await prisma.$transaction([
      prisma.loginFailure.create({ data: { email: email.slice(0, 200), ip } }),
      prisma.loginFailure.deleteMany({ where: { at: { lt: new Date(Date.now() - LOGIN_FAILURE_KEEP_MS) } } }),
    ]);
    return { ok: false, error: "Wrong email or password." };
  }
  if (!user.active) return { ok: false, error: "This account is deactivated — ask the admin." };

  // signed in: this account's mistakes from here are forgiven
  await prisma.loginFailure.deleteMany({ where: { email, ip } });
  await createSession(user.id);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}
