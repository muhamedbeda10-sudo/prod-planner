import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { readFloorLayout, restoreFloorLayout, type FloorLayoutSnapshot } from "@/lib/server/rowSnapshots";
import { createPartition, saveFloorLayout } from "@/app/simulate/floorActions";
import { deleteMachine } from "@/app/admin/machines/actions";
import {
  FLOOR_COLORS, addNode, moveNode, parseLayout, placeMachine, removeNode, resizeNode, startingFloor, updateNode, type FloorColor, type FloorLayoutData, type FloorNode,
} from "@/lib/domain/floor";
import { SHIFT_DEPTS, machineWord, type ShiftDept } from "@/lib/domain/shifts";
import type { AiChange } from "@/lib/domain/aiActions";
import { answerOf, formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The Floor canvas for the assistant: a department's drawn floor — its
// machines where they really stand, the areas drawn around them and free
// labels — read, and edited as the canvas edits it (the same pure moves, then
// the canvas's own save), under the key that keeps the machines list. A floor
// nobody has drawn yet is the one the page shows: every machine set out in
// rows. A new partition (Welding), line (Painting, Shot Blast) or machine
// (Fabrication) is made as the canvas's ＋ New makes it — a row of the
// machines list — and placed in the same edit. Undone by putting the floor
// back exactly as it was stored, or not drawn at all, and taking the new rows
// off the list again while nothing uses them.

const TABS = ["simulate"] as const;
const DEPT = { type: "string", enum: SHIFT_DEPTS, description: "The department's floor." } as const;
const NO_RIGHT = "Drawing the floor needs the machines key (machines.manage) — the owner ticks it on Users & Permissions.";
const COLOR = { type: "string", enum: FLOOR_COLORS } as const;

async function machinesOf(dept: string) {
  return prisma.machine.findMany({ where: { dept }, select: { id: true, code: true, name: true, active: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

type Machines = Awaited<ReturnType<typeof machinesOf>>;

/** A partition, line or machine an edit makes, and the id it has (a stand-in
 *  below zero until it is made). */
interface NewStation {
  code: string;
  name: string;
  id: number;
}

/** The code series the canvas's ＋ New numbers a department's stations in
 *  (app/simulate/floorActions.ts). */
const stationPrefix = (dept: string) => (dept === "Welding" ? "W" : dept === "Painting" ? "PL" : dept === "ShotBlast" ? "SB" : "M");
const STATION_CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;

const nodeName = (n: FloorNode, machines: Machines) => (n.kind === "machine" ? machines.find((m) => m.id === n.machineId)?.code ?? `machine #${n.machineId}` : `${n.kind} "${n.text ?? ""}"`);

/** The floor as the page shows it, and whether anything is drawn on it — an
 *  edit of a floor nobody has drawn starts from its machines set out in rows,
 *  as the planner sees them, never from an empty floor. */
function floorOf(stored: FloorLayoutSnapshot | null, machines: Machines): { layout: FloorLayoutData; drawn: boolean } {
  const drawnLayout = parseLayout(stored?.data ?? null);
  return {
    layout: startingFloor(drawnLayout, machines.filter((m) => m.active).map((m) => m.id)),
    drawn: drawnLayout.nodes.length > 0,
  };
}

export const getFloorLayoutTool: ReadTool<{ dept: ShiftDept }> = {
  kind: "read",
  name: "get_floor_layout",
  title: "Reading the floor",
  description:
    "A department's drawn floor (Floor / Simulator): the canvas size and every node — a machine (by its code) where it stands, an area or a label with its text and colour — each with its id, position (x, y from the top left) and size, in canvas units on a 10-unit grid; and the department's machines not on the floor yet. A floor nobody has drawn (drawn: false) is shown with every machine set out in rows, and is edited from there. Read it before edit_floor_layout.",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  tabs: TABS,
  status: (i) => `Reading the ${i.dept} floor`,
  async run(i) {
    const [stored, machines] = await Promise.all([readFloorLayout(i.dept), machinesOf(i.dept)]);
    const { layout, drawn } = floorOf(stored, machines);
    const placed = new Set(layout.nodes.filter((n) => n.kind === "machine").map((n) => n.machineId));
    return {
      ok: true,
      text: JSON.stringify({
        dept: i.dept,
        drawn,
        canvas: { w: layout.w, h: layout.h },
        nodes: layout.nodes.map((n) => ({
          id: n.id, kind: n.kind, ...(n.kind === "machine" ? { machine: nodeName(n, machines) } : { text: n.text ?? "", color: n.color ?? "slate" }), x: n.x, y: n.y, w: n.w, h: n.h,
        })),
        notOnFloor: machines.filter((m) => m.active && !placed.has(m.id)).map((m) => m.code),
      }),
    };
  },
};

interface AddItem {
  kind: "machine" | "zone" | "label" | "new";
  machine?: string;
  text?: string;
  color?: FloorColor;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface EditInput {
  dept: ShiftDept;
  add?: AddItem[];
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

/** The codes the new stations of an edit take — one asked for is checked
 *  free; the rest take the next free codes of the department's series, as the
 *  canvas's ＋ New picks them. In the order they are asked for. */
async function planStations(dept: ShiftDept, add: readonly AddItem[]): Promise<Omit<NewStation, "id">[] | { error: string }> {
  const asked = add.filter((a) => a.kind === "new");
  if (asked.length === 0) return [];
  const word = machineWord(dept);
  if (asked.some((a) => !a.text?.trim())) return { error: `Name each new ${word} (text) — e.g. Bay C, Tank welding 2.` };
  const taken = new Set((await prisma.machine.findMany({ select: { code: true } })).map((m) => m.code));
  const typed = asked.map((a) => a.machine?.trim().toUpperCase() || null);
  for (const code of typed) {
    if (code === null) continue;
    if (!STATION_CODE.test(code)) return { error: `${code} is not a code — letters, digits and dashes, at most 20.` };
    if (taken.has(code)) return { error: `Code ${code} is already taken.` };
    taken.add(code);
  }
  const prefix = stationPrefix(dept);
  let n = 1;
  return asked.map((a, k) => {
    let code = typed[k];
    if (code === null) {
      while (taken.has(`${prefix}-${n}`)) n += 1;
      code = `${prefix}-${n}`;
      taken.add(code);
    }
    return { code, name: a.text!.trim().slice(0, 80) };
  });
}

/** The floor after the edit, as the canvas would leave it — or what is wrong.
 *  `fresh` are the new stations the adds of kind "new" stand for, in order. */
function edited(layout: FloorLayoutData, i: EditInput, known: Machines, fresh: readonly NewStation[] = []): { layout: FloorLayoutData; changes: AiChange[] } | { error: string } {
  const machines: Machines = [...known, ...fresh.map((f) => ({ id: f.id, code: f.code, name: f.name, active: true }))];
  let next = layout;
  let made = 0;
  const changes: AiChange[] = [];
  for (const ref of i.remove ?? []) {
    const n = findNode(next, ref, machines);
    if (!n) return { error: `Nothing on the floor is ${ref} — read get_floor_layout.` };
    next = removeNode(next, n.id);
    changes.push({ label: nodeName(n, machines), before: `at ${n.x}, ${n.y}`, after: "off the floor" });
  }
  for (const a of i.add ?? []) {
    let id: string;
    if (a.kind === "new") {
      const f = fresh[made++];
      if (!f) return { error: "A new station was not planned." };
      next = placeMachine(next, f.id);
      id = `m${f.id}`;
    } else if (a.kind === "machine") {
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
    const isNew = a.kind === "new";
    changes.push({
      label: isNew ? `${nodeName(n, machines)} ${fresh[made - 1].name}` : nodeName(n, machines),
      before: "—",
      after: `${isNew ? `new ${machineWord(i.dept)}, ` : ""}at ${n.x}, ${n.y} (${n.w}×${n.h})`,
    });
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
    "Edit a department's drawn floor as the Floor canvas does: add a machine already on the list (by its code — once; it lands on a free spot unless x/y are given), an area (zone) or a label with its text and colour, or a NEW partition (Welding), line (Painting, Shot Blast) or machine (Fabrication) — kind new, its name as text, made on the machines list under the next free code (W-1, PL-1, SB-1, M-1 …) or the code given, and placed at once; move or resize nodes (by node id, or a machine's code), change an area's or label's text or colour; take nodes off the floor (a machine itself stays on the list). Positions snap to the 10-unit grid and stay on the canvas. Read get_floor_layout first. Undo puts the floor back, and takes new stations off the list again while nothing uses them.",
  area: "simulator",
  // a new row of the machines list waits for approval like any other
  risk: (i) => (i.add?.some((a) => a.kind === "new") ? "high" : "low"),
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
          properties: {
            kind: { type: "string", enum: ["machine", "zone", "label", "new"], description: "new = a new partition / line / machine made on the machines list." },
            machine: { type: "string", maxLength: 40, description: "kind machine: its code. kind new: the code to give it (left out: the next free one)." },
            text: { type: "string", maxLength: 80, description: "An area's or label's text; kind new: its name." },
            color: COLOR,
            ...PLACE,
          },
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
    const [stored, machines, plan] = await Promise.all([readFloorLayout(i.dept), machinesOf(i.dept), planStations(i.dept, i.add ?? [])]);
    if ("error" in plan) return plan;
    const floor = floorOf(stored, machines);
    const e = edited(floor.layout, i, machines, standIns(plan));
    if ("error" in e) return e;
    const codes = plan.map((p) => p.code);
    return {
      title: `Edit the ${i.dept} floor`,
      summary: `Edit the ${i.dept} floor: ${e.changes.length} change(s)${floor.drawn ? "" : " — its first drawing, from its machines set out in rows as the page shows them"}${codes.length ? ` — and ${codes.join(", ")} new on the machines list` : ""}.`,
      changes: e.changes,
      // the codes the new ones take must still be free, and theirs
      snapshot: codes.length ? { floor: stored, stations: codes } : stored,
    };
  },
  async execute(i) {
    const [stored, machines, plan] = await Promise.all([readFloorLayout(i.dept), machinesOf(i.dept), planStations(i.dept, i.add ?? [])]);
    if ("error" in plan) return { ok: false, error: plan.error };
    const floor = floorOf(stored, machines).layout;
    // the whole edit checked before anything is made
    const dry = edited(floor, i, machines, standIns(plan));
    if ("error" in dry) return { ok: false, error: dry.error };
    const made: NewStation[] = [];
    for (const p of plan) {
      const r = await answerOf(() => createPartition(formOf({ dept: i.dept, name: p.name, code: p.code })));
      const id = "id" in r ? r.id : undefined;
      if (!r.ok || !id) {
        await dropStations(made);
        return { ok: false, error: `${p.code}: ${r.error ?? "it could not be made."}` };
      }
      made.push({ ...p, id });
    }
    const e = edited(floor, i, machines, made);
    const r = "error" in e ? { ok: false, error: e.error } : await answerOf(() => saveFloorLayout(formOf({ dept: i.dept, layout: JSON.stringify(e.layout) })));
    if (!r.ok) {
      await dropStations(made);
      return { ok: false, error: r.error };
    }
    if (made.length === 0) return { ok: true, message: `The ${i.dept} floor is saved.`, undo: { tool: "restore_floor_layout", input: { dept: i.dept, layout: JSON.stringify(stored) } } };
    return {
      ok: true,
      message: `The ${i.dept} floor is saved — ${made.map((m) => m.code).join(", ")} new on the machines list.`,
      undo: { tool: "remove_floor_stations", input: { dept: i.dept, layout: JSON.stringify(stored), stations: made.map((m) => m.code) } },
    };
  },
};

/** Stand-in ids for stations not made yet — below zero, never a real row's. */
const standIns = (plan: readonly Omit<NewStation, "id">[]): NewStation[] => plan.map((p, k) => ({ ...p, id: -(k + 1) }));

/** Stations an edit made, taken off the list again when the edit could not finish. */
async function dropStations(made: readonly NewStation[]) {
  for (const m of made) await answerOf(() => deleteMachine(formOf({ id: m.id })));
}

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

interface RemoveStationsInput {
  dept: ShiftDept;
  layout: string;
  stations: string[];
}

/** What uses a machine — none of it may, for a new station to go again. */
async function usesOf(id: number): Promise<number> {
  const where = { machineId: id };
  const counts = await Promise.all([
    prisma.shiftEntry.count({ where }), prisma.machineDowntime.count({ where }), prisma.machineRule.count({ where }), prisma.worklistMachine.count({ where }),
    prisma.machineItemTime.count({ where }), prisma.handoverEntry.count({ where }), prisma.manualJob.count({ where }), prisma.sheetCutLog.count({ where }),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

/** The undo of a floor edit that made new stations — never offered to the
 *  model: the floor back as it was, and the new rows off the machines list,
 *  only while nothing uses them yet. */
export const removeFloorStationsTool: WriteTool<RemoveStationsInput> = {
  kind: "write",
  name: "remove_floor_stations",
  internal: true,
  title: "Take the new stations off again",
  description: "Put a department's floor back as it was and take the partitions, lines or machines the edit made off the machines list again (the undo of edit_floor_layout when it made new ones).",
  area: "simulator",
  risk: "high",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      layout: { type: "string", minLength: 4, maxLength: 500_000 },
      stations: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", minLength: 1, maxLength: 20 } },
    },
    required: ["dept", "layout", "stations"],
    additionalProperties: false,
  },
  parse(r) {
    const s = layoutState(String(r.layout));
    return typeof s === "string" ? s : { dept: r.dept as ShiftDept, layout: String(r.layout), stations: [...new Set(r.stations as string[])] };
  },
  async describe(i, ctx) {
    const no = denied(ctx);
    if (no) return { error: no };
    const rows = await prisma.machine.findMany({ where: { code: { in: i.stations } }, select: { id: true, code: true, name: true, dept: true } });
    const gone = i.stations.filter((c) => !rows.some((m) => m.code === c));
    if (gone.length) return { error: `${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer on the machines list.` };
    for (const m of rows) {
      if (m.dept !== i.dept) return { error: `${m.code} is in ${m.dept} now.` };
      const used = await usesOf(m.id);
      if (used > 0) return { error: `${m.code} is in use since (${used} row(s) name it) — retire it on Tools → Machines instead, and move the floor by hand.` };
    }
    const then = layoutState(i.layout) as FloorLayoutSnapshot | null;
    const now = await readFloorLayout(i.dept);
    const count = (s: FloorLayoutSnapshot | null) => (s ? `${parseLayout(s.data).nodes.length} node(s)` : "not drawn");
    return {
      title: `Put the ${i.dept} floor back`,
      summary: `Put the ${i.dept} floor back as it was (${count(then)}) and take ${rows.map((m) => `${m.code} ${m.name}`).join(", ")} off the machines list.`,
      changes: [{ label: `${i.dept} floor`, before: count(now), after: count(then) }, ...rows.map((m) => ({ label: `${m.code} ${m.name}`, before: "on the machines list", after: "removed" }))],
      snapshot: { now, stations: rows },
    };
  },
  async execute(i) {
    const back = await restoreFloorLayout(i.dept, layoutState(i.layout) as FloorLayoutSnapshot | null);
    if (!back.ok) return { ok: false, error: back.error };
    const rows = await prisma.machine.findMany({ where: { code: { in: i.stations } }, select: { id: true, code: true } });
    const failed: string[] = [];
    for (const m of rows) {
      const r = await answerOf(() => deleteMachine(formOf({ id: m.id })));
      if (!r.ok) failed.push(`${m.code}: ${r.error}`);
    }
    return failed.length
      ? { ok: false, error: `The floor is back; not taken off the list — ${failed.join("; ")}` }
      : { ok: true, message: `The ${i.dept} floor is back as it was, and ${rows.map((m) => m.code).join(", ")} off the machines list.` };
  },
};

export const FLOOR_TOOLS = [getFloorLayoutTool, editFloorLayoutTool, restoreFloorLayoutTool, removeFloorStationsTool] as const;
