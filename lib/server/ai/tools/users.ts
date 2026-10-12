import "server-only";
import { randomBytes } from "node:crypto";
import type { AiAccess, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createUser, deleteUser, setUserActive, updateUserPerms } from "@/app/admin/users/actions";
import { readUserAccess, restoreUserAccess, type UserAccessSnapshot } from "@/lib/server/rowSnapshots";
import { PERMISSIONS, PERM_KEYS, parsePerms } from "@/lib/domain/permissions";
import { TABS, parseHiddenTabs } from "@/lib/domain/tabs";
import { formOf, type ReadTool, type WriteTool } from "./types";

// Users & Permissions for the assistant — the owner's alone, as the screen
// is, and only in a live chat with the owner (never an automation or the
// morning review): which keys a person holds, which screens they see,
// whether they are an admin, whether the assistant is open to them and with
// what monthly allowance, and accounts made, deactivated or brought back.
// Through the screen's own actions; every change waits for the owner's click
// and is undone by putting the account's access back exactly as it was.
//
// Passwords never go through the assistant: an account it makes has a
// random one nobody knows, and the owner sets the first password on the
// screen (Reset password). Deleting an account stays on the screen too —
// the assistant deactivates instead, which keeps the account's history.

const OWNER_ONLY = "Only the owner manages users and permissions.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_STATE = 20_000;
const USER = { type: "string", minLength: 1, maxLength: 120, description: "The account's email, or its exact name." } as const;
const KEYS = { type: "array", minItems: 1, maxItems: PERMISSIONS.length, items: { type: "string", enum: PERMISSIONS.map((p) => p.key) } } as const;
const SCREENS = { type: "array", minItems: 1, maxItems: TABS.length, items: { type: "string", enum: TABS.map((t) => t.id) } } as const;
const USD = { type: "number", minimum: 0, maximum: 100000, description: "The person's own monthly AI allowance in US dollars (0 = none of their own — the plant's cap still holds)." } as const;

const permLabel = (k: string) => PERMISSIONS.find((p) => p.key === k)?.label ?? k;
const tabLabel = (id: string) => TABS.find((t) => t.id === id)?.label ?? id;
const yesNo = (b: boolean) => (b ? "yes" : "no");
const aiText = (a: { enabled: boolean; monthlyUsd: number } | null) => (!a || !a.enabled ? "off" : a.monthlyUsd > 0 ? `on, $${a.monthlyUsd} a month` : "on, no allowance of their own");

type Account = User & { aiAccess: AiAccess | null };

/** The account a reference names: its email, or its exact name when that
 *  is one account's alone. */
async function findAccount(ref: string): Promise<Account | null | "many"> {
  const t = ref.trim();
  const byEmail = await prisma.user.findFirst({ where: { email: { equals: t, mode: "insensitive" } }, include: { aiAccess: true } });
  if (byEmail) return byEmail;
  const byName = await prisma.user.findMany({ where: { name: { equals: t.replace(/\s+/g, " "), mode: "insensitive" } }, include: { aiAccess: true }, take: 2 });
  if (byName.length > 1) return "many";
  return byName[0] ?? null;
}

async function accountOr(ref: string): Promise<Account | { error: string }> {
  const a = await findAccount(ref);
  if (a === "many") return { error: `More than one account is called ${ref} — use the email.` };
  return a ?? { error: `No account ${ref} — list them with list_users.` };
}

/** The screens' form fields: every screen NOT hidden is a ticked "tabs" box. */
function appendScreens(fd: FormData, hidden: ReadonlySet<string>) {
  fd.set("tabsForm", "1");
  for (const t of TABS) if (!hidden.has(t.id)) fd.append("tabs", t.id);
}

// ------------------------------------------------------------------ read

export const listUsersTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "list_users",
  title: "Reading Users & Permissions",
  ownerOnly: true,
  liveOnly: true,
  description:
    "The owner's Users & Permissions: every account (name, email, owner, admin, active), the permission keys each holds, the screens hidden from each, and whether the assistant is open to them with what monthly allowance — and the catalogue of permission keys and screens to choose from.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  async run(_i, ctx) {
    if (!ctx.user.isOwner) return { ok: false, text: OWNER_ONLY };
    const users = await prisma.user.findMany({ orderBy: { name: "asc" }, include: { aiAccess: true } });
    return {
      ok: true,
      text: JSON.stringify({
        users: users.map((u) => ({
          id: u.id, name: u.name, email: u.email, owner: u.isOwner, admin: u.isAdmin, active: u.active,
          permissions: u.isOwner ? "every access right (the owner's), plus: " + [...parsePerms(u.perms)].join(", ") : [...parsePerms(u.perms)],
          hiddenScreens: [...parseHiddenTabs(u.hiddenTabs)],
          assistant: u.isOwner ? "always" : aiText(u.aiAccess ? { enabled: u.aiAccess.enabled, monthlyUsd: u.aiAccess.monthlyUsd } : null),
        })),
        permissionKeys: PERMISSIONS.map((p) => ({ key: p.key, label: p.label, ...(p.notify ? { kind: "notification" } : p.optIn ? { kind: "opt-in" } : {}) })),
        screens: TABS.map((t) => ({ id: t.id, label: t.label })),
      }),
    };
  },
};

// ------------------------------------------------------------------ change access

interface AccessInput {
  user: string;
  admin?: boolean;
  grant?: string[];
  revoke?: string[];
  showScreens?: string[];
  hideScreens?: string[];
  aiEnabled?: boolean;
  aiMonthlyUsd?: number;
}

interface PlannedAccess {
  target: Account;
  admin: boolean;
  perms: Set<string>;
  hidden: Set<string>;
  ai: { enabled: boolean; monthlyUsd: number } | null;
  aiChanges: boolean;
}

function planAccess(target: Account, i: AccessInput): PlannedAccess | { error: string } {
  const aiAsked = i.aiEnabled !== undefined || i.aiMonthlyUsd !== undefined;
  if (target.isOwner && (i.admin !== undefined || aiAsked)) return { error: "The owner's own standing and assistant do not change." };
  const perms = parsePerms(target.perms);
  for (const k of i.grant ?? []) perms.add(k);
  for (const k of i.revoke ?? []) perms.delete(k);
  const hidden = parseHiddenTabs(target.hiddenTabs);
  for (const t of i.showScreens ?? []) hidden.delete(t);
  for (const t of i.hideScreens ?? []) hidden.add(t);
  const was = target.aiAccess ? { enabled: target.aiAccess.enabled, monthlyUsd: target.aiAccess.monthlyUsd } : null;
  const ai = aiAsked ? { enabled: i.aiEnabled ?? was?.enabled ?? false, monthlyUsd: Math.round((i.aiMonthlyUsd ?? was?.monthlyUsd ?? 0) * 100) / 100 } : was;
  return { target, admin: i.admin ?? target.isAdmin, perms, hidden, ai, aiChanges: aiAsked };
}

function accessChanges(p: PlannedAccess) {
  const t = p.target;
  const name = t.name;
  const was = parsePerms(t.perms);
  const wasHidden = parseHiddenTabs(t.hiddenTabs);
  const wasAi = t.aiAccess ? { enabled: t.aiAccess.enabled, monthlyUsd: t.aiAccess.monthlyUsd } : null;
  return [
    ...(p.admin !== t.isAdmin ? [{ label: `${name} — admin`, before: yesNo(t.isAdmin), after: yesNo(p.admin) }] : []),
    ...[...p.perms].filter((k) => !was.has(k)).map((k) => ({ label: `${name} — ${permLabel(k)}`, before: "no", after: "yes" })),
    ...[...was].filter((k) => !p.perms.has(k)).map((k) => ({ label: `${name} — ${permLabel(k)}`, before: "yes", after: "no" })),
    ...[...wasHidden].filter((s) => !p.hidden.has(s)).map((s) => ({ label: `${name} — screen ${tabLabel(s)}`, before: "hidden", after: "shown" })),
    ...[...p.hidden].filter((s) => !wasHidden.has(s)).map((s) => ({ label: `${name} — screen ${tabLabel(s)}`, before: "shown", after: "hidden" })),
    ...(p.aiChanges && aiText(wasAi) !== aiText(p.ai) ? [{ label: `${name} — AI assistant`, before: aiText(wasAi), after: aiText(p.ai) }] : []),
  ];
}

const undoAccess = (s: UserAccessSnapshot) => ({ tool: "restore_user_access", input: { access: JSON.stringify(s) } });

export const updateUserAccessTool: WriteTool<AccessInput> = {
  kind: "write",
  name: "update_user_access",
  title: "Change a person's access",
  liveOnly: true,
  description:
    "Change what one account may do and see, as the owner does on Users & Permissions: grant or revoke permission keys, show or hide screens, make them an admin or not, and open or close the assistant to them with their monthly allowance. Only what is given changes. Read the account and the key catalogue with list_users first.",
  area: "users",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      user: USER,
      admin: { type: "boolean" },
      grant: { ...KEYS, description: "Permission keys to tick." },
      revoke: { ...KEYS, description: "Permission keys to untick." },
      showScreens: { ...SCREENS, description: "Screens (tab ids) to show." },
      hideScreens: { ...SCREENS, description: "Screens (tab ids) to hide." },
      aiEnabled: { type: "boolean", description: "Open (true) or close (false) the assistant to them." },
      aiMonthlyUsd: USD,
    },
    required: ["user"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as AccessInput;
    const both = (i.grant ?? []).find((k) => (i.revoke ?? []).includes(k));
    if (both) return `${both} is both granted and revoked.`;
    const twice = (i.showScreens ?? []).find((t) => (i.hideScreens ?? []).includes(t));
    if (twice) return `${twice} is both shown and hidden.`;
    if (["admin", "grant", "revoke", "showScreens", "hideScreens", "aiEnabled", "aiMonthlyUsd"].every((k) => (i as unknown as Record<string, unknown>)[k] === undefined)) return "Say what changes for the account.";
    if ((i.grant ?? []).some((k) => !PERM_KEYS.has(k)) || (i.revoke ?? []).some((k) => !PERM_KEYS.has(k))) return "Unknown permission key.";
    return i;
  },
  async describe(i, ctx) {
    if (!ctx.user.isOwner) return { error: OWNER_ONLY };
    const target = await accountOr(i.user);
    if ("error" in target) return target;
    const p = planAccess(target, i);
    if ("error" in p) return p;
    const changes = accessChanges(p);
    if (changes.length === 0) return { error: `${target.name}'s access reads so already.` };
    return {
      title: `${target.name}: access`,
      summary: `Change ${target.name}'s access (${target.email}): ${changes.map((c) => `${c.label.slice(target.name.length + 3)} ${c.before} → ${c.after}`).join("; ")}.`,
      changes,
      snapshot: await readUserAccess(target.id),
    };
  },
  async execute(i) {
    const target = await accountOr(i.user);
    if ("error" in target) return { ok: false, error: target.error };
    const p = planAccess(target, i);
    if ("error" in p) return { ok: false, error: p.error };
    const before = await readUserAccess(target.id);
    const fd = formOf({ id: target.id, ...(p.admin ? { isAdmin: "on" } : {}) });
    for (const k of p.perms) fd.append("perms", k);
    appendScreens(fd, p.hidden);
    if (p.aiChanges && p.ai) {
      fd.set("aiForm", "1");
      fd.set("aiUsd", String(p.ai.monthlyUsd));
      if (p.ai.enabled) fd.set("aiEnabled", "on");
    }
    const r = await updateUserPerms(fd);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${target.name}'s access is changed.`, ...(before ? { undo: undoAccess(before) } : {}) };
  },
};

// ------------------------------------------------------------------ accounts

interface CreateInput {
  email: string;
  name: string;
  admin?: boolean;
  permissions?: string[];
  hiddenScreens?: string[];
  aiEnabled?: boolean;
  aiMonthlyUsd?: number;
}

export const createUserTool: WriteTool<CreateInput> = {
  kind: "write",
  name: "create_user",
  title: "Make an account",
  liveOnly: true,
  description:
    "Make a new account on Users & Permissions: email, name, admin or not, its permission keys, the screens hidden from it, and the assistant for it. It gets no password anyone knows — the owner sets the first one on the screen (Reset password); passwords never go through the assistant.",
  area: "users",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      email: { type: "string", minLength: 3, maxLength: 120 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      admin: { type: "boolean" },
      permissions: { ...KEYS, description: "The permission keys to tick." },
      hiddenScreens: { ...SCREENS, description: "Screens (tab ids) the account does not see." },
      aiEnabled: { type: "boolean" },
      aiMonthlyUsd: USD,
    },
    required: ["email", "name"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as CreateInput;
    const email = i.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return "Give a valid email.";
    return { ...i, email, name: i.name.trim().replace(/\s+/g, " ") };
  },
  async describe(i, ctx) {
    if (!ctx.user.isOwner) return { error: OWNER_ONLY };
    if (await prisma.user.findUnique({ where: { email: i.email }, select: { id: true } })) return { error: `An account with ${i.email} already exists.` };
    const perms = i.permissions ?? [];
    const ai = i.aiEnabled !== undefined || i.aiMonthlyUsd !== undefined ? { enabled: i.aiEnabled ?? false, monthlyUsd: i.aiMonthlyUsd ?? 0 } : null;
    return {
      title: `New account: ${i.name}`,
      summary: `Make an account for ${i.name} (${i.email})${i.admin ? ", an admin" : ""}, with ${perms.length} permission(s) — you set its first password on Users & Permissions.`,
      changes: [
        { label: i.name, before: "—", after: `${i.email}${i.admin ? " · admin" : ""}` },
        ...(perms.length ? [{ label: "Permissions", before: "—", after: perms.map(permLabel).join(", ") }] : []),
        ...(i.hiddenScreens?.length ? [{ label: "Hidden screens", before: "—", after: i.hiddenScreens.map(tabLabel).join(", ") }] : []),
        ...(ai ? [{ label: "AI assistant", before: "—", after: aiText(ai) }] : []),
      ],
      snapshot: { email: i.email, exists: false },
    };
  },
  async execute(i) {
    const fd = formOf({ email: i.email, name: i.name, password: randomBytes(24).toString("base64url"), ...(i.admin ? { isAdmin: "on" } : {}) });
    for (const k of i.permissions ?? []) fd.append("perms", k);
    appendScreens(fd, new Set(i.hiddenScreens ?? []));
    if (i.aiEnabled !== undefined || i.aiMonthlyUsd !== undefined) {
      fd.set("aiForm", "1");
      fd.set("aiUsd", String(i.aiMonthlyUsd ?? 0));
      if (i.aiEnabled) fd.set("aiEnabled", "on");
    }
    const r = await createUser(fd);
    if (!r.ok) return { ok: false, error: r.error };
    const made = await prisma.user.findUnique({ where: { email: i.email }, select: { id: true } });
    return {
      ok: true,
      message: `${i.name}'s account is made. Nobody knows its password yet — set the first one on Users & Permissions (Reset password).`,
      ...(made ? { undo: { tool: "delete_new_user", input: { id: made.id } } } : {}),
    };
  },
};

export const setUserActiveTool: WriteTool<{ user: string; active: boolean }> = {
  kind: "write",
  name: "set_user_active",
  title: "Deactivate or bring back an account",
  liveOnly: true,
  description: "Deactivate an account (it can no longer log in, and is signed out at once — its history stays) or bring a deactivated one back. The owner's own account never changes.",
  area: "users",
  risk: "high",
  schema: { type: "object", properties: { user: USER, active: { type: "boolean" } }, required: ["user", "active"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isOwner) return { error: OWNER_ONLY };
    const target = await accountOr(i.user);
    if ("error" in target) return target;
    if (target.isOwner) return { error: "The owner's account cannot be deactivated." };
    if (target.active === i.active) return { error: `${target.name}'s account is ${i.active ? "active" : "deactivated"} already.` };
    return {
      title: `${i.active ? "Bring back" : "Deactivate"} ${target.name}`,
      summary: i.active ? `Bring ${target.name}'s account (${target.email}) back — they can log in again.` : `Deactivate ${target.name}'s account (${target.email}) — they are signed out now and cannot log in; their history stays.`,
      changes: [{ label: `${target.name} — account`, before: target.active ? "active" : "deactivated", after: i.active ? "active" : "deactivated" }],
      snapshot: await readUserAccess(target.id),
    };
  },
  async execute(i) {
    const target = await accountOr(i.user);
    if ("error" in target) return { ok: false, error: target.error };
    const r = await setUserActive(formOf({ id: target.id, active: String(i.active) }));
    return r.ok ? { ok: true, message: `${target.name}'s account is ${i.active ? "active again" : "deactivated"}.`, undo: { tool: "set_user_active", input: { user: target.email, active: !i.active } } } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ undo

/** An access snapshot out of its JSON, checked whole — or null. */
export function readAccessText(text: string): UserAccessSnapshot | null {
  try {
    const s = JSON.parse(text) as UserAccessSnapshot;
    const aiOk = s.ai === null || (s.ai && typeof s.ai.enabled === "boolean" && typeof s.ai.monthlyUsd === "number" && Number.isFinite(s.ai.monthlyUsd));
    return Number.isInteger(s?.id) && typeof s.isAdmin === "boolean" && typeof s.perms === "string" && typeof s.hiddenTabs === "string" && typeof s.active === "boolean" && aiOk ? s : null;
  } catch {
    return null;
  }
}

/** The undo of update_user_access — never offered to the model. */
export const restoreUserAccessTool: WriteTool<{ access: string }> = {
  kind: "write",
  name: "restore_user_access",
  internal: true,
  title: "Put a person's access back",
  description: "Put an account's access back exactly as it was (the undo of an access change).",
  area: "users",
  risk: "low",
  schema: { type: "object", properties: { access: { type: "string", minLength: 2, maxLength: MAX_STATE } }, required: ["access"], additionalProperties: false },
  parse: (r) => (readAccessText(String(r.access)) ? { access: String(r.access) } : "The access to put back cannot be read."),
  async describe(i, ctx) {
    if (!ctx.user.isOwner) return { error: OWNER_ONLY };
    const then = readAccessText(i.access)!;
    const target = await prisma.user.findUnique({ where: { id: then.id }, include: { aiAccess: true } });
    if (!target) return { error: "That account is not there any more." };
    const now = await readUserAccess(target.id);
    const p: PlannedAccess = { target, admin: then.isAdmin, perms: parsePerms(then.perms), hidden: parseHiddenTabs(then.hiddenTabs), ai: then.ai, aiChanges: true };
    return { title: `Put ${target.name}'s access back`, summary: `Put ${target.name}'s access back as it was.`, changes: accessChanges(p), snapshot: now };
  },
  async execute(i) {
    const r = await restoreUserAccess(readAccessText(i.access)!);
    return r.ok ? { ok: true, message: "The access is back as it was." } : { ok: false, error: r.error };
  },
};

/** The undo of create_user — never offered to the model: the account goes
 *  again, only while nothing was done to it since it was made (a password
 *  set, a key ticked … — its record then reads changed and the undo stops). */
export const deleteNewUserTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_new_user",
  internal: true,
  title: "Take back a new account",
  description: "Delete an account the assistant just made (the undo of create_user).",
  area: "users",
  risk: "destructive",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isOwner) return { error: OWNER_ONLY };
    const target = await prisma.user.findUnique({ where: { id: i.id }, select: { id: true, name: true, email: true, isOwner: true, updatedAt: true } });
    if (!target || target.isOwner) return { error: "That account is not there any more." };
    return {
      title: `Take back ${target.name}'s account`,
      summary: `Delete the account made for ${target.name} (${target.email}).`,
      changes: [{ label: target.name, before: target.email, after: "no account" }],
      snapshot: { id: target.id, email: target.email, updatedAt: target.updatedAt.toISOString() },
    };
  },
  async execute(i) {
    const r = await deleteUser(formOf({ id: i.id }));
    return r.ok ? { ok: true, message: "The account is deleted." } : { ok: false, error: r.error };
  },
};

export const USER_TOOLS = [listUsersTool, updateUserAccessTool, createUserTool, setUserActiveTool, restoreUserAccessTool, deleteNewUserTool] as const;
