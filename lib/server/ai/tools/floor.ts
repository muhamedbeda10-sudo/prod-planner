import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { readFloorLayout, restoreFloorLayout, type FloorLayoutSnapshot } from "@/lib/server/rowSnapshots";
import { saveFloorLayout } from "@/app/simulate/floorActions";
import {
  FLOOR_COLORS, addNode, moveNode, parseLayout, placeMachine, removeNode, resizeNode, updateNode, type FloorColor, type FloorLayoutData, type FloorNode,
} from "@/lib/domain/floor";
import { SHIFT_DEPTS, type ShiftDept } from "@/lib/domain/shifts";
import type { AiChange } from "@/lib/domain/aiActions";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The Floor canvas for the assistant: a department's drawn floor — its
// machines where they really stand, the areas drawn around them and free
// labels — read, and edited as the canvas edits it (the same pure moves, then
// the canvas's own save), under the key that keeps the machines list. Undone
// by putting the floor back exactly as it was stored, or not drawn at all.

const TABS = ["simulate"] as const;
const DEPT = { type: "string", enum: SHIFT_DEPTS, description: "The department's floor." } as const;
const NO_RIGHT = "Drawing the floor needs the machines key (machines.manage) — the owner ticks it on Users & Permissions.";
const COLOR = { type: "string", enum: FLOOR_COLORS } as const;

async function machinesOf(dept: string) {
  return prisma.machine.findMany({ where: { dept }, select: { id: true, code: true, name: true, active: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

type Machines = Awaited<ReturnType<typeof machinesOf>>;

const nodeName = (n: FloorNode, machines: Machines) => (n.kind === "machine" ? machines.find((m) => m.id === n.machineId)?.code ?? `machine #${n.machineId}` : `${n.kind} "${n.text ?? ""}"`);

export const getFloorLayoutTool: ReadTool<{ dept: ShiftDept }> = {
  kind: "read",
  name: "get_floor_layout",
  title: "Reading the floor",
  description:
    "A department's drawn floor (Floor / Simulator): the canvas size and every node — a machine (by its code) where it stands, an area or a label with its text and colour — each with its id, position (x, y from the top left) and size, in canvas units on a 10-unit grid; and the department's machines not on the floor yet. Read it before edit_floor_layout.",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  tabs: TABS,
  status: (i) => `Reading the ${i.dept} floor`,
  async run(i) {
    const [stored, machines] = await Promise.all([readFloorLayout(i.dept), machinesOf(i.dept)]);
    const layout = parseLayout(stored?.data ?? null);
    const placed = new Set(layout.nodes.filter((n) => n.kind === "machine").map((n) => n.machineId));
    return {
      ok: true,
      text: JSON.stringify({
        dept: i.dept,
        drawn: stored !== null,
        canvas: { w: layout.w, h: layout.h },
        nodes: layout.nodes.map((n) => ({
          id: n.id, kind: n.kind, ...(n.kind === "machine" ? { machine: nodeName(n, machines) } : { text: n.text ?? "", color: n.color ?? "slate" }), x: n.x, y: n.y, w: n.w, h: n.h,
        })),
        notOnFloor: machines.filter((m) => m.active && !placed.has(m.id)).map((m) => m.code),
      }),
    };
  },
};

interface EditInput {
  dept: ShiftDept;
  add?: { kind: "machine" | "zone" | "label"; machine?: string; text?: string; color?: FloorColor; x?: number; y?: number; w?: number; h?: number }[];
  move?: { node: string; x?: number; y?: number; w?: number; h?: number; text?: string; color?: FloorColor }[];
  remove?: string[];
}

/** A node by its id, or a machine node by the machine's code. */
function findNode(layout: FloorLayoutData, ref: string, machines: Machines): FloorNode | undefined {
  const byId = layout.nodes.find((n) => n.id === ref);
  if (byId) return byId;
  const m = machines.find((x) => x.code.toLowerCase() === ref.trim().toLowerCase());
  return m ? layout.nodes.find((n) => n.kind === "machine" && n.machineId === m.id) : undefined;
}

/** The floor after the edit, as the canvas would leave it — or what is wrong. */
function edited(layout: FloorLayoutData, i: EditInput, machines: Machines): { layout: FloorLayoutData; changes: AiChange[] } | { error: string } {
  let next = layout;
  const changes: AiChange[] = [];
  for (const ref of i.remove ?? []) {
    const n = findNode(next, ref, machines);
    if (!n) return { error: `Nothing on the floor is ${ref} — read get_floor_layout.` };
    next = removeNode(next, n.id);
    changes.push({ label: nodeName(n, machines), before: `at ${n.x}, ${n.y}`, after: "off the floor" });
  }
  for (const a of i.add ?? []) {
    let id: string;
    if (a.kind === "machine") {
      const m = machines.find((x) => x.code.toLowerCase() === (a.machine ?? "").trim().toLowerCase());
      if (!m) return { error: `No machine ${a.machine ?? "(none named)"} in this department.` };
      if (next.nodes.some((n) => n.kind === "machine" && n.machineId === m.id)) return { error: `${m.code} is on the floor already — move it instead.` };
      next = placeMachine(next, m.id);
      id = `m${m.id}`;
    } else {
      if (!a.text?.trim()) return { error: `Give the ${a.kind === "zone" ? "area" : "label"} its text.` };
      next = addNode(next, a.kind, a.text.trim().slice(0, 80), a.color ?? "slate");
      id = next.nodes[next.nodes.length - 1].id;
    }
    if (a.x !== undefined || a.y !== undefined) {
      const n = next.nodes.find((x) => x.id === id)!;
      next = moveNode(next, id, a.x ?? n.x, a.y ?? n.y);
    }
    if (a.w !== undefined || a.h !== undefined) {
      const n = next.nodes.find((x) => x.id === id)!;
      next = resizeNode(next, id, a.w ?? n.w, a.h ?? n.h);
    }
    const n = next.nodes.find((x) => x.id === id)!;
    changes.push({ label: nodeName(n, machines), before: "—", after: `at ${n.x}, ${n.y} (${n.w}×${n.h})` });
  }
  for (const mv of i.move ?? []) {
    const n = findNode(next, mv.node, machines);
    if (!n) return { error: `Nothing on the floor is ${mv.node} — read get_floor_layout.` };
    if (n.kind === "machine" && (mv.text !== undefined || mv.color !== undefined)) return { error: `${nodeName(n, machines)} shows the machine's own name — only areas and labels take a text and a colour.` };
    let out = next;
    if (mv.x !== undefined || mv.y !== undefined) out = moveNode(out, n.id, mv.x ?? n.x, mv.y ?? n.y);
    if (mv.w !== undefined || mv.h !== undefined) {
      const at = out.nodes.find((x) => x.id === n.id)!;
      out = resizeNode(out, n.id, mv.w ?? at.w, mv.h ?? at.h);
    }
    if (mv.text !== undefined || mv.color !== undefined) out = updateNode(out, n.id, { ...(mv.text !== undefined ? { text: mv.text.trim().slice(0, 80) } : {}), ...(mv.color ? { color: mv.color } : {}) });
    const after = out.nodes.find((x) => x.id === n.id)!;
    const was = `${n.x}, ${n.y} (${n.w}×${n.h})${n.text !== undefined ? ` "${n.text}"` : ""}`;
    const now = `${after.x}, ${after.y} (${after.w}×${after.h})${after.text !== undefined ? ` "${after.text}"` : ""}`;
    if (was !== now || n.color !== after.color) changes.push({ label: nodeName(n, machines), before: was, after: now });
    next = out;
  }
  if (changes.length === 0) return { error: "The floor reads so already." };
  return { layout: parseLayout(next), changes };
}

function denied(ctx: ToolCtx): string | null {
  return hasPerm(ctx.user, "machines.manage") ? null : NO_RIGHT;
}

const PLACE = { x: { type: "number", minimum: 0, maximum: 6000 }, y: { type: "number", minimum: 0, maximum: 6000 }, w: { type: "number", minimum: 20, maximum: 6000 }, h: { type: "number", minimum: 20, maximum: 6000 } } as const;

export const editFloorLayoutTool: WriteTool<EditInput> = {
  kind: "write",
  name: "edit_floor_layout",
  title: "Edit the floor",
  description:
    "Edit a department's drawn floor as the Floor canvas does: add a machine (by its code — once; it lands on a free spot unless x/y are given), an area (zone) or a label with its text and colour; move or resize nodes (by node id, or a machine's code), change an area's or label's text or colour; take nodes off the floor (a machine itself stays on the list). Positions snap to the 10-unit grid and stay on the canvas. Read get_floor_layout first. Undo puts the floor back.",
  area: "simulator",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      add: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          properties: { kind: { type: "string", enum: ["machine", "zone", "label"] }, machine: { type: "string", maxLength: 40, description: "kind machine: its code." }, text: { type: "string", maxLength: 80 }, color: COLOR, ...PLACE },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      move: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          properties: { node: { type: "string", minLength: 1, maxLength: 60, description: "The node's id, or a machine's code." }, text: { type: "string", maxLength: 80 }, color: COLOR, ...PLACE },
          required: ["node"],
          additionalProperties: false,
        },
      },
      remove: { type: "array", maxItems: 80, items: { type: "string", minLength: 1, maxLength: 60 }, description: "Nodes to take off the floor — ids, or machines' codes." },
    },
    required: ["dept"],
    additionalProperties: false,
  },
  parse: (r) => (r.add || r.move || r.remove ? (r as unknown as EditInput) : "Say what changes on the floor."),
  async describe(i, ctx) {
    const no = denied(ctx);
    if (no) return { error: no };
    const [stored, machines] = await Promise.all([readFloorLayout(i.dept), machinesOf(i.dept)]);
    const e = edited(parseLayout(stored?.data ?? null), i, machines);
    if ("error" in e) return e;
    return {
      title: `Edit the ${i.dept} floor`,
      summary: `Edit the ${i.dept} floor: ${e.changes.length} change(s)${stored ? "" : " — its first drawing"}.`,
      changes: e.changes,
      snapshot: stored,
    };
  },
  async execute(i) {
    const [stored, machines] = await Promise.all([readFloorLayout(i.dept), machinesOf(i.dept)]);
    const e = edited(parseLayout(stored?.data ?? null), i, machines);
    if ("error" in e) return { ok: false, error: e.error };
    const r = await saveFloorLayout(formOf({ dept: i.dept, layout: JSON.stringify(e.layout) }));
    return r.ok ? { ok: true, message: `The ${i.dept} floor is saved.`, undo: { tool: "restore_floor_layout", input: { dept: i.dept, layout: JSON.stringify(stored) } } } : { ok: false, error: r.error };
  },
};

function layoutState(text: string): FloorLayoutSnapshot | null | string {
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null) return null;
    return v && typeof v === "object" && "data" in v ? (v as FloorLayoutSnapshot) : "The earlier floor is not whole.";
  } catch {
    return "The earlier floor could not be read.";
  }
}

/** The undo of a floor edit — never offered to the model. */
export const restoreFloorLayoutTool: WriteTool<{ dept: ShiftDept; layout: string }> = {
  kind: "write",
  name: "restore_floor_layout",
  internal: true,
  title: "Put the floor back",
  description: "Put a department's drawn floor back exactly as it was (the undo of edit_floor_layout).",
  area: "simulator",
  risk: "low",
  schema: { type: "object", properties: { dept: DEPT, layout: { type: "string", minLength: 4, maxLength: 500_000 } }, required: ["dept", "layout"], additionalProperties: false },
  parse(r) {
    const s = layoutState(String(r.layout));
    return typeof s === "string" ? s : { dept: r.dept as ShiftDept, layout: String(r.layout) };
  },
  async describe(i, ctx) {
    const no = denied(ctx);
    if (no) return { error: no };
    const then = layoutState(i.layout) as FloorLayoutSnapshot | null;
    const now = await readFloorLayout(i.dept);
    const count = (s: FloorLayoutSnapshot | null) => (s ? `${parseLayout(s.data).nodes.length} node(s)` : "not drawn");
    return {
      title: `Put the ${i.dept} floor back`,
      summary: `Put the ${i.dept} floor back as it was (${count(then)}).`,
      changes: [{ label: `${i.dept} floor`, before: count(now), after: count(then) }],
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreFloorLayout(i.dept, layoutState(i.layout) as FloorLayoutSnapshot | null);
    return r.ok ? { ok: true, message: `The ${i.dept} floor is back as it was.` } : { ok: false, error: r.error };
  },
};

export const FLOOR_TOOLS = [getFloorLayoutTool, editFloorLayoutTool, restoreFloorLayoutTool] as const;
