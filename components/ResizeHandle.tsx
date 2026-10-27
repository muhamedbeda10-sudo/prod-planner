"use client";

import { useRef } from "react";

// The edge a panel is dragged by to make it wider or narrower — the chats
// beside the assistant's chat (AiSidebar) and the docked assistant (AiPanel).
// The arrow keys move it a step, Home and End to its narrowest and widest,
// and a double-click puts it back to its usual width. While a drag goes the
// owner draws the width `onMove` is given; it is kept once the drag ends.

export function ResizeHandle({
  label,
  width,
  min,
  max,
  step,
  grows,
  className,
  onMove,
  onEnd,
  onSet,
  onReset,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  step: number;
  /** The way a drag makes the panel wider. */
  grows: "left" | "right";
  className: string;
  /** The width the pointer asks for (and the one the drag began at): the
   *  width drawn, or null when the drag ends there. */
  onMove: (width: number, from: number) => number | null;
  /** The drag is over: the width it left, to keep. */
  onEnd: (width: number) => void;
  /** A key moved it: the width asked for. */
  onSet: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; width: number; to: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className={`resize-handle ${className}`}
      title="Drag to resize — double-click for the usual width"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width, to: width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const to = onMove(d.width + (grows === "right" ? dx : -dx), d.width);
        if (to === null) drag.current = null;
        else d.to = to;
      }}
      // the capture is let go after pointerup and pointercancel alike
      onLostPointerCapture={() => {
        const d = drag.current;
        drag.current = null;
        if (d) onEnd(d.to);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const wider = grows === "right" ? "ArrowRight" : "ArrowLeft";
        const narrower = grows === "right" ? "ArrowLeft" : "ArrowRight";
        const to =
          e.key === wider ? width + step
          : e.key === narrower ? width - step
          : e.key === "Home" ? min
          : e.key === "End" ? max
          : null;
        if (to === null) return;
        e.preventDefault();
        onSet(to);
      }}
    />
  );
}
