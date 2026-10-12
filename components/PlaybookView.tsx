"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Modal } from "@/components/Modal";
import { savePlaybookRule, setPlaybookRuleActive } from "@/app/ai/playbook/actions";
import { PLAYBOOK_BODY_MAX, PLAYBOOK_TITLE_MAX, PLAYBOOK_TOPICS, PLAYBOOK_TOPIC_LABEL, isPlaybookTopic } from "@/lib/domain/aiPlaybook";
import { formatDateTime } from "@/lib/domain/format";
import type { PlaybookRuleView } from "@/lib/server/ai/panel";

// The playbook's rules by topic: read by anyone the assistant is opened to,
// kept by admins — add, rewrite, retire, bring back. A rule is a paragraph,
// in the words people use on the floor.

export type { PlaybookRuleView };

const inputCls = "px-2.5 py-1.5 text-sm w-full";

function RuleForm({ rule, onClose, onSaved }: { rule: PlaybookRuleView | null; onClose: () => void; onSaved?: () => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (rule) fd.set("id", String(rule.id));
    setErr(null);
    start(async () => {
      const r = await savePlaybookRule(fd).catch(() => ({ ok: false, error: "The request failed — try again." }));
      if (r.ok) {
        onSaved?.();
        onClose();
      } else setErr(r.error ?? "It was not saved.");
    });
  };
  return (
    <Modal title={rule ? `Rule #${rule.id}` : "New rule"} onClose={onClose} busy={pending}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-xs font-semibold">
          <span className="block mb-1 text-muted">Topic</span>
          <select name="topic" defaultValue={rule?.topic ?? "general"} className={inputCls} disabled={pending}>
            {PLAYBOOK_TOPICS.map((t) => <option key={t} value={t}>{PLAYBOOK_TOPIC_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold">
          <span className="block mb-1 text-muted">Title</span>
          <input name="title" defaultValue={rule?.title ?? ""} maxLength={PLAYBOOK_TITLE_MAX} required className={inputCls} disabled={pending} dir="auto" placeholder="Tanks of 1000 kVA and up" />
        </label>
        <label className="block text-xs font-semibold">
          <span className="block mb-1 text-muted">The rule</span>
          <textarea name="body" defaultValue={rule?.body ?? ""} maxLength={PLAYBOOK_BODY_MAX} required rows={6} className={inputCls} disabled={pending} dir="auto" placeholder="They are welded in bay 2 only; plan them first on the laser L2." />
        </label>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          {err && <span className="text-sm font-semibold text-bad-fg">{err}</span>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Rule({ rule, canEdit, onEdit, onChanged }: { rule: PlaybookRuleView; canEdit: boolean; onEdit: () => void; onChanged?: () => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const toggle = () => {
    if (rule.active && !confirm(`Retire rule #${rule.id}? The assistant stops being told it; it stays here with its history.`)) return;
    const fd = new FormData();
    fd.set("id", String(rule.id));
    fd.set("active", rule.active ? "false" : "true");
    setErr(null);
    start(async () => {
      const r = await setPlaybookRuleActive(fd).catch(() => ({ ok: false, error: "The request failed — try again." }));
      if (!r.ok) setErr(r.error ?? "It did not go through.");
      else onChanged?.();
    });
  };
  return (
    <li className={`border rounded-xl bg-surface px-3 py-2 ${rule.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted tabnum">#{rule.id}</span>
        <span className="font-bold" dir="auto">{rule.title}</span>
        {!rule.active && <span className="pill pill-muted text-[11px]">Retired</span>}
        <span className="ms-auto text-xs text-muted">{rule.updatedBy ? `${rule.updatedBy} · ` : ""}{formatDateTime(rule.updatedAt)}</span>
        {canEdit && (
          <span className="inline-flex gap-1">
            {rule.active && <button type="button" className="btn btn-sm" onClick={onEdit} disabled={pending} aria-label={`Edit rule ${rule.id}`}><Pencil size={13} aria-hidden /></button>}
            <button type="button" className="btn btn-sm" onClick={toggle} disabled={pending} aria-label={rule.active ? `Retire rule ${rule.id}` : `Bring back rule ${rule.id}`}>
              {rule.active ? <Trash2 size={13} aria-hidden /> : <RotateCcw size={13} aria-hidden />}
            </button>
          </span>
        )}
      </div>
      <p className="text-sm whitespace-pre-wrap mt-1" dir="auto">{rule.body}</p>
      {rule.revisions.length > 1 && (
        <p className="text-[11px] text-muted mt-1">{rule.revisions.map((v) => `${v.action} by ${v.by}, ${formatDateTime(v.at)}`).join(" · ")}</p>
      )}
      {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}
    </li>
  );
}

export function PlaybookView({ rules, canEdit, left, onChanged }: { rules: PlaybookRuleView[]; canEdit: boolean; left: number; onChanged?: () => void }) {
  const [editing, setEditing] = useState<PlaybookRuleView | null | "new">(null);
  const [showRetired, setShowRetired] = useState(false);
  const active = rules.filter((r) => r.active);
  const retired = rules.filter((r) => !r.active);
  const topics = [...PLAYBOOK_TOPICS, ...new Set(active.map((r) => r.topic).filter((t) => !isPlaybookTopic(t)))];
  const rule = (r: PlaybookRuleView) => <Rule key={r.id} rule={r} canEdit={canEdit} onEdit={() => setEditing(r)} onChanged={onChanged} />;
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex">
          <button type="button" className="btn btn-primary btn-sm ms-auto" onClick={() => setEditing("new")}><Plus size={14} aria-hidden /> New rule</button>
        </div>
      )}
      {left > 0 && <p className="text-sm font-semibold text-warn-fg">{left} rule(s) do not fit — shorten or retire some.</p>}
      {topics.map((t) => {
        const list = active.filter((r) => r.topic === t);
        if (list.length === 0) return null;
        return (
          <section key={t} className="space-y-2">
            <h2>{isPlaybookTopic(t) ? PLAYBOOK_TOPIC_LABEL[t] : t}</h2>
            <ul className="space-y-2">{list.map(rule)}</ul>
          </section>
        );
      })}
      {active.length === 0 && <p className="text-sm text-muted">No rules yet.</p>}
      {retired.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowRetired((v) => !v)}>{showRetired ? "Hide" : "Show"} {retired.length} retired</button>
      )}
      {showRetired && <ul className="space-y-2">{retired.map(rule)}</ul>}
      {editing !== null && <RuleForm rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </div>
  );
}
