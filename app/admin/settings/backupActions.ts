"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/server/auth";
import { makeBackupPassword, turnOffBackupLogin, type MakeBackupPasswordResult } from "@/lib/server/backupLogin";

// The nightly backup's own read-only login — the owner's alone: its password
// opens every table of the app for reading.

const OWNER_ONLY = "Only the owner manages the backup's login.";

export async function makeBackupLogin(): Promise<MakeBackupPasswordResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "You are not logged in — refresh the page." };
  if (!user.isOwner) return { ok: false, error: OWNER_ONLY };
  const r = await makeBackupPassword(user);
  revalidatePath("/admin/settings");
  return r;
}

export async function turnOffBackup(): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "You are not logged in — refresh the page." };
  if (!user.isOwner) return { ok: false, error: OWNER_ONLY };
  const r = await turnOffBackupLogin(user);
  revalidatePath("/admin/settings");
  return r;
}
