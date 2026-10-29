"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ResponsiveContainer as RechartsContainer } from "recharts";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { ZOOM_MAX, ZOOM_ONE, panBy, wheelFactor, zoomAt, type ZoomView } from "@/lib/domain/chartZoom";

// Every chart zooms: Ctrl (⌘) + scroll, or a pinch on a trackpad or a touch
// screen, magnifies it about the pointer; dragging moves a zoomed chart; a
// double click (or the corner's reset) puts it back. A plain scroll still
// scrolls the page — a dashboard is mostly charts, and a page that stopped
// scrolling under every one of them could not be read — so a plain scroll over
// a chart says how to zoom instead. The chart is magnified, not redrawn: its
// numbers, clicks and tooltips stay where they were (Recharts reads the
// pointer through the scale), and print shows it whole. On a touch screen a
// zoomed chart moves sideways under one finger and the page still scrolls up
// and down; two fingers move it any way.

const STEP = 1.5;
const HINT_MS = 1400;
/** The hint shows at most this often across the page, not under every chart a scroll passes. */
const HINT_EVERY_MS = 20_000;
/** How far a press moves before it is a drag, not a click. */
const DRAG_PX = 4;

let lastHint = 0;

/** Inside a zooming chart: a chart in it is magnified with it, not on its own. */
const InZoom = createContext(false);

export function ChartZoom({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  if (useContext(InZoom)) return <>{children}</>;
  return <ZoomFrame className={className}>{children}</ZoomFrame>;
}

function ZoomFrame({ children, className }: { children: React.ReactNode; className: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ZoomView>(ZOOM_ONE);
  const [hint, setHint] = useState(false);
  const [dragging, setDragging] = useState(false);

  const size = () => {
    const el = frame.current;
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
  };
  const zoomBy = useCallback((factor: number, px?: number, py?: number) => {
    const { w, h } = size();
    setView((v) => zoomAt(v, factor, px ?? w / 2, py ?? h / 2, w, h));
  }, []);
  const reset = useCallback(() => setView(ZOOM_ONE), []);

  // the wheel: a listener of our own, since React's is passive and could not stop the page's zoom
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        const now = Date.now();
        if (now - lastHint < HINT_EVERY_MS) return;
        lastHint = now;
        setHint(true);
        clearTimeout(timer);
        timer = setTimeout(() => setHint(false), HINT_MS);
        return;
      }
      e.preventDefault();
      setHint(false);
      const r = el.getBoundingClientRect();
      zoomBy(wheelFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(timer);
    };
  }, [zoomBy]);

  // a drag moves a zoomed chart; two fingers pinch it
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinch = useRef<number | null>(null);
  const swallowClick = useRef(false);

  const local = (e: React.PointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // a press that ended a pinch made no click to swallow — this one is new
    if (pointers.current.size === 0) swallowClick.current = false;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      pinch.current = spread().d;
      press.current = null;
    } else if (pointers.current.size === 1 && view.k > 1) {
      press.current = { ...local(e), moved: false };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const { w, h } = size();
    if (pointers.current.size === 2 && pinch.current !== null) {
      const s = spread();
      const ratio = pinch.current > 0 ? s.d / pinch.current : 1;
      const dx = (p.x - prev.x) / 2;
      const dy = (p.y - prev.y) / 2;
      setView((v) => panBy(zoomAt(v, ratio, s.mx, s.my, w, h), dx, dy, w, h));
      pinch.current = s.d;
      swallowClick.current = true;
      return;
    }
    const start = press.current;
    if (!start) return;
    if (!start.moved && Math.hypot(p.x - start.x, p.y - start.y) < DRAG_PX) return;
    if (!start.moved) {
      start.moved = true;
      setDragging(true);
      frame.current?.setPointerCapture(e.pointerId);
    }
    setView((v) => panBy(v, p.x - prev.x, p.y - prev.y, w, h));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (press.current?.moved) swallowClick.current = true;
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      press.current = null;
      setDragging(false);
    }
  };
  // the click that ends a drag is not a click on the chart
  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  // the corner's buttons go when the chart is back to its size: keep the keyboard's place on the chart
  const keepFocus = () => requestAnimationFrame(() => {
    const el = frame.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  });
  const zoomOut = () => {
    zoomBy(1 / STEP);
    keepFocus();
  };
  const zoomIn = () => zoomBy(STEP);
  const resetKeepFocus = () => {
    reset();
    keepFocus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / STEP);
    else if (e.key === "0" && view.k > 1) reset();
    else return;
    e.preventDefault();
    keepFocus();
  };

  const zoomed = view.k > 1;
  return (
    <div
      ref={frame}
      tabIndex={-1}
      className={`chart-zoom ${zoomed ? (dragging ? "is-dragging" : "is-zoomed") : ""} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={onClickCapture}
      onDoubleClick={zoomed ? reset : undefined}
      onKeyDown={onKeyDown}
    >
      <div
        className="chart-zoom-pane"
        style={zoomed ? ({ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, "--zoom": view.k } as React.CSSProperties) : undefined}
      >
        <InZoom.Provider value={true}>{children}</InZoom.Provider>
      </div>
      {zoomed && (
        <div className="chart-zoom-bar no-print" role="toolbar" aria-label="Chart zoom" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" className="icon-btn" onClick={zoomOut} aria-label="Zoom out" title="Zoom out (−)"><ZoomOut size={14} aria-hidden /></button>
          <span className="text-xs font-bold tabnum min-w-[2.75rem] text-center" aria-live="polite">{Math.round(view.k * 100)}%</span>
          <button type="button" className="icon-btn" onClick={zoomIn} disabled={view.k >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn size={14} aria-hidden /></button>
          <button type="button" className="icon-btn" onClick={resetKeepFocus} aria-label="Reset zoom" title="Reset zoom (0, or double-click the chart)"><RotateCcw size={14} aria-hidden /></button>
        </div>
      )}
      {hint && <div className="chart-zoom-hint no-print" aria-hidden>Hold Ctrl and scroll to zoom</div>}
    </div>
  );
}

/** Recharts' ResponsiveContainer inside a ChartZoom — every chart's own container. */
export function ResponsiveContainer(props: React.ComponentProps<typeof RechartsContainer>) {
  return (
    <ChartZoom>
      <RechartsContainer {...props} />
    </ChartZoom>
  );
}
