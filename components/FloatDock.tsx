"use client";

import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import { ResizeHandle } from "@/components/ResizeHandle";
import type { FloatName } from "@/components/floatWindow";
import { AI_DOCK_DEFAULT, AI_DOCK_MIN, AI_DOCK_STEP, clampDockWidth, dockMax } from "@/lib/domain/aiDock";

// A floating window — the AI assistant or the inbox — docked down the right
// of the screen, top to bottom, as wide as the person drags it: from a
// laptop up the app (its bar and the page) moves left into the rest
// (html.ai-docked and --ai-dock in globals.css); on a narrower tablet it
// lies over the page's right. One of the two is open at a time.

// the widest a docked window may be on this screen — a snapshot that changes
// only when that does, so resizing a wide window draws nothing new
function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const screenMax = () => dockMax(window.innerWidth);
const serverMax = () => dockMax();

export function useDockMax(): number {
  return useSyncExternalStore(subscribeResize, screenMax, serverMax);
}

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

/** While `on`, the window is docked `width` pixels wide and the app moves left of it. */
export function useDock(name: FloatName, on: boolean, width: number): void {
  useLayoutEffect(() => {
    if (!on) return;
    docked.set(name, width);
    applyDock();
    return () => {
      docked.delete(name);
      applyDock();
    };
  }, [name, on, width]);
}

/** The docked window's left edge, dragged to make it wider or narrower.
 *  While it is dragged the width is drawn on the window alone (`pop`) —
 *  the page is laid out again once, when the drag ends and it is kept. */
export function DockEdge({ label, width, max, pop, onKeep }: { label: string; width: number; max: number; pop: RefObject<HTMLElement | null>; onKeep: (width: number) => void }) {
  const keep = (w: number) => onKeep(clampDockWidth(w, max));
  const draw = (w: number | null) => {
    document.documentElement.classList.toggle("ai-resizing", w !== null);
    if (w === null) pop.current?.style.removeProperty("--ai-dock");
    else pop.current?.style.setProperty("--ai-dock", `${w}px`);
  };
  return (
    <ResizeHandle
      label={label}
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
        keep(w);
        draw(null);
      }}
      onSet={keep}
      onReset={() => keep(AI_DOCK_DEFAULT)}
    />
  );
}
