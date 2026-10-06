import { prisma } from "@/lib/db";
import type { UserPrefKey, UserPrefs } from "@/lib/domain/userPrefs";

/** The account's saved values for these keys — null for one never set. */
export async function getUserPrefs(userId: number | null | undefined, keys: readonly UserPrefKey[]): Promise<UserPrefs> {
  const out: UserPrefs = Object.fromEntries(keys.map((k) => [k, null]));
  if (!userId) return out;
  const rows = await prisma.userPref.findMany({ where: { userId, key: { in: [...keys] } }, select: { key: true, value: true } });
  for (const r of rows) out[r.key as UserPrefKey] = r.value;
  return out;
}
