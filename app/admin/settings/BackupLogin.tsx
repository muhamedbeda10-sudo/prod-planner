"use client";

import { useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";
import { makeBackupLogin, turnOffBackup } from "./backupActions";

// The nightly backup's own read-only login, on the owner's Settings: make its
// password — the address with it is shown here once, to paste into GitHub —
// or turn it off. Wordy on purpose: it is done once in a long while, and the
// person doing it should not have to look up where the address goes.

interface Props {
  exists: boolean;
  on: boolean;
  /** "12 Oct 10:58 by Beda" — when the password was last made or the login turned off. */
  changed: string | null;
  links: { secrets: string; workflow: string } | null;
}

interface Made {
  url: string;
  pooler: boolean;
  tested: string;
}

export function BackupLogin({ exists, on, changed, links }: Props) {
  const [pending, startTransition] = useTransition();
  const [made, setMade] = useState<Made | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function make() {
    if (
      on &&
      !window.confirm(
        "Make a new password for the backup?\n\n" +
          "The old one stops working at once: the nightly backup fails until GitHub has the new address.",
      )
    ) {
      return;
    }
    setMsg(null);
    setMade(null);
    startTransition(async () => {
      const r = await makeBackupLogin();
      if (r.ok) setMade({ url: r.url, pooler: r.pooler, tested: r.tested });
      else setMsg({ ok: false, text: r.error });
    });
  }

  function turnOff() {
    if (
      !window.confirm(
        "Turn the backup's login off?\n\n" +
          "Its password stops working at once, so the nightly backup fails until you make a new one. The backups already kept are not touched.",
      )
    ) {
      return;
    }
    setMsg(null);
    setMade(null);
    startTransition(async () => {
      const r = await turnOffBackup();
      setMsg(r.ok ? { ok: true, text: "The backup's login is off." } : { ok: false, text: r.error });
    });
  }

  function copy(url: string) {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const status = !exists ? "NOT SET UP" : on ? "ON" : "OFF";

  return (
    <div className="border rounded-xl p-4 sm:p-5 space-y-3 mt-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-[200px] space-y-1">
          <h2 className="text-sm font-extrabold flex items-center gap-2">
            🗄 Database backup — its own login
            <span className={`pill ${on ? "pill-ok" : "pill-muted"}`}>{status}</span>
          </h2>
          <p className="text-sm text-muted">
            Every night GitHub takes a sealed copy of the database (Actions → Database backup). It logs in as{" "}
            <code className="text-xs">backup_reader</code>: it can read every table and change nothing.
          </p>
          <p className="text-xs text-muted">
            {!exists
              ? "The database update that makes this login has not run yet."
              : changed
                ? `${on ? "Password made" : "Turned off"} ${changed}.`
                : "No password yet."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={make}
            disabled={pending || !exists}
            className="rounded-md px-4 py-2 text-sm font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
          >
            {pending ? "Working…" : on ? "Make a new password" : "Make the password"}
          </button>
          {on && (
            <button type="button" onClick={turnOff} disabled={pending} className="btn btn-ghost btn-sm text-bad-fg">
              Turn off
            </button>
          )}
        </div>
      </div>

      {msg && <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>}

      {made && (
        <div className="rounded-lg border bg-surface-2 p-3 space-y-3">
          <p className="text-sm font-bold">The backup&apos;s address — copy it now: it is shown only this once.</p>
          <div className="flex items-start gap-2">
            <code dir="ltr" className="flex-1 block text-xs break-all select-all rounded border bg-surface p-2">
              {made.url}
            </code>
            <button type="button" onClick={() => copy(made.url)} className="btn btn-ghost btn-sm shrink-0" aria-label="Copy the address">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {made.tested === "ok" ? (
            <p className="text-sm text-ok-fg font-semibold">✓ It logged in with this address just now.</p>
          ) : (
            <p className="text-sm text-bad-fg">
              It could not log in with this address just now ({made.tested}). Supabase&apos;s pooler can take a minute to take a new
              password: put it in GitHub and run the backup once; if that fails too, make a new password.
            </p>
          )}
          {!made.pooler && (
            <p className="text-sm text-bad-fg">
              This is not Supabase&apos;s Session pooler address, and GitHub can reach only that one. In Supabase → Connect → Direct →
              Session pooler, take its host (…pooler.supabase.com) and put it in place of this one&apos;s, port 5432.
            </p>
          )}
          <ol className="text-sm list-decimal pl-5 space-y-1">
            <li>
              On GitHub, open{" "}
              {links ? (
                <a href={links.secrets} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                  Settings → Secrets and variables → Actions
                </a>
              ) : (
                <b>Settings → Secrets and variables → Actions</b>
              )}{" "}
              and put this address in the secret <code className="text-xs">BACKUP_DATABASE_URL</code> — New repository secret, or the
              pencil to update it.
            </li>
            <li>
              The same page, once: <code className="text-xs">BACKUP_PASSPHRASE</code> — a long passphrase (16 characters or more) that
              locks each backup. Keep it somewhere besides GitHub: a backup cannot be opened without it.
            </li>
            <li>
              Run the backup once:{" "}
              {links ? (
                <a href={links.workflow} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                  Actions → Database backup
                </a>
              ) : (
                <b>Actions → Database backup</b>
              )}{" "}
              → Run workflow. It should turn green in a few minutes.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
