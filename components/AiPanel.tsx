"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import type { AiLayout, AiTab, AiView } from "@/components/AiWorkspace";
import { announceOpen, floatStore, isPhone, parseStored, useCloseWhenOtherOpens, usePhone, useWindowChrome } from "@/components/floatWindow";
import { handToAssistant } from "@/lib/aiAsk";
import { clampDockWidth } from "@/lib/domain/aiDock";
import { FloatWindow } from "@/components/FloatDock";

// The workspace (the chat, its Markdown and its charts) is the heaviest thing
// this layout could ship, and every page carries its button in the bar. So it is split
// into its own chunk and fetched the first time the window opens — a page
// that never opens it never downloads it. The window is only ever made in
// the browser (see `made` below), so there is nothing to prerender.
const AiWorkspace = dynamic(() => import("./AiWorkspace").then((m) => m.AiWorkspace), {
  ssr: false,
  loading: () => <div className="h-full grid place-items-center text-sm text-muted" role="status">Opening the assistant…</div>,
});

// The AI assistant on every page: its button in the bar (AppNav) opens it
// docked down the right of the screen, top to bottom, and the whole app —
// its bar and the page — moves left into the rest, so both are seen at once;
// its left edge is dragged to make it wider or narrower. One click fills
// the viewport with the chats down its side; on a phone it is always the
// whole screen. It stays open — and a chat being answered
// keeps going — while the person moves between pages, steps back to the
// side when a link in it opens a page, closes on Escape, and reopens as it
// was left. The inbox is a window of its own (components/InboxPanel); one of
// the two is open at a time. It sits inside <main>, where the app's control
// and table styles live, but is fixed to the window above the bar.

export interface AiPanelConfig {
  /** The assistant itself is open to this person (the chat, the playbook). */
  ai: boolean;
  /** They may keep automations. */
  automations: boolean;
  isOwner: boolean;
}

interface PanelState {
  open: boolean;
  large: boolean;
  view: AiView;
  /** Docked: how wide it was dragged (lib/domain/aiDock). */
  width: number;
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
  /** Open a new chat with this question in its box, for the person to send —
   *  or, with `explain`, sent at once to explain only. Nothing for someone
   *  without the chat. */
  ask: (question: string, opts?: { explain?: boolean }) => void;
  /** The chat is open to this person. */
  canAsk: boolean;
  close: () => void;
  setLarge: (v: boolean) => void;
  /** Docked: keep this width. */
  setWidth: (width: number) => void;
  setView: (view: AiView) => void;
}

const Ctx = createContext<PanelApi | null>(null);

/** The window's switches — null where there is none (signed out, or nothing to show). */
export function useAiPanel(): PanelApi | null {
  return useContext(Ctx);
}

const store = floatStore("ai-panel:v2");
const serverRaw = () => "";

/** The assistant's own pages show it full size; the window stays out of their way. */
const onAiPage = (path: string) => path === "/ai" || path.startsWith("/ai/");

const VIEWS: AiView[] = ["chat", "history", "automations", "playbook"];

export function AiPanelProvider({ config, children }: { config: AiPanelConfig; children: ReactNode }) {
  const tabs = useMemo<AiTab[]>(() => {
    const t: AiTab[] = [];
    if (config.ai) t.push("chat");
    if (config.automations) t.push("automations");
    if (config.ai) t.push("playbook");
    return t;
  }, [config.ai, config.automations]);

  const raw = useSyncExternalStore(store.subscribe, store.read, serverRaw);
  const phone = usePhone();
  // opened since this page loaded: on a phone a window left open is not
  // reopened over the page by a reload — only by a tap (which may store
  // nothing new, so this is what shows it)
  const [openedNow, setOpenedNow] = useState(false);
  const state = useMemo<PanelState>(() => {
    const s = parseStored<PanelState>(raw);
    const allowed = (v: AiView | undefined): v is AiView => !!v && VIEWS.includes(v) && (v === "history" ? tabs.includes("chat") : tabs.includes(v));
    const view = allowed(s.view) ? s.view : tabs[0] ?? "chat";
    return { open: !!s.open && (openedNow || !isPhone()), large: !!s.large, view, width: clampDockWidth(s.width) };
  }, [raw, tabs, openedNow]);
  const pathname = usePathname();
  const aiPage = onAiPage(pathname);

  // a page opened from the window (a link in an answer) is shown: the large
  // window steps back to the side, and on a phone it closes
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    const cur = parseStored<PanelState>(store.read());
    if (cur.open && (cur.large || isPhone())) store.write({ ...cur, open: !isPhone(), large: false, view: cur.view ?? tabs[0] ?? "chat" });
  }, [pathname, tabs]);

  const shown = state.open && tabs.length > 0 && !aiPage;

  const put = useCallback(
    (next: Partial<PanelState>) => {
      if (next.open) {
        setOpenedNow(true);
        if (!state.open) announceOpen("ai");
      }
      store.write({ ...state, ...next });
    },
    [state],
  );
  const close = useCallback(() => put({ open: false }), [put]);

  useWindowChrome("ai", shown, shown && (state.large || phone), close);
  useCloseWhenOtherOpens("ai", shown, close);

  const api = useMemo<PanelApi>(() => {
    const fix = (v: AiView | undefined, cur: AiView): AiView => {
      const ok = (x: AiView) => (x === "history" ? tabs.includes("chat") : tabs.includes(x));
      return v && ok(v) ? v : ok(cur) ? cur : tabs[0];
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
      ask: (question, opts) => {
        if (!tabs.includes("chat")) return;
        put({ open: true, view: "chat" });
        handToAssistant(question, opts);
      },
      canAsk: tabs.includes("chat"),
      close,
      setLarge: (v) => put({ large: v }),
      setWidth: (width) => put({ width }),
      setView: (view) => put({ view: fix(view, state.view) }),
    };
  }, [tabs, shown, aiPage, state, put, close]);

  if (tabs.length === 0) return <>{children}</>;
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The window itself — placed inside <main>; its button is in the bar
 *  (AppNav). The window is made the first time it opens, then kept (hidden
 *  when closed), so what it was doing carries on. */
export function AiPanel({ isOwner }: { isOwner: boolean }) {
  const p = useAiPanel();
  const phone = usePhone();
  const [made, setMade] = useState(false);
  if (p?.shown && !made) setMade(true);
  if (!p || p.aiPage || !made) return null;
  const { state } = p;
  const layout: AiLayout = phone ? "phone" : state.large ? "large" : "compact";

  // automations and the playbook open in the large window on a wide screen
  const onView = (v: AiView) => {
    if (!phone && !state.large && (v === "automations" || v === "playbook")) store.write({ ...state, large: true, view: v });
    else p.setView(v);
  };

  return (
    <FloatWindow name="ai" label="AI assistant" edgeLabel="Resize the assistant" layout={layout} shown={p.shown} width={state.width} onWidth={p.setWidth} onClose={p.close}>
      <AiWorkspace
        tabs={p.tabs}
        view={state.view}
        onView={onView}
        layout={layout}
        visible={p.shown}
        isOwner={isOwner}
        onExpand={p.setLarge}
        onClose={p.close}
      />
    </FloatWindow>
  );
}
