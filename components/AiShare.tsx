"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Inbox, Loader2, MessageSquare, Search, Users } from "lucide-react";
import { Modal } from "@/components/Modal";
import { loadAiShareTargets, shareAiAnswer, shareAiAnswerToChat } from "@/app/ai/actions";

// An answer sent on: to colleagues' inboxes as it reads (tables and charts;
// for someone who may send messages to inboxes), kept in the person's own
// inbox as a report, or posted in the team chat as plain text.

type Targets = { people: { id: number; name: string }[]; groups: { id: number; name: string }[]; inbox: boolean; chat: boolean };

export function ShareDialog({ title, question, body, onClose }: { title: string; question: string; body: string; onClose: () => void }) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [where, setWhere] = useState<"inbox" | "chat">("inbox");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [keep, setKeep] = useState(false);
  const [chatTo, setChatTo] = useState<string>("");
  const [q, setQ] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let gone = false;
    loadAiShareTargets().then((r) => {
      if (gone) return;
      if (!r.ok) setError(r.error ?? "Could not load who to send to.");
      else {
        const t = { people: r.people ?? [], groups: r.groups ?? [], inbox: !!r.inbox, chat: !!r.chat };
        setTargets(t);
        // with no key for inboxes, the answer is kept for oneself by default
        if (!t.inbox) setKeep(true);
      }
    });
    return () => { gone = true; };
  }, []);

  const needle = q.trim().toLowerCase();
  const people = (targets?.people ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const canSend = where === "inbox" ? picked.size > 0 || keep : !!chatTo;

  const send = () =>
    start(async () => {
      setError(null);
      if (where === "inbox") {
        const r = await shareAiAnswer({ title, body, question, userIds: [...picked], keep });
        if (!r.ok) return setError(r.error ?? "Could not send it.");
        setDone(`Sent to ${r.sent} inbox${r.sent === 1 ? "" : "es"}.`);
      } else {
        const [kind, id] = chatTo.split(":");
        const r = await shareAiAnswerToChat({ kind: kind === "group" ? "group" : "user", to: Number(id), body });
        if (!r.ok) return setError(r.error ?? "Could not send it.");
        setDone(r.cut ? "Posted in the chat — cut to its length; the charts stay here." : "Posted in the chat (as text; the charts stay here).");
      }
    });

  return (
    <Modal title="Share this answer" sub={<span dir="auto">{title}</span>} onClose={onClose} busy={pending} width="max-w-md" focusField={false}>
      {done ? (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-ok-fg flex items-center gap-1.5" role="status"><Check size={15} aria-hidden /> {done}</p>
          <div className="flex justify-end"><button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="seg seg-sm" role="group" aria-label="Where to send it">
            <button type="button" aria-pressed={where === "inbox"} className={where === "inbox" ? "on" : ""} onClick={() => setWhere("inbox")}><Inbox size={11} className="inline -mt-0.5 me-1" aria-hidden />Inbox</button>
            {targets?.chat && <button type="button" aria-pressed={where === "chat"} className={where === "chat" ? "on" : ""} onClick={() => setWhere("chat")}><MessageSquare size={11} className="inline -mt-0.5 me-1" aria-hidden />Team chat</button>}
          </div>
          {!targets && !error && <p className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden /> Loading…</p>}
          {targets && where === "inbox" && (
            <>
              <p className="text-xs text-muted">The answer goes as it reads here — tables and charts — as a message from you.</p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep a copy in my inbox as a report
              </label>
              {targets.inbox ? (
                <>
                  <div className="relative">
                    <Search size={14} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a colleague…" aria-label="Find a colleague" className="w-full ps-8 pe-2 py-1.5 text-sm" />
                  </div>
                  <div className="max-h-56 overflow-y-auto rounded-lg border divide-y">
                    {people.length === 0 && <p className="px-3 py-2 text-sm text-muted">{needle ? "Nobody matches." : "No colleagues to send to."}</p>}
                    {people.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2 cursor-pointer">
                        <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                        <span dir="auto">{p.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted">Sending to colleagues&apos; inboxes needs the automations key — ask the owner.{targets.chat ? " The team chat is open to you." : ""}</p>
              )}
            </>
          )}
          {targets && where === "chat" && (
            <>
              <p className="text-xs text-muted">Posted as you, as text — a chart stays here, and a long answer is cut to the chat&apos;s length.</p>
              <label className="block text-sm">
                <span className="filter-label block mb-1">To</span>
                <select value={chatTo} onChange={(e) => setChatTo(e.target.value)} className="w-full text-sm">
                  <option value="">Pick a colleague or a group…</option>
                  {targets.groups.length > 0 && (
                    <optgroup label="Groups">
                      {targets.groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
                    </optgroup>
                  )}
                  <optgroup label="Colleagues">
                    {targets.people.map((p) => <option key={p.id} value={`user:${p.id}`}>{p.name}</option>)}
                  </optgroup>
                </select>
              </label>
            </>
          )}
          {error && <p className="text-xs font-semibold text-bad-fg" role="alert">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={!targets || !canSend || pending}>
              {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : where === "inbox" ? <Users size={14} aria-hidden /> : <MessageSquare size={14} aria-hidden />} Send
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
