"use client";

import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ResizeHandle } from "@/components/ResizeHandle";
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
  // the width while a drag is going: drawn, not kept until it ends
  const [live, setLive] = useState<number | null>(null);
  const room = () => box.current?.parentElement?.clientWidth ?? window.innerWidth;
  const width = live ?? clampSideWidth(side.width);

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
      <ResizeHandle
        label="Resize the chats"
        width={width}
        min={AI_SIDE_MIN}
        max={AI_SIDE_MAX}
        step={AI_SIDE_STEP}
        grows="right"
        className="ai-side-handle"
        onMove={(w, from) => {
          const next = dragSide(w, room(), from);
          if (next.open) {
            setLive(next.width);
            return next.width;
          }
          // pulled shut: the drag ends here, and the list hides at the width it had
          setLive(null);
          onChange(next);
          return null;
        }}
        onEnd={(w) => {
          onChange({ width: w, open: true });
          setLive(null);
        }}
        onSet={(w) => onChange({ width: clampSideWidth(w, room()), open: true })}
        onReset={() => onChange({ width: AI_SIDE_DEFAULT, open: true })}
      />
    </aside>
  );
}
