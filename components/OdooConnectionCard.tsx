"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Note, SettingRow, Switch } from "@/components/primitives";
import { formatDateTime } from "@/lib/domain/format";
import { nextOdooSlotLabel, summaryText } from "@/lib/domain/odooSync";
import type { OdooSyncStatus } from "@/lib/server/odooSync";
import {
  odooSyncStatusNow, removeOdooConnection, saveOdooConnection, setOdooSyncEnabled, syncOdooNow,
} from "@/app/admin/settings/odooActions";

const RUN_TONE: Record<string, BadgeTone> = { ok: "success", partial: "warning", failed: "danger", running: "info" };
const RUN_LABEL: Record<string, string> = { ok: "OK", partial: "Partly done", failed: "Failed", running: "Running…" };

/** Admin → Settings: the Odoo connection (the owner's), its schedule and the
 *  last run, with "Sync now" for any admin. */
export function OdooConnectionCard({ initial, isOwner }: { initial: OdooSyncStatus; isOwner: boolean }) {
  const [st, setSt] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const [form, setForm] = useState({ url: initial.url || "https://atcodoo.odoo.com", db: initial.db, login: initial.login, apiKey: "" });
  const running = st.last?.status === "running";

  // while a run is going, the card follows it
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      odooSyncStatusNow().then((r) => { if (r.ok && r.status) setSt(r.status); }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [running]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) => {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Saved.") : (r.error ?? "Could not save.") });
      if (r.ok) {
        after?.();
        const s = await odooSyncStatusNow();
        if (s.ok && s.status) setSt(s.status);
        router.refresh();
      }
    });
  };

  const save = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.set(k, v);
    act(() => saveOdooConnection(fd), () => setForm((f) => ({ ...f, apiKey: "" })));
  };

  const last = st.last;
  return (
    <div className="space-y-3">
      <SettingRow
        title={st.connected ? "Connected" : "Not connected"}
        hint={st.connected
          ? `Reads Odoo at 09:00 and 13:00 Riyadh time, Sunday to Thursday${st.enabled ? ` — next ${nextOdooSlotLabel(new Date())}` : " — the scheduled runs are off"}. The app only reads Odoo; it never changes anything there.`
          : "The owner connects the app with an Odoo user's API key. Use a user that can only read."}
      >
        <button type="button" className="btn btn-sm btn-primary" disabled={!st.connected || pending || running} onClick={() => act(syncOdooNow, () => setSt((s) => ({ ...s, last: { status: "running", trigger: "manual", startedAtISO: new Date().toISOString(), finishedAtISO: null, summary: null, error: null } })))}>
          <RefreshCw size={14} aria-hidden className={running ? "motion-safe:animate-spin" : ""} /> {running ? "Syncing…" : "Sync now"}
        </button>
      </SettingRow>

      {last && (
        <div className="rounded-md border px-3 py-2 text-[length:var(--fs-body)] space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Last run</span>
            <Badge tone={RUN_TONE[last.status] ?? "neutral"}>{RUN_LABEL[last.status] ?? last.status}</Badge>
            <span className="text-muted tabnum">{formatDateTime(last.startedAtISO)}</span>
            <span className="text-muted">{last.trigger === "manual" ? "· started by hand" : "· on schedule"}</span>
            {last.summary && <span className="text-muted tabnum">· {Math.round(last.summary.ms / 1000)} s</span>}
          </div>
          {last.summary && <p className="text-muted">{summaryText(last.summary)}</p>}
          {last.summary?.issues.map((i) => <p key={i} className="text-warn-fg">{i}</p>)}
          {last.error && <p className="text-bad-fg font-semibold">{last.error}</p>}
          {st.lastOkAtISO && last.status === "failed" && <p className="text-muted">Last good run: {formatDateTime(st.lastOkAtISO)}</p>}
        </div>
      )}

      {isOwner && (
        <>
          <SettingRow title="Scheduled runs" hint="Off: only “Sync now” reads Odoo.">
            <Switch on={st.enabled} disabled={pending} label="Scheduled Odoo runs" onChange={(on) => { const fd = new FormData(); fd.set("on", String(on)); act(() => setOdooSyncEnabled(fd), () => setSt((s) => ({ ...s, enabled: on }))); }} />
          </SettingRow>
          <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className="flex flex-col gap-1 text-xs font-semibold">Odoo address
              <input className="ctl ltr" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://atcodoo.odoo.com" autoComplete="off" disabled={pending} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold">Database
              <input className="ctl ltr" value={form.db} onChange={(e) => setForm({ ...form, db: e.target.value })} autoComplete="off" disabled={pending} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold">Login (the key&apos;s Odoo user)
              <input className="ctl ltr" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} autoComplete="off" disabled={pending} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold">API key
              <input
                className="ctl ltr" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="new-password" disabled={pending}
                placeholder={st.keyHint ? `Saved — ends in ${st.keyHint}; leave empty to keep it` : "From Odoo: My Profile → Account Security → New API Key"}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <button type="submit" className="btn btn-sm btn-secondary" disabled={pending}>{pending ? "Trying…" : "Test and save"}</button>
              {st.keyHint && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => act(removeOdooConnection)}>Remove the key</button>
              )}
              {!st.keyReadable && <span className="text-xs text-bad-fg font-semibold">The saved key cannot be read any more — enter it again.</span>}
            </div>
          </form>
        </>
      )}
      <Note msg={msg} />
    </div>
  );
}
