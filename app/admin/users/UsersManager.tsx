"use client";

import { useState, useTransition } from "react";
import { PERM_ALERTS, PERM_OTHER, PERM_TABLES, parsePerms, permDef } from "@/lib/domain/permissions";
import { TABS, TAB_GROUPS, parseHiddenTabs } from "@/lib/domain/tabs";
import { createUser, updateUserPerms, setUserActive, resetUserPassword, deleteUser } from "./actions";
import { Modal } from "@/components/Modal";
import { usdText } from "@/lib/domain/ai";

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
const btnCls = "btn btn-primary btn-sm";

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
      className="w-4 h-4 accent-[var(--brand,#1b7a43)]"
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
            <legend className="px-1.5 text-xs font-extrabold uppercase tracking-wide text-muted">{t.title}</legend>
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
        <legend className="px-1.5 text-xs font-extrabold uppercase tracking-wide text-muted">Other</legend>
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
        <legend className="px-1.5 text-xs font-extrabold uppercase tracking-wide text-muted">Notifications</legend>
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
      <legend className="px-1.5 text-xs font-extrabold uppercase tracking-wide text-muted">Screens this account sees</legend>
      <input type="hidden" name="tabsForm" value="1" />
      <div className="flex flex-wrap items-center justify-end gap-2 mb-2 text-xs">
        <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => setAll(e.currentTarget, true)}>All</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => setAll(e.currentTarget, false)}>None</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
        {TAB_GROUPS.map((g) => (
          <div key={g}>
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">{g}</div>
            <div className="space-y-1">
              {TABS.filter((t) => t.group === g).map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" name="tabs" value={t.id} defaultChecked={!hidden.has(t.id)} className="accent-[var(--brand,#1b7a43)]" />
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
      <a href="/admin/ai#people" className="ms-auto underline text-brand font-semibold">Manage on AI settings</a>
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
        className="mt-0.5 accent-[var(--brand,#1b7a43)]"
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

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

function EditUserCard({ user, myId }: { user: Row; myId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const perms = useAction();
  const pw = useAction();
  const act = useAction();
  const del = useAction();

  return (
    <div className={`border rounded-xl p-4 ${user.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="font-bold flex items-center gap-2">
            {user.name}
            {user.isOwner ? <span className="pill pill-ok">owner</span> : user.isAdmin && <span className="pill pill-ok">admin</span>}
            {!user.active && <span className="pill pill-bad">deactivated</span>}
            {user.id === myId && <span className="pill pill-muted">you</span>}
          </div>
          <div className="text-sm text-muted ltr">{user.email}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {user.hiddenTabs && <span className="pill pill-muted" title="Screens switched off for this account">{parseHiddenTabs(user.hiddenTabs).size} screen(s) hidden</span>}
          {user.ai.enabled && !user.isOwner && (
            <span className="pill pill-info" title={`AI assistant — spent ${usdText(user.ai.spent)} this month`}>
              AI{user.ai.monthlyUsd > 0 ? ` · ${usdText(user.ai.monthlyUsd)}/mo` : ""}
            </span>
          )}
          <button type="button" className={btnCls} onClick={() => setExpanded(true)}>
            Permissions
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowReset(true)}
          >
            Reset password
          </button>
          {user.id !== myId && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act.run(setUserActive, new FormData(e.currentTarget), user.active ? "Deactivated." : "Reactivated.");
              }}
            >
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="active" value={user.active ? "false" : "true"} />
              <button
                type="submit"
                disabled={act.pending}
                className={user.active ? "btn btn-secondary btn-sm text-bad-fg" : btnCls}
              >
                {user.active ? "Deactivate" : "Reactivate"}
              </button>
            </form>
          )}
          {user.id !== myId && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!confirm(`Delete ${user.name} (${user.email}) permanently? They are signed out immediately and the account cannot be recovered.`)) return;
                del.run(deleteUser, new FormData(e.currentTarget), "Account deleted.");
              }}
            >
              <input type="hidden" name="id" value={user.id} />
              <button type="submit" disabled={del.pending} className="btn btn-danger btn-sm">
                🗑 Delete
              </button>
            </form>
          )}
        </div>
      </div>
      <Msg msg={act.msg} />
      <Msg msg={del.msg} />

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
          <button type="submit" disabled={pw.pending} className={btnCls}>Save password</button>
          <Msg msg={pw.msg} />
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
            <p className="text-sm text-muted">The owner holds every right — only the notifications below are yours to tick.</p>
          ) : (
            <AdminCheck defaultChecked={user.isAdmin} label="Admin" />
          )}
          <TabChecks hidden={parseHiddenTabs(user.hiddenTabs)} />
          <AiNote ai={user.ai} owner={user.isOwner} />
          {/* read as the server reads them: an old key shows as the one it became */}
          <PermChecks defaults={parsePerms(user.perms)} />
          <div className="flex items-center justify-end gap-3 pt-3 border-t">
            <Msg msg={perms.msg} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(false)} disabled={perms.pending}>Close</button>
            <button type="submit" disabled={perms.pending} className={btnCls}>Save permissions</button>
          </div>
        </form>
        </Modal>
      )}
    </div>
  );
}

export function UsersManager({ users, myId }: { users: Row[]; myId: number }) {
  const create = useAction();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <button type="button" className={btnCls} onClick={() => setShowCreate(true)}>
          + Add account
        </button>
      </div>

      {showCreate && (
        <Modal title="+ Add account" onClose={() => setShowCreate(false)} busy={create.pending} width="max-w-4xl">
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
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Name</span>
              <input name="name" required className={inputCls} placeholder="e.g. Ahmed — Welding" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Email (Gmail)</span>
              <input name="email" type="email" required className={`${inputCls} ltr`} placeholder="person@gmail.com" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Password (min 8)</span>
              <input name="password" type="text" required minLength={8} className={`${inputCls} ltr`} placeholder="give them this password" />
            </label>
          </div>
          <AdminCheck label="Admin" />
          <TabChecks hidden={new Set()} />
          <AiNote ai={null} />
          <PermChecks defaults={new Set()} />
          <div className="flex items-center justify-end gap-3 pt-3 border-t">
            <Msg msg={create.msg} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowCreate(false)} disabled={create.pending}>Cancel</button>
            <button type="submit" disabled={create.pending} className={btnCls}>Create account</button>
          </div>
        </form>
        </Modal>
      )}

      <div className="space-y-3">
        {users.map((u) => (
          <EditUserCard key={u.id} user={u} myId={myId} />
        ))}
      </div>
    </div>
  );
}
