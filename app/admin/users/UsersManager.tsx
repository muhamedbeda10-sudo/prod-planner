"use client";

import { useState, useTransition } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2, UserCheck, Users, UserX } from "lucide-react";
import { PERM_ALERTS, PERM_OTHER, PERM_TABLES, parsePerms, permDef } from "@/lib/domain/permissions";
import { TABS, TAB_GROUPS, parseHiddenTabs } from "@/lib/domain/tabs";
import { createUser, updateUserPerms, setUserActive, resetUserPassword, deleteUser } from "./actions";
import { Modal } from "@/components/Modal";
import { PageHead } from "@/components/ui";
import { Note, SectionCard } from "@/components/primitives";
import { Avatar } from "@/components/UserMenu";
import { usdText } from "@/lib/domain/ai";
import { formatDate } from "@/lib/domain/format";

// The accounts as one table: who, their role, whether they are active, the
// screens and the assistant they have, and what to do with each — the
// permissions (a popup of their own), a new password, deactivating, deleting.

interface Row {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  isOwner: boolean;
  perms: string;
  hiddenTabs: string;
  active: boolean;
  createdAt: Date;
  /** The AI assistant: may they use it, their monthly allowance, this month's spend. */
  ai: { enabled: boolean; monthlyUsd: number; spent: number };
}

const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";

/** One key's box. Access rights carry data-access, so ticking Admin ticks
 *  them; notifications are never ticked in bulk. */
function PermBox({ k, on, disabled, label }: { k: string; on: boolean; disabled?: boolean; label?: string }) {
  const d = permDef(k);
  return (
    <input
      type="checkbox"
      name="perms"
      value={k}
      defaultChecked={on}
      disabled={disabled}
      title={d?.desc}
      aria-label={label ?? d?.label ?? k}
      data-access={d?.notify || d?.optIn ? undefined : "1"}
      className="w-4 h-4"
    />
  );
}

/** The permissions as tables — a department across the two lines and its
 *  shift log, an order's job across the two lines — then the rest, then the
 *  notifications. The assistant's own rights are on AI assistant settings. */
function PermChecks({ defaults, disabled }: { defaults: Set<string>; disabled?: boolean }) {
  const box = (k: string, label?: string) => <PermBox k={k} on={defaults.has(k)} disabled={disabled} label={label} />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        {PERM_TABLES.map((t) => (
          <fieldset key={t.title} className="border rounded-lg p-3">
            <legend className="px-1.5 filter-label">{t.title}</legend>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-start font-bold">&nbsp;</th>
                  {t.columns.map((c) => <th key={c} className="text-center font-bold w-24">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.label}>
                    <td className="font-semibold py-1.5">{r.label}</td>
                    {r.cells.map((k, i) => (
                      <td key={i} className="text-center">{k ? box(k, `${r.label} — ${t.columns[i]}`) : <span className="text-muted">—</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </fieldset>
        ))}
      </div>
      <fieldset className="border rounded-lg p-3">
        <legend className="px-1.5 filter-label">Other</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1.5">
          {PERM_OTHER.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm cursor-pointer" title={permDef(k)?.desc}>
              {box(k)}
              <span className="font-semibold">{permDef(k)?.label ?? k}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="border rounded-lg p-3">
        <legend className="px-1.5 filter-label">Notifications</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
          {PERM_ALERTS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm cursor-pointer" title={permDef(k)?.desc}>
              {box(k)}
              <span className="font-semibold">{permDef(k)?.label ?? k}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** The screens this account sees — ticked is shown. Admins and the owner
 *  follow it too; Users & Permissions itself stays the owner's whatever is
 *  ticked. Unticked screens leave the menus, and opening one by its address
 *  sends the person to the first screen they do see. */
function TabChecks({ hidden }: { hidden: Set<string> }) {
  const setAll = (el: HTMLElement, on: boolean) =>
    el.closest("fieldset")?.querySelectorAll<HTMLInputElement>('input[name="tabs"]').forEach((c) => (c.checked = on));
  return (
    <fieldset className="border rounded-lg p-3">
      <legend className="px-1.5 filter-label">Screens this account sees</legend>
      <input type="hidden" name="tabsForm" value="1" />
      <div className="flex flex-wrap items-center justify-end gap-2 mb-2 text-xs">
        <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => setAll(e.currentTarget, true)}>All</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => setAll(e.currentTarget, false)}>None</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
        {TAB_GROUPS.map((g) => (
          <div key={g}>
            <div className="filter-label mb-1">{g}</div>
            <div className="space-y-1">
              {TABS.filter((t) => t.group === g).map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" name="tabs" value={t.id} defaultChecked={!hidden.has(t.id)} />
                  <span className="font-semibold">{t.label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** The assistant is managed on its own page — access, caps and what it may
 *  do for this person. */
function AiNote({ ai, owner }: { ai: Row["ai"] | null; owner?: boolean }) {
  return (
    <p className="text-sm border rounded-lg px-3 py-2 flex flex-wrap items-center gap-2">
      <span className="font-bold">AI assistant:</span>
      <span className="text-muted">{owner ? "always on for the owner" : ai?.enabled ? `on${ai.monthlyUsd > 0 ? ` · ${usdText(ai.monthlyUsd)}/month` : ""}` : "off"}</span>
      <a href="/admin/ai#people" className="ms-auto underline text-brand-ink font-semibold">Manage on AI settings</a>
    </p>
  );
}

/** The admin switch. Ticking it ticks every access right in the form below
 *  (not the notifications) — an admin starts with everything and the owner
 *  unticks what this one does not do. */
function AdminCheck({ defaultChecked, label }: { defaultChecked?: boolean; label: string }) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer" title="Manages accounts, Settings and the admin pages. Everything else follows the ticks below.">
      <input
        type="checkbox"
        name="isAdmin"
        defaultChecked={defaultChecked}
        className="mt-0.5"
        onChange={(e) => {
          if (!e.currentTarget.checked) return;
          e.currentTarget.form?.querySelectorAll<HTMLInputElement>('input[name="perms"][data-access]').forEach((c) => (c.checked = true));
        }}
      />
      <span className="font-bold">{label}</span>
    </label>
  );
}

function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  function run(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn(fd);
      setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
      if (res.ok) after?.();
    });
  }
  return { pending, msg, run, setMsg };
}

function UserRow({ user, myId }: { user: Row; myId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const perms = useAction();
  const pw = useAction();
  const act = useAction();
  const del = useAction();
  const hidden = user.hiddenTabs ? parseHiddenTabs(user.hiddenTabs).size : 0;
  const me = user.id === myId;

  const toggleActive = () => {
    const fd = new FormData();
    fd.set("id", String(user.id));
    fd.set("active", user.active ? "false" : "true");
    act.run(setUserActive, fd, user.active ? "Deactivated." : "Reactivated.");
  };
  const remove = () => {
    if (!confirm(`Delete ${user.name} (${user.email}) permanently? They are signed out immediately; their settings, automations and assistant conversations go with the account, and it cannot be recovered. An account with chat messages, assistant changes, automation runs or tasks behind it is refused — deactivate it instead.`)) return;
    const fd = new FormData();
    fd.set("id", String(user.id));
    del.run(deleteUser, fd, "Account deleted.");
  };

  return (
    <>
      <tr className={user.active ? "" : "opacity-60"}>
        <td className="ps-4 md:ps-5">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar id={user.id} name={user.name} size={32} />
            <div className="min-w-0">
              <div className="font-semibold flex items-center gap-1.5">
                <span className="truncate">{user.name}</span>
                {me && <span className="pill pill-muted">you</span>}
              </div>
              <div className="text-xs text-muted ltr truncate">{user.email}</div>
            </div>
          </div>
          <Note msg={act.msg} className="mt-1" />
          <Note msg={del.msg} className="mt-1" />
        </td>
        <td>
          {user.isOwner ? <span className="pill pill-ok">Owner</span> : user.isAdmin ? <span className="pill pill-info">Admin</span> : <span className="pill pill-muted">Member</span>}
        </td>
        <td>{user.active ? <span className="pill pill-ok">Active</span> : <span className="pill pill-bad">Deactivated</span>}</td>
        <td className="text-sm tabnum" title="Screens switched off for this account">{hidden ? <span className="text-warn-fg font-semibold">{hidden} hidden</span> : <span className="text-muted">All</span>}</td>
        <td className="text-sm whitespace-nowrap" title={user.ai.enabled && !user.isOwner ? `Spent ${usdText(user.ai.spent)} this month` : undefined}>
          {user.isOwner ? (
            <span className="text-muted">Always</span>
          ) : user.ai.enabled ? (
            <span className="text-ok-fg font-semibold">On{user.ai.monthlyUsd > 0 ? <span className="text-muted font-normal"> · {usdText(user.ai.monthlyUsd)}/mo</span> : null}</span>
          ) : (
            <span className="text-muted">Off</span>
          )}
        </td>
        <td className="text-xs text-muted tabnum whitespace-nowrap">{formatDate(user.createdAt)}</td>
        <td className="text-end pe-4 md:pe-5">
          <div className="inline-flex items-center gap-1">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setExpanded(true)}>
              <ShieldCheck size={14} aria-hidden /> Permissions
            </button>
            <button type="button" className="icon-btn icon-btn-md" onClick={() => setShowReset(true)} title="Reset the password" aria-label={`Reset ${user.name}'s password`}>
              <KeyRound size={16} />
            </button>
            {!me && (
              <button
                type="button"
                className="icon-btn icon-btn-md"
                disabled={act.pending}
                onClick={toggleActive}
                title={user.active ? "Deactivate — they can no longer sign in" : "Reactivate"}
                aria-label={user.active ? `Deactivate ${user.name}` : `Reactivate ${user.name}`}
              >
                {user.active ? <UserX size={16} /> : <UserCheck size={16} />}
              </button>
            )}
            {!me && (
              <button type="button" className="icon-btn icon-btn-md icon-btn-danger" disabled={del.pending} onClick={remove} title="Delete the account" aria-label={`Delete ${user.name}`}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </td>
      </tr>

      {showReset && (
        <Modal title="Reset password" sub={`${user.name} · ${user.email}`} onClose={() => setShowReset(false)} busy={pw.pending} width="max-w-lg">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              pw.run(resetUserPassword, new FormData(e.currentTarget), "Password changed — their old sessions were signed out.", () => setShowReset(false));
            }}
          >
            <input type="hidden" name="id" value={user.id} />
            <input name="password" type="text" required minLength={8} placeholder="New password (min 8 chars)" className={`${inputCls} max-w-xs ltr`} />
            <button type="submit" disabled={pw.pending} className="btn btn-primary btn-sm">Save password</button>
            <Note msg={pw.msg} />
          </form>
        </Modal>
      )}

      {expanded && (
        <Modal title={`Permissions — ${user.name}`} sub={user.email} onClose={() => setExpanded(false)} busy={perms.pending} width="max-w-4xl">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              perms.run(updateUserPerms, new FormData(e.currentTarget), "Permissions saved.");
            }}
          >
            <input type="hidden" name="id" value={user.id} />
            {user.isOwner ? (
              <p className="explain text-sm text-muted">The owner holds every right — only the notifications below are yours to tick.</p>
            ) : (
              <AdminCheck defaultChecked={user.isAdmin} label="Admin" />
            )}
            <TabChecks hidden={parseHiddenTabs(user.hiddenTabs)} />
            <AiNote ai={user.ai} owner={user.isOwner} />
            {/* read as the server reads them: an old key shows as the one it became */}
            <PermChecks defaults={parsePerms(user.perms)} />
            <div className="flex items-center justify-end gap-3 pt-3 border-t">
              <Note msg={perms.msg} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(false)} disabled={perms.pending}>Close</button>
              <button type="submit" disabled={perms.pending} className="btn btn-primary btn-sm">Save permissions</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function UsersManager({ users, myId }: { users: Row[]; myId: number }) {
  const create = useAction();
  const [showCreate, setShowCreate] = useState(false);
  const active = users.filter((u) => u.active).length;

  return (
    <div className="space-y-4">
      <PageHead
        title="Users & Permissions"
        sub={`${active} active account${active === 1 ? "" : "s"}${users.length > active ? ` · ${users.length - active} deactivated` : ""}`}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} aria-hidden /> Add account
          </button>
        }
      />

      {showCreate && (
        <Modal title="Add account" onClose={() => setShowCreate(false)} busy={create.pending} width="max-w-4xl">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              create.run(createUser, new FormData(form), "Account created.", () => { form.reset(); setShowCreate(false); });
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block text-sm">
                <span className="field-label">Name</span>
                <input name="name" required className={inputCls} placeholder="e.g. Ahmed — Welding" />
              </label>
              <label className="block text-sm">
                <span className="field-label">Email (Gmail)</span>
                <input name="email" type="email" required className={`${inputCls} ltr`} placeholder="person@gmail.com" />
              </label>
              <label className="block text-sm">
                <span className="field-label">Password (min 8)</span>
                <input name="password" type="text" required minLength={8} className={`${inputCls} ltr`} placeholder="give them this password" />
              </label>
            </div>
            <AdminCheck label="Admin" />
            <TabChecks hidden={new Set()} />
            <AiNote ai={null} />
            <PermChecks defaults={new Set()} />
            <div className="flex items-center justify-end gap-3 pt-3 border-t">
              <Note msg={create.msg} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowCreate(false)} disabled={create.pending}>Cancel</button>
              <button type="submit" disabled={create.pending} className="btn btn-primary btn-sm">Create account</button>
            </div>
          </form>
        </Modal>
      )}

      <SectionCard
        icon={Users}
        title="Accounts"
        description="Who may sign in, their role, the screens they see and the assistant they have. Permissions open in their own window."
        padded={false}
      >
        <div className="overflow-x-auto border-t">
          <table className="table-cards w-full min-w-[880px]">
            <thead>
              <tr>
                <th className="text-start ps-4 md:ps-5">Person</th>
                <th className="text-start">Role</th>
                <th className="text-start">Status</th>
                <th className="text-start">Screens</th>
                <th className="text-start">AI assistant</th>
                <th className="text-start">Added</th>
                <th className="text-end pe-4 md:pe-5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => <UserRow key={u.id} user={u} myId={myId} />)}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
