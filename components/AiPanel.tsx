"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Bot } from "lucide-react";
import { AiWorkspace, type AiLayout, type AiTab, type AiView } from "@/components/AiWorkspace";

// The AI assistant on every page: a round button in the corner opens it as
// a card in the corner (the page stays usable beside it); one click widens it
// to a window in the middle of the screen with the chats and the inbox down
// its side; on a phone it is the whole screen. It stays open — and a chat
// being answered keeps going — while the person moves between pages, steps
// back to the corner when a link in it opens a page, closes on Escape, and
// reopens as it was left. It sits inside <main>, where the app's control and
// table styles live, but is fixed to the window above the bar.

export interface AiPanelConfig {
  /** The assistant itself is open to this person (the chat, the playbook). */
  ai: boolean;
  /** They may keep automations. */
  automations: boolean;
  /** Something was ever sent to their inbox (a person without the assistant still gets messages). */
  inbox: boolean;
  /** The inbox's unread count when the page was made. */
  inboxUnread?: number;
  isOwner: boolean;
}

interface PanelState {
  open: boolean;
  large: boolean;
  view: AiView;
}

interface PanelApi {
  tabs: AiTab[];
  /** The window shows now (open, and not on the assistant's own page). */
  shown: boolean;
  /** On the assistant's own page, which is the window at full size already. */
  aiPage: boolean;
  state: PanelState;
  /** Open on a view — or, already open on it, close. */
  toggle: (view?: AiView) => void;
  openTab: (view: AiView) => void;
  /** Open where it was left. */
  open: () => void;
  close: () => void;
  setLarge: (v: boolean) => void;
  setView: (view: AiView) => void;
}

const Ctx = createContext<PanelApi | null>(null);

/** The window's switches — null where there is none (signed out, or nothing to show). */
export function useAiPanel(): PanelApi | null {
  return useContext(Ctx);
}

const STORE_KEY = "ai-panel:v2";
const PHONE = "(max-width: 767px)";

// The window's state lives in this browser's storage — the source of truth,
// so it reopens as it was after a reload (memory when storage is blocked).
// The server renders it closed; the browser takes over after hydration.
const listeners = new Set<() => void>();
let memory = "";
/** Opened since this page loaded: on a phone a window left open is not
 *  reopened over the page by a reload — only by a tap. */
let openedNow = false;

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function readRaw(): string {
  try {
    return localStorage.getItem(STORE_KEY) ?? memory;
  } catch {
    return memory;
  }
}

function parseStored(raw: string): Partial<PanelState> {
  try {
    const v = JSON.parse(raw || "null") as Partial<PanelState> | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeStored(s: PanelState) {
  memory = JSON.stringify(s);
  try {
    localStorage.setItem(STORE_KEY, memory);
  } catch {
    /* storage unavailable — holds for this page load only */
  }
  listeners.forEach((l) => l());
}

const isPhone = () => window.matchMedia(PHONE).matches;

function subscribePhone(cb: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** Whether the screen is a phone's — the server says no. */
function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

/** The assistant's own pages show it full size; the window stays out of their way. */
const onAiPage = (path: string) => path === "/ai" || path.startsWith("/ai/");

const VIEWS: AiView[] = ["chat", "history", "inbox", "automations", "playbook"];

export function AiPanelProvider({ config, children }: { config: AiPanelConfig; children: ReactNode }) {
  const tabs = useMemo<AiTab[]>(() => {
    const t: AiTab[] = [];
    if (config.ai) t.push("chat");
    if (config.ai || config.inbox) t.push("inbox");
    if (config.automations) t.push("automations");
    if (config.ai) t.push("playbook");
    return t;
  }, [config.ai, config.inbox, config.automations]);

  const raw = useSyncExternalStore(subscribe, readRaw, () => "");
  const phone = usePhone();
  const state = useMemo<PanelState>(() => {
    const s = parseStored(raw);
    const allowed = (v: AiView | undefined): v is AiView => !!v && VIEWS.includes(v) && (v === "history" ? tabs.includes("chat") : tabs.includes(v));
    const view = allowed(s.view) ? s.view : tabs[0] ?? "inbox";
    return { open: !!s.open && (openedNow || !isPhone()), large: !!s.large, view };
  }, [raw, tabs]);
  const pathname = usePathname();
  const aiPage = onAiPage(pathname);

  // a page opened from the window (a link in an answer) is shown: the large
  // window steps back to the corner, and on a phone it closes
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    const cur = parseStored(readRaw());
    if (cur.open && (cur.large || isPhone())) {
      writeStored({ open: !isPhone(), large: false, view: cur.view ?? tabs[0] ?? "inbox" });
    }
  }, [pathname, tabs]);

  const shown = state.open && tabs.length > 0 && !aiPage;
  const modal = shown && (state.large || phone);

  // the page behind the window in the middle (or the whole screen) does not scroll
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("ai-modal", modal);
    return () => el.classList.remove("ai-modal");
  }, [modal]);

  const api = useMemo<PanelApi>(() => {
    const fix = (v: AiView | undefined, cur: AiView): AiView => {
      const ok = (x: AiView) => (x === "history" ? tabs.includes("chat") : tabs.includes(x));
      return v && ok(v) ? v : ok(cur) ? cur : tabs[0];
    };
    const put = (next: Partial<PanelState>) => {
      if (next.open) openedNow = true;
      writeStored({ ...state, ...next });
    };
    return {
      tabs,
      shown,
      aiPage,
      state,
      toggle: (view) => {
        const v = fix(view, state.view);
        if (shown && (view === undefined || state.view === v)) put({ open: false });
        else put({ open: true, view: v });
      },
      openTab: (view) => put({ open: true, view: fix(view, state.view) }),
      open: () => put({ open: true, view: fix(undefined, state.view) }),
      close: () => put({ open: false }),
      setLarge: (v) => put({ large: v }),
      setView: (view) => put({ view: fix(view, state.view) }),
    };
  }, [tabs, shown, aiPage, state]);

  // Escape closes it
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") api.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, api]);

  if (tabs.length === 0) return <>{children}</>;
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The round button in the corner, and the window itself — placed inside
 *  <main>. The window is made the first time it opens, then kept (hidden
 *  when closed), so what it was doing carries on. */
export function AiPanel({ isOwner, inboxUnread = 0 }: { isOwner: boolean; inboxUnread?: number }) {
  const p = useAiPanel();
  const phone = usePhone();
  const [made, setMade] = useState(false);
  if (p?.shown && !made) setMade(true);
  if (!p || p.aiPage) return null;
  const { state } = p;
  const layout: AiLayout = phone ? "phone" : state.large ? "large" : "compact";

  // automations and the playbook open in the large window on a wide screen
  const onView = (v: AiView) => {
    if (!phone && !state.large && (v === "automations" || v === "playbook")) writeStored({ ...state, large: true, view: v });
    else p.setView(v);
  };

  return (
    <>
      {!p.shown && (
        <button type="button" className="ai-fab no-print" onClick={p.open} aria-label="Open the AI assistant" title="AI assistant">
          <Bot size={26} aria-hidden />
        </button>
      )}
      {made && (
        <div hidden={!p.shown} className="no-print">
          {layout === "large" && p.shown && <div className="ai-overlay" onClick={p.close} aria-hidden />}
          <section role="dialog" aria-modal={layout !== "compact"} aria-label="AI assistant" className={`ai-pop ai-pop-${layout}`}>
            <AiWorkspace
              tabs={p.tabs}
              view={state.view}
              onView={onView}
              layout={layout}
              visible={p.shown}
              isOwner={isOwner}
              inboxUnread={inboxUnread}
              onExpand={p.setLarge}
              onClose={p.close}
            />
          </section>
        </div>
      )}
    </>
  );
}
