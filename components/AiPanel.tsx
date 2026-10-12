"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Maximize2, Minimize2, Settings, X } from "lucide-react";
import { AiWorkspace, type AiTab } from "@/components/AiWorkspace";

// The AI assistant as a panel on the right of every page: the page narrows
// beside it on a wide screen (over it on a phone), and one click widens it to
// the whole app below the bar and back. It stays open — and a chat being
// answered keeps going — while the person moves between pages, and reopens as
// it was after a reload. It sits inside <main>, where the app's control and
// table styles live, but is fixed to the window, under the bar's own layer
// (the bar's menus and drawer open over it).

export interface AiPanelConfig {
  /** The assistant itself is open to this person (the chat, the playbook). */
  ai: boolean;
  /** They may keep automations. */
  automations: boolean;
  /** Something was ever sent to their inbox (a person without the assistant still gets messages). */
  inbox: boolean;
  isOwner: boolean;
}

interface PanelState {
  open: boolean;
  expanded: boolean;
  tab: AiTab;
}

interface PanelApi {
  tabs: AiTab[];
  /** The panel shows now (open, and not on the assistant's own page). */
  shown: boolean;
  state: PanelState;
  /** Open on a tab — or, already open on it, close. */
  toggle: (tab?: AiTab) => void;
  openTab: (tab: AiTab) => void;
  close: () => void;
  setExpanded: (v: boolean) => void;
  setTab: (tab: AiTab) => void;
}

const Ctx = createContext<PanelApi | null>(null);

/** The panel's switches — null where there is no panel (signed out, or nothing to show). */
export function useAiPanel(): PanelApi | null {
  return useContext(Ctx);
}

const STORE_KEY = "ai-panel:v1";
const WIDE = "(min-width: 1024px)";

// The panel's state lives in this browser's storage — the source of truth,
// so it reopens as it was after a reload (memory when storage is blocked).
// The server renders it closed; the browser takes over after hydration.
const listeners = new Set<() => void>();
let memory = "";
/** Opened since this page loaded: on a phone a panel left open is not
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

const isWide = () => window.matchMedia(WIDE).matches;

/** The assistant's own pages show it full size; the panel stays out of their way. */
const onAiPage = (path: string) => path === "/ai" || path.startsWith("/ai/");

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
  const state = useMemo<PanelState>(() => {
    const s = parseStored(raw);
    const tab = s.tab && tabs.includes(s.tab) ? s.tab : tabs[0] ?? "inbox";
    return { open: !!s.open && (openedNow || isWide()), expanded: !!s.expanded, tab };
  }, [raw, tabs]);
  const pathname = usePathname();

  // a page opened from the panel (a link in an answer) is shown: a wide panel
  // steps back to the side, and on a phone it closes
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    const cur = parseStored(readRaw());
    if (cur.open && (cur.expanded || !isWide())) {
      writeStored({ open: isWide(), expanded: false, tab: cur.tab ?? tabs[0] ?? "inbox" });
    }
  }, [pathname, tabs]);

  const shown = state.open && tabs.length > 0 && !onAiPage(pathname);

  // the page narrows beside the docked panel (globals.css: html.ai-docked)
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("ai-docked", shown && !state.expanded);
    return () => el.classList.remove("ai-docked");
  }, [shown, state.expanded]);

  const api = useMemo<PanelApi>(() => {
    const fix = (t: AiTab | undefined, cur: AiTab) => (t && tabs.includes(t) ? t : tabs.includes(cur) ? cur : tabs[0]);
    const put = (next: Partial<PanelState>) => {
      if (next.open) openedNow = true;
      writeStored({ ...state, ...next });
    };
    return {
      tabs,
      shown,
      state,
      toggle: (tab) => {
        const t = fix(tab, state.tab);
        if (shown && (tab === undefined || state.tab === t)) put({ open: false });
        else put({ open: true, tab: t });
      },
      openTab: (tab) => put({ open: true, tab: fix(tab, state.tab) }),
      close: () => put({ open: false }),
      setExpanded: (v) => put({ expanded: v }),
      setTab: (tab) => put({ tab: fix(tab, state.tab) }),
    };
  }, [tabs, shown, state]);

  if (tabs.length === 0) return <>{children}</>;
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The panel itself — placed inside <main>. Made the first time it opens,
 *  then kept (hidden when closed), so what it was doing carries on. */
export function AiPanel({ isOwner }: { isOwner: boolean }) {
  const p = useAiPanel();
  const [made, setMade] = useState(false);
  if (p?.shown && !made) setMade(true);
  if (!p || !made) return null;
  const { state } = p;

  const iconBtn = "icon-btn icon-btn-md";
  return (
    <aside
      aria-label="AI assistant"
      hidden={!p.shown}
      className={`ai-panel no-print fixed z-[29] top-[49px] bottom-0 right-0 left-0 flex flex-col bg-surface text-foreground shadow-2xl ${
        state.expanded ? "" : "lg:left-auto lg:w-[var(--ai-panel-w)] lg:border-l"
      }`}
    >
      <AiWorkspace
        tabs={p.tabs}
        tab={state.tab}
        onTab={p.setTab}
        compact={!state.expanded}
        visible={p.shown}
        toolbar={
          <>
            {isOwner && (
              <Link href="/admin/ai" className={iconBtn} title="AI settings" aria-label="AI settings">
                <Settings size={16} />
              </Link>
            )}
            <button
              type="button"
              className={`${iconBtn} hidden lg:grid`}
              onClick={() => p.setExpanded(!state.expanded)}
              title={state.expanded ? "Back to the side" : "Full size"}
              aria-label={state.expanded ? "Back to the side" : "Full size"}
            >
              {state.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" className={iconBtn} onClick={p.close} title="Close" aria-label="Close the assistant">
              <X size={18} />
            </button>
          </>
        }
      />
    </aside>
  );
}
