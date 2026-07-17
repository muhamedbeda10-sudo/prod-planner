"use client";

import { useState, useTransition } from "react";
import { PERMISSIONS } from "@/lib/domain/permissions";
import { createUser, updateUserPerms, setUserActive, resetUserPassword } from "./actions";

interface Row {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  perms: string;
  active: boolean;
  createdAt: Date;
}

const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";
const btnCls = "btn btn-primary btn-sm";

function PermChecks({ defaults, disabled }: { defaults: Set<string>; disabled?: boolean }) {
  return (
    <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
      {PERMISSIONS.map((p) => (
        <label key={p.key} className="flex items-start gap-2 text-sm cursor-pointer" title={p.desc}>
          <input
            type="checkbox"
            name="perms"
            value={p.key}
            defaultChecked={defaults.has(p.key)}
            disabled={disabled}
            className="mt-0.5 accent-[var(--brand,#1b7a43)]"
          />
          <span>
            <span className="font-semibold">{p.label}</span>
            <span className="block text-xs text-muted">{p.desc}</span>
          </span>
        </label>
      ))}
    </div>
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

  return (
    <div className={`border rounded-xl p-4 ${user.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="font-bold flex items-center gap-2">
            {user.name}
            {user.isAdmin && <span className="pill pill-ok">admin</span>}
            {!user.active && <span className="pill pill-bad">deactivated</span>}
            {user.id === myId && <span className="pill pill-muted">you</span>}
          </div>
          <div className="text-sm text-muted ltr">{user.email}</div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={btnCls} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Close" : "Permissions"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowReset((v) => !v)}
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
        </div>
      </div>
      <Msg msg={act.msg} />

      {showReset && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
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
      )}

      {expanded && (
        <form
          className="mt-3 border-t pt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            perms.run(updateUserPerms, new FormData(e.currentTarget), "Permissions saved.");
          }}
        >
          <input type="hidden" name="id" value={user.id} />
          <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
            <input type="checkbox" name="isAdmin" defaultChecked={user.isAdmin} className="accent-[var(--brand,#1b7a43)]" />
            Admin — full access to everything, including this page
          </label>
          <PermChecks defaults={new Set(user.perms.split(",").map((s) => s.trim()))} />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={perms.pending} className={btnCls}>Save permissions</button>
            <Msg msg={perms.msg} />
          </div>
        </form>
      )}
    </div>
  );
}

export function UsersManager({ users, myId }: { users: Row[]; myId: number }) {
  const create = useAction();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Every active account can <b>view</b> all screens. Permissions control who can <b>edit</b> what.
        </p>
        <button type="button" className={btnCls} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Close" : "+ Add account"}
        </button>
      </div>

      {showCreate && (
        <form
          className="border-2 border-dashed rounded-xl p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            create.run(createUser, new FormData(form), "Account created.", () => form.reset());
          }}
        >
          <div className="grid sm:grid-cols-3 gap-3">
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
          <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
            <input type="checkbox" name="isAdmin" className="accent-[var(--brand,#1b7a43)]" />
            Admin — full access to everything
          </label>
          <PermChecks defaults={new Set()} />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={create.pending} className={btnCls}>Create account</button>
            <Msg msg={create.msg} />
          </div>
        </form>
      )}

      <div className="space-y-3">
        {users.map((u) => (
          <EditUserCard key={u.id} user={u} myId={myId} />
        ))}
      </div>
    </div>
  );
}
