"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { announceOpen, floatStore, isPhone, parseStored, useCloseWhenOtherOpens, usePhone, useWindowChrome } from "@/components/floatWindow";
import { DockEdge, useDock, useDockMax } from "@/components/FloatDock";
import { isInboxTab, type InboxTab } from "@/lib/domain/inbox";
import { clampDockWidth } from "@/lib/domain/aiDock";

// The workspace renders its reports as Markdown with charts, which every page
// would otherwise carry for a window most of them never open. It is split
// into its own chunk and fetched the first time the window opens; the window
// is only ever made in the browser (see `made` below), so nothing prerenders.
const InboxWorkspace = dynamic(() => import("./InboxWorkspace").then((m) => m.InboxWorkspace), {
  ssr: false,
  loading: () => <div className="h-full grid place-items-center text-sm text-muted" role="status">Opening the inbox…</div>,
});

// The inbox as a window of its own, opened from the bell in the bar: docked
// down the right of the screen, top to bottom, with the app moved left of it
// and its left edge dragged to resize (components/FloatDock) — as the
// assistant's window is; the whole screen with Expand, and on a phone. Like
// the assistant's window it stays as it was while the person moves between
// pages, closes on Escape, and reopens as it was left; one of the two is open
// at a time. On the inbox's own page it stays closed — that page is the
// window at full size.

interface InboxState {
  open: boolean;
  large: boolean;
  tab: InboxTab;
  taskId: number | null;
  /** An item opened from its popup: unfolded and in view. */
  itemId: number | null;
  /** Docked: how wide it was dragged (lib/domain/aiDock). */
  width: number;
}

interface InboxApi {
  shown: boolean;
  state: InboxState;
  /** Open — or, already open, close. */
  toggle: () => void;
  open: (o?: { tab?: InboxTab; taskId?: number | null; itemId?: number | null }) => void;
  close: () => void;
  setLarge: (v: boolean) => void;
  setTab: (t: InboxTab) => void;
  setTask: (id: number | null) => void;
}

const Ctx = createContext<InboxApi | null>(null);

export function useInboxPanel(): InboxApi | null {
  return useContext(Ctx);
}

const store = floatStore("inbox-panel:v1");
const serverRaw = () => "";

/** The inbox's own page — where its window and popups stay out of the way. */
export const onInboxPage = (path: string) => path === "/inbox" || path.startsWith("/inbox/");

export function InboxPanelProvider({ children }: { children: ReactNode }) {
  const raw = useSyncExternalStore(store.subscribe, store.read, serverRaw);
  const phone = usePhone();
  // opened since this page loaded — on a phone only a tap reopens it
  const [openedNow, setOpenedNow] = useState(false);
  const state = useMemo<InboxState>(() => {
    const s = parseStored<InboxState>(raw);
    return {
      open: !!s.open && (openedNow || !isPhone()),
      large: !!s.large,
      tab: s.tab && isInboxTab(s.tab) ? s.tab : "alerts",
      taskId: typeof s.taskId === "number" && s.taskId > 0 ? s.taskId : null,
      itemId: typeof s.itemId === "number" && s.itemId > 0 ? s.itemId : null,
      width: clampDockWidth(s.width),
    };
  }, [raw, openedNow]);
  const pathname = usePathname();
  const inboxPage = onInboxPage(pathname);

  // a link in it opened a page: the large window steps back to the side, and on a phone it closes
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    const cur = parseStored<InboxState>(store.read());
    if (cur.open && (cur.large || isPhone())) store.write({ ...cur, open: !isPhone(), large: false });
  }, [pathname]);

  const shown = state.open && !inboxPage;
  const put = useCallback(
    (next: Partial<InboxState>) => {
      if (next.open) {
        setOpenedNow(true);
        if (!state.open) announceOpen("inbox");
      }
      store.write({ ...state, ...next });
    },
    [state],
  );
  const close = useCallback(() => put({ open: false }), [put]);

  useWindowChrome("inbox", shown, shown && (state.large || phone), close);
  useCloseWhenOtherOpens("inbox", shown, close);

  const api = useMemo<InboxApi>(
    () => ({
      shown,
      state,
      toggle: () => (shown ? put({ open: false }) : put({ open: true, itemId: null })),
      open: (o = {}) => put({ open: true, itemId: o.itemId ?? null, ...(o.tab ? { tab: o.tab } : {}), ...(o.taskId !== undefined ? { taskId: o.taskId } : {}) }),
      close,
      setLarge: (v) => put({ large: v }),
      setTab: (t) => put({ tab: t }),
      setTask: (id) => put({ taskId: id }),
    }),
    [shown, state, put, close],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The window — placed inside <main>, made the first time it opens, then kept. */
export function InboxPanel() {
  const p = useInboxPanel();
  const phone = usePhone();
  const max = useDockMax();
  const [made, setMade] = useState(false);
  const pop = useRef<HTMLElement>(null);
  if (p?.shown && !made) setMade(true);
  const layout = phone ? "phone" : p?.state.large ? "large" : "compact";
  const width = clampDockWidth(p?.state.width, max);
  useDock("inbox", !!p?.shown && layout === "compact", width);
  if (!p || !made) return null;
  return (
    <div hidden={!p.shown} className="no-print">
      {layout === "large" && p.shown && <div className="ai-overlay" onClick={p.close} aria-hidden />}
      <section ref={pop} role="dialog" aria-modal={layout !== "compact"} aria-label="Inbox" className={`ai-pop ${layout === "compact" ? "ai-pop-dock" : `ai-pop-${layout}`}`}>
        {layout === "compact" && <DockEdge label="Resize the inbox" width={width} max={max} pop={pop} onKeep={(w) => store.write({ ...p.state, width: w })} />}
        <InboxWorkspace
          layout={layout}
          tab={p.state.tab}
          onTab={p.setTab}
          taskId={p.state.taskId}
          onTask={p.setTask}
          openItem={p.state.itemId}
          visible={p.shown}
          onExpand={p.setLarge}
          onClose={p.close}
        />
      </section>
    </div>
  );
}
