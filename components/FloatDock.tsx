"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ResizeHandle } from "@/components/ResizeHandle";
import type { FloatName } from "@/components/floatWindow";
import { AI_DOCK_DEFAULT, AI_DOCK_MIN, AI_DOCK_STEP, clampDockWidth, dockMax } from "@/lib/domain/aiDock";

// The shell of a floating window — the AI assistant, the inbox or the chat
// (ChatDock). Docked ("compact") it runs down the right of the screen, top to bottom, as wide
// as the person drags its left edge: from a laptop up the app (its bar and
// the page) moves left into the rest (html.ai-docked and --ai-dock in
// globals.css); on a narrower tablet it lies over the page under the bar.
// Expanded it fills the screen over a dimmed page, and on a phone it is
// the whole screen. One of them is open at a time.

export type FloatLayout = "compact" | "large" | "phone";

// the widest a docked window may be on this screen — a snapshot that changes
// only when that does; nothing listens while no window is docked
function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const subscribeNone = () => () => {};
const screenMax = () => dockMax(window.innerWidth);
const serverMax = () => dockMax();

// the windows docked right now and their widths — the page moves for
// whichever is, in any order they open and close
const docked = new Map<FloatName, number>();

function applyDock() {
  const html = document.documentElement;
  const width = [...docked.values()].pop();
  html.classList.toggle("ai-docked", width !== undefined);
  // the width the person dragged it to: no token can hold it
  if (width === undefined) html.style.removeProperty("--ai-dock");
  else html.style.setProperty("--ai-dock", `${width}px`);
}

/** While `on`, the window is docked `width` pixels wide and the app moves
 *  left of it; a new width only moves the edge. */
function useDock(name: FloatName, on: boolean, width: number): void {
  useLayoutEffect(() => {
    if (!on) return;
    docked.set(name, width);
    applyDock();
  }, [name, on, width]);
  useLayoutEffect(() => {
    if (!on) return;
    return () => {
      docked.delete(name);
      applyDock();
    };
  }, [name, on]);
}

export function FloatWindow({
  name,
  label,
  edgeLabel,
  layout,
  shown,
  width: kept,
  onWidth,
  onClose,
  children,
}: {
  name: FloatName;
  label: string;
  /** The name of its resize edge, for a screen reader. */
  edgeLabel: string;
  layout: FloatLayout;
  /** Open (a closed one stays made, hidden, so what it was doing carries on). */
  shown: boolean;
  /** Docked: the width kept. */
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const dock = shown && layout === "compact";
  const max = useSyncExternalStore(dock ? subscribeResize : subscribeNone, screenMax, serverMax);
  const width = clampDockWidth(kept, max);
  const pop = useRef<HTMLElement>(null);
  useDock(name, dock, width);

  // while its edge is dragged the width is drawn on the window alone — the
  // page is laid out again once, when the drag ends and the width is kept
  const draw = (w: number | null) => {
    document.documentElement.classList.toggle("ai-resizing", w !== null);
    if (w === null) pop.current?.style.removeProperty("--ai-dock");
    else pop.current?.style.setProperty("--ai-dock", `${w}px`);
  };
  const keep = (w: number) => onWidth(clampDockWidth(w, max));

  return (
    <div hidden={!shown} className="no-print">
      {layout === "large" && shown && <div className="ai-overlay" onClick={onClose} aria-hidden />}
      <section
        ref={pop}
        role="dialog"
        aria-modal={layout !== "compact"}
        aria-label={label}
        className={`ai-pop ${layout === "compact" ? "ai-pop-dock" : `ai-pop-${layout}`}`}
        // docked beside the page, it takes Escape from inside itself only —
        // Escape in the page stays the page's (the expanded and phone
        // windows take it from anywhere: floatWindow's useWindowChrome)
        onKeyDown={layout === "compact" ? (e) => e.key === "Escape" && !e.defaultPrevented && onClose() : undefined}
      >
        {layout === "compact" && (
          <ResizeHandle
            label={edgeLabel}
            width={width}
            min={AI_DOCK_MIN}
            max={max}
            step={AI_DOCK_STEP}
            grows="left"
            className="ai-dock-handle"
            onMove={(w) => {
              const to = clampDockWidth(w, max);
              draw(to);
              return to;
            }}
            onEnd={(w) => {
              onWidth(w);
              draw(null);
            }}
            onSet={keep}
            onReset={() => keep(AI_DOCK_DEFAULT)}
          />
        )}
        {children}
      </section>
    </div>
  );
}

/** The window's head: its logo (a ring breathes around it while `busy`),
 *  its name and a line under it, then its buttons. */
export function FloatHead({ icon: Icon, title, sub, busy = false, children }: { icon: LucideIcon; title: string; sub: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <header className="ai-pop-head">
      <span className={`ai-pop-logo ${busy ? "ai-pop-logo-busy" : ""}`}><Icon size={18} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div className="ai-pop-title">{title}</div>
        <div className="ai-pop-sub" dir="auto">{sub}</div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">{children}</div>
    </header>
  );
}

/** One button of the head: an icon, its name as the tooltip, lit when its view is open. */
export function HeadBtn({ icon: Icon, label, on = false, badge = 0, onClick, disabled }: { icon: LucideIcon; label: string; on?: boolean; badge?: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`icon-btn icon-btn-md ai-head-btn ${on ? "icon-btn-on" : ""}`} title={label} aria-label={badge > 0 ? `${label} — ${badge} not read` : label} aria-pressed={on}>
      <Icon size={17} />
      {badge > 0 && <span className="count-badge count-badge-alert">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}
