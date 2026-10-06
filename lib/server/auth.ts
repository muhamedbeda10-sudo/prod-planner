import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { parsePerms, deptPermKey, PERM_KEYS, ACCESS_PERM_KEYS } from "@/lib/domain/permissions";
import type { User } from "@prisma/client";
import { redirect } from "next/navigation";
import { canSeePath, firstVisiblePath, parseHiddenTabs } from "@/lib/domain/tabs";

const SESSION_COOKIE = "atc_session";
const SESSION_DAYS = 30;

// ---- passwords: scrypt (built-in, no deps). Stored as salt:hash hex. ----

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---- sessions: random token in the cookie, sha256(token) as the DB key ----

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: tokenId(token), userId, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { id: tokenId(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/** The logged-in user, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: tokenId(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || !session.user.active) return null;
  return asOwner(session.user);
});

/** The owner holds every right: every admin gate and every access tick pass.
 *  The notification subscriptions stay theirs to tick. */
function asOwner(user: User): User {
  if (!user.isOwner) return user;
  const notify = [...parsePerms(user.perms)].filter((k) => !ACCESS_PERM_KEYS.includes(k));
  return { ...user, isAdmin: true, perms: [...ACCESS_PERM_KEYS, ...notify].join(",") };
}

export function userPerms(user: User): Set<string> {
  return parsePerms(user.perms);
}

/** Admins follow their ticks like everyone else — every admin was ticked with
 *  every right when this changed, and the owner unticks what that admin does
 *  not do. A key that is not in the catalog (so cannot be ticked) stays an
 *  admin-only right. */
export function hasPerm(user: User, perm: string): boolean {
  if (PERM_KEYS.has(perm)) return userPerms(user).has(perm);
  return user.isAdmin;
}

export function canEditDept(user: User, dept: string): boolean {
  return hasPerm(user, deptPermKey(dept));
}

// ---- guards for server actions: return an error string or null when allowed ----

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const NO_PERMISSION = "You do not have permission for this action — ask the admin.";

export async function requirePerm(perm: string): Promise<{ user?: User; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: NOT_LOGGED_IN };
  if (!hasPerm(user, perm)) return { error: NO_PERMISSION };
  return { user };
}

export async function requireDeptEdit(dept: string): Promise<{ user?: User; error?: string }> {
  return requirePerm(deptPermKey(dept));
}

/** Users & Permissions are the owner's alone — admins included out. */
export async function requireOwner(): Promise<{ user?: User; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: NOT_LOGGED_IN };
  if (!user.isOwner) return { error: "Only the owner manages users and permissions." };
  return { user };
}

export async function requireAdmin(): Promise<{ user?: User; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: NOT_LOGGED_IN };
  if (!user.isAdmin) return { error: NO_PERMISSION };
  return { user };
}

// ---- the screens an account sees (lib/domain/tabs.ts) ----

export function hiddenTabsOf(user: User | null): Set<string> {
  return parseHiddenTabs(user?.hiddenTabs);
}

/** First thing on every page: a screen switched off for this account sends
 *  them to the first one they do see (or to /no-access when none is left). */
export async function guardTab(pathname: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const hidden = hiddenTabsOf(user);
  if (canSeePath(hidden, pathname)) return;
  redirect(firstVisiblePath(hidden) ?? "/no-access");
}
