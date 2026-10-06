"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { USER_PREF_MAX, isUserPrefKey } from "@/lib/domain/userPrefs";

/** Keep one of the signed-in person's view settings on their account. Any
 *  signed-in user may set their own; nothing else is touched. */
export async function saveUserPref(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!isUserPrefKey(key)) return { ok: false, error: "Unknown setting." };
  const v = String(value ?? "").slice(0, USER_PREF_MAX);
  await prisma.userPref.upsert({
    where: { userId_key: { userId: user.id, key } },
    create: { userId: user.id, key, value: v },
    update: { value: v },
  });
  return { ok: true };
}
