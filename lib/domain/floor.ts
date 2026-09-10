// The Floor canvas — pure. A department's floor is a sheet of NODES: its
// machines (or welding partitions) as blocks the planner drags into the
// places they really stand, areas drawn around them (a bending table, a
// store, the paint booth) and free labels. Only shapes and positions live
// here; what a machine is on and who stands at it are read live from the
// board and the shift log when the canvas is drawn.

export const FLOOR_VERSION = 1;
export const GRID = 10;
export const FLOOR_W = 1600;
export const FLOOR_H = 900;

export type FloorNodeKind = "machine" | "zone" | "label";

export interface FloorNode {
  id: string;
  kind: FloorNodeKind;
  /** The Machine row a "machine" node stands for. */
  machineId?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A zone's or label's text; a machine node shows the machine's own name. */
  text?: string;
  /** A zone's or label's tint, one of FLOOR_COLORS. */
  color?: string;
}

export interface FloorLayoutData {
  version: number;
  w: number;
  h: number;
  nodes: FloorNode[];
}

export const FLOOR_COLORS = ["slate", "green", "blue", "amber", "red", "violet"] as const;
export type FloorColor = (typeof FLOOR_COLORS)[number];

export const NODE_SIZE: Record<FloorNodeKind, { w: number; h: number }> = {
  machine: { w: 180, h: 110 },
  zone: { w: 260, h: 160 },
  label: { w: 160, h: 32 },
};
export const MIN_SIZE: Record<FloorNodeKind, { w: number; h: number }> = {
  machine: { w: 120, h: 80 },
  zone: { w: 80, h: 50 },
  label: { w: 60, h: 24 },
};

export function emptyLayout(): FloorLayoutData {
  return { version: FLOOR_VERSION, w: FLOOR_W, h: FLOOR_H, nodes: [] };
}

export const snap = (n: number) => Math.round(n / GRID) * GRID;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Read a stored layout, dropping anything malformed rather than failing the
 *  page — a bad node is not worth losing the floor over. */
export function parseLayout(raw: unknown): FloorLayoutData {
  const out = emptyLayout();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  if (typeof o.w === "number" && o.w >= 400 && o.w <= 6000) out.w = o.w;
  if (typeof o.h === "number" && o.h >= 300 && o.h <= 6000) out.h = o.h;
  const nodes = Array.isArray(o.nodes) ? o.nodes : [];
  const seen = new Set<string>();
  for (const n of nodes as Record<string, unknown>[]) {
    if (!n || typeof n !== "object") continue;
    const kind = n.kind;
    if (kind !== "machine" && kind !== "zone" && kind !== "label") continue;
    const id = typeof n.id === "string" && n.id ? n.id : null;
    if (!id || seen.has(id)) continue;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const node: FloorNode = {
      id, kind,
      x: clamp(snap(num(n.x, 0)), 0, out.w - MIN_SIZE[kind].w),
      y: clamp(snap(num(n.y, 0)), 0, out.h - MIN_SIZE[kind].h),
      w: clamp(snap(num(n.w, NODE_SIZE[kind].w)), MIN_SIZE[kind].w, out.w),
      h: clamp(snap(num(n.h, NODE_SIZE[kind].h)), MIN_SIZE[kind].h, out.h),
    };
    if (kind === "machine") {
      if (!Number.isInteger(n.machineId)) continue;
      node.machineId = n.machineId as number;
    }
    if (typeof n.text === "string") node.text = n.text.slice(0, 80);
    if (typeof n.color === "string" && (FLOOR_COLORS as readonly string[]).includes(n.color)) node.color = n.color;
    seen.add(id);
    out.nodes.push(node);
  }
  return out;
}

/** The first grid spot, row by row, where a block of this size overlaps
 *  nothing — where a newly added node lands. */
export function freeSpot(layout: FloorLayoutData, w: number, h: number): { x: number; y: number } {
  const step = GRID * 2;
  const overlaps = (x: number, y: number) =>
    layout.nodes.some((n) => x < n.x + n.w + GRID && x + w + GRID > n.x && y < n.y + n.h + GRID && y + h + GRID > n.y);
  for (let y = step; y + h <= layout.h; y += step) {
    for (let x = step; x + w <= layout.w; x += step) {
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return { x: step, y: step };
}

/** Add a machine to the floor (once — a machine stands in one place). */
export function placeMachine(layout: FloorLayoutData, machineId: number): FloorLayoutData {
  if (layout.nodes.some((n) => n.kind === "machine" && n.machineId === machineId)) return layout;
  const size = NODE_SIZE.machine;
  const at = freeSpot(layout, size.w, size.h);
  return { ...layout, nodes: [...layout.nodes, { id: `m${machineId}`, kind: "machine", machineId, ...at, ...size }] };
}

export function addNode(layout: FloorLayoutData, kind: "zone" | "label", text: string, color: FloorColor = "slate"): FloorLayoutData {
  const size = NODE_SIZE[kind];
  const at = freeSpot(layout, size.w, size.h);
  const id = `${kind[0]}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { ...layout, nodes: [...layout.nodes, { id, kind, text, color, ...at, ...size }] };
}

export function moveNode(layout: FloorLayoutData, id: string, x: number, y: number): FloorLayoutData {
  return {
    ...layout,
    nodes: layout.nodes.map((n) => (n.id === id ? { ...n, x: clamp(snap(x), 0, layout.w - n.w), y: clamp(snap(y), 0, layout.h - n.h) } : n)),
  };
}

export function resizeNode(layout: FloorLayoutData, id: string, w: number, h: number): FloorLayoutData {
  return {
    ...layout,
    nodes: layout.nodes.map((n) =>
      n.id === id ? { ...n, w: clamp(snap(w), MIN_SIZE[n.kind].w, layout.w - n.x), h: clamp(snap(h), MIN_SIZE[n.kind].h, layout.h - n.y) } : n
    ),
  };
}

export function updateNode(layout: FloorLayoutData, id: string, patch: Partial<Pick<FloorNode, "text" | "color">>): FloorLayoutData {
  return { ...layout, nodes: layout.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

export function removeNode(layout: FloorLayoutData, id: string): FloorLayoutData {
  return { ...layout, nodes: layout.nodes.filter((n) => n.id !== id) };
}

/** Zones are drawn under machines, labels on top — whatever order they were added in. */
export function drawOrder(nodes: readonly FloorNode[]): FloorNode[] {
  const rank: Record<FloorNodeKind, number> = { zone: 0, machine: 1, label: 2 };
  return [...nodes].sort((a, b) => rank[a.kind] - rank[b.kind]);
}
