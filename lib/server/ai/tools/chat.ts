import "server-only";
import type { AiFile } from "@prisma/client";
import { prisma } from "@/lib/db";
import { chatFile, uploadOf } from "@/lib/server/ai/files";
import { addChatGroupMembers, createChatGroup, sendChatMessage } from "@/app/chat/actions";
import { peopleNamed } from "./automations";
import { formOf, type ToolCtx, type WriteTool } from "./types";
import { CHAT_MESSAGE_MAX } from "@/lib/domain/chatTopic";

// The team chat for the assistant — writing in it, never reading it (the
// chat is the people's own; the assistant cannot see it). A message goes
// out as the person, through the chat's own action, to a colleague or one of
// the person's groups; a group is made, or added to, by its maker. Nothing
// sent can be taken back, as in the chat itself — the card says so.

const NOT_OPEN = "The chat is not opened for you, so the assistant cannot write in it for you.";
const MAX_FILES = 6;

type Target = { kind: "user" | "group"; id: number; name: string };

/** Who a message goes to: a colleague by name, or one of the person's groups. */
async function targetOf(to: string, kind: "person" | "group" | undefined, ctx: ToolCtx): Promise<Target | { error: string }> {
  const groups = kind === "person" ? [] : await prisma.chatGroup.findMany({
    where: { name: { equals: to.trim(), mode: "insensitive" }, members: { some: { userId: ctx.user.id } } },
    select: { id: true, name: true },
  });
  const person = kind === "group" ? null : await peopleNamed([to]);
  const user = person && !("error" in person) ? { id: person.ids[0], name: person.names[0] } : null;
  if (user && user.id === ctx.user.id) return { error: "That is the person themselves." };
  if (groups.length > 1) return { error: `${groups.length} of the person's groups are called "${to}" — the chat tells them apart, the assistant cannot.` };
  if (user && groups.length === 1) return { error: `"${to}" is both a colleague and a group — say which (kind).` };
  if (groups.length === 1) return { kind: "group", id: groups[0].id, name: groups[0].name };
  if (user) return { kind: "user", ...user };
  if (kind === "group") return { error: `The person is in no group called "${to}".` };
  const why = person && "error" in person ? person.error : `No colleague is called ${to}.`;
  return { error: kind === "person" ? why : `${why} Nor is any of the person's groups.` };
}

/** Files attached in this chat for the message — photos, PDFs and sheets the chat takes. */
async function messageFiles(ids: readonly number[], ctx: ToolCtx): Promise<AiFile[] | { error: string }> {
  const out: AiFile[] = [];
  for (const id of ids) {
    const f = await chatFile(ctx, id);
    if ("error" in f) return f;
    out.push(f);
  }
  return out;
}

interface SendInput {
  to: string;
  kind?: "person" | "group";
  text?: string;
  mo?: string;
  files?: number[];
}

export const sendChatMessageTool: WriteTool<SendInput> = {
  kind: "write",
  name: "send_chat_message",
  title: "Send a team chat message",
  description:
    "Send a message in the team chat as the person — to a colleague (by their name) or to one of the person's groups (by its name) — with an order attached as a chip (mo) and files attached in this chat (photos, PDF, Excel). Only when the person asks for it to be sent, worded as they want. It cannot be taken back, as in the chat itself. For a notice in their inbox use send_message.",
  area: "automations",
  risk: "high",
  liveOnly: true,
  tabs: ["chat"],
  schema: {
    type: "object",
    properties: {
      to: { type: "string", minLength: 1, maxLength: 80, description: "The colleague's name, or the group's name." },
      kind: { type: "string", enum: ["person", "group"], description: "Only when a colleague and a group share the name." },
      text: { type: "string", maxLength: CHAT_MESSAGE_MAX },
      mo: { type: "string", maxLength: 60, description: "An order to attach as a chip (its MO)." },
      files: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: MAX_FILES, description: "Files attached in this chat, by file number." },
    },
    required: ["to"],
    additionalProperties: false,
  },
  parse(r) {
    const text = String(r.text ?? "").trim();
    const mo = String(r.mo ?? "").trim();
    const files = [...new Set((r.files as number[] | undefined) ?? [])];
    if (!text && !mo && files.length === 0) return "The message is empty.";
    return { to: String(r.to).trim(), ...(r.kind ? { kind: r.kind as SendInput["kind"] } : {}), ...(text ? { text } : {}), ...(mo ? { mo } : {}), ...(files.length ? { files } : {}) };
  },
  async describe(i, ctx) {
    if (ctx.hidden.has("chat")) return { error: NOT_OPEN };
    const t = await targetOf(i.to, i.kind, ctx);
    if ("error" in t) return t;
    if (i.mo && !(await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { mo: true } }))) return { error: `${i.mo} is not in the orders registry.` };
    const files = await messageFiles(i.files ?? [], ctx);
    if ("error" in files) return files;
    return {
      title: `💬 To ${t.kind === "group" ? `the group ${t.name}` : t.name}`,
      summary: `Send in the team chat to ${t.kind === "group" ? `the group ${t.name}` : t.name}, as ${ctx.user.name}${i.text ? `: "${i.text}"` : ""}${i.mo ? ` — with ${i.mo}` : ""}${files.length ? ` — with ${files.map((f) => f.name).join(", ")}` : ""}. It cannot be taken back.`,
      changes: [{ label: t.name, before: "—", after: `${i.text ?? ""}${i.mo ? ` [${i.mo}]` : ""}${files.length ? ` 📎×${files.length}` : ""}`.trim() }],
      snapshot: { to: t, files: files.map((f) => f.sha256) },
    };
  },
  async execute(i, ctx) {
    const t = await targetOf(i.to, i.kind, ctx);
    if ("error" in t) return { ok: false, error: t.error };
    const files = await messageFiles(i.files ?? [], ctx);
    if ("error" in files) return { ok: false, error: files.error };
    const fd = formOf({ kind: t.kind, to: t.id, body: i.text ?? "", mo: i.mo ?? "" });
    for (const f of files) fd.append("files", uploadOf(f));
    const r = await sendChatMessage(fd);
    return r.ok ? { ok: true, message: `Sent to ${t.name} in the team chat.` } : { ok: false, error: r.error ?? "Not sent." };
  },
};

interface GroupInput {
  name: string;
  members: string[];
}

export const createChatGroupTool: WriteTool<GroupInput> = {
  kind: "write",
  name: "create_chat_group",
  title: "Make a chat group",
  description: "Make a group in the team chat, as the chat's ＋ Group does: its name and its members (by their names) — the person is in it and manages who is. It shows in everyone's chat at once; it is not taken back here (members can leave it in the chat).",
  area: "automations",
  risk: "high",
  liveOnly: true,
  tabs: ["chat"],
  schema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      members: { type: "array", minItems: 1, maxItems: 60, items: { type: "string", minLength: 1, maxLength: 80 }, description: "The members' names on the users list." },
    },
    required: ["name", "members"],
    additionalProperties: false,
  },
  parse: (r) => ({ name: String(r.name).trim(), members: r.members as string[] }),
  async describe(i, ctx) {
    if (ctx.hidden.has("chat")) return { error: NOT_OPEN };
    const p = await peopleNamed(i.members);
    if ("error" in p) return p;
    const others = p.names.filter((_, n) => p.ids[n] !== ctx.user.id);
    if (others.length === 0) return { error: "Name at least one colleague to be in it." };
    return {
      title: `💬 New group "${i.name}"`,
      summary: `Make the chat group "${i.name}" with ${ctx.user.name}, ${others.join(", ")}.`,
      changes: [{ label: i.name, before: "—", after: [ctx.user.name, ...others].join(", ") }],
      snapshot: { members: p.ids },
    };
  },
  async execute(i, ctx) {
    const p = await peopleNamed(i.members);
    if ("error" in p) return { ok: false, error: p.error };
    const r = await createChatGroup(i.name, p.ids.filter((id) => id !== ctx.user.id));
    return r.ok ? { ok: true, message: `The group "${i.name}" is in the chat.` } : { ok: false, error: r.error };
  },
};

export const addChatGroupMembersTool: WriteTool<{ group: string; members: string[] }> = {
  kind: "write",
  name: "add_chat_group_members",
  title: "Add people to a chat group",
  description: "Add colleagues (by their names) to a team chat group the person made — only its maker manages who is in it. It is not taken back here.",
  area: "automations",
  risk: "high",
  liveOnly: true,
  tabs: ["chat"],
  schema: {
    type: "object",
    properties: {
      group: { type: "string", minLength: 1, maxLength: 60, description: "The group's name." },
      members: { type: "array", minItems: 1, maxItems: 60, items: { type: "string", minLength: 1, maxLength: 80 } },
    },
    required: ["group", "members"],
    additionalProperties: false,
  },
  parse: (r) => ({ group: String(r.group).trim(), members: r.members as string[] }),
  async describe(i, ctx) {
    if (ctx.hidden.has("chat")) return { error: NOT_OPEN };
    const groups = await prisma.chatGroup.findMany({ where: { name: { equals: i.group, mode: "insensitive" }, createdBy: ctx.user.id }, select: { id: true, name: true, members: { select: { userId: true } } } });
    if (groups.length === 0) return { error: `${ctx.user.name} made no group called "${i.group}" — only its maker adds people to a group.` };
    if (groups.length > 1) return { error: `${ctx.user.name} made ${groups.length} groups called "${i.group}" — add them in the chat.` };
    const p = await peopleNamed(i.members);
    if ("error" in p) return p;
    const inIt = new Set(groups[0].members.map((m) => m.userId));
    const fresh = p.names.filter((_, n) => !inIt.has(p.ids[n]));
    if (fresh.length === 0) return { error: `They are all in "${groups[0].name}" already.` };
    return {
      title: `💬 Add ${fresh.length} to "${groups[0].name}"`,
      summary: `Add ${fresh.join(", ")} to the chat group "${groups[0].name}".`,
      changes: fresh.map((n) => ({ label: groups[0].name, before: "—", after: n })),
      snapshot: { group: groups[0].id, members: [...inIt].sort((a, b) => a - b) },
    };
  },
  async execute(i, ctx) {
    const g = await prisma.chatGroup.findFirst({ where: { name: { equals: i.group, mode: "insensitive" }, createdBy: ctx.user.id }, select: { id: true, name: true } });
    if (!g) return { ok: false, error: `${ctx.user.name} made no group called "${i.group}".` };
    const p = await peopleNamed(i.members);
    if ("error" in p) return { ok: false, error: p.error };
    const r = await addChatGroupMembers(g.id, p.ids);
    return r.ok ? { ok: true, message: `Added to "${g.name}".` } : { ok: false, error: r.error };
  },
};

export const CHAT_TOOLS = [sendChatMessageTool, createChatGroupTool, addChatGroupMembersTool] as const;
