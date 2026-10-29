// Zooming into a chart: the view is a scale `k` and the offset (x, y) the
// chart is moved by, in the frame's pixels — the chart drawn at k times its
// size, shifted so the frame shows part of it. The chart always covers the
// frame: no empty edge shows past it, and it never shrinks below its own size.

export interface ZoomView {
  k: number;
  x: number;
  y: number;
}

export const ZOOM_ONE: ZoomView = { k: 1, x: 0, y: 0 };
export const ZOOM_MAX = 6;

/** The view held inside the frame: k in [1, ZOOM_MAX], the chart covering the frame. */
export function clampView(v: ZoomView, w: number, h: number): ZoomView {
  const k = Math.min(ZOOM_MAX, Math.max(1, Number.isFinite(v.k) ? v.k : 1));
  if (k === 1) return ZOOM_ONE;
  const clamp = (n: number, size: number) => Math.min(0, Math.max(size * (1 - k), Number.isFinite(n) ? n : 0));
  return { k, x: clamp(v.x, w), y: clamp(v.y, h) };
}

/** Zoom by `factor` about the frame point (px, py): that point stays under the pointer. */
export function zoomAt(v: ZoomView, factor: number, px: number, py: number, w: number, h: number): ZoomView {
  const k = Math.min(ZOOM_MAX, Math.max(1, v.k * factor));
  const r = k / v.k;
  return clampView({ k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }, w, h);
}

/** Move the zoomed chart by (dx, dy) frame pixels. */
export function panBy(v: ZoomView, dx: number, dy: number, w: number, h: number): ZoomView {
  return clampView({ k: v.k, x: v.x + dx, y: v.y + dy }, w, h);
}

/** The zoom factor of one wheel event: a trackpad pinch's many small steps a
 *  few percent each, growing with the step up to ~35% for a mouse notch. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const step = Math.min(Math.abs(px) * 0.01, 0.3);
  return Math.exp(px > 0 ? -step : step);
}
