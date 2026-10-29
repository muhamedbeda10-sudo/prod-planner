"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  AlertCircle, ArrowDown, BarChart3, Bot, Brain, Boxes, Check, ChevronRight, Clock, Copy, CornerDownRight, Crosshair, Factory, FileSpreadsheet, FileText, Image as ImageIcon,
  Layers, ListChecks, Loader2, Paperclip, RotateCcw, ScanLine, Search, Send, Share2, Sparkles, Square, Telescope, X, Zap,
} from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { AiActionCard, ApproveAll } from "@/components/AiActionCard";
import { AiPrintButton } from "@/components/AiPrint";
import { aiFileHref } from "@/lib/domain/links";
import { useAsk, useConfirm } from "@/components/DataTable";
import { Modal } from "@/components/Modal";
import { AiQuickGrid } from "@/components/AiQuickActions";
import { ShareDialog } from "@/components/AiShare";
import { deleteAiConversations, discardAiFile, loadAiConversation, pinAiConversations, renameAiConversation, uploadAiFile } from "@/app/ai/actions";
import { loadAiChat } from "@/app/ai/panel/actions";
import { AI_MAX_QUESTION, aiModel, usdText, type AiChatTurn, type AiStep } from "@/lib/domain/ai";
import { AI_CONVERSATION_TITLE_MAX, AI_DEPTHS, AI_DEPTH_META, DEFAULT_AI_DEPTH, followupsOf, hasPageSuggestions, isAiDepth, suggestionsFor, withoutFollowups, type AiDepth } from "@/lib/domain/aiAnswer";
import { composeQuickQuestion, quickActionsFor, type AiQuickAction } from "@/lib/domain/aiQuickActions";
import { durationText } from "@/lib/domain/format";
import { AI_FILE_ACCEPT, AI_FILE_LIMITS, AI_IMAGE_MAX_SIDE, AI_IMAGE_QUALITY, SCAN_SHEET_QUESTION, fileSizeText } from "@/lib/domain/aiFiles";
import { compressImage } from "@/lib/imageCompress";
import { onHandedQuestion, takeHandedQuestion, type HandedFile, type HandedQuestion } from "@/lib/aiAsk";
import type { AiActionView } from "@/lib/domain/aiActions";
import type { AiChatStatus } from "@/lib/server/ai/panel";
import { captureAiPage } from "@/lib/domain/aiScreen";
import { tabForPath } from "@/lib/domain/tabs";
import { useActiveLine, useCarryLine } from "@/components/LineContext";
import { readAiStream } from "@/lib/aiStream";
import { AnswerRating } from "@/components/AiFeedback";
import type { AiFeedbackRating } from "@/lib/domain/aiLearn";

// The AI assistant's chat: the open conversation (whoever holds the chat draws
// the list of them — components/AiChatList — from `onApi`), the answer
// streaming in as it is written — the steps it takes as a
// timeline (each look-up with its time and its rows, folded once the answer
// is in), the changes it prepares as cards to approve, the next questions
// it offers as chips, and a bar under it naming the model, the time and (for
// the owner) the cost, with Copy, Print, Share (components/AiShare) and
// 👍 / 👎. Stop halts an answer — the server stops too and keeps what was
// written; Retry asks a failed question again, with its files; ↑ in the
// empty box brings the last question back. The depth beside the box —
// Quick / Standard / Deep — says how hard to work the next question.
// A photo, a PDF or a sheet can go with a question: the paperclip sends it
// to the app first (a photo shrunk to what reads well), and the question
// carries its number; the photo shows on the question after. A question
// handed over from elsewhere on the page (a cockpit decision's "Ask") lands
// in the box, for the person to send. An empty chat opens on what the
// assistant can do — tiles for a report, a chart, an Excel file, a what-if…
// (lib/domain/aiQuickActions), each with a short form — and the composer's ✨
// brings the same tiles back in a chat already going.

interface Turn extends AiChatTurn {
  error?: string;
  /** What it began to remember about the person during this answer. */
  remembered?: string[];
  /** The steps of a live answer — each look-up or change with its timing. */
  steps?: AiStep[];
  /** How long it took and what it cost — a live answer's. */
  ms?: number;
  cost?: number;
  /** Stopped by the person before it finished. */
  stopped?: boolean;
  /** When the question went — the live line counts from it. */
  startedAt?: number;
}

export interface Conv {
  id: number;
  title: string;
  updatedAt: string;
  pinned?: boolean;
}

/** The chat's list of conversations and what moves it — handed to whoever
 *  draws the list outside the chat (the popup's sidebar, its History pane). */
export interface ChatListApi {
  convs: Conv[];
  activeId: number | null;
  activeTitle: string | null;
  busy: boolean;
  open: (id: number) => void;
  newChat: () => void;
  /** Delete these chats, once the person confirms — whether they went, and why not when it failed. */
  removeMany: (list: Conv[]) => Promise<ListResult>;
  rename: (c: Conv) => Promise<ListResult>;
  /** Pin (or unpin) these chats together — whether it worked. */
  pinMany: (list: Conv[], pinned: boolean) => Promise<ListResult>;
}

/** What a move on the list came to: done, or the reason it failed (none when the person cancelled). */
export interface ListResult {
  ok: boolean;
  error?: string;
}

/** A file attached and kept, waiting for the question it goes with. */
type Pending = HandedFile;

export type { AiChatStatus };

const SUGGESTION_ICONS = [ListChecks, Clock, Factory, Boxes, BarChart3, Layers];

const DEPTH_ICON: Record<AiDepth, typeof Zap> = { quick: Zap, standard: Crosshair, deep: Telescope };
const DEPTH_KEY = "ai:depth";

/** "Opus 5.5" — the model as the answer's bar names it. */
const modelShort = (id: string) => aiModel(id).label.replace(/^Claude\s+/, "");

export function AiChat({
  isOwner,
  status,
  conversations,
  initial,
  compact = false,
  syncUrl = true,
  canAutomate = false,
  onApi,
}: {
  isOwner: boolean;
  status: AiChatStatus;
  conversations: Conv[];
  initial: { id: number; turns: AiChatTurn[]; actions: AiActionView[]; ratings?: Record<number, AiFeedbackRating> } | null;
  /** Narrow (the docked window, a phone): the tiles and questions in fewer columns. */
  compact?: boolean;
  /** Keep the open chat in the address bar (the /ai page). */
  syncUrl?: boolean;
  /** The person may make automations — the "New automation" tile shows. */
  canAutomate?: boolean;
  /** Told the list and its moves whenever they change. */
  onApi?: (api: ChatListApi) => void;
}) {
  const pathname = usePathname() ?? "/ai";
  const line = useActiveLine();
  const carryLine = useCarryLine();
  const [convs, setConvs] = useState<Conv[]>(conversations);
  const [activeId, setActiveId] = useState<number | null>(initial?.id ?? null);
  const [turns, setTurns] = useState<Turn[]>(initial?.turns ?? []);
  // the cards, by the tool call that prepared them
  const [actions, setActions] = useState<Record<string, AiActionView>>(() => byCall(initial?.actions ?? []));
  const putAction = (v: AiActionView) => setActions((m) => (v.toolUseId ? { ...m, [v.toolUseId]: v } : m));
  // the person's 👍 / 👎, by the answer's place among the chat's answers
  const [ratings, setRatings] = useState<Record<number, AiFeedbackRating>>(initial?.ratings ?? {});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [spent, setSpent] = useState({ user: status.userSpent, plant: status.plantSpent, userToday: status.userSpentToday, plantToday: status.plantSpentToday });
  const [quickOpen, setQuickOpen] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(0);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [depth, setDepth] = useState<AiDepth>(DEFAULT_AI_DEPTH);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const sending = useRef(false);
  const aborter = useRef<AbortController | null>(null);
  /** The running question's first event reached the screen (its chat is in the list). */
  const started = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  // deltas arrive token by token — gathered and drawn a few times a second
  const delta = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ask, askDialog] = useAsk();
  const [confirmIt, confirmDialog] = useConfirm();
  // the prompts as refs: they are made anew each render, and the list's
  // moves must keep their identity (the window keeps them in state)
  const askRef = useRef(ask);
  askRef.current = ask;
  const confirmRef = useRef(confirmIt);
  confirmRef.current = confirmIt;

  const capReached =
    (status.userCap > 0 && spent.user >= status.userCap) ||
    (status.plantCap > 0 && spent.plant >= status.plantCap) ||
    (status.userDayCap > 0 && spent.userToday >= status.userDayCap) ||
    (status.plantDayCap > 0 && spent.plantToday >= status.plantDayCap);
  const canAsk = status.ok && !capReached;

  // a question handed over from the page (a cockpit decision's "Ask"): in a
  // new chat, in the box beside any draft, ready to send — taken when the
  // chat is made, when one is handed over, and once an answer being written
  // ends (never into it). A right-click's "Ask AI" — and a table sent with
  // the AI mark at its corner, with its file — is sent as soon as the new
  // chat is clear — unless the box holds a draft or files of the person's
  // own, which it would carry off: then it waits in the box like the rest.
  const [autoAsk, setAutoAsk] = useState<HandedQuestion | null>(null);
  /** In the box beside any draft, ready to send. */
  const putInBox = (q: string, files: Pending[] = []) => {
    setInput((draft) => (draft.trim() ? `${draft.trimEnd()}\n\n${q}` : q));
    // a handed file joins the person's own — past the limit, sending says so
    if (files.length > 0) setPending((all) => [...all, ...files.filter((f) => !all.some((a) => a.id === f.id))]);
    // the window may still be opening: focus once it shows
    requestAnimationFrame(() => box.current?.focus());
  };
  const takeHanded = useRef<() => void>(() => {});
  takeHanded.current = () => {
    if (busy || sending.current) return;
    const h = takeHandedQuestion();
    if (!h) return;
    if (turns.length > 0 || activeId !== null) newChat();
    if ((h.explain || h.files.length > 0) && !input.trim() && pending.length === 0) setAutoAsk(h);
    else putInBox(h.question, h.files);
  };
  useEffect(() => {
    takeHanded.current();
    return onHandedQuestion(() => takeHanded.current());
  }, []);
  useEffect(() => {
    if (!busy) takeHanded.current();
  }, [busy]);

  // the depth the person last picked, on this browser
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DEPTH_KEY);
      if (isAiDepth(saved)) setDepth(saved);
    } catch { /* storage is optional */ }
  }, []);
  const pickDepth = (d: AiDepth) => {
    setDepth(d);
    try { localStorage.setItem(DEPTH_KEY, d); } catch { /* storage is optional */ }
  };

  // Keep following only while the person is at the bottom. Reading an older
  // figure must not be interrupted by every token of the next answer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // an empty chat opens on its tiles, at the top
    if (turns.length === 0) el.scrollTop = 0;
    else if (following.current) el.scrollTop = el.scrollHeight;
    else setShowLatest(true);
  }, [turns, live]);

  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current); }, []);

  const patchLast = (f: (t: Turn) => Turn) =>
    setTurns((all) => {
      if (all.length === 0) return all;
      const copy = all.slice();
      copy[copy.length - 1] = f(copy[copy.length - 1]);
      return copy;
    });

  const flush = () => {
    flushTimer.current = null;
    const d = delta.current;
    delta.current = "";
    if (d) patchLast((t) => ({ ...t, text: t.text + d }));
  };

  const setUrl = useCallback(
    (id: number | null) => {
      // a line the address names stays in it, so the next question asks on it too
      if (syncUrl) window.history.replaceState(null, "", carryLine(id ? `/ai?c=${id}` : "/ai"));
    },
    [syncUrl, carryLine],
  );

  const open = useCallback(
    async (id: number) => {
      if (busy) return;
      setLoadErr(null);
      const r = await loadAiConversation(id);
      if (!r.ok) {
        setLoadErr(r.error ?? "Could not open it.");
        return;
      }
      setActiveId(id);
      following.current = true;
      setShowLatest(false);
      setTurns(r.turns ?? []);
      setActions(byCall(r.actions ?? []));
      setRatings(r.ratings ?? {});
      setUrl(id);
    },
    [busy, setUrl],
  );

  const newChat = useCallback(() => {
    if (busy) return;
    setActiveId(null);
    following.current = true;
    setShowLatest(false);
    setTurns([]);
    setActions({});
    setRatings({});
    setLoadErr(null);
    setUrl(null);
    box.current?.focus();
  }, [busy, setUrl]);

  const removeMany = useCallback(
    async (list: Conv[]) => {
      if (busy || list.length === 0) return { ok: false };
      const ok = await confirmRef.current({
        title: list.length === 1 ? "Delete this chat?" : `Delete ${list.length} chats?`,
        body: "They go for good, with their answers and ratings. What they cost stays in the usage log.",
        items: list.map((c) => c.title),
        confirmLabel: list.length === 1 ? "Delete" : `Delete ${list.length}`,
        danger: true,
      });
      if (!ok) return { ok: false };
      const r = await deleteAiConversations(list.map((c) => c.id)).catch(() => null);
      if (!r?.ok) return { ok: false, error: r?.error ?? "Could not delete them — try again." };
      const gone = new Set(r.deleted ?? []);
      setConvs((all) => all.filter((x) => !gone.has(x.id)));
      if (activeId !== null && gone.has(activeId)) newChat();
      return { ok: true };
    },
    [busy, activeId, newChat],
  );

  const rename = useCallback(
    async (c: Conv) => {
      const v = await askRef.current({
        title: "Rename this chat",
        fields: [{ name: "title", label: "Name", type: "text", defaultValue: c.title, required: true, placeholder: "e.g. Welding — week 43" }],
        confirmLabel: "Rename",
      });
      const title = v?.title.replace(/\s+/g, " ").trim().slice(0, AI_CONVERSATION_TITLE_MAX);
      if (!title || title === c.title) return { ok: false };
      const r = await renameAiConversation(c.id, title).catch(() => null);
      if (!r?.ok) return { ok: false, error: r?.error ?? "Could not rename it — try again." };
      setConvs((all) => all.map((x) => (x.id === c.id ? { ...x, title } : x)));
      return { ok: true };
    },
    [],
  );

  const pinMany = useCallback(async (list: Conv[], pinned: boolean) => {
    if (list.length === 0) return { ok: false };
    const r = await pinAiConversations(list.map((c) => c.id), pinned).catch(() => null);
    if (!r?.ok) return { ok: false, error: r?.error ?? "Could not pin them — try again." };
    const changed = new Set(r.changed ?? []);
    setConvs((all) => all.map((x) => (changed.has(x.id) ? { ...x, pinned } : x)));
    return { ok: true };
  }, []);

  const activeTitle = convs.find((c) => c.id === activeId)?.title ?? null;

  // the list outside the chat follows it
  useEffect(() => {
    onApi?.({ convs, activeId, activeTitle, busy, open, newChat, removeMany, rename, pinMany });
  }, [onApi, convs, activeId, activeTitle, busy, open, newChat, removeMany, rename, pinMany]);

  function handle(ev: { type: string; [k: string]: unknown }, question: string) {
    if (ev.type === "start") {
      started.current = true;
      const id = Number(ev.conversationId);
      setActiveId(id);
      setUrl(id);
      setConvs((all) => [{ id, title: String(ev.title ?? question), updatedAt: new Date().toISOString(), pinned: all.find((c) => c.id === id)?.pinned ?? false }, ...all.filter((c) => c.id !== id)]);
      const model = typeof ev.model === "string" ? ev.model : undefined;
      if (model) patchLast((t) => ({ ...t, model }));
    } else if (ev.type === "status") {
      flush();
      setLive(String(ev.text ?? ""));
    } else if (ev.type === "step") {
      flush();
      const step = ev as unknown as AiStep;
      if (typeof step.id !== "string" || typeof step.text !== "string") return;
      patchLast((t) => {
        const steps = t.steps ?? [];
        const at = steps.findIndex((s) => s.id === step.id);
        return { ...t, steps: at >= 0 ? steps.map((s, i) => (i === at ? { ...s, ...step } : s)) : [...steps, step] };
      });
    } else if (ev.type === "text") {
      setLive(null);
      delta.current += String(ev.delta ?? "");
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, 60);
    } else if (ev.type === "action") {
      const v = ev.action as AiActionView;
      putAction(v);
      if (v.toolUseId) {
        const id = v.toolUseId;
        patchLast((t) => ({ ...t, actionIds: [...(t.actionIds ?? []).filter((x) => x !== id), id] }));
      }
    } else if (ev.type === "memory") {
      const text = String(ev.text ?? "");
      if (text) patchLast((t) => ({ ...t, remembered: [...(t.remembered ?? []), text] }));
    } else if (ev.type === "done") {
      flush();
      const cost = Number(ev.costUsd ?? 0);
      const ms = Number(ev.totalMs);
      setSpent((s) => ({ user: s.user + cost, plant: s.plant + cost, userToday: s.userToday + cost, plantToday: s.plantToday + cost }));
      patchLast((t) => ({ ...t, cost, ...(Number.isFinite(ms) ? { ms } : {}), ...(ev.error ? { error: String(ev.error) } : {}) }));
    }
  }

  /** Send picked files to the app, one by one — each kept as it arrives.
   *  How many were kept. */
  async function attach(list: FileList | null): Promise<number> {
    const picked = [...(list ?? [])];
    if (picker.current) picker.current.value = "";
    if (camera.current) camera.current.value = "";
    if (picked.length === 0) return 0;
    let kept = 0;
    setFileErr(null);
    const room = AI_FILE_LIMITS.perQuestion - pending.length;
    if (picked.length > room) setFileErr(`At most ${AI_FILE_LIMITS.perQuestion} files with one question.`);
    for (const raw of picked.slice(0, Math.max(0, room))) {
      // a phone photo is several MB: shrunk to what still reads well
      const f = await compressImage(raw, { maxDimension: AI_IMAGE_MAX_SIDE, quality: AI_IMAGE_QUALITY });
      if (f.size > AI_FILE_LIMITS.maxBytes) {
        setFileErr(`"${f.name}" is ${fileSizeText(f.size)} — at most ${fileSizeText(AI_FILE_LIMITS.maxBytes)} a file.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const fd = new FormData();
        fd.set("file", f);
        const r = await uploadAiFile(fd);
        if (r.ok) {
          setPending((all) => [...all, r.file]);
          kept++;
        } else setFileErr(r.error);
      } catch {
        setFileErr(`"${f.name}" could not be sent — try again.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    return kept;
  }

  /** A photo of a paper sheet: attached, and the question to read it put in
   *  the box (theirs kept when they already wrote one) — ready to send. */
  async function scan(list: FileList | null) {
    if (!list || list.length === 0) return;
    // the question only with a photo that went: never "read this sheet" with no sheet
    if ((await attach(list)) === 0) return;
    setInput((q) => (q.trim() ? q : SCAN_SHEET_QUESTION));
    box.current?.focus();
  }

  function unattach(id: number) {
    setPending((all) => all.filter((f) => f.id !== id));
    void discardAiFile(id);
  }

  /** Stop the answer being written: the server stops the model too, keeps
   *  what was written in this chat, and frees the next question. */
  function stop() {
    aborter.current?.abort();
  }

  /** The chats read again — after a stop before the chat's first event
   *  reached the screen, the new chat is on the server and not in the list. */
  async function refreshList() {
    const r = await loadAiChat();
    if (!r.ok || r.conversations.length === 0) return;
    setConvs(r.conversations);
    const newest = r.conversations.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    setActiveId(newest.id);
    setUrl(newest.id);
  }

  /** Ask — with the files attached in the box, or (asking again) the ones
   *  that went with the question the first time. */
  async function askQuestion(text: string, again?: { id: number; name: string; kind: string; size?: number }[], o: { explain?: boolean } = {}) {
    const question = text.trim();
    if (!question || busy || sending.current || !canAsk || uploading > 0) return;
    sending.current = true;
    following.current = true;
    setShowLatest(false);
    const sent: Pending[] = again ? again.map((f) => ({ ...f, size: f.size ?? 0 })) : pending;
    setInput("");
    setPending([]);
    setFileErr(null);
    setBusy(true);
    setLive("Reading the question");
    setTurns((all) => [
      ...all,
      { role: "user", text: question, lookups: [], ...(sent.length ? { files: sent.map(({ id, name, kind }) => ({ id, name, kind })) } : {}) },
      { role: "assistant", text: "", lookups: [], steps: [], startedAt: Date.now() },
    ]);
    const controller = new AbortController();
    aborter.current = controller;
    started.current = false;
    try {
      // the line on screen rides in the address, like a page's, so the
      // assistant's answers and the changes it prepares start from it
      const res = await fetch(`/api/ai/chat?line=${line}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ conversationId: activeId, question, fileIds: sent.map((f) => f.id), depth, page: captureAiPage(pathname, line, window.location.search, (key) => sessionStorage.getItem(key)), explain: o.explain || undefined }),
      });
      if (!res.ok || !res.body) {
        // refused before it began: the files wait for the next try
        setPending(sent);
        setInput((draft) => draft || question);
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `The request failed (${res.status}).`);
      }
      await readAiStream(res.body, (event) => handle(event, question));
    } catch (e) {
      flush();
      if (controller.signal.aborted) {
        patchLast((t) => ({ ...t, stopped: true, ms: Date.now() - (t.startedAt ?? Date.now()), steps: (t.steps ?? []).map((s) => (s.state === "start" ? { ...s, state: "error" as const } : s)) }));
        // stopped before the chat's first event: the chat is on the server, not in the list yet
        if (!started.current) await refreshList();
      } else patchLast((t) => ({ ...t, error: e instanceof Error ? e.message : "The request failed." }));
    } finally {
      flush();
      aborter.current = null;
      setBusy(false);
      sending.current = false;
      setLive(null);
    }
  }

  // "Ask AI": sent once the new chat it was handed into has cleared — to
  // explain only (the reading tools alone); a table sent from a screen, with
  // its file, as a question like any other. Something in the way by then (a
  // cap reached, a file on its way): it waits in the box instead.
  const askRefFn = useRef(askQuestion);
  askRefFn.current = askQuestion;
  useEffect(() => {
    if (autoAsk === null || activeId !== null || turns.length > 0) return;
    const q = autoAsk;
    setAutoAsk(null);
    if (busy || sending.current || !canAsk || uploading > 0 || pending.length > 0) putInBox(q.question, q.files);
    else void askRefFn.current(q.question, q.files.length > 0 ? q.files : undefined, { explain: q.explain });
  }, [autoAsk, activeId, turns.length, busy, canAsk, uploading, pending.length]);

  // what the assistant can do: a tile's form, then its question — sent at
  // once, unless the box holds a draft or files of the person's own (then it
  // joins them there, for the person to send)
  const quick = useMemo(() => quickActionsFor({ automations: canAutomate }), [canAutomate]);
  async function runQuick(a: AiQuickAction) {
    setQuickOpen(false);
    if (a.id === "scan") {
      camera.current?.click();
      return;
    }
    let values: Record<string, string> = {};
    if (a.fields.length > 0) {
      const v = await askRef.current({ title: a.label, body: a.hint, fields: a.fields, confirmLabel: a.confirmLabel ?? "Ask" });
      if (!v) return;
      values = v;
    }
    const q = composeQuickQuestion(a.id, values);
    // the form was open a while: read the chat as it is now, not as it was at the click
    if (q) sendQuick.current(q);
  }
  const sendQuick = useRef<(q: string) => void>(() => {});
  sendQuick.current = (q: string) => {
    if (!canAsk || busy || sending.current || uploading > 0 || input.trim() || pending.length > 0) putInBox(q);
    else void askQuestion(q);
  };

  // each answer's place among the chat's answers — what a 👍 / 👎 is kept by
  const answerNo: number[] = [];
  let answers = 0;
  for (const t of turns) {
    answerNo.push(answers);
    if (t.role === "assistant") answers += 1;
  }
  const lastQuestion = [...turns].reverse().find((t) => t.role === "user")?.text ?? "";
  const tab = tabForPath(pathname);

  return (
    <div className="ai-chat relative flex h-full min-h-[380px]">
      {askDialog}
      {confirmDialog}
      {quickOpen && (
        <Modal title="What the assistant can do" onClose={() => setQuickOpen(false)} width="max-w-3xl">
          <AiQuickGrid actions={quick} onPick={(a) => void runQuick(a)} disabled={!canAsk} compact />
        </Modal>
      )}

      {/* the open conversation */}
      <section className="flex-1 min-w-0 flex flex-col bg-surface overflow-hidden">
        <div ref={scroller} onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 100;
          if (following.current) setShowLatest(false);
        }} className="flex-1 overflow-y-auto px-3 py-4 sm:px-5 md:px-8 md:py-6">
          {loadErr && <p className="text-sm font-semibold text-bad-fg mb-3">{loadErr}</p>}
          {turns.length === 0 ? (
            <Welcome tabId={tab?.id ?? null} tabLabel={tab?.label ?? null} actions={quick} onAction={(a) => void runQuick(a)} onPick={(q) => (canAsk ? askQuestion(q) : setInput(q))} disabled={!canAsk || busy} compact={compact} />
          ) : (
            <div className={`${compact ? "max-w-3xl" : "max-w-4xl"} mx-auto space-y-6`}>
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="ai-turn flex flex-col items-end gap-1.5">
                    {t.files && t.files.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5 max-w-[88%] sm:max-w-[78%]">
                        {t.files.map((f) => <SentFile key={f.id} file={f} />)}
                      </div>
                    )}
                    <div dir="auto" className="ai-bubble">{t.text}</div>
                  </div>
                ) : (
                  <Answer
                    key={i}
                    turn={t}
                    question={turns[i - 1]?.role === "user" ? turns[i - 1].text : ""}
                    live={busy && i === turns.length - 1 ? live : null}
                    streaming={busy && i === turns.length - 1}
                    isOwner={isOwner}
                    actions={(t.actionIds ?? []).flatMap((id) => (actions[id] ? [actions[id]] : []))}
                    onAction={putAction}
                    onFollowup={(q) => (canAsk && !busy ? askQuestion(q) : setInput(q))}
                    onRetry={!busy && canAsk && turns[i - 1]?.role === "user" ? () => askQuestion(turns[i - 1].text, turns[i - 1].files ?? []) : null}
                    rating={activeId !== null && !(busy && i === turns.length - 1) ? {
                      conversationId: activeId,
                      answer: answerNo[i],
                      text: t.text,
                      value: ratings[answerNo[i]] ?? null,
                      onRated: (r: AiFeedbackRating) => setRatings((m) => ({ ...m, [answerNo[i]]: r })),
                    } : null}
                  />
                ),
              )}
            </div>
          )}
        </div>

        {showLatest && (
          <div className="flex justify-center py-1">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
              following.current = true;
              setShowLatest(false);
              if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            }}><ArrowDown size={14} aria-hidden />Latest answer</button>
          </div>
        )}
        <form
          className="px-3 pb-3 pt-1 sm:px-5 md:px-8"
          onSubmit={(e) => {
            e.preventDefault();
            askQuestion(input);
          }}
        >
          <div className={`${compact ? "max-w-3xl" : "max-w-4xl"} mx-auto`}>
            <div className="mb-1.5 flex justify-end">
              <div className="seg seg-sm ai-depth" role="group" aria-label="How deep to work the next question">
                {AI_DEPTHS.map((d) => {
                  const Icon = DEPTH_ICON[d];
                  return (
                    <button key={d} type="button" aria-pressed={depth === d} className={depth === d ? "on" : ""} onClick={() => pickDepth(d)} title={AI_DEPTH_META[d].hint} disabled={!canAsk}>
                      <Icon size={11} aria-hidden /> {AI_DEPTH_META[d].label}
                    </button>
                  );
                })}
              </div>
            </div>
            {!canAsk && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border bg-surface-2 px-3 py-2 text-xs">
                <AlertCircle size={14} className="text-warn-fg mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0">
                  {status.reason ?? "The AI allowance is used up."}
                  {isOwner && <> <a href="/admin/ai" className="font-semibold text-brand-ink underline underline-offset-2">Settings</a></>}
                </span>
              </div>
            )}
            <div className={`composer ${!canAsk ? "opacity-60" : ""} ${busy ? "composer-busy" : ""}`}>
              <textarea
                ref={box}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    askQuestion(input);
                  } else if (e.key === "ArrowUp" && !input && lastQuestion && !busy) {
                    // the last question back in the box, to change and send again
                    e.preventDefault();
                    setInput(lastQuestion);
                  } else if (e.key === "Escape" && busy) {
                    e.preventDefault();
                    stop();
                  }
                }}
                rows={Math.min(6, Math.max(1, input.split("\n").length))}
                maxLength={AI_MAX_QUESTION}
                dir="auto"
                enterKeyHint="send"
                disabled={!canAsk}
                placeholder={canAsk ? "Ask about the plant…" : ""}
                // 16px: a phone zooms the page into a smaller box
                className="w-full min-w-0 resize-none text-base leading-relaxed"
              />
              <div className="flex items-center gap-1.5 px-2 pb-2">
                <button
                  type="button"
                  className="icon-btn ai-quick-btn"
                  onClick={() => setQuickOpen(true)}
                  disabled={!canAsk || busy}
                  aria-label="What the assistant can do"
                  title="What the assistant can do — a report, a chart, an Excel file, a what-if, a plan to a deadline…"
                >
                  <Sparkles size={16} />
                </button>
                <input ref={picker} type="file" accept={AI_FILE_ACCEPT} multiple hidden onChange={(e) => void attach(e.target.files)} />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => picker.current?.click()}
                  disabled={!canAsk || busy || pending.length >= AI_FILE_LIMITS.perQuestion}
                  aria-label="Attach a photo, a PDF or a sheet"
                  title="Attach a photo, a PDF or a sheet (Excel, CSV) — to read it, take figures off it, or import it"
                >
                  <Paperclip size={16} />
                </button>
                {/* on a phone, straight to the back camera; elsewhere, an image to pick */}
                <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void scan(e.target.files)} />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => camera.current?.click()}
                  disabled={!canAsk || busy || pending.length >= AI_FILE_LIMITS.perQuestion}
                  aria-label="Scan a handwritten sheet"
                  title="Scan a handwritten sheet — take a photo of a paper form (output, attendance, stops…) and the assistant reads it and prepares the records for your approval"
                >
                  <ScanLine size={16} />
                </button>
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
                  {pending.map((f) => (
                    <span key={f.id} className="pill pill-muted gap-1 max-w-full" dir="auto">
                      <FileKindIcon kind={f.kind} size={12} /> <span className="truncate">{f.name}</span> <span className="text-muted">{fileSizeText(f.size)}</span>
                      <button type="button" onClick={() => unattach(f.id)} disabled={busy} className="-me-1 p-0.5 rounded hover:bg-surface-3" aria-label={`Remove ${f.name}`} title="Remove">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {uploading > 0 && (
                    <span className="text-xs text-muted inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Sending…</span>
                  )}
                  {fileErr && <span className="text-xs font-semibold text-bad-fg" dir="auto">{fileErr}</span>}
                </div>
                {busy ? (
                  <button type="button" className="composer-stop shrink-0" onClick={stop} aria-label="Stop the answer" title="Stop the answer (Esc) — what is written stays">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button type="submit" className="composer-send shrink-0" disabled={!canAsk || uploading > 0 || !input.trim()} aria-label="Send" title="Send (Enter)">
                    <Send size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function Welcome({ tabId, tabLabel, actions, onAction, onPick, disabled, compact }: { tabId: string | null; tabLabel: string | null; actions: readonly AiQuickAction[]; onAction: (a: AiQuickAction) => void; onPick: (q: string) => void; disabled: boolean; compact: boolean }) {
  const suggestions = suggestionsFor(tabId);
  const own = !!tabLabel && hasPageSuggestions(tabId);
  return (
    <div className={`ai-welcome mx-auto ${compact ? "max-w-2xl pt-1" : "max-w-5xl pt-1 sm:pt-4"}`}>
      <div className="ai-hero">
        <span className="ai-hero-logo" aria-hidden><Bot size={24} /></span>
        <h2 className="ai-hero-title">Ask about the plant</h2>
      </div>
      <p className="ai-welcome-label"><Sparkles size={12} aria-hidden /> What it can do</p>
      <AiQuickGrid actions={actions} onPick={onAction} disabled={disabled} compact={compact} />
      <p className="ai-welcome-label">{own ? `Ask about ${tabLabel}` : "Or just ask"}</p>
      <div className={`ai-suggests ${compact ? "" : "ai-suggests-2"}`}>
        {suggestions.map((q, i) => {
          const Icon = SUGGESTION_ICONS[i % SUGGESTION_ICONS.length];
          return (
            <button
              key={q}
              type="button"
              disabled={disabled}
              onClick={() => onPick(q)}
              dir="auto"
              // a phone and the docked window show the first four
              className={`ai-suggest ${i >= 4 ? (compact ? "hidden" : "hidden sm:flex") : "flex"}`}
            >
              <Icon size={14} className="ai-suggest-icon" aria-hidden />
              <span className="leading-snug">{q}</span>
              <CornerDownRight size={13} className="ai-suggest-go" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The cards keyed by the tool call that prepared them. */
function byCall(list: readonly AiActionView[]): Record<string, AiActionView> {
  const out: Record<string, AiActionView> = {};
  for (const v of list) if (v.toolUseId) out[v.toolUseId] = v;
  return out;
}

/** The steps the assistant took — a timeline while it works, folded to one
 *  line once the answer is in (open it to read each step, its time and its
 *  rows). A reopened chat has the steps' names alone. */
function Steps({ steps, lookups, streaming }: { steps: AiStep[] | undefined; lookups: string[]; streaming: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const items: AiStep[] = steps && steps.length > 0 ? steps : lookups.map((text, i) => ({ id: `saved-${i}`, kind: "read", text, state: "done" }));
  if (items.length === 0) return null;
  const shown = open ?? streaming;
  const reads = items.filter((s) => s.kind === "read").length;
  const writes = items.length - reads;
  const head = [
    reads > 0 && `${reads} look-up${reads === 1 ? "" : "s"}`,
    writes > 0 && `${writes} change${writes === 1 ? "" : "s"} prepared`,
  ].filter(Boolean).join(", ");
  return (
    <div className="ai-steps">
      <button type="button" className="ai-steps-head" onClick={() => setOpen(!shown)} aria-expanded={shown}>
        <ChevronRight size={13} className={`transition-transform ${shown ? "rotate-90" : ""}`} aria-hidden />
        <Search size={12} className="opacity-70" aria-hidden />
        <span>{streaming && steps?.some((s) => s.state === "start") ? "Working…" : head}</span>
      </button>
      {shown && (
        <ol className="ai-steps-list">
          {items.map((s) => (
            <li key={s.id} className={`ai-step ai-step-${s.state}`}>
              {s.state === "start" ? <Loader2 size={12} className="animate-spin shrink-0 text-brand-ink" aria-label="Running" /> : s.state === "error" ? <X size={12} className="shrink-0 text-bad-fg" aria-label="Failed" /> : <Check size={12} className="shrink-0 text-ok-fg" aria-label="Done" />}
              <span className="ai-step-text" dir="auto" title={s.text}>{s.kind === "write" ? `Prepared: ${s.text}` : s.text}</span>
              {(s.ms !== undefined || s.rows !== undefined) && (
                <span className="ai-step-meta">{[s.rows !== undefined && `${s.rows} row${s.rows === 1 ? "" : "s"}`, s.ms !== undefined && durationText(s.ms)].filter(Boolean).join(" · ")}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What the assistant does right now, with the seconds since the question went. */
function Live({ text, since }: { text: string; since: number | undefined }) {
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (since === undefined) return;
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  return (
    <div className="ai-live" dir="auto" role="status">
      <span className="ai-dots" aria-hidden><span /><span /><span /></span>
      <span className="ai-live-text">{text}…</span>
      {elapsed !== null && <span className="ai-live-time">{elapsed}s</span>}
    </div>
  );
}

function Answer({
  turn,
  question,
  live,
  streaming,
  isOwner,
  actions,
  onAction,
  onFollowup,
  onRetry,
  rating,
}: {
  turn: Turn;
  /** The question it answers — the printout's title. */
  question: string;
  live: string | null;
  streaming: boolean;
  isOwner: boolean;
  actions: AiActionView[];
  onAction: (v: AiActionView) => void;
  onFollowup: (q: string) => void;
  /** Ask the question again — after a failure, or a stop. */
  onRetry: (() => void) | null;
  /** The 👍 / 👎 of a saved answer — none while it is still being written. */
  rating: { conversationId: number; answer: number; text: string; value: AiFeedbackRating | null; onRated: (r: AiFeedbackRating) => void } | null;
}) {
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  // read off the text when it changes, not on every streamed token of the chat
  const followups = useMemo(() => (streaming ? [] : followupsOf(turn.text)), [turn.text, streaming]);
  const printable = useMemo(() => withoutFollowups(turn.text), [turn.text]);
  const title = question.length > 90 ? `${question.slice(0, 89)}…` : question || "AI assistant";
  return (
    <div className="ai-turn flex gap-3">
      <div className="hidden sm:grid w-7 h-7 rounded-lg bg-brand-light text-brand-ink place-items-center shrink-0 mt-0.5">
        <Bot size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <Steps steps={turn.steps} lookups={turn.lookups} streaming={streaming} />
        {turn.text && <AiMarkdown text={turn.text} streaming={streaming} className="ai-answer" />}
        {live && <Live text={live} since={turn.startedAt} />}
        {turn.remembered?.map((m, k) => (
          <p key={k} className="mt-2 flex items-start gap-1.5 text-xs text-muted" dir="auto">
            <Brain size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span><span className="font-semibold">Remembered:</span> {m} <span className="opacity-80">— the brain button above lists what it remembers, to correct or delete.</span></span>
          </p>
        ))}
        {actions.map((v) => <AiActionCard key={v.id} view={v} onChange={onAction} />)}
        {!streaming && <ApproveAll views={actions} onChange={onAction} />}
        {turn.stopped && !streaming && (
          <p className="text-sm text-muted mt-2 flex items-start gap-1.5"><Square size={13} className="mt-1 shrink-0" aria-hidden /> Stopped — what was written stays in this chat. Check any change cards before asking again.</p>
        )}
        {turn.error && (
          <p className="text-sm font-semibold text-bad-fg mt-2 flex items-start gap-1.5"><AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden /> {turn.error}</p>
        )}
        {!streaming && followups.length > 0 && (
          <div className="ai-followups no-print" role="group" aria-label="Next questions">
            {followups.map((q) => (
              <button key={q} type="button" className="ai-chip" onClick={() => onFollowup(q)} dir="auto">
                <CornerDownRight size={13} aria-hidden /> {q}
              </button>
            ))}
          </div>
        )}
        {!streaming && (turn.text || turn.error || turn.stopped) && (
          <div className="ai-answer-bar">
            {(turn.model || turn.ms !== undefined || (isOwner && turn.cost !== undefined)) && (
              <span className="ai-answer-meta">
                {turn.model && <span className="pill pill-muted" title={aiModel(turn.model).label}><Sparkles size={10} aria-hidden /> {modelShort(turn.model)}</span>}
                {turn.ms !== undefined && <span title="How long the answer took"><Clock size={11} className="inline -mt-0.5 me-1" aria-hidden />{durationText(turn.ms)}</span>}
                {isOwner && turn.cost !== undefined && turn.cost > 0 && <span title="What this answer cost">{usdText(turn.cost)}</span>}
              </span>
            )}
            {turn.text && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-xs"
                onClick={() => {
                  navigator.clipboard?.writeText(printable).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
              </button>
            )}
            {turn.text && <AiPrintButton title={title} text={printable} className="text-xs" />}
            {turn.text && !turn.error && (
              <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setSharing(true)} title="Send this answer to a colleague's inbox or the team chat, or keep it in your inbox">
                <Share2 size={13} /> Share
              </button>
            )}
            {onRetry && (turn.error || turn.stopped) && (
              <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={onRetry} title="Ask the same question again">
                <RotateCcw size={13} /> Try again
              </button>
            )}
            {rating && !turn.error && turn.text && <AnswerRating conversationId={rating.conversationId} answer={rating.answer} text={rating.text} rating={rating.value} onRated={rating.onRated} />}
          </div>
        )}
        {sharing && <ShareDialog title={title} question={question} body={printable} onClose={() => setSharing(false)} />}
      </div>
    </div>
  );
}

function FileKindIcon({ kind, size }: { kind: string; size: number }) {
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "pdf") return <FileText size={size} />;
  return <FileSpreadsheet size={size} />;
}

/** A file sent with a question: a photo as itself (opening full size), any
 *  other file as its name to download — or a note once it is no longer kept. */
function SentFile({ file }: { file: { id: number; name: string; kind: string } }) {
  const [gone, setGone] = useState(false);
  const href = aiFileHref(file.id);
  if (file.kind === "image" && !gone) {
    return (
      <a href={href} target="_blank" rel="noopener" title={file.name} className="block">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind the session, not a static asset */}
        <img src={href} alt={file.name} loading="lazy" onError={() => setGone(true)} className="h-28 max-w-[14rem] rounded-xl border object-cover bg-surface-2" />
      </a>
    );
  }
  return (
    // a tab of its own: a file cleared since must not take the chat's place
    <a href={gone ? undefined : href} target="_blank" rel="noopener" className="pill pill-muted" dir="auto" title={gone ? "No longer kept" : `File #${file.id}`}>
      <FileKindIcon kind={file.kind} size={12} /> {file.name}{gone ? " — no longer kept" : ""}
    </a>
  );
}
