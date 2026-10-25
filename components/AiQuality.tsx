"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, CheckCircle2, ClipboardCheck, Pencil, Play, Plus, ThumbsDown, ThumbsUp, Trash2, XCircle } from "lucide-react";
import { deleteAiCheck, feedbackToRule, runAiCheck, saveAiCheck, setAiCheckActive, setFeedbackDone, type AiActionResult } from "@/app/admin/ai/actions";
import { Modal } from "@/components/Modal";
import { EmptyState, Note, SectionCard, Switch } from "@/components/primitives";
import { AI_CHECK_LIMITS, ruleFromFeedback } from "@/lib/domain/aiLearn";
import { PLAYBOOK_TOPICS, PLAYBOOK_TOPIC_LABEL, PLAYBOOK_BODY_MAX, PLAYBOOK_TITLE_MAX } from "@/lib/domain/aiPlaybook";
import { usdText } from "@/lib/domain/ai";
import { formatDateTime } from "@/lib/domain/format";

// AI settings → Quality: what people thought of the assistant's answers (a
// thumbs-down with what was wrong turns into a playbook rule or a quality
// check in two clicks), and the quality checks — real questions with what a
// right answer must say, run after a change of model, effort or playbook.

export interface AiFeedbackItem {
  id: number;
  at: string;
  who: string;
  rating: "up" | "down";
  note: string;
  question: string;
  answer: string;
  model: string;
  done: boolean;
}

export interface AiCheckItem {
  id: number;
  question: string;
  expect: string;
  referenceSql: string | null;
  active: boolean;
  lastRunAt: string | null;
  lastPass: boolean | null;
  lastWhy: string | null;
  lastAnswer: string | null;
  lastCostUsd: number | null;
}

export interface AiQualityData {
  feedback: AiFeedbackItem[];
  up30: number;
  down30: number;
  /** Thumbs-down not dealt with — all of them, past the list's length. */
  openCount: number;
  checks: AiCheckItem[];
}

type Msg = { ok: boolean; text: string } | null;

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const run = (fn: () => Promise<AiActionResult>, after?: () => void) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? (r.message ? { ok: true, text: r.message } : null) : { ok: false, text: r.error ?? "Failed." });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  return { pending, msg, run };
}

const form = (o: Record<string, string | number | null | undefined>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) f.set(k, String(v));
  return f;
};

export function AiQuality({ data }: { data: AiQualityData }) {
  const [rule, setRule] = useState<AiFeedbackItem | null>(null);
  const [check, setCheck] = useState<{ item: Partial<AiCheckItem>; feedbackId?: number } | null>(null);
  const rated = data.up30 + data.down30;
  return (
    <div className="space-y-4">
      <div className="kpi-strip">
        <div className="kpi"><div className="kpi-label">Good answers · 30 days</div><div className="kpi-value">{rated ? `${Math.round((data.up30 / rated) * 100)}%` : "—"}</div><div className="kpi-sub">{data.up30} 👍 · {data.down30} 👎</div></div>
        <div className="kpi"><div className="kpi-label">Notes to read</div><div className="kpi-value">{data.openCount}</div><div className="kpi-sub">thumbs-down not dealt with</div></div>
        <div className="kpi"><div className="kpi-label">Checks passing</div><div className="kpi-value">{data.checks.filter((c) => c.active && c.lastPass).length} / {data.checks.filter((c) => c.active).length}</div><div className="kpi-sub">at their last run</div></div>
      </div>

      <FeedbackCard items={data.feedback} onRule={setRule} onCheck={(f) => setCheck({ item: { question: f.question, expect: f.note }, feedbackId: f.id })} />
      <ChecksCard checks={data.checks} onEdit={(c) => setCheck({ item: c })} onAdd={() => setCheck({ item: {} })} />

      {rule && <RuleDialog item={rule} onClose={() => setRule(null)} />}
      {check && <CheckDialog item={check.item} feedbackId={check.feedbackId} onClose={() => setCheck(null)} />}
    </div>
  );
}

function FeedbackCard({ items, onRule, onCheck }: { items: AiFeedbackItem[]; onRule: (f: AiFeedbackItem) => void; onCheck: (f: AiFeedbackItem) => void }) {
  const act = useAct();
  const [all, setAll] = useState(false);
  const shown = items.filter((f) => all || !f.done);
  return (
    <SectionCard icon={ThumbsDown} title="What people thought of its answers"
      description="A thumbs-down comes with what was wrong. Make it a playbook rule (the assistant is told it from now on, for everyone) or a quality check (so it is tested after every change)."
      end={<label className="text-xs inline-flex items-center gap-1.5"><Switch on={all} onChange={setAll} label="Show the ones dealt with" size="sm" /> Dealt with too</label>}>
      {shown.length === 0 ? (
        <EmptyState compact icon={ThumbsUp} title={all ? "No ratings yet" : "Nothing to read"} hint="People rate an answer with 👍 / 👎 under it in the chat." />
      ) : (
        <ul className="divide-y">
          {shown.map((f) => (
            <li key={f.id} className={`py-3 ${f.done ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {f.rating === "up" ? <ThumbsUp size={14} className="text-ok-fg" aria-label="Good" /> : <ThumbsDown size={14} className="text-bad-fg" aria-label="Wrong" />}
                <span className="font-semibold text-foreground">{f.who}</span>
                <span>{formatDateTime(f.at)}</span>
                <span>{f.model}</span>
              </div>
              <p className="text-sm font-semibold mt-1" dir="auto">{f.question}</p>
              {f.note && <p className="text-sm mt-1 rounded-lg bg-surface-2 px-2.5 py-1.5" dir="auto">{f.note}</p>}
              <details className="mt-1">
                <summary className="text-xs text-muted cursor-pointer">The answer it gave</summary>
                <p className="text-sm whitespace-pre-wrap mt-1 max-h-60 overflow-auto" dir="auto">{f.answer}</p>
              </details>
              <div className="flex flex-wrap gap-2 mt-2">
                {f.rating === "down" && f.note && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRule(f)}><BookOpen size={14} /> Make it a rule</button>}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCheck(f)}><ClipboardCheck size={14} /> Make it a check</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={act.pending} onClick={() => act.run(() => setFeedbackDone(f.id, !f.done))}>{f.done ? "Not dealt with" : "Dealt with"}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Note msg={act.msg} />
    </SectionCard>
  );
}

function ChecksCard({ checks, onEdit, onAdd }: { checks: AiCheckItem[]; onEdit: (c: AiCheckItem) => void; onAdd: () => void }) {
  const act = useAct();
  const router = useRouter();
  const [running, setRunning] = useState<{ id: number; done: number; of: number } | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const runAll = async (ids: number[]) => {
    setRunMsg(null);
    let passed = 0;
    let cost = 0;
    for (let k = 0; k < ids.length; k++) {
      setRunning({ id: ids[k], done: k, of: ids.length });
      const r = await runAiCheck(ids[k]);
      if (!r.ok) {
        setRunMsg(`Stopped at check #${ids[k]}: ${r.error}`);
        break;
      }
      if (r.pass) passed++;
      cost += r.costUsd;
      if (k === ids.length - 1) setRunMsg(`${passed} of ${ids.length} passed · ${usdText(cost)}`);
    }
    setRunning(null);
    router.refresh();
  };
  const active = checks.filter((c) => c.active).map((c) => c.id);
  return (
    <SectionCard icon={ClipboardCheck} title="Quality checks"
      description="Real questions and what a right answer must say — with SQL giving the right figures, when there is one. Run them after a change of model, effort or playbook; a cheap model grades each answer. Each run costs like a question."
      end={
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onAdd} disabled={!!running}><Plus size={14} /> Add</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => runAll(active)} disabled={!!running || active.length === 0}>
            <Play size={14} /> {running ? `Running ${running.done + 1} of ${running.of}…` : `Run all (${active.length})`}
          </button>
        </div>
      }>
      {runMsg && <p className="text-sm font-semibold mb-2" role="status">{runMsg}</p>}
      {checks.length === 0 ? (
        <EmptyState compact icon={ClipboardCheck} title="No checks yet" hint="Add the questions people really ask — or make one from a thumbs-down." />
      ) : (
        <ul className="divide-y">
          {checks.map((c) => (
            <li key={c.id} className="py-3">
              <div className="flex items-start gap-2">
                {c.lastPass === null ? <span className="pill pill-muted">Not run</span> : c.lastPass ? <span className="pill pill-ok"><CheckCircle2 size={12} /> Pass</span> : <span className="pill pill-bad"><XCircle size={12} /> Fail</span>}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" dir="auto">{c.question}</p>
                  <p className="text-xs text-muted" dir="auto">Must say: {c.expect}</p>
                  {c.lastWhy && <p className="text-xs mt-1" dir="auto">{c.lastWhy}{c.lastRunAt ? ` · ${formatDateTime(c.lastRunAt)}` : ""}{c.lastCostUsd !== null ? ` · ${usdText(c.lastCostUsd)}` : ""}</p>}
                  {c.lastAnswer && (
                    <details className="mt-1">
                      <summary className="text-xs text-muted cursor-pointer">Its last answer</summary>
                      <p className="text-sm whitespace-pre-wrap mt-1 max-h-60 overflow-auto" dir="auto">{c.lastAnswer}</p>
                    </details>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch on={c.active} onChange={(v) => act.run(() => setAiCheckActive(c.id, v))} label={`Check #${c.id} on`} size="sm" />
                  <button type="button" className="icon-btn" disabled={!!running} onClick={() => runAll([c.id])} title="Run this one" aria-label="Run this one"><Play size={14} /></button>
                  <button type="button" className="icon-btn" onClick={() => onEdit(c)} title="Edit" aria-label="Edit"><Pencil size={14} /></button>
                  <button type="button" className="icon-btn" disabled={act.pending} onClick={() => act.run(() => deleteAiCheck(c.id))} title="Delete" aria-label="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Note msg={act.msg} />
    </SectionCard>
  );
}

function RuleDialog({ item, onClose }: { item: AiFeedbackItem; onClose: () => void }) {
  const act = useAct();
  const draft = ruleFromFeedback(item);
  const [topic, setTopic] = useState(draft.topic);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  return (
    <Modal title="Make it a playbook rule" sub="The assistant is told it with every question and every automation, for everyone. Word it as a rule." onClose={onClose} busy={act.pending}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act.run(() => feedbackToRule(form({ id: item.id, topic, title, body })), onClose); }}>
        <label className="block text-sm font-semibold">Topic
          <select className="block mt-1 w-full" value={topic} onChange={(e) => setTopic(e.target.value)}>
            {PLAYBOOK_TOPICS.map((t) => <option key={t} value={t}>{PLAYBOOK_TOPIC_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="block text-sm font-semibold">Title
          <input className="block mt-1 w-full" dir="auto" maxLength={PLAYBOOK_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block text-sm font-semibold">The rule
          <textarea className="block mt-1 w-full" dir="auto" rows={5} maxLength={PLAYBOOK_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <Note msg={act.msg} />
          <button type="submit" className="btn btn-primary btn-sm ms-auto" disabled={act.pending}>Add to the playbook</button>
        </div>
      </form>
    </Modal>
  );
}

function CheckDialog({ item, feedbackId, onClose }: { item: Partial<AiCheckItem>; feedbackId?: number; onClose: () => void }) {
  const act = useAct();
  const [question, setQuestion] = useState(item.question ?? "");
  const [expect, setExpect] = useState(item.expect ?? "");
  const [sql, setSql] = useState(item.referenceSql ?? "");
  return (
    <Modal title={item.id ? `Quality check #${item.id}` : "A new quality check"} sub="Asked as you, reading only — nothing is prepared or changed." onClose={onClose} busy={act.pending}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act.run(() => saveAiCheck(form({ id: item.id, feedbackId, question, expect, referenceSql: sql })), onClose); }}>
        <label className="block text-sm font-semibold">The question
          <textarea className="block mt-1 w-full" dir="auto" rows={2} maxLength={AI_CHECK_LIMITS.question} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </label>
        <label className="block text-sm font-semibold">A right answer must say
          <textarea className="block mt-1 w-full" dir="auto" rows={3} maxLength={AI_CHECK_LIMITS.expect} value={expect} onChange={(e) => setExpect(e.target.value)}
            placeholder="e.g. The plan's target is the sum of CF, TC, TN and CB — the figure from the SQL — and names the lines behind" />
        </label>
        <label className="block text-sm font-semibold">Reference SQL <span className="font-normal text-muted">(optional — run read-only, its rows are the right figures)</span>
          <textarea className="block mt-1 w-full font-mono text-xs ltr" rows={4} maxLength={AI_CHECK_LIMITS.sql} value={sql} onChange={(e) => setSql(e.target.value)} placeholder={'SELECT SUM("targetQty") FROM "PlanSchedule" WHERE …'} />
        </label>
        <div className="flex items-center gap-2">
          <Note msg={act.msg} />
          <button type="submit" className="btn btn-primary btn-sm ms-auto" disabled={act.pending}>Save the check</button>
        </div>
      </form>
    </Modal>
  );
}
