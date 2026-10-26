"use client";

import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { armChime, playChime } from "@/lib/chime";
import { appInBackground, onNotifyClick, systemNotify } from "@/lib/sysNotify";
import { startPoll } from "@/lib/poll";
import { closeOdooReady, fillOdooMo, odooRowMaterial, pollOdooAlerts } from "@/app/odoo/alertActions";
import { OdooMaterialPopup } from "@/components/OdooMaterialPopup";
import { ODOO_CHANGED_EVENT, alertKey, pruneSeen, unseenKeys, type ReadyRow } from "@/lib/domain/odooAlerts";

// 🔔 The ODOO alerts, for whoever is subscribed:
// - "needs an MO" (odoo.needMo): a row landed on the log without Odoo's MO —
//   the popup has a box to type it in;
// - "ready to close" (odoo.alerts): a row has the MO and is still open — the
//   popup closes it.
// The ODOO tab carries the count and the browser tab's title starts with it;
// when a row not seen yet appears, the popup opens with both lists. "Later"
// hides it until the next new row. Checked every minute while the window is
// in front, every five minutes while it is out of sight (each check is a
// server call and two table reads, from every open page), when it comes back
// into view, and right after a change saved on the ODOO page. A new row plays
// the alert chime once (muted with the chat sound) and, with the app out of
// sight, raises a system notification.

const PACE = { visibleMs: 60_000, hiddenMs: 5 * 60_000 };
const seenKey = (userId: number) => `odoo.alerts.seen2.${userId}`;

function readSeen(userId: number): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(seenKey(userId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function writeSeen(userId: number, keys: string[]) {
  try { localStorage.setItem(seenKey(userId), JSON.stringify(keys)); } catch {}
}

const liveKeys = (close: ReadyRow[], mo: ReadyRow[]) => [
  ...close.map((r) => alertKey("close", r.id)),
  ...mo.map((r) => alertKey("mo", r.id)),
];

export interface OdooAlertsState {
  count: number;
  show: () => void;
  popup: React.ReactNode;
}

export function useOdooAlerts(enabled: boolean, initialCount: number, userId: number): OdooAlertsState {
  const router = useRouter();
  const pathname = usePathname();
  const [close, setClose] = useState<ReadyRow[] | null>(null);
  const [mo, setMo] = useState<ReadyRow[]>([]);
  const [canEdit, setCanEdit] = useState<{ TR: boolean; LV: boolean }>({ TR: false, LV: false });
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const loaded = close !== null;
  const count = loaded ? close.length + mo.length : enabled ? initialCount : 0;
  const chimed = useRef<Set<string>>(new Set()); // keys already rung for on this page

  // `ownChange`: the check that follows a change saved on the ODOO page in
  // this tab — the count follows, but a row this person just touched is
  // their own doing, not news, so it is marked seen instead of popping up
  const tick = useCallback(async (ownChange = false) => {
    const r = await pollOdooAlerts().catch(() => null);
    if (!r?.ok) return;
    const c = r.close ?? [];
    const m = r.mo ?? [];
    setClose(c);
    setMo(m);
    if (r.canEdit) setCanEdit(r.canEdit);
    const live = liveKeys(c, m);
    if (ownChange) {
      writeSeen(userId, pruneSeen([...readSeen(userId), ...live], live));
      for (const k of live) chimed.current.add(k);
      return;
    }
    const unseen = unseenKeys(live, readSeen(userId));
    if (unseen.length === 0) return;
    setFresh(new Set(unseen));
    setOpen(true);
    const newOnes = unseen.filter((k) => !chimed.current.has(k));
    for (const k of unseen) chimed.current.add(k);
    if (newOnes.length === 0) return;
    playChime("alert");
    if (!appInBackground()) return;
    const newMo = m.filter((x) => newOnes.includes(alertKey("mo", x.id)));
    const newClose = c.filter((x) => newOnes.includes(alertKey("close", x.id)));
    const lead = newMo[0] ?? newClose[0];
    const title = [m.length ? `${m.length} need an MO` : "", c.length ? `${c.length} ready to close` : ""].filter(Boolean).join(" · ") + " — Odoo";
    void systemNotify({
      title,
      body: lead
        ? `${lead.odooMo || "No MO yet"} · ${lead.product} × ${lead.qty}${lead.soi ? ` · ${lead.soi}` : ""}${newOnes.length > 1 ? ` and ${newOnes.length - 1} more` : ""}`
        : "Open the app to see them",
      tag: `odoo-${newOnes.sort().at(-1)}`,
      url: "/odoo?day=all",
      action: { kind: "odoo" },
    });
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    armChime();
    const stop = startPoll(() => tick(), PACE, 1500); // the first after the page has painted
    const onChanged = () => void tick(true);
    window.addEventListener(ODOO_CHANGED_EVENT, onChanged);
    return () => {
      stop();
      window.removeEventListener(ODOO_CHANGED_EVENT, onChanged);
    };
  }, [enabled, tick]);

  // a click on the system notification opens the popup
  useEffect(() => {
    if (!enabled) return;
    return onNotifyClick((a) => a.kind === "odoo" && setOpen(true));
  }, [enabled]);

  // the browser tab says it too — re-applied after every navigation, since
  // each page sets its own title
  useEffect(() => {
    if (!enabled) return;
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [enabled, count, pathname]);

  const later = useCallback(() => {
    if (close) {
      const live = liveKeys(close, mo);
      writeSeen(userId, pruneSeen([...readSeen(userId), ...live], live));
    }
    setOpen(false);
  }, [close, mo, userId]);

  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const afterSave = () => {
    if (pathname.startsWith("/odoo")) router.refresh();
    void tick(true); // the row moves list (MO typed → ready to close) — no popup for one's own step
  };
  const closeRows = (ids: number[]) => {
    const fd = new FormData();
    for (const id of ids) fd.append("id", String(id));
    setErr("");
    start(async () => {
      const r = await closeOdooReady(fd);
      if (!r.ok) { setErr(r.error ?? "Could not close."); return; }
      setClose((cur) => (cur ? cur.filter((x) => !ids.includes(x.id)) : cur));
      afterSave();
    });
  };
  const saveMo = (id: number, value: string) => {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("odooMo", value);
    setErr("");
    start(async () => {
      const r = await fillOdooMo(fd);
      if (!r.ok) { setErr(r.error ?? "Could not save the MO."); return; }
      setMo((cur) => cur.filter((x) => x.id !== id));
      afterSave();
    });
  };

  // a row clicked in the popup opens its material on top — the same popup
  // the ODOO tab opens, fetched for that one row
  type Material = NonNullable<Awaited<ReturnType<typeof odooRowMaterial>>["data"]>;
  const [material, setMaterial] = useState<Material | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const openMaterial = (id: number) => {
    setErr("");
    setOpening(id);
    odooRowMaterial(id)
      .then((r) => (r.ok && r.data ? setMaterial(r.data) : setErr(r.error ?? "Could not open the material.")))
      .catch(() => setErr("Could not open the material."))
      .finally(() => setOpening(null));
  };

  const popup = enabled && open && count > 0 && loaded ? (
    <>
      <ReadyPopup
        close={close} mo={mo} fresh={fresh} canEdit={canEdit} pending={pending} err={err}
        onClose={closeRows} onSaveMo={saveMo} onLater={later}
        onOpen={openMaterial} opening={opening} covered={material !== null}
      />
      {material && (
        <OdooMaterialPopup e={material.entry} nesting={material.nesting} needCtx={material.needCtx} onClose={() => setMaterial(null)} />
      )}
    </>
  ) : null;
  return { count, show: () => { setOpen(true); if (!loaded) void tick(); }, popup };
}

const SOURCE_LABEL: Record<string, string> = { painting: "from Painting", shotblast: "from Shot Blast" };

/** Odoo's MO with a button that copies it, to paste into Odoo. */
function CopyMo({ mo }: { mo: string }) {
  const [done, setDone] = useState(false);
  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(mo);
    } catch {
      // an older browser or an insecure page: select it for Ctrl+C instead
      const el = document.createElement("textarea");
      el.value = mo; document.body.appendChild(el); el.select();
      try { document.execCommand("copy"); } finally { el.remove(); }
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  }
  return (
    <span className="inline-flex items-center gap-1">
      {/* a click on the MO selects it for copying — it does not open the material */}
      <b className="ltr tabnum text-base select-all cursor-text" onClick={(e) => e.stopPropagation()}>{mo}</b>
      <button type="button" onClick={copy} className="btn btn-sm btn-ghost !px-1.5 !py-0.5 text-xs" title="Copy the MO" aria-label={`Copy ${mo}`}>
        {done ? "✓ copied" : "📋"}
      </button>
    </span>
  );
}

function RowFacts({ r, isNew, onOpen, opening }: { r: ReadyRow; isNew: boolean; onOpen: (id: number) => void; opening: boolean }) {
  // the facts open the material behind the row — unless text is being
  // selected in them (the MO, to copy it)
  function open() {
    if (opening) return;
    if ((window.getSelection()?.toString() ?? "").trim()) return;
    onOpen(r.id);
  }
  // not a button itself — the MO inside it is selectable and has its own
  // copy button; the "📦 material" link is the keyboard's way in
  return (
    <div
      onClick={open}
      title="Click for the material behind this row"
      className={`flex flex-1 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md -mx-1.5 px-1.5 py-1 text-left hover:bg-surface-2 select-text ${opening ? "cursor-wait" : "cursor-pointer"}`}
    >
      <span className={`pill ${r.line === "LV" ? "pill-muted" : "pill-ok"} text-[10px]`}>{r.line}</span>
      <span className="tabnum text-xs text-muted ltr">{formatDate(r.dateISO)}</span>
      {r.odooMo && <CopyMo mo={r.odooMo} />}
      <span className={r.odooMo ? "text-muted" : "font-bold"}>{r.product}</span>
      {r.bom && <span className="text-xs text-muted ltr truncate max-w-[18rem]" title={`BOM ${r.bom}`}>{r.bom}</span>}
      {r.soi && <span className="text-xs text-muted ltr">{r.soi}</span>}
      <span className="tabnum font-bold">× {r.qty}</span>
      {SOURCE_LABEL[r.source] && <span className="pill pill-muted text-[10px]">{SOURCE_LABEL[r.source]}</span>}
      {isNew && <span className="pill pill-warn text-[10px]">new</span>}
      <button type="button" disabled={opening} onClick={(e) => { e.stopPropagation(); onOpen(r.id); }} className="text-xs text-brand-ink font-semibold hover:underline">
        {opening ? "opening…" : "📦 material"}
      </button>
    </div>
  );
}

function MoInput({ r, disabled, onSave }: { r: ReadyRow; disabled: boolean; onSave: (id: number, v: string) => void }) {
  const [v, setV] = useState("");
  const save = () => v.trim() && onSave(r.id, v.trim());
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        disabled={disabled}
        placeholder="SF01/MO/…"
        aria-label={`Odoo MO for ${r.product} × ${r.qty}`}
        className="w-40 rounded-md border bg-surface px-2 py-1 text-sm font-semibold uppercase ltr"
      />
      <button type="button" className="btn btn-sm btn-primary" disabled={disabled || !v.trim()} onClick={save}>Save</button>
    </div>
  );
}

function ReadyPopup({ close, mo, fresh, canEdit, pending, err, onClose, onSaveMo, onLater, onOpen, opening, covered }: {
  close: ReadyRow[]; mo: ReadyRow[]; fresh: Set<string>; canEdit: { TR: boolean; LV: boolean }; pending: boolean; err: string;
  onClose: (ids: number[]) => void; onSaveMo: (id: number, v: string) => void; onLater: () => void;
  onOpen: (id: number) => void; opening: number | null;
  /** The material popup is open on top — Escape is its, not this one's. */
  covered: boolean;
}) {
  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onLater(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLater, covered]);
  const can = (r: ReadyRow) => canEdit[r.line as "TR" | "LV"];
  const closable = close.filter(can);
  const title = [mo.length ? `${mo.length} need${mo.length === 1 ? "s" : ""} an MO` : "", close.length ? `${close.length} ready to close` : ""]
    .filter(Boolean).join(" · ");
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-3" role="dialog" aria-modal="true" aria-label="Odoo alerts">
      <button type="button" aria-label="Later" onClick={onLater} className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto bg-surface text-foreground border rounded-xl shadow-lg">
        <div className="flex items-start gap-3 p-4 border-b">
          <div className="text-2xl leading-none">🔔</div>
          <div className="min-w-0">
            <div className="font-extrabold text-lg">{title} — Odoo</div>
            <div className="text-xs text-muted mt-0.5">
              {mo.length > 0 && "Type Odoo's MO number on what was recorded. "}
              {close.length > 0 && "Close the ready ones in Odoo, then here."}
            </div>
          </div>
          <button type="button" onClick={onLater} aria-label="Close" className="ms-auto btn btn-sm btn-ghost">✕</button>
        </div>

        {mo.length > 0 && (
          <section>
            <h3 className="px-4 pt-3 pb-1 text-xs font-extrabold uppercase tracking-wide text-muted">Needs an MO · {mo.length}</h3>
            <ul className="divide-y">
              {mo.map((r) => (
                <li key={`mo-${r.id}`} className={`flex flex-wrap items-center gap-3 px-5 py-3 text-base ${fresh.has(alertKey("mo", r.id)) ? "bg-warn-bg/40" : ""}`}>
                  <RowFacts r={r} isNew={fresh.has(alertKey("mo", r.id))} onOpen={onOpen} opening={opening === r.id} />
                  {can(r) ? <MoInput r={r} disabled={pending} onSave={onSaveMo} /> : <span className="text-xs text-muted">No permission on this line</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {close.length > 0 && (
          <section className={mo.length > 0 ? "border-t" : ""}>
            <h3 className="px-4 pt-3 pb-1 text-xs font-extrabold uppercase tracking-wide text-muted">Ready to close · {close.length}</h3>
            <ul className="divide-y">
              {close.map((r) => (
                <li key={`close-${r.id}`} className={`flex items-center gap-3 px-5 py-3 text-base ${fresh.has(alertKey("close", r.id)) ? "bg-warn-bg/40" : ""}`}>
                  <RowFacts r={r} isNew={fresh.has(alertKey("close", r.id))} onOpen={onOpen} opening={opening === r.id} />
                  <button
                    type="button" className="shrink-0 btn btn-sm btn-primary" disabled={pending || !can(r)} onClick={() => onClose([r.id])}
                    title={can(r) ? "Closed in Odoo — mark it Done" : "You cannot record on this line's ODOO tab"}
                  >
                    ✓ Done
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

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
