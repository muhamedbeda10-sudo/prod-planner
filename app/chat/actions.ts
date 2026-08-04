"use server";

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { put } from "@vercel/blob";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { getChatContacts, getChatThread, type ChatAttachment, type ChatContact, type ChatMessageDTO } from "@/lib/server/chat";
import { broadcast } from "@/lib/server/realtimeBroadcast";
import { chatTopic } from "@/lib/domain/chatTopic";

// Chat needs no permission key — every active account can message every other.
// What it DOES need is scoping: every query here pins the caller's id from the
// session, so nobody can read, hide, or mark a thread they aren't an end of.

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const MAX_BODY = 2000;
const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — same ceiling as note photos

// the allowed set, by extension (browser MIME strings are too inconsistent to
// gate on): images render inline, the documents render as file cards
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const DOC_EXTENSIONS = new Set([".pdf", ".xls", ".xlsx", ".csv", ".doc", ".docx"]);

export async function sendChatMessage(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; message?: ChatMessageDTO }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };

  const toId = Number(formData.get("to"));
  const text = String(formData.get("body") ?? "").trim();
  const moRaw = String(formData.get("mo") ?? "").trim();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  if (text.length > MAX_BODY) return { ok: false, error: `Message is too long (max ${MAX_BODY} characters).` };
  if (!Number.isInteger(toId) || toId === me.id) return { ok: false, error: "Invalid recipient." };
  if (!text && files.length === 0 && !moRaw) return { ok: false, error: "Message is empty." };
  if (files.length > MAX_FILES) return { ok: false, error: `Max ${MAX_FILES} files per message.` };

  const recipient = await prisma.user.findUnique({ where: { id: toId }, select: { active: true } });
  if (!recipient?.active) return { ok: false, error: "Recipient not found." };

  // an attached order must be a REAL order — the chip links to its trace
  let mo: string | null = null;
  if (moRaw) {
    const order = await prisma.masterOrder.findUnique({ where: { mo: moRaw }, select: { mo: true } });
    if (!order) return { ok: false, error: `MO "${moRaw}" is not in the orders registry.` };
    mo = order.mo;
  }

  // ---- attachments: whitelist, cap, then store (Vercel Blob or local dev dir) ----
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) {
      return { ok: false, error: `"${f.name}" — only images, PDF, Excel, Word and CSV files are allowed.` };
    }
    if (f.size > MAX_FILE_BYTES) return { ok: false, error: `"${f.name}" is larger than 10 MB.` };
  }
  const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN; // cloud + any machine with the token
  if (files.length > 0 && !useBlob && process.env.VERCEL) {
    // ephemeral filesystem and no blob token — refuse clearly instead of losing files
    return { ok: false, error: "File storage is not configured — ask the admin." };
  }
  const attachments: ChatAttachment[] = [];
  if (files.length > 0) {
    const dir = path.join(process.cwd(), "uploads", "chat");
    if (!useBlob) await mkdir(dir, { recursive: true });
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      const stored = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      let url: string;
      if (useBlob) {
        const blob = await put(`chat/${stored}`, Buffer.from(await f.arrayBuffer()), {
          access: "public",
          contentType: f.type || "application/octet-stream",
          addRandomSuffix: true, // unguessable URL — the app itself stays behind login
        });
        url = blob.url;
      } else {
        await writeFile(path.join(dir, stored), Buffer.from(await f.arrayBuffer()));
        url = `/uploads/chat/${stored}`;
      }
      attachments.push({ url, name: f.name, size: f.size, type: f.type || "application/octet-stream" });
    }
  }

  const row = await prisma.chatMessage.create({
    data: {
      fromId: me.id,
      toId,
      body: text,
      mo,
      attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
    },
    select: { id: true, fromId: true, toId: true, body: true, mo: true, createdAt: true },
  });
  const message: ChatMessageDTO = {
    id: row.id,
    fromId: row.fromId,
    toId: row.toId,
    body: row.body,
    mo: row.mo,
    attachments,
    createdAt: row.createdAt.toISOString(),
  };

  // live delivery (best-effort): the recipient's tab, and the sender's OTHER
  // tabs so a conversation never forks between two open windows
  await Promise.all([
    broadcast(chatTopic(toId), "message", { message, fromName: me.name }),
    broadcast(chatTopic(me.id), "message", { message, fromName: me.name }),
  ]);

  return { ok: true, message };
}

/** "Delete for me": hide a message from the CALLER's view only — the other
 *  end keeps it. The row itself is never removed. */
export async function deleteChatMessageForMe(messageId: number): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(messageId)) return { ok: false, error: "Invalid message." };

  const m = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { fromId: true, toId: true },
  });
  if (!m || (m.fromId !== me.id && m.toId !== me.id)) return { ok: false, error: "Message not found." };

  await prisma.chatMessage.update({
    where: { id: messageId },
    data: m.fromId === me.id ? { hiddenForFrom: true } : { hiddenForTo: true },
  });
  return { ok: true };
}

/** Order picker search for the composer: match MO or BOM, a few best hits. */
export async function searchChatOrders(
  q: string,
): Promise<{ ok: boolean; orders: { mo: string; bom: string; status: string }[] }> {
  const me = await getCurrentUser();
  const needle = q.trim();
  if (!me || needle.length < 2) return { ok: !!me, orders: [] };

  const orders = await prisma.masterOrder.findMany({
    where: {
      OR: [
        { mo: { contains: needle, mode: "insensitive" } },
        { bom: { contains: needle, mode: "insensitive" } },
      ],
    },
    select: { mo: true, bom: true, status: true },
    orderBy: { mo: "asc" },
    take: 20,
  });
  // open orders first — they are what people talk about
  orders.sort((a, b) => Number(a.status === "closed") - Number(b.status === "closed") || a.mo.localeCompare(b.mo));
  return { ok: true, orders: orders.slice(0, 10) };
}

/** Open (or refresh) a conversation: returns the thread and stamps everything
 *  the other user sent as read. */
export async function openChatThread(
  otherId: number,
): Promise<{ ok: boolean; error?: string; messages?: ChatMessageDTO[] }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(otherId)) return { ok: false, error: "Invalid user." };

  const [messages] = await Promise.all([
    getChatThread(me.id, otherId),
    prisma.chatMessage.updateMany({
      where: { fromId: otherId, toId: me.id, readAt: null },
      data: { readAt: new Date() },
    }),
  ]);
  return { ok: true, messages };
}

/** Mark the open thread read (called when messages arrive while it's open). */
export async function markChatThreadRead(otherId: number): Promise<{ ok: boolean }> {
  const me = await getCurrentUser();
  if (!me || !Number.isInteger(otherId)) return { ok: false };
  await prisma.chatMessage.updateMany({
    where: { fromId: otherId, toId: me.id, readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

/** The polling fallback (and reconnect catch-up): everything new in the open
 *  thread after `afterId`, plus a fresh contact list for the unread badges. */
export async function pollChat(
  openThreadWith: number | null,
  afterId: number,
): Promise<{ ok: boolean; error?: string; messages?: ChatMessageDTO[]; contacts?: ChatContact[] }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };

  const [messages, contacts] = await Promise.all([
    openThreadWith && Number.isInteger(openThreadWith)
      ? getChatThread(me.id, openThreadWith, afterId)
      : Promise.resolve([]),
    getChatContacts(me.id),
  ]);
  return { ok: true, messages, contacts };
}
