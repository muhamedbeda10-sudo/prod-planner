"use server";

import { revalidatePath } from "next/cache";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { put, del } from "@vercel/blob";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { AVATAR_TYPES, avatarFileError } from "@/lib/domain/avatar";
import { userMessage } from "@/lib/server/errors";

// A person's own photo for the bar's round button. Only ever their own: the
// account comes from the session, never from the form. Stored the way note
// photos are — in the Blob store where there is one, else on the server's
// disk behind /uploads/avatars — and the photo it replaces is deleted.

interface Result {
  ok: boolean;
  error?: string;
}

const LOCAL_DIR = path.join(process.cwd(), "uploads", "avatars");
const LOCAL_PREFIX = "/uploads/avatars/";

/** Delete a photo the account no longer uses. A file already gone is fine —
 *  the account has moved on either way. */
async function dropPhoto(url: string | null): Promise<void> {
  if (!url) return;
  try {
    if (url.startsWith(LOCAL_PREFIX)) await rm(path.join(LOCAL_DIR, path.basename(url)));
    else if (url.startsWith("https://")) await del(url);
  } catch {
    /* already gone */
  }
}

export async function setAvatar(formData: FormData): Promise<Result> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "You are not logged in — refresh the page." };
    const file = formData.get("photo");
    if (!(file instanceof File)) return { ok: false, error: "Choose a photo." };
    const bad = avatarFileError(file.type, file.size);
    if (bad) return { ok: false, error: bad };

    const name = `u${user.id}-${Date.now()}${AVATAR_TYPES[file.type]}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    let url: string;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      // an unguessable URL — the app itself stays behind the login
      const blob = await put(`avatars/${name}`, bytes, { access: "public", contentType: file.type, addRandomSuffix: true });
      url = blob.url;
    } else if (process.env.VERCEL) {
      // the server's disk does not survive a deployment there
      return { ok: false, error: "Photo storage is not configured — ask the admin." };
    } else {
      await mkdir(LOCAL_DIR, { recursive: true });
      await writeFile(path.join(LOCAL_DIR, name), bytes);
      url = `${LOCAL_PREFIX}${name}`;
    }

    const before = user.avatarUrl;
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
    await dropPhoto(before);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: userMessage(e, "save the photo") };
  }
}

export async function removeAvatar(): Promise<Result> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "You are not logged in — refresh the page." };
    if (!user.avatarUrl) return { ok: true };
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
    await dropPhoto(user.avatarUrl);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: userMessage(e, "remove the photo") };
  }
}
