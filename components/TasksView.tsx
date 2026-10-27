"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowLeft, Ban, CalendarClock, Check, CheckCircle2, ClipboardCheck, FileText, Flag, ListChecks, Loader2, Paperclip, Pause, Pencil, Play, Repeat, RotateCcw, Search, Send, Trash2, Undo2, Users, X,
} from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { EmptyState } from "@/components/primitives";
import { INBOX_CHANGED } from "@/components/InboxBell";
import { useConfirm } from "@/components/DataTable";
import { ChecklistEditor, StepsBar, TASK_VIEWS, TaskBoard, TaskCalendar, TaskFilterBar, TaskTeam, peopleOf, type TaskViewId } from "@/components/TasksViews";
import {
  deleteTaskRepeat, loadTask, markTaskSeen, postTaskUpdate, setTaskChecklist, setTaskRepeatEnabled, tickTaskStep,
} from "@/app/tasks/actions";
import { compressImage } from "@/lib/imageCompress";
import { traceHref } from "@/lib/domain/links";
import { formatDate, formatDateTime } from "@/lib/domain/format";
import { factoryDayISO } from "@/lib/domain/dates";
import {
  MOVE_NEEDS_TEXT, NO_FILTER, isFiltered, TASK_LIMITS, TASK_MOVE_LABEL, TASK_STATUS_LABEL, TASK_STATUS_TONE, filterTasks, isClosed,
  type TaskFilter, type TaskMove,
} from "@/lib/domain/tasks";
import type { TaskDetail, TaskRepeatView, TaskSummary, TasksData, TaskUpdateView } from "@/lib/server/tasks";
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
            {t.repeatId && <Repeat size={12} className="text-muted shrink-0" aria-label="Repeats" />}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-muted">
            <span className="truncate max-w-full" dir="auto">{who}</span>
            <DueLine due={t.dueDate} overdue={t.overdue} />
            <StepsBar steps={t.steps} />
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

/** A task's checklist: its giver and its people tick the steps while it is
 *  open; its giver can change the steps (those ticked stay ticked). */
function TaskChecklist({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const [editing, setEditing] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const open = !isClosed(task.status);
  const canTick = open && (task.role.giver || task.role.doer);
  const canEdit = open && task.role.giver;
  if (task.checklist.length === 0 && !canEdit) return null;

  const tick = (itemId: string, done: boolean) => {
    const fd = new FormData();
    fd.set("id", String(task.id));
    fd.set("item", itemId);
    fd.set("done", String(done));
    setMsg(null);
    start(async () => {
      const r = await tickTaskStep(fd).catch(() => ({ ok: false, error: "Not saved — check the connection and try again." }));
      if (!r.ok) setMsg(r.error ?? "Not saved.");
      onChanged();
    });
  };
  const save = () => {
    if (!editing) return;
    // a step kept as it was keeps its id — and so its tick
    const free = [...task.checklist];
    const items = editing.map((text) => {
      const n = free.findIndex((x) => x.text === text);
      return n >= 0 ? { id: free.splice(n, 1)[0].id, text } : { text };
    });
    const fd = new FormData();
    fd.set("id", String(task.id));
    fd.set("checklist", JSON.stringify(items));
    setMsg(null);
    start(async () => {
      const r = await setTaskChecklist(fd).catch(() => ({ ok: false, error: "Not saved — check the connection and try again." }));
      if (!r.ok) {
        setMsg(r.error ?? "Not saved.");
        return;
      }
      setEditing(null);
      onChanged();
    });
  };

  const done = task.checklist.filter((x) => x.done).length;
  return (
    <section className="rounded-xl border px-3 py-2.5 space-y-2" aria-label="Checklist">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-bold inline-flex items-center gap-1.5"><ListChecks size={15} aria-hidden /> Checklist</h4>
        {task.checklist.length > 0 && <span className="text-xs text-muted tabnum">{done} of {task.checklist.length} ticked</span>}
        {canEdit && !editing && (
          <button type="button" className="btn btn-ghost btn-sm ms-auto" onClick={() => setEditing(task.checklist.map((x) => x.text))}>
            <Pencil size={13} aria-hidden /> {task.checklist.length ? "Edit steps" : "Add steps"}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <ChecklistEditor value={editing} onChange={setEditing} disabled={pending} />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={pending}>{pending && <Loader2 size={13} className="animate-spin" aria-hidden />} Save steps</button>
          </div>
        </>
      ) : task.checklist.length > 0 ? (
        <>
          <StepsBar steps={{ done, total: task.checklist.length }} wide />
          <ul className="space-y-0.5">
            {task.checklist.map((x) => (
              <li key={x.id}>
                <label className={`task-step ${x.done ? "task-step-done" : ""} ${canTick ? "cursor-pointer" : ""}`}>
                  <input type="checkbox" checked={x.done} disabled={!canTick || pending} onChange={(e) => tick(x.id, e.target.checked)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="task-step-text text-sm" dir="auto">{x.text}</span>
                    {x.done && x.by && <span className="block text-[11px] text-muted">{x.by}{x.at ? ` · ${formatDateTime(x.at)}` : ""}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted">No steps yet — add the steps to tick, and they see how far it is.</p>
      )}
      {msg && <p className="text-xs font-semibold text-bad-fg">{msg}</p>}
    </section>
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
              {task.repeat && <span className="inline-flex items-center gap-1" title="Given by a repeating task"><Repeat size={12} aria-hidden /> {task.repeat.text}{task.repeat.enabled ? "" : " (paused)"}</span>}
              <span>{formatDateTime(task.createdAt)}</span>
            </div>
          </div>
          {task.details && (
            <div className="rounded-xl border bg-surface-2 px-3 py-2.5">
              <AiMarkdown text={task.details} shared className="!text-[13px]" />
            </div>
          )}
          <FilesView files={task.attachments} />
          <TaskChecklist task={task} onChanged={() => { read(); onChanged(); }} />
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
                  aria-label="Update on the task"
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

// ------------------------------------------------------------------ repeating ones

/** The giver's repeating tasks: how each comes, when next, pause or stop it. */
function RepeatList({ repeats, onChanged }: { repeats: TaskRepeatView[]; onChanged: () => void }) {
  const [askStop, confirmDialog] = useConfirm();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) =>
    start(async () => {
      const r = await fn(fd).catch(() => ({ ok: false, error: "Not saved — check the connection and try again." }));
      setMsg(r.ok ? null : r.error ?? "Not saved.");
      onChanged();
    });
  if (repeats.length === 0) {
    return <EmptyState compact icon={Repeat} title="No repeating tasks" hint="Give a task with “Repeat it by itself” on, and it comes back each day, week or month." />;
  }
  return (
    <div className="space-y-1.5">
      {repeats.map((r) => (
        <div key={r.id} className={`rounded-lg border px-3 py-2 ${r.enabled ? "" : "bg-surface-2"}`}>
          <div className="flex items-start gap-2">
            <Repeat size={14} className={`mt-0.5 shrink-0 ${r.enabled ? "text-brand-ink" : "text-muted"}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold truncate" dir="auto">{r.title}</div>
              <div className="text-[11px] text-muted">{r.text} · to {r.people.map((p) => p.name).join(", ")}</div>
              <div className="text-[11px] text-muted tabnum">{r.enabled ? (r.nextOn ? `Next: ${formatDate(r.nextOn)}` : "No next day within a year") : "Paused"}{r.lastGivenOn ? ` · last given ${formatDate(r.lastGivenOn)}` : ""}</div>
              {r.lastError && <div className="text-[11px] text-bad-fg font-semibold">{r.lastError}</div>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" className="icon-btn icon-btn-md" disabled={pending} title={r.enabled ? "Pause" : "Turn back on"} aria-label={r.enabled ? `Pause ${r.title}` : `Turn ${r.title} back on`}
                onClick={() => { const fd = new FormData(); fd.set("id", String(r.id)); fd.set("enabled", String(!r.enabled)); act(setTaskRepeatEnabled, fd); }}>
                {r.enabled ? <Pause size={15} /> : <Play size={15} />}
              </button>
              <button type="button" className="icon-btn icon-btn-md icon-btn-danger" disabled={pending} title="Stop for good" aria-label={`Stop ${r.title} for good`}
                onClick={async () => {
                  if (!(await askStop({ title: `Stop “${r.title}” for good?`, body: "It is given no more. The tasks it already gave stay.", confirmLabel: "Stop repeating", danger: true }))) return;
                  const fd = new FormData(); fd.set("id", String(r.id)); act(deleteTaskRepeat, fd);
                }}>
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        </div>
      ))}
      {msg && <p className="text-xs font-semibold text-bad-fg">{msg}</p>}
      {confirmDialog}
    </div>
  );
}

// ------------------------------------------------------------------ the tab

const VIEW_KEY = "tasks.view";

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
  const [show, setShow] = useState<Show | "repeating">("open");
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);
  const [view, setViewState] = useState<TaskViewId>(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY);
      return v === "board" || v === "calendar" || v === "team" ? v : "list";
    } catch {
      return "list";
    }
  });
  const setView = (v: TaskViewId) => {
    setViewState(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* a private window keeps no choice — the list stays the default */
    }
  };
  const views = TASK_VIEWS.filter((v) => v.id !== "team" || data.team);
  const current: TaskViewId = views.some((v) => v.id === view) ? view : "list";
  const today = factoryDayISO(new Date());

  const list = which === "mine" ? data.mine : data.sent;
  const people = useMemo(() => peopleOf(list), [list]);
  const filtered = useMemo(() => filterTasks(list, filter, today), [list, filter, today]);
  const openCount = (xs: TaskSummary[]) => xs.filter((t) => !isClosed(t.status)).length;
  const shown = filtered.filter((t) => (show === "closed" ? isClosed(t.status) : !isClosed(t.status)));
  const waiting = data.sent.filter((t) => t.status === "submitted").length;
  const filtering = isFiltered(filter);

  const whichSwitch = giver ? (
    <div className="segmented flex-1 min-w-[12rem] max-w-md">
      <button type="button" aria-pressed={which === "mine"} onClick={() => setWhich("mine")}>For me{openCount(data.mine) > 0 ? ` · ${openCount(data.mine)}` : ""}</button>
      <button type="button" aria-pressed={which === "sent"} onClick={() => { setWhich("sent"); }}>
        I gave{openCount(data.sent) > 0 ? ` · ${openCount(data.sent)}` : ""}
        {waiting > 0 && <span className="ms-1.5 pill pill-warn !py-0">{waiting} to review</span>}
      </button>
    </div>
  ) : (
    <span className="text-sm font-semibold flex-1">Tasks for me</span>
  );
  // the views by their icons beside For me | I gave (the list's narrow
  // column, the corner card); spelled out where the board has the width
  const viewSwitch = (icons: boolean) =>
    views.length > 1 && (
      <div className="segmented shrink-0" role="group" aria-label="View">
        {views.map((v) => (
          <button key={v.id} type="button" aria-pressed={current === v.id} onClick={() => setView(v.id)} title={v.label} aria-label={icons ? v.label : undefined}>
            <v.icon size={14} aria-hidden />{!icons && <span className="ms-1">{v.label}</span>}
          </button>
        ))}
      </div>
    );

  const listPane = (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2.5 space-y-2 border-b shrink-0">
        <div className="flex items-center gap-2">{whichSwitch}{viewSwitch(true)}</div>
        <TaskFilterBar f={filter} onChange={setFilter} people={people} count={filtered.length}>
          <button type="button" className={`chip ${show === "open" ? "chip-on" : ""}`} aria-pressed={show === "open"} onClick={() => setShow("open")}>Open<span className="chip-count">{openCount(filtered)}</span></button>
          <button type="button" className={`chip ${show === "closed" ? "chip-on" : ""}`} aria-pressed={show === "closed"} onClick={() => setShow("closed")}>Done & cancelled</button>
          {which === "sent" && (data.repeats.length > 0 || data.canAssign) && (
            <button type="button" className={`chip ${show === "repeating" ? "chip-on" : ""}`} aria-pressed={show === "repeating"} onClick={() => setShow("repeating")}>
              <Repeat size={12} aria-hidden /> Repeating{data.repeats.length > 0 && <span className="chip-count">{data.repeats.filter((r) => r.enabled).length}</span>}
            </button>
          )}
        </TaskFilterBar>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {show === "repeating" && which === "sent" ? (
          <RepeatList repeats={data.repeats} onChanged={onChanged} />
        ) : shown.length === 0 ? (
          <EmptyState
            compact
            icon={filtering ? Search : ClipboardCheck}
            title={filtering ? "No task matches" : show === "closed" ? "Nothing closed yet" : which === "mine" ? "No tasks for you" : "No open tasks you gave"}
            hint={filtering ? "Change the search or the filters, or clear them." : show === "open" && which === "sent" && data.canAssign ? "Ask the assistant to give one: “give Ahmed a task to …”." : show === "open" && which === "mine" ? "Tasks given to you land here, and on this device when notifications are on." : undefined}
            action={filtering ? <button type="button" className="btn btn-sm" onClick={() => setFilter(NO_FILTER)}>Clear filters</button> : undefined}
          />
        ) : (
          <div className="space-y-1">
            {shown.map((t) => <TaskRow key={t.id} t={t} which={which} on={t.id === openId} onPick={() => onOpen(t.id)} />)}
          </div>
        )}
      </div>
    </div>
  );

  const detail: ReactNode = openId ? (
    <TaskPane key={openId} id={openId} onBack={split && current === "list" ? undefined : () => onOpen(null)} onChanged={onChanged} onOpen={onOpen} />
  ) : null;

  // the board, the month and the team: the whole width, the open task beside them
  if (current !== "list") {
    const mineOf = (t: TaskSummary) => which === "mine" || t.assignees.some((a) => a.id === t.createdById);
    const body = filtering && filtered.length === 0 && current !== "team" ? (
      <EmptyState icon={Search} title="No task matches" hint="Change the search or the filters, or clear them." action={<button type="button" className="btn btn-sm" onClick={() => setFilter(NO_FILTER)}>Clear filters</button>} />
    ) : current === "board" ? (
      <TaskBoard list={filtered.filter((t) => t.status !== "cancelled")} openId={openId} onOpen={onOpen} mineOf={mineOf} />
    ) : current === "calendar" ? (
      <TaskCalendar list={filtered.filter((t) => !isClosed(t.status))} todayISO={today} openId={openId} onOpen={onOpen} />
    ) : (
      <TaskTeam team={data.team ?? []} owner={data.teamAll} onPick={(id) => { setWhich("sent"); setFilter({ ...NO_FILTER, person: id }); setView("list"); }} />
    );
    const main = (
      <div className="flex flex-col h-full min-h-0">
        <div className="p-2.5 space-y-2 border-b shrink-0">
          <div className="flex flex-wrap items-center gap-2">{current !== "team" && whichSwitch}{viewSwitch(!split)}</div>
          {current !== "team" && <TaskFilterBar f={filter} onChange={setFilter} people={people} count={filtered.length} />}
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-2.5">{body}</div>
      </div>
    );
    if (!split) return detail ?? main;
    return (
      <div className="flex h-full min-h-0">
        <div className="flex-1 min-w-0 min-h-0">{main}</div>
        {detail && <div className="w-[420px] max-w-[45%] shrink-0 border-s min-h-0">{detail}</div>}
      </div>
    );
  }

  if (!split) return detail ?? listPane;
  return (
    <div className="flex h-full min-h-0">
      <div className="w-[360px] shrink-0 border-e min-h-0">{listPane}</div>
      <div className="flex-1 min-w-0 min-h-0">
        {detail ?? <div className="h-full grid place-items-center"><EmptyState icon={ClipboardCheck} title="Choose a task" hint="Its details, its checklist, its updates and photos, and what you can do on it open here." /></div>}
      </div>
    </div>
  );
}
