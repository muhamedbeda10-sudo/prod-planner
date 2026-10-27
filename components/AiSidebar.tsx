"use client";

import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { floatStore } from "@/components/floatWindow";
import { AI_SIDE_DEFAULT, AI_SIDE_MAX, AI_SIDE_MIN, AI_SIDE_STEP, clampSideWidth, dragSide, parseAiSide, type AiSideState } from "@/lib/domain/aiSidebar";

// The chats beside the assistant's chat: dragged wider or narrower by the
// handle on its edge (arrow keys too; a double-click puts it back), hidden
// and shown from the window's head — the chat takes the room, and keeps at
// least half of it whatever was kept. A drag moves only this list and is
// kept once it ends; kept on this browser (lib/domain/aiSidebar).

const store = floatStore("ai:side");

/** The sidebar's width and whether it shows, kept on this browser (the
 *  server, with no storage, draws the usual width). */
export function useAiSide(): [AiSideState, (next: AiSideState) => void] {
  const raw = useSyncExternalStore(store.subscribe, store.read, () => "");
  const side = useMemo(() => parseAiSide(raw), [raw]);
  return [side, store.write];
}

export function AiSidebar({ side, onChange, children }: { side: AiSideState; onChange: (next: AiSideState) => void; children: ReactNode }) {
  const box = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; pointer: number; handle: HTMLElement } | null>(null);
  // the width while a drag is going: drawn, not kept until it ends
  const [live, setLiveState] = useState<number | null>(null);
  // the same, for the handlers of one frame — the state is the last render's
  const liveNow = useRef<number | null>(null);
  const setLive = (w: number | null) => {
    liveNow.current = w;
    setLiveState(w);
  };
  const room = () => box.current?.parentElement?.clientWidth ?? window.innerWidth;
  const width = live ?? clampSideWidth(side.width);

  const endDrag = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.handle.hasPointerCapture(d.pointer)) d.handle.releasePointerCapture(d.pointer);
    if (commit && liveNow.current !== null) onChange({ width: liveNow.current, open: true });
    setLive(null);
  };

  return (
    <aside
      ref={box}
      className={`ai-side ${side.open ? "" : "ai-side-closed"} ${live !== null ? "ai-side-dragging" : ""}`}
      // the width the person dragged it to: no token can hold it
      style={{ "--ai-side-w": `${width}px` } as CSSProperties}
      aria-hidden={!side.open || undefined}
      inert={!side.open}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the chats"
        aria-valuemin={AI_SIDE_MIN}
        aria-valuemax={AI_SIDE_MAX}
        aria-valuenow={width}
        tabIndex={0}
        className="ai-side-handle"
        title="Drag to resize — double-click for the usual width"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, width, pointer: e.pointerId, handle: e.currentTarget };
          setLive(width);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const next = dragSide(d.width + e.clientX - d.x, room(), d.width);
          if (next.open) setLive(next.width);
          else {
            // pulled shut: the drag ends here, and the list hides at the width it had
            endDrag(false);
            onChange(next);
          }
        }}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(true)}
        onLostPointerCapture={() => endDrag(true)}
        onDoubleClick={() => onChange({ width: AI_SIDE_DEFAULT, open: true })}
        onKeyDown={(e) => {
          const to =
            e.key === "ArrowRight" ? width + AI_SIDE_STEP
            : e.key === "ArrowLeft" ? width - AI_SIDE_STEP
            : e.key === "Home" ? AI_SIDE_MIN
            : e.key === "End" ? AI_SIDE_MAX
            : null;
          if (to === null) return;
          e.preventDefault();
          onChange({ width: clampSideWidth(to, room()), open: true });
        }}
      />
    </aside>
  );
}
