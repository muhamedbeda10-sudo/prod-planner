"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { closeOdooReady, pollOdooReady } from "@/app/odoo/alertActions";
import { pruneSeen, unseenReady, type ReadyRow } from "@/lib/domain/odooAlerts";

// 🔔 Rows ready to close in Odoo — for the person subscribed (odoo.alerts).
// The ODOO tab carries the count and the browser tab's title starts with it;
// when a row he has not seen becomes ready, a popup lists them all and each
// closes from there. "Later" hides it until the next new row. Checked every
// minute and whenever the window comes back into view.

const POLL_MS = 60_000;
const seenKey = (userId: number) => `odoo.alerts.seen.${userId}`;

function readSeen(userId: number): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(seenKey(userId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter(Number.isInteger) : []);
  } catch {
    return new Set();
  }
}
function writeSeen(userId: number, ids: number[]) {
  try { localStorage.setItem(seenKey(userId), JSON.stringify(ids)); } catch {}
}

export interface OdooAlertsState {
  count: number;
  show: () => void;
  popup: React.ReactNode;
}

export function useOdooAlerts(enabled: boolean, initialCount: number, userId: number): OdooAlertsState {
  const router = useRouter();
  const pathname = usePathname();
  const [rows, setRows] = useState<ReadyRow[] | null>(null);
  const [canClose, setCanClose] = useState<{ TR: boolean; LV: boolean }>({ TR: false, LV: false });
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const count = rows ? rows.length : enabled ? initialCount : 0;

  const tick = useCallback(async () => {
    const r = await pollOdooReady().catch(() => null);
    if (!r?.ok || !r.rows) return;
    setRows(r.rows);
    if (r.canClose) setCanClose(r.canClose);
    const unseen = unseenReady(r.rows, readSeen(userId));
    if (unseen.length > 0) {
      setFresh(new Set(unseen));
      setOpen(true);
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(tick, 1500); // after the page has painted
    const every = setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(first); clearInterval(every); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, tick]);

  // the browser tab says it too — re-applied after every navigation, since
  // each page sets its own title
  useEffect(() => {
    if (!enabled) return;
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [enabled, count, pathname]);

  const later = useCallback(() => {
    if (rows) writeSeen(userId, pruneSeen([...readSeen(userId), ...rows.map((r) => r.id)], rows));
    setOpen(false);
  }, [rows, userId]);

  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const close = (ids: number[]) => {
    const fd = new FormData();
    for (const id of ids) fd.append("id", String(id));
    setErr("");
    start(async () => {
      const r = await closeOdooReady(fd);
      if (!r.ok) { setErr(r.error ?? "Could not close."); return; }
      setRows((cur) => (cur ? cur.filter((x) => !ids.includes(x.id)) : cur));
      if (pathname.startsWith("/odoo")) router.refresh();
    });
  };

  const list = rows ?? [];
  const popup = enabled && open && list.length > 0 ? (
    <ReadyPopup rows={list} fresh={fresh} canClose={canClose} pending={pending} err={err} onClose={close} onLater={later} />
  ) : null;
  return { count, show: () => { setOpen(true); if (!rows) void tick(); }, popup };
}

function ReadyPopup({ rows, fresh, canClose, pending, err, onClose, onLater }: {
  rows: ReadyRow[]; fresh: Set<number>; canClose: { TR: boolean; LV: boolean }; pending: boolean; err: string;
  onClose: (ids: number[]) => void; onLater: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onLater(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLater]);
  const closable = rows.filter((r) => canClose[r.line as "TR" | "LV"]);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-3" role="dialog" aria-modal="true" aria-label="Ready to close in Odoo">
      <button type="button" aria-label="Later" onClick={onLater} className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-3xl max-h-[88vh] overflow-y-auto bg-surface text-foreground border rounded-xl shadow-lg">
        <div className="flex items-start gap-3 p-4 border-b">
          <div className="text-2xl leading-none">🔔</div>
          <div className="min-w-0">
            <div className="font-extrabold text-base">{rows.length} ready to close in Odoo</div>
            <div className="text-xs text-muted mt-0.5">Odoo&apos;s MO is on {rows.length === 1 ? "this row" : "these rows"} and {rows.length === 1 ? "it is" : "they are"} still open — close {rows.length === 1 ? "it" : "them"} in Odoo, then here.</div>
          </div>
          <button type="button" onClick={onLater} aria-label="Close" className="ms-auto btn btn-sm btn-ghost">✕</button>
        </div>
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className={`flex items-center gap-3 px-4 py-2.5 text-sm ${fresh.has(r.id) ? "bg-warn-bg/40" : ""}`}>
              <div className="flex flex-1 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`pill ${r.line === "LV" ? "pill-muted" : "pill-ok"} text-[10px]`}>{r.line}</span>
              <span className="tabnum text-xs text-muted ltr">{r.dateISO}</span>
              <b className="ltr tabnum">{r.odooMo}</b>
              <span className="text-muted">{r.product}</span>
              <span className="text-xs text-muted ltr truncate max-w-[14rem]" title={r.fgCode}>{r.fgCode}</span>
              {r.soi && <span className="text-xs text-muted ltr">{r.soi}</span>}
              <span className="tabnum font-bold">× {r.qty}</span>
              {fresh.has(r.id) && <span className="pill pill-warn text-[10px]">new</span>}
              </div>
              <button
                type="button" className="shrink-0 btn btn-sm btn-primary" disabled={pending || !canClose[r.line as "TR" | "LV"]} onClick={() => onClose([r.id])}
                title={canClose[r.line as "TR" | "LV"] ? "Closed in Odoo — mark it Done" : "You cannot record on this line's ODOO tab"}
              >
                ✓ Done
              </button>
            </li>
          ))}
        </ul>
        {err && <p className="px-4 pt-2 text-sm font-semibold text-bad-fg">{err}</p>}
        <div className="flex flex-wrap items-center gap-2 p-4 border-t">
          {closable.length > 1 && (
            <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => onClose(closable.map((r) => r.id))}>
              ✓ All {closable.length} done
            </button>
          )}
          <Link href="/odoo?day=all" className="btn btn-sm btn-secondary" onClick={onLater}>Open ODOO →</Link>
          <button type="button" className="ms-auto btn btn-sm btn-ghost" onClick={onLater}>Later</button>
        </div>
      </div>
    </div>
  );
}
