"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowLeft, Ban, CalendarClock, Check, CheckCircle2, ClipboardCheck, FileText, Flag, Loader2, Paperclip, Play, Plus, RotateCcw, Search, Send, Undo2, Users, X,
} from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { EmptyState } from "@/components/primitives";
import { INBOX_CHANGED } from "@/components/InboxBell";
import { createTask, loadAssignable, loadTask, markTaskSeen, postTaskUpdate } from "@/app/tasks/actions";
import { compressImage } from "@/lib/imageCompress";
import { traceHref } from "@/lib/domain/links";
import { formatDate, formatDateTime } from "@/lib/domain/format";
import { factoryDayISO } from "@/lib/domain/dates";
import { MOVE_NEEDS_TEXT, TASK_LIMITS, TASK_MOVE_LABEL, TASK_STATUS_LABEL, TASK_STATUS_TONE, isClosed, type TaskMove } from "@/lib/domain/tasks";
import type { TaskDetail, TaskSummary, TasksData, TaskUpdateView } from "@/lib/server/tasks";
import type { StoredFile } from "@/lib/server/uploads";

// The inbox's Tasks tab: the tasks given to the person and those they gave,
// each opened on its thread — the details, every update with its photos, and
// the moves open to the person now (start, mark done; approve, return for
// rework, cancel, reopen). In the large window and on the page the list sits
// beside the open task; in the corner card and on a phone the task opens in
// its place, with Back.

const changed = () => window.dispatchEvent(new Event(INBOX_CHANGED));

type Which = "mine" | "sent";
type Show = "open" | "closed";

function Initials({ name }: { name: string }) {
  const letters = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return <span className="w-7 h-7 rounded-full grid place-items-center shrink-0 bg-surface-3 text-[11px] font-bold text-muted" aria-hidden>{letters || "?"}</span>;
}

function StatusPill({ status }: { status: TaskSummary["status"] }) {
  return <span className={`pill ${TASK_STATUS_TONE[status]} shrink-0`}>{TASK_STATUS_LABEL[status]}</span>;
}

function DueLine({ due, overdue }: { due: string | null; overdue: boolean }) {
  if (!due) return null;
  return (
    <span className={`inline-flex items-center gap-1 tabnum ${overdue ? "text-bad-fg font-semibold" : ""}`}>
      <CalendarClock size={12} aria-hidden /> {overdue ? "Late · " : "Due "}{formatDate(due)}
    </span>
  );
}

function FilesView({ files }: { files: StoredFile[] }) {
  if (files.length === 0) return null;
  const images = files.filter((f) => f.type.startsWith("image/"));
  const docs = files.filter((f) => !f.type.startsWith("image/"));
  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((f) => (
            <a key={f.url} href={f.url} target="_blank" rel="noreferrer" title={`${f.name} — open full size`} className="block">
              {/* eslint-disable-next-line @next/next/no-img-element -- runtime uploads, size unknown at build */}
              <img src={f.url} alt={f.name} loading="lazy" className="h-28 w-28 sm:h-32 sm:w-32 rounded-lg object-cover border" />
            </a>
          ))}
        </div>
      )}
      {docs.map((f) => (
        <a key={f.url} href={f.url} target="_blank" rel="noreferrer" download={f.name} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-surface-2 w-fit max-w-full">
          <FileText size={14} className="text-muted shrink-0" aria-hidden />
          <span className="truncate font-semibold">{f.name}</span>
        </a>
      ))}
    </div>
  );
}

/** Photos and files picked for an update or a new task: shrunk, listed, removable. */
function usePicked() {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const add = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      const ready = await Promise.all(Array.from(list).map((f) => compressImage(f)));
      setFiles((xs) => [...xs, ...ready].slice(0, TASK_LIMITS.files));
    } finally {
      setBusy(false);
    }
  };
  const remove = (i: number) => setFiles((xs) => xs.filter((_, n) => n !== i));
  return { files, busy, add, remove, clear: () => setFiles([]) };
}

function PickedFiles({ picked }: { picked: ReturnType<typeof usePicked> }) {
  if (picked.files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {picked.files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border bg-surface-2 ps-2 pe-1 py-0.5 text-xs max-w-[220px]">
          <Paperclip size={11} className="text-muted shrink-0" aria-hidden />
          <span className="truncate">{f.name}</span>
          <button type="button" onClick={() => picked.remove(i)} className="p-0.5 rounded hover:bg-surface-3" aria-label={`Remove ${f.name}`} title="Remove"><X size={11} /></button>
        </span>
      ))}
    </div>
  );
}

function AttachButton({ picked, disabled }: { picked: ReturnType<typeof usePicked>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,.pdf,.xls,.xlsx,.csv,.doc,.docx"
        className="hidden"
        onChange={(e) => {
          void picked.add(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="icon-btn icon-btn-md"
        onClick={() => input.current?.click()}
        disabled={disabled || picked.busy || picked.files.length >= TASK_LIMITS.files}
        title="Add photos or files"
        aria-label="Add photos or files"
      >
        {picked.busy ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
      </button>
    </>
  );
}

// ------------------------------------------------------------------ list

function TaskRow({ t, which, on, onPick }: { t: TaskSummary; which: Which; on: boolean; onPick: () => void }) {
  const who = which === "mine" ? `From ${t.createdByName}` : `To ${t.assignees.map((a) => a.name).join(", ")}`;
  return (
    <button type="button" onClick={onPick} className={`task-row ${on ? "task-row-on" : ""} ${t.unread > 0 ? "task-row-unread" : ""}`} aria-current={on || undefined}>
      <span className="flex items-start gap-2 min-w-0">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            {t.priority === "urgent" && <Flag size={13} className="text-bad-fg shrink-0" aria-label="Urgent" />}
            <span className={`truncate text-[13px] ${t.unread > 0 ? "font-bold" : "font-semibold"}`} dir="auto">{t.title}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-muted">
            <span className="truncate max-w-full" dir="auto">{who}</span>
            <DueLine due={t.dueDate} overdue={t.overdue} />
          </span>
          {t.last && (
            <span className="block mt-1 text-[12px] text-muted truncate" dir="auto">
              <span className="font-medium text-foreground/80">{t.last.authorName}:</span> {t.last.body || TASK_MOVE_LABEL[t.last.kind as TaskMove] || t.last.kind}
            </span>
          )}
        </span>
        <span className="flex flex-col items-end gap-1 shrink-0">
          <StatusPill status={t.status} />
          {t.unread > 0 && <span className="w-2 h-2 rounded-full bg-[var(--brand)]" aria-label={`${t.unread} new`} />}
        </span>
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ one task

const MOVE_BUTTON: Record<Exclude<TaskMove, "note">, { icon: typeof Check; cls: string; label: string }> = {
  start: { icon: Play, cls: "btn-secondary", label: "Start" },
  submit: { icon: CheckCircle2, cls: "btn-primary", label: "Mark done" },
  approve: { icon: Check, cls: "btn-primary", label: "Approve" },
  return: { icon: Undo2, cls: "btn-secondary", label: "Return for rework" },
  reopen: { icon: RotateCcw, cls: "btn-secondary", label: "Reopen" },
  cancel: { icon: Ban, cls: "btn-ghost text-bad-fg", label: "Cancel task" },
};

const ENTRY_ICON: Record<TaskMove, typeof Check> = {
  note: FileText, start: Play, submit: CheckCircle2, approve: Check, return: Undo2, cancel: Ban, reopen: RotateCcw,
};

function Entry({ u, mine }: { u: TaskUpdateView; mine: boolean }) {
  if (u.kind === "note") {
    return (
      <li className={`flex gap-2.5 ${mine ? "flex-row-reverse" : ""}`}>
        <Initials name={u.authorName} />
        <div className={`min-w-0 max-w-[85%] ${mine ? "items-end text-end" : ""} flex flex-col`}>
          <div className="text-[11px] text-muted mb-0.5"><span className="font-semibold text-foreground/80">{u.authorName}</span> · {formatDateTime(u.createdAt)}</div>
          {u.body && <div className={`task-bubble ${mine ? "task-bubble-mine" : ""}`} dir="auto">{u.body}</div>}
          <FilesView files={u.attachments} />
        </div>
      </li>
    );
  }
  const Icon = ENTRY_ICON[u.kind] ?? FileText;
  const tone = u.kind === "approve" ? "text-ok-fg" : u.kind === "return" || u.kind === "cancel" ? "text-bad-fg" : u.kind === "submit" ? "text-warn-fg" : "text-muted";
  return (
    <li className="task-event">
      <span className={`task-event-icon ${tone}`}><Icon size={13} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px]">
          <span className="font-semibold">{u.authorName}</span> <span className={tone}>{TASK_MOVE_LABEL[u.kind].toLowerCase()}</span>
          <span className="text-muted"> · {formatDateTime(u.createdAt)}</span>
        </div>
        {u.body && <div className="text-[13px] mt-0.5 whitespace-pre-wrap" dir="auto">{u.body}</div>}
        <FilesView files={u.attachments} />
      </div>
    </li>
  );
}

function TaskPane({ id, onBack, onChanged, onOpen }: { id: number; onBack?: () => void; onChanged: () => void; onOpen: (id: number) => void }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const picked = usePicked();
  const end = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const read = useCallback(() => {
    const n = ++seq.current;
    loadTask(id)
      .then((r) => {
        if (n !== seq.current) return;
        if (r.ok) {
          setTask(r.task);
          setError(null);
          if (r.task.unread > 0) markTaskSeen(id).then(changed).catch(() => undefined);
        } else setError(r.error);
      })
      .catch(() => n === seq.current && setError("Could not load — check the connection and try again."));
  }, [id]);

  useEffect(() => {
    read();
  }, [read]);

  // it opens on its title and details; a new entry after that brings the thread's end into view
  const seen = useRef<number | null>(null);
  const entries = task?.updates.length ?? null;
  useEffect(() => {
    if (entries === null) return;
    if (seen.current !== null && entries > seen.current) end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    seen.current = entries;
  }, [entries]);

  if (error) {
    return (
      <div className="p-4 text-sm">
        {onBack && <button type="button" className="btn btn-ghost btn-sm mb-2" onClick={onBack}><ArrowLeft size={15} aria-hidden /> Back</button>}
        <p className="font-semibold text-bad-fg">{error}</p>
        <button type="button" className="btn btn-sm mt-2" onClick={read}>Try again</button>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
      </div>
    );
  }

  const send = (move: TaskMove) => {
    if (MOVE_NEEDS_TEXT.has(move) && !text.trim() && (move !== "note" || picked.files.length === 0)) {
      setMsg(move === "note" ? "Write something or add a photo." : move === "return" ? "Say what to fix — it goes to them with the task." : "Say what to redo — it goes to them with the task.");
      return;
    }
    if (move === "cancel" && !confirm(`Cancel "${task.title}"? Its people are told.`)) return;
    setMsg(null);
    const fd = new FormData();
    fd.set("id", String(task.id));
    fd.set("move", move);
    fd.set("body", text.trim());
    for (const f of picked.files) fd.append("files", f);
    start(async () => {
      const r = await postTaskUpdate(fd).catch(() => ({ ok: false, error: "Not sent — check the connection and try again." }));
      if (!r.ok) {
        setMsg(r.error ?? "Not sent.");
        read();
        return;
      }
      setText("");
      picked.clear();
      read();
      onChanged();
      changed();
    });
  };

  const closed = isClosed(task.status);
  const canWrite = !closed && (task.role.giver || task.role.doer);
  const people = task.assignees.map((a) => a.name).join(", ");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="ai-pane-head">
        {onBack && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            <ArrowLeft size={15} aria-hidden /> Back
          </button>
        )}
        <span className="text-sm font-semibold truncate flex-1 min-w-0" dir="auto">Task #{task.id}</span>
        <StatusPill status={task.status} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-3 md:p-4 space-y-3">
          <div>
            <h3 className="text-base font-bold leading-snug flex items-start gap-1.5" dir="auto">
              {task.priority === "urgent" && <Flag size={15} className="text-bad-fg shrink-0 mt-1" aria-label="Urgent" />}
              {task.title}
            </h3>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted">
              <span className="inline-flex items-center gap-1"><Users size={12} aria-hidden /> {task.createdByName} → {people}{task.shared && task.assignees.length > 1 ? " (together)" : ""}</span>
              <DueLine due={task.dueDate} overdue={task.overdue} />
              {task.mo && <Link href={traceHref({ mo: task.mo })} className="code-chip hover:underline">{task.mo}</Link>}
              {task.via === "ai" && <span title="Given through the assistant">via AI</span>}
              <span>{formatDateTime(task.createdAt)}</span>
            </div>
          </div>
          {task.details && (
            <div className="rounded-xl border bg-surface-2 px-3 py-2.5">
              <AiMarkdown text={task.details} className="!text-[13px]" />
            </div>
          )}
          <FilesView files={task.attachments} />
          {task.batch.length > 0 && (
            <div className="text-xs">
              <span className="text-muted">Also given, one each: </span>
              {task.batch.map((b, i) => (
                <span key={b.id}>
                  {i > 0 && <span className="text-muted"> · </span>}
                  <button type="button" className="font-semibold hover:underline" onClick={() => onOpen(b.id)}>{b.assignee}</button>
                  <span className="text-muted"> ({TASK_STATUS_LABEL[b.status].toLowerCase()})</span>
                </span>
              ))}
            </div>
          )}
          {task.status === "submitted" && task.role.giver && (
            <div className="alert alert-warn text-sm flex items-center gap-2"><AlertTriangle size={15} aria-hidden /> Marked done — approve it, or return it with what to fix.</div>
          )}
          {task.status === "returned" && task.role.doer && (
            <div className="alert alert-bad text-sm flex items-center gap-2"><Undo2 size={15} aria-hidden /> Returned for rework — see what to fix below, then mark it done again.</div>
          )}
          <ul className="space-y-3 pt-1">
            {task.updates.map((u) => <Entry key={u.id} u={u} mine={u.authorId === task.viewerId} />)}
            {task.updates.length === 0 && <li className="text-xs text-muted">No updates yet.</li>}
          </ul>
          <div ref={end} />
        </div>
      </div>
      {(canWrite || task.moves.length > 0) && (
        <div className="border-t p-2.5 space-y-2 bg-surface shrink-0">
          {canWrite && (
            <>
              <PickedFiles picked={picked} />
              <div className="flex items-end gap-1.5">
                <AttachButton picked={picked} disabled={pending} />
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={2}
                  maxLength={TASK_LIMITS.update}
                  placeholder={task.role.doer ? "How far did you get? Add a photo…" : "Write to them…"}
                  className="flex-1 min-w-0 resize-none text-sm px-2.5 py-1.5"
                  dir="auto"
                  disabled={pending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send("note");
                  }}
                />
                <button type="button" className="icon-btn icon-btn-md text-brand-ink" onClick={() => send("note")} disabled={pending || (!text.trim() && picked.files.length === 0)} title="Send update (Ctrl+Enter)" aria-label="Send update">
                  {pending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
            </>
          )}
          {task.moves.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {task.moves.map((m) => {
                const b = MOVE_BUTTON[m as Exclude<TaskMove, "note">];
                const label = m === "submit" && task.selfOnly ? "Mark done" : b.label;
                return (
                  <button key={m} type="button" className={`btn btn-sm ${b.cls}`} onClick={() => send(m)} disabled={pending}>
                    <b.icon size={14} aria-hidden /> {label}
                  </button>
                );
              })}
              {(task.moves.includes("return") || task.moves.includes("reopen")) && <span className="text-[11px] text-muted">Return and reopen send what you wrote above.</span>}
            </div>
          )}
          {msg && <p className="text-xs font-semibold text-bad-fg">{msg}</p>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ giving one

function TaskForm({ onDone, onCancel }: { onDone: (ids: number[]) => void; onCancel: () => void }) {
  const [people, setPeople] = useState<{ id: number; name: string }[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [q, setQ] = useState("");
  const [shared, setShared] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const picked = usePicked();
  const today = factoryDayISO(new Date());

  useEffect(() => {
    let live = true;
    loadAssignable()
      .then((r) => live && (r.ok ? setPeople(r.people) : setLoadErr(r.error)))
      .catch(() => live && setLoadErr("Could not load the people — check the connection."));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !n || p.name.toLowerCase().includes(n));
  }, [people, q]);
  const toggle = (id: number) => setChosen((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= TASK_LIMITS.people ? xs : [...xs, id]));

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (chosen.length === 0) {
      setMsg("Choose who it is for.");
      return;
    }
    const fd = new FormData(e.currentTarget);
    fd.set("people", chosen.join(","));
    fd.set("shared", shared && chosen.length > 1 ? "1" : "0");
    fd.set("priority", urgent ? "urgent" : "normal");
    for (const f of picked.files) fd.append("files", f);
    setMsg(null);
    start(async () => {
      const r = await createTask(fd).catch(() => ({ ok: false, error: "Not sent — check the connection and try again.", ids: undefined }));
      if (!r.ok || !r.ids) {
        setMsg(r.error ?? "Not given.");
        return;
      }
      onDone(r.ids);
    });
  };

  const names = (people ?? []).filter((p) => chosen.includes(p.id)).map((p) => p.name);

  return (
    <form onSubmit={submit} className="flex flex-col h-full min-h-0">
      <div className="ai-pane-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}><ArrowLeft size={15} aria-hidden /> Back</button>
        <span className="text-sm font-semibold">New task</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 md:p-4 space-y-3">
        <label className="block">
          <span className="field-label">What is to be done</span>
          <input name="title" required maxLength={TASK_LIMITS.title} placeholder="Clean bay 2 before the audit" className="w-full px-2.5 py-1.5 text-sm" dir="auto" />
        </label>
        <label className="block">
          <span className="field-label">Details <span className="font-normal text-muted">— optional</span></span>
          <textarea name="details" rows={3} maxLength={TASK_LIMITS.details} placeholder="The steps, what counts as done, what to send back (a photo of the result…)" className="w-full px-2.5 py-1.5 text-sm resize-y" dir="auto" />
        </label>
        <div>
          <span className="field-label">For</span>
          {names.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {names.map((n, i) => (
                <span key={n} className="inline-flex items-center gap-1 rounded-full bg-brand-light text-brand-ink text-xs font-semibold ps-2.5 pe-1 py-0.5">
                  {n}
                  <button type="button" className="p-0.5 rounded-full hover:bg-black/10" onClick={() => toggle(chosen[i])} aria-label={`Remove ${n}`}><X size={11} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="rounded-lg border overflow-hidden">
            <div className="relative border-b">
              <Search size={14} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people" className="w-full ps-8 pe-2 py-1.5 text-sm border-0 rounded-none" />
            </div>
            <div className="max-h-44 overflow-y-auto">
              {loadErr ? <p className="p-3 text-xs text-bad-fg">{loadErr}</p>
                : !people ? <p className="p-3 text-xs text-muted flex items-center gap-2"><Loader2 size={13} className="animate-spin" aria-hidden /> Loading…</p>
                : shown.length === 0 ? <p className="p-3 text-xs text-muted">Nobody matches.</p>
                : shown.map((p) => (
                  <label key={p.id} className="flex items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-surface-2 cursor-pointer">
                    <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                    <span dir="auto">{p.name}</span>
                  </label>
                ))}
            </div>
          </div>
        </div>
        {chosen.length > 1 && (
          <div>
            <span className="field-label">{chosen.length} people</span>
            <div className="segmented w-full">
              <button type="button" aria-pressed={!shared} onClick={() => setShared(false)}>One task each</button>
              <button type="button" aria-pressed={shared} onClick={() => setShared(true)}>One shared task</button>
            </div>
            <p className="text-xs text-muted mt-1.5">{shared ? "They work on it together and see each other's updates; it is done when you approve it once." : "Each gets their own copy, reports on it and is approved on their own."}</p>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="field-label">Due day <span className="font-normal text-muted">— optional</span></span>
            <input name="due" type="date" min={today} className="w-full px-2 py-1.5 text-sm tabnum" />
          </label>
          <label className="block">
            <span className="field-label">Order <span className="font-normal text-muted">— optional</span></span>
            <input name="mo" maxLength={60} placeholder="MO" className="w-full px-2 py-1.5 text-sm ltr" />
          </label>
          <div>
            <span className="field-label">Priority</span>
            <div className="segmented w-full">
              <button type="button" aria-pressed={!urgent} onClick={() => setUrgent(false)}>Normal</button>
              <button type="button" aria-pressed={urgent} onClick={() => setUrgent(true)}>Urgent</button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AttachButton picked={picked} disabled={pending} />
          <span className="text-xs text-muted">Photos or files to go with it</span>
        </div>
        <PickedFiles picked={picked} />
      </div>
      <div className="border-t p-2.5 flex items-center justify-end gap-2 shrink-0">
        {msg && <span className="text-xs font-semibold text-bad-fg me-auto">{msg}</span>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={pending || picked.busy}>
          {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />} Give the task
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ the tab

export function TasksView({
  data,
  onChanged,
  split,
  openId,
  onOpen,
}: {
  data: TasksData;
  onChanged: () => void;
  /** The list beside the open task (the large window, the page); else one at a time. */
  split: boolean;
  openId: number | null;
  onOpen: (id: number | null) => void;
}) {
  const giver = data.canAssign || data.sent.length > 0;
  const [which, setWhich] = useState<Which>(() => (!giver || data.mine.some((t) => !isClosed(t.status)) || data.sent.length === 0 ? "mine" : "sent"));
  const [show, setShow] = useState<Show>("open");
  const [creating, setCreating] = useState(false);

  const list = which === "mine" ? data.mine : data.sent;
  const openCount = (xs: TaskSummary[]) => xs.filter((t) => !isClosed(t.status)).length;
  const shown = list.filter((t) => (show === "open" ? !isClosed(t.status) : isClosed(t.status)));
  const waiting = data.sent.filter((t) => t.status === "submitted").length;

  const listPane = (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2.5 space-y-2 border-b shrink-0">
        <div className="flex items-center gap-2">
          {giver ? (
            <div className="segmented flex-1">
              <button type="button" aria-pressed={which === "mine"} onClick={() => setWhich("mine")}>For me{openCount(data.mine) > 0 ? ` · ${openCount(data.mine)}` : ""}</button>
              <button type="button" aria-pressed={which === "sent"} onClick={() => setWhich("sent")}>
                I gave{openCount(data.sent) > 0 ? ` · ${openCount(data.sent)}` : ""}
                {waiting > 0 && <span className="ms-1.5 pill pill-warn !py-0">{waiting} to review</span>}
              </button>
            </div>
          ) : (
            <span className="text-sm font-semibold flex-1">Tasks for me</span>
          )}
          {data.canAssign && (
            <button type="button" className="btn btn-sm btn-primary shrink-0" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> New
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className={`chip ${show === "open" ? "chip-on" : ""}`} aria-pressed={show === "open"} onClick={() => setShow("open")}>Open<span className="chip-count">{openCount(list)}</span></button>
          <button type="button" className={`chip ${show === "closed" ? "chip-on" : ""}`} aria-pressed={show === "closed"} onClick={() => setShow("closed")}>Done & cancelled</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {shown.length === 0 ? (
          <EmptyState
            compact
            icon={ClipboardCheck}
            title={show === "closed" ? "Nothing closed yet" : which === "mine" ? "No tasks for you" : "No open tasks you gave"}
            hint={show === "open" && which === "sent" && data.canAssign ? "Give one here, or ask the assistant: “give Ahmed a task to …”." : show === "open" && which === "mine" ? "Tasks given to you land here, and on this device when notifications are on." : undefined}
          />
        ) : (
          <div className="space-y-1">
            {shown.map((t) => <TaskRow key={t.id} t={t} which={which} on={t.id === openId} onPick={() => onOpen(t.id)} />)}
          </div>
        )}
      </div>
    </div>
  );

  const detail: ReactNode = creating ? (
    <TaskForm
      onCancel={() => setCreating(false)}
      onDone={(ids) => {
        setCreating(false);
        setWhich("sent");
        setShow("open");
        onChanged();
        if (ids.length === 1) onOpen(ids[0]);
      }}
    />
  ) : openId ? (
    <TaskPane key={openId} id={openId} onBack={split ? undefined : () => onOpen(null)} onChanged={onChanged} onOpen={onOpen} />
  ) : null;

  if (!split) return detail ?? listPane;
  return (
    <div className="flex h-full min-h-0">
      <div className="w-[340px] shrink-0 border-e min-h-0">{listPane}</div>
      <div className="flex-1 min-w-0 min-h-0">
        {detail ?? <div className="h-full grid place-items-center"><EmptyState icon={ClipboardCheck} title="Choose a task" hint="Its details, its updates and photos, and what you can do on it open here." /></div>}
      </div>
    </div>
  );
}
