import "server-only";
import type { Machine } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { isMachinePlanningOn } from "@/lib/server/data";
import { getDeptBoardLines, getMachineBoard, getOptimizerInputs } from "@/lib/server/machineBoard";
import { readQueueSnapshot, type QueueRowSnapshot } from "@/lib/server/machineQueues";
import { getAllMachineRules } from "@/lib/server/machineRules";
import {
  assignLineMachine, clearMachineQueue, moveLineRank, optimizeMachines, resetMachinePlan, restoreMachineQueues, setLineRunning, unassignLineMachine,
} from "@/app/worklist/machineActions";
import { createMachineRule, setMachineRuleOn } from "@/app/admin/machines/ruleActions";
import { optimizePlan } from "@/lib/domain/optimizePlan";
import { checkRule, machineVerdict, ruleSentence, RULE_EFFECTS, RULE_ITEMS, type MachineRuleLike } from "@/lib/domain/machineRules";
import { deptPermKey } from "@/lib/domain/permissions";
import { lineKey } from "@/lib/domain/machineBoard";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import type { MachineActionResult } from "@/app/worklist/machineActions";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The machines for the assistant: the board as the planner sees it, a dry run
// of ⚡ Plan, and every move the board itself makes — put a line on a machine,
// take it off, move it in the queue, start or pause it, plan the whole
// department, empty a machine, reset — plus the machines' rules that ⚡ Plan
// follows. Every queue change runs the board's own action as the person (the
// department's worklist permission), and is undone by putting the whole
// department's queues back exactly as they were.

type BoardDept = "Cut" | "Welding" | "Painting" | "ShotBlast";
const DEPT = { type: "string", enum: ["Cut", "Welding", "Painting", "ShotBlast"], description: "The department: Cut (Fabrication — lasers, punch, bending, fins), Welding (bay partitions), Painting (lines), ShotBlast." } as const;
const OFF = "Machine planning is switched off for the plant (Settings) — the machine board is not in use.";
const NO_RIGHT = "You do not have this department's worklist permission — the owner ticks it on Users & Permissions.";

const lineName = (bom: string, mo: string, item: string) => `${mo || bom} ${item}`;

async function machinesOf(dept: string) {
  return prisma.machine.findMany({ where: { dept }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

async function machineByCode(dept: string, code: string) {
  const m = await prisma.machine.findFirst({ where: { dept, code: { equals: code.trim(), mode: "insensitive" } } });
  return m;
}

const queueOf = (rows: readonly QueueRowSnapshot[], codeOf: Map<number, string>) =>
  rows.map((r) => `${codeOf.get(r.machineId) ?? r.machineId}#${r.rank}${r.running ? "▶" : ""} ${lineName(r.bom, r.mo, r.item)}${r.sheet ? ` [${r.sheet}]` : ""}${r.qty !== null ? ` ×${r.qty}` : ""}`);

/** The undo of any queue change: the whole department back as it was. */
const restoreUndo = (dept: string, before: QueueRowSnapshot[]) => ({ tool: "restore_machine_queues", input: { dept, rows: before } });

// ------------------------------------------------------------------ board

interface DeptInput {
  dept: BoardDept;
}

export const getMachineBoardTool: ReadTool<DeptInput> = {
  kind: "read",
  name: "get_machine_board",
  title: "Reading the machine board",
  description:
    "The department's machine board as the planner sees it today: each machine (code, centre, hours today, load in days, the day its queue clears, its crew) with what runs now and what waits in order (pieces, standard hours, the sheet, the due day), each machine's rules, and the lines NOT on any machine yet, most urgent first, with the centre they need and their sheets. Read it before moving lines or planning.",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  status: (i) => `Reading the ${i.dept} machine board`,
  async run(i, ctx) {
    if (!(await isMachinePlanningOn())) return { ok: false, text: OFF };
    const lines = await getDeptBoardLines(i.dept, ctx.todayISO);
    const [board, rules] = await Promise.all([getMachineBoard(i.dept, lines, ctx.todayISO), getAllMachineRules()]);
    const sheetsOf = (key: string) => (board.material[key]?.specs ?? []).map((s) => `${s.thicknessMm} mm ${s.material}`);
    return {
      ok: true,
      text: JSON.stringify({
        dept: i.dept,
        day: ctx.todayISO,
        machines: board.cards.map((c) => ({
          code: c.machine.code,
          name: c.machine.name,
          center: c.machine.center,
          active: c.machine.active,
          hoursToday: c.availableH,
          loadDays: c.days,
          clears: c.clearsISO ?? null,
          crew: c.crew,
          rules: rules.filter((r) => r.machineId === c.machine.id && r.active).map((r) => `#${r.id} ${ruleSentence(c.machine.code, r)}${r.note ? ` (${r.note})` : ""}`),
          queue: c.queue.map((q) => ({
            rank: q.rank, running: q.running, line: lineKey(q.bom, q.mo, q.item), pcs: q.remaining,
            ...(q.sheet ? { sheet: q.sheet } : {}), ...(q.split ? { split: true } : {}), hours: q.hours, due: q.dueISO ?? q.deliveryISO ?? null,
          })),
        })),
        notOnMachine: board.unassigned.slice(0, 80).map((u) => ({
          line: u.key, center: u.center, pcs: u.remaining, ...(u.partial ? { restOf: u.lineRemaining } : {}), ...(u.sheet ? { sheet: u.sheet } : {}),
          hours: u.hours, due: u.dueISO ?? u.deliveryISO ?? null, sheets: sheetsOf(u.key),
        })),
        notOnMachineTotal: board.unassigned.length,
      }),
    };
  },
};

export const previewMachinePlanTool: ReadTool<DeptInput> = {
  kind: "read",
  name: "preview_machine_plan",
  title: "Working out a plan for the machines",
  description:
    "A dry run of ⚡ Plan for a department — changes nothing. It plans every open line onto the machines the way the button would: by due day (flagged orders first among equals, then the longest job), each on the machine that can start it soonest, split over parallel machines when that clears it sooner, along the route, keeping what runs now, and following the machines' rules. Returns each machine's planned queue, the lines that would be late and by how much, and the lines no machine's rules allow (with why).",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  status: (i) => `Working out a plan for ${i.dept}`,
  async run(i, ctx) {
    if (!(await isMachinePlanningOn())) return { ok: false, text: OFF };
    const inp = await getOptimizerInputs(i.dept, ctx.todayISO);
    if (inp.machines.every((m) => m.availableH <= 0)) return { ok: false, text: "No machine of the department has its hours a day set (Tools → Machines) — nothing can be planned." };
    const plan = optimizePlan(inp.machines, inp.lines, inp.pins);
    const codeOf = new Map(inp.machines.map((m) => [m.id, m.code]));
    const byMachine = new Map<string, string[]>();
    for (const p of [...plan.placements].sort((a, b) => a.machineId - b.machineId || a.rank - b.rank)) {
      const code = codeOf.get(p.machineId) ?? String(p.machineId);
      (byMachine.get(code) ?? byMachine.set(code, []).get(code)!).push(`${p.key} ×${p.pieces} (day ${p.startDay}→${p.endDay})`);
    }
    const rulesOf = new Map<number, MachineRuleLike[]>();
    for (const r of inp.rules) (rulesOf.get(r.machineId) ?? rulesOf.set(r.machineId, []).get(r.machineId)!).push(r);
    return {
      ok: true,
      text: JSON.stringify({
        dept: i.dept,
        linesPlaced: plan.linesPlaced,
        machinesUsed: plan.machinesUsed,
        clearsInWorkingDays: plan.spanDays,
        queues: Object.fromEntries(byMachine),
        late: plan.late.map((l) => ({ line: l.key, dueDay: l.dueDay, endDay: l.endDay, byDays: l.byDays })),
        notPlanned: plan.skipped.map((s) => ({
          line: s.key,
          center: s.center,
          reason: s.reason,
          ...(s.reason === "not allowed"
            ? { why: inp.machines.filter((m) => m.center === s.center).map((m) => `${m.code}: ${machineVerdict(rulesOf.get(m.id) ?? [], inp.facts[s.key]).why ?? "allowed"}`) }
            : {}),
        })),
        unpriced: plan.unpriced,
      }),
    };
  },
};

// ------------------------------------------------------------- queue edits

interface LineInput {
  dept: BoardDept;
  bom: string;
  mo: string;
  item: string;
  sheet?: string;
  machine: string;
}

const LINE_FIELDS = {
  dept: DEPT,
  bom: { type: "string", minLength: 1, maxLength: 80, description: "The line's BOM (a manual job's is MANUAL, a nest run's RUN)." },
  mo: { type: "string", maxLength: 80, description: "The line's MO (\"\" for a BOM-level line)." },
  item: { type: "string", minLength: 1, maxLength: 20, description: "The line's item (CF, TC, TN, CB, AR, MB, PNL; JOB / SHEET for manual jobs and nest runs)." },
  sheet: { type: "string", maxLength: 120, description: "Only for an item spread over machines by sheet: \"<thickness>|<material>|<size>\" as the board shows it." },
  machine: { type: "string", minLength: 1, maxLength: 40, description: "The machine's code (e.g. B4-10)." },
} as const;

const parseLine = (r: Record<string, unknown>) => ({
  ...(r as unknown as LineInput),
  bom: String(r.bom).trim(),
  mo: String(r.mo ?? "").trim(),
  item: String(r.item).trim().toUpperCase(),
  sheet: String(r.sheet ?? "").trim(),
  machine: String(r.machine).trim(),
});

type EditCheck = { ok: false; error: string } | { ok: true; machine: Machine };

/** The checks every queue edit shares: the board in use, and the person's
 *  worklist permission for the department. */
async function deptEditCheck(dept: string, ctx: ToolCtx): Promise<string | null> {
  if (!(await isMachinePlanningOn())) return OFF;
  if (!hasPerm(ctx.user, deptPermKey(dept))) return NO_RIGHT;
  return null;
}

/** The department checks, and the machine of that department by its code. */
async function machineEditCheck(i: { dept: string; machine: string }, ctx: ToolCtx): Promise<EditCheck> {
  const denied = await deptEditCheck(i.dept, ctx);
  if (denied) return { ok: false, error: denied };
  const m = await machineByCode(i.dept, i.machine);
  if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
  return { ok: true, machine: m };
}

async function codes(dept: string): Promise<Map<number, string>> {
  return new Map((await machinesOf(dept)).map((m) => [m.id, m.code]));
}

function queueChanges(before: QueueRowSnapshot[], label: string, after: string): AiChange[] {
  return [{ label, before: before.length ? `${before.length} row(s)` : "—", after }];
}

const done = (r: MachineActionResult, what: string, dept: string, before: QueueRowSnapshot[]) =>
  r.ok ? { ok: true, message: r.summary ?? what, undo: restoreUndo(dept, before) } : { ok: false, error: r.error };

interface AssignInput extends LineInput {
  qty?: number | null;
}

export const assignLineTool: WriteTool<AssignInput> = {
  kind: "write",
  name: "assign_line_to_machine",
  title: "Put a line on a machine",
  description:
    "Put a worklist line on a machine, at the back of its queue. With qty only those pieces go there (the line is split, the rest stays where it is); without qty the machine takes the rest of the line. The line must be one the department still owes (see get_machine_board).",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: { ...LINE_FIELDS, qty: { type: ["integer", "null"], minimum: 1, maximum: 100000, description: "Pieces for this machine; leave out for the rest of the line." } },
    required: ["dept", "bom", "mo", "item", "machine"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...parseLine(r), qty: (r.qty as number | null | undefined) ?? null }),
  async describe(i, ctx) {
    const c = await machineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    if (!c.machine.active) return { error: `${c.machine.code} is retired.` };
    const key = lineKey(i.bom, i.mo, i.item);
    const open = i.bom === "MANUAL" || i.bom === "RUN" || (await getDeptBoardLines(i.dept, ctx.todayISO)).some((l) => lineKey(l.bom, l.mo, l.item) === key);
    if (!open) return { error: `${lineName(i.bom, i.mo, i.item)} is not an open line of ${i.dept} — read get_machine_board for the lines it owes.` };
    const before = await readQueueSnapshot(i.dept);
    const codeOf = await codes(i.dept);
    const now = before.filter((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item);
    return {
      title: `${lineName(i.bom, i.mo, i.item)} → ${c.machine.code}`,
      summary: `Put ${i.qty ? `${i.qty} pcs of ` : ""}${lineName(i.bom, i.mo, i.item)}${i.sheet ? ` (${i.sheet})` : ""} on ${c.machine.code}, at the back of its queue${i.qty ? "" : " — the rest of the line"}.`,
      changes: [{ label: lineName(i.bom, i.mo, i.item), before: now.length ? queueOf(now, codeOf).join("; ") : "not on a machine", after: `${c.machine.code}${i.qty ? ` ×${i.qty}` : " (the rest)"}` }],
      snapshot: before,
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const r = await assignLineMachine(formOf({ dept: i.dept, bom: i.bom, mo: i.mo, item: i.item, sheet: i.sheet ?? "", machineId: m.id, qty: i.qty ?? "" }));
    return done(r, `${lineName(i.bom, i.mo, i.item)} is on ${m.code}.`, i.dept, before);
  },
};

export const unassignLineTool: WriteTool<LineInput> = {
  kind: "write",
  name: "unassign_line",
  title: "Take a line off a machine",
  description: "Take a line's share off one machine (the work itself is untouched — it goes back to the lines not on a machine).",
  area: "machines",
  risk: "low",
  schema: { type: "object", properties: { ...LINE_FIELDS }, required: ["dept", "bom", "mo", "item", "machine"], additionalProperties: false },
  parse: parseLine,
  async describe(i, ctx) {
    const c = await machineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const row = before.find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === c.machine.id && r.sheet === (i.sheet ?? ""));
    if (!row) return { error: `${lineName(i.bom, i.mo, i.item)} is not on ${c.machine.code}.` };
    return {
      title: `Take ${lineName(i.bom, i.mo, i.item)} off ${c.machine.code}`,
      summary: `Take ${lineName(i.bom, i.mo, i.item)}${row.qty ? ` (×${row.qty})` : ""} off ${c.machine.code}${row.running ? " — it is running there now" : ""}.`,
      changes: queueChanges([row], `${c.machine.code} #${row.rank}`, "off the machine"),
      snapshot: before,
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const r = await unassignLineMachine(formOf({ dept: i.dept, bom: i.bom, mo: i.mo, item: i.item, sheet: i.sheet ?? "", machineId: m.id }));
    return done(r, `${lineName(i.bom, i.mo, i.item)} is off ${m.code}.`, i.dept, before);
  },
};

interface MoveInput extends LineInput {
  dir: "up" | "down" | "top";
}

export const moveLineTool: WriteTool<MoveInput> = {
  kind: "write",
  name: "move_line_in_queue",
  title: "Move a line in a machine's queue",
  description: "Move a line up or down one place in its machine's queue, or to the top (run it next).",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: { ...LINE_FIELDS, dir: { type: "string", enum: ["up", "down", "top"], description: "up / down one place, or top = run next." } },
    required: ["dept", "bom", "mo", "item", "machine", "dir"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...parseLine(r), dir: r.dir as MoveInput["dir"] }),
  async describe(i, ctx) {
    const c = await machineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const row = before.find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === c.machine.id && r.sheet === (i.sheet ?? ""));
    if (!row) return { error: `${lineName(i.bom, i.mo, i.item)} is not on ${c.machine.code}.` };
    return {
      title: `${lineName(i.bom, i.mo, i.item)} ${i.dir === "top" ? "to the top" : i.dir} on ${c.machine.code}`,
      summary: `Move ${lineName(i.bom, i.mo, i.item)} ${i.dir === "top" ? "to the top of" : `${i.dir} one place in`} ${c.machine.code}'s queue.`,
      changes: [{ label: `${c.machine.code} ${lineName(i.bom, i.mo, i.item)}`, before: `#${row.rank}`, after: i.dir === "top" ? "next" : i.dir === "up" ? `#${Math.max(1, row.rank - 1)}` : `#${row.rank + 1}` }],
      snapshot: before,
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const r = await moveLineRank(formOf({ dept: i.dept, bom: i.bom, mo: i.mo, item: i.item, sheet: i.sheet ?? "", machineId: m.id, dir: i.dir }));
    return done(r, `Moved ${lineName(i.bom, i.mo, i.item)} on ${m.code}.`, i.dept, before);
  },
};

interface RunningInput extends LineInput {
  running: boolean;
}

export const setLineRunningTool: WriteTool<RunningInput> = {
  kind: "write",
  name: "set_line_running",
  title: "Start or pause a line on a machine",
  description: "Mark a line as running on its machine now (several can run at once — a nest of several orders) or put it back to waiting.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: { ...LINE_FIELDS, running: { type: "boolean", description: "true = running now, false = back to waiting." } },
    required: ["dept", "bom", "mo", "item", "machine", "running"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...parseLine(r), running: r.running as boolean }),
  async describe(i, ctx) {
    const c = await machineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const row = before.find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === c.machine.id && r.sheet === (i.sheet ?? ""));
    if (!row) return { error: `${lineName(i.bom, i.mo, i.item)} is not on ${c.machine.code}.` };
    if (row.running === i.running) return { error: `It is ${i.running ? "running" : "waiting"} already.` };
    return {
      title: `${i.running ? "Start" : "Pause"} ${lineName(i.bom, i.mo, i.item)} on ${c.machine.code}`,
      summary: `${i.running ? "Mark" : "Put"} ${lineName(i.bom, i.mo, i.item)} ${i.running ? "as running now on" : "back to waiting on"} ${c.machine.code}.`,
      changes: [{ label: `${c.machine.code} ${lineName(i.bom, i.mo, i.item)}`, before: row.running ? "running" : "waiting", after: i.running ? "running" : "waiting" }],
      snapshot: before,
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const r = await setLineRunning(formOf({ dept: i.dept, bom: i.bom, mo: i.mo, item: i.item, sheet: i.sheet ?? "", machineId: m.id, running: i.running }));
    return done(r, `${lineName(i.bom, i.mo, i.item)} is ${i.running ? "running" : "waiting"} on ${m.code}.`, i.dept, before);
  },
};

// --------------------------------------------------------- board-wide

export const planMachinesTool: WriteTool<DeptInput> = {
  kind: "write",
  name: "plan_machines",
  title: "Plan the machines (⚡)",
  description:
    "Run ⚡ Plan for a department: every waiting whole line is taken off and the open lines are planned onto the machines again (what runs now stays, manual jobs and nest runs stay), following the machines' rules. Look at preview_machine_plan first. The card lists each machine's new queue.",
  area: "machines",
  risk: "high",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  async describe(i, ctx) {
    const denied = await deptEditCheck(i.dept, ctx);
    if (denied) return { error: denied };
    const inp = await getOptimizerInputs(i.dept, ctx.todayISO);
    if (inp.machines.every((m) => m.availableH <= 0)) return { error: "No machine of the department has its hours a day set (Tools → Machines)." };
    const plan = optimizePlan(inp.machines, inp.lines, inp.pins);
    if (plan.placements.length === 0) return { error: "Nothing to plan — every open line is running already." };
    const before = await readQueueSnapshot(i.dept);
    const codeOf = new Map(inp.machines.map((m) => [m.id, m.code]));
    const waitingNow = new Map<number, number>();
    for (const r of before) if (!r.running) waitingNow.set(r.machineId, (waitingNow.get(r.machineId) ?? 0) + 1);
    const planned = new Map<number, string[]>();
    for (const p of [...plan.placements].sort((a, b) => a.rank - b.rank)) (planned.get(p.machineId) ?? planned.set(p.machineId, []).get(p.machineId)!).push(`${p.key.split("|")[1] || p.key.split("|")[0]} ${p.key.split("|")[2]} ×${p.pieces}`);
    const changes: AiChange[] = [...new Set([...waitingNow.keys(), ...planned.keys()])].map((id) => ({
      label: codeOf.get(id) ?? String(id),
      before: `${waitingNow.get(id) ?? 0} waiting`,
      after: (planned.get(id) ?? []).join(", ") || "nothing new",
    }));
    return {
      title: `⚡ Plan ${i.dept}: ${plan.linesPlaced} line(s) on ${plan.machinesUsed} machine(s)`,
      summary: `Re-plan ${i.dept}: ${plan.linesPlaced} line(s) over ${plan.machinesUsed} machine(s), clearing in ${plan.spanDays} working day(s)${plan.late.length ? `; ${plan.late.length} line(s) would still be late (worst by ${plan.late[0].byDays} day(s))` : ""}${plan.skipped.length ? `; ${new Set(plan.skipped.map((s) => s.key)).size} line(s) left unplaced (no machine, or the rules allow none)` : ""}. What runs now stays.`,
      changes,
      snapshot: { queues: before, placements: plan.placements.map((p) => [p.key, p.machineId, p.pieces]) },
    };
  },
  async execute(i) {
    const before = await readQueueSnapshot(i.dept);
    const r = await optimizeMachines(formOf({ dept: i.dept }));
    return r.ok ? { ok: true, message: [r.summary, r.lateNote].filter(Boolean).join(" "), undo: restoreUndo(i.dept, before) } : { ok: false, error: r.error };
  },
};

export const clearMachineTool: WriteTool<{ dept: BoardDept; machine: string }> = {
  kind: "write",
  name: "clear_machine_queue",
  title: "Empty a machine's queue",
  description: "Take every line off one machine — running ones too. The work itself is untouched; the lines go back to the ones not on a machine.",
  area: "machines",
  risk: "destructive",
  schema: { type: "object", properties: { dept: DEPT, machine: LINE_FIELDS.machine }, required: ["dept", "machine"], additionalProperties: false },
  async describe(i, ctx) {
    const c = await machineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const mine = before.filter((r) => r.machineId === c.machine.id);
    if (mine.length === 0) return { error: `${c.machine.code} has nothing on it.` };
    return {
      title: `Empty ${c.machine.code}`,
      summary: `Take all ${mine.length} line(s) off ${c.machine.code}${mine.some((r) => r.running) ? ", the running ones too" : ""}.`,
      changes: queueOf(mine, new Map([[c.machine.id, c.machine.code]])).map((l) => ({ label: l, before: "on the machine", after: "off" })),
      snapshot: before,
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const r = await clearMachineQueue(formOf({ dept: i.dept, machineId: m.id }));
    return done(r, `${m.code} is empty.`, i.dept, before);
  },
};

export const resetMachinePlanTool: WriteTool<DeptInput> = {
  kind: "write",
  name: "reset_machine_plan",
  title: "Reset the department's machine plan",
  description: "⟲ Reset: take every line off every machine of the department, running ones included — the board goes back to empty, ready to be planned again. The work itself is untouched.",
  area: "machines",
  risk: "destructive",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  async describe(i, ctx) {
    const denied = await deptEditCheck(i.dept, ctx);
    if (denied) return { error: denied };
    const before = await readQueueSnapshot(i.dept);
    if (before.length === 0) return { error: `Nothing is on ${i.dept}'s machines.` };
    const codeOf = await codes(i.dept);
    const per = new Map<number, number>();
    for (const r of before) per.set(r.machineId, (per.get(r.machineId) ?? 0) + 1);
    return {
      title: `⟲ Reset ${i.dept}'s machines`,
      summary: `Take all ${before.length} line(s) off ${per.size} machine(s) of ${i.dept}, running ones included.`,
      changes: [...per].map(([id, n]) => ({ label: codeOf.get(id) ?? String(id), before: `${n} line(s)`, after: "empty" })),
      snapshot: before,
    };
  },
  async execute(i) {
    const before = await readQueueSnapshot(i.dept);
    const r = await resetMachinePlan(formOf({ dept: i.dept }));
    return done(r, `${i.dept}'s machines are empty.`, i.dept, before);
  },
};

interface RestoreInput {
  dept: BoardDept;
  rows: QueueRowSnapshot[];
}

/** The undo of every queue change above — never offered to the model. */
export const restoreQueuesTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_machine_queues",
  internal: true,
  title: "Put the machine queues back",
  description: "Put a department's machine queues back exactly as a snapshot of them (the undo of a board change).",
  area: "machines",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      rows: {
        type: "array",
        maxItems: 3000,
        items: {
          type: "object",
          properties: {
            bom: { type: "string", maxLength: 80 },
            mo: { type: "string", maxLength: 80 },
            item: { type: "string", maxLength: 20 },
            machineId: { type: "integer", minimum: 1 },
            rank: { type: "integer", minimum: 0 },
            running: { type: "boolean" },
            qty: { type: ["integer", "null"], minimum: 1 },
            sheet: { type: "string", maxLength: 120 },
            sheetDone: { type: "integer", minimum: 0 },
          },
          required: ["bom", "mo", "item", "machineId", "rank", "running", "qty", "sheet", "sheetDone"],
          additionalProperties: false,
        },
      },
    },
    required: ["dept", "rows"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const denied = await deptEditCheck(i.dept, ctx);
    if (denied) return { error: denied };
    const now = await readQueueSnapshot(i.dept);
    return {
      title: `Put ${i.dept}'s machine queues back`,
      summary: `Put ${i.dept}'s machine queues back as they were: ${i.rows.length} line(s) on the machines.`,
      changes: [{ label: `${i.dept} queues`, before: `${now.length} row(s)`, after: `${i.rows.length} row(s)` }],
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreMachineQueues(formOf({ dept: i.dept, rows: JSON.stringify(i.rows) }));
    return r.ok ? { ok: true, message: r.summary } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ rules

interface RuleInput {
  machine: string;
  dept: BoardDept;
  effect: "only" | "never" | "prefer";
  item?: string;
  line?: "TR" | "LV";
  minThicknessMm?: number;
  maxThicknessMm?: number;
  material?: string;
  minKva?: number;
  maxKva?: number;
  note?: string;
}

export const addMachineRuleTool: WriteTool<RuleInput> = {
  kind: "write",
  name: "add_machine_rule",
  title: "Add a rule to a machine",
  description:
    "Write down how a machine is used, as the planner explains it, for ⚡ Plan to follow: only = the machine takes ONLY matching work (several only-rules: any of them), never = it never takes matching work, prefer = it goes first for matching work. Every field given must match: item, line (TR/LV), thickness range in mm (every sheet of the line inside it), material (as the MATERIAL tab names it), kVA range. Put the planner's own words in note. One rule per call.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      machine: LINE_FIELDS.machine,
      effect: { type: "string", enum: RULE_EFFECTS, description: "only | never | prefer" },
      item: { type: "string", enum: RULE_ITEMS, description: "The component it is about." },
      line: { type: "string", enum: ["TR", "LV"], description: "Transformers or LV panels." },
      minThicknessMm: { type: "number", minimum: 0.1, maximum: 200, description: "The thinnest sheet, mm." },
      maxThicknessMm: { type: "number", minimum: 0.1, maximum: 200, description: "The thickest sheet, mm." },
      material: { type: "string", maxLength: 60, description: "The sheet's material as the MATERIAL tab writes it (Steel, Stainless steel …)." },
      minKva: { type: "integer", minimum: 1, maximum: 100000 },
      maxKva: { type: "integer", minimum: 1, maximum: 100000 },
      note: { type: "string", maxLength: 300, description: "The planner's own words for the rule." },
    },
    required: ["dept", "machine", "effect"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!(await isMachinePlanningOn())) return { error: OFF };
    if (!hasPerm(ctx.user, "machines.manage")) return { error: "Keeping the machines' rules needs the Machines — manage permission." };
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { error: `No machine ${i.machine} in ${i.dept}.` };
    // the same check the rule is kept under, so the card reads the rule as stored
    const checked = checkRule(i);
    if (!checked.ok) return { error: checked.error };
    const rule = { id: 0, machineId: m.id, ...checked.rule };
    const existing = await prisma.machineRule.findMany({ where: { machineId: m.id, active: true } });
    return {
      title: ruleSentence(m.code, rule),
      summary: `New rule: ${ruleSentence(m.code, rule)}${rule.note ? ` — "${rule.note}"` : ""}. ⚡ Plan follows it from the next plan.`,
      changes: [{ label: `${m.code} rules`, before: existing.length ? existing.map((r) => ruleSentence(m.code, r)).join("; ") : "none", after: `+ ${ruleSentence(m.code, rule)}` }],
      snapshot: { machineId: m.id, active: existing.map((r) => r.id) },
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const r = await createMachineRule(formOf({
      machineId: m.id, effect: i.effect, item: i.item, line: i.line, minThicknessMm: i.minThicknessMm, maxThicknessMm: i.maxThicknessMm,
      material: i.material, minKva: i.minKva, maxKva: i.maxKva, note: i.note,
    }));
    return r.ok && r.id ? { ok: true, message: `Rule #${r.id} added to ${m.code}.`, undo: { tool: "set_machine_rule_active", input: { id: r.id, active: false } } } : { ok: false, error: r.error };
  },
};

export const setMachineRuleActiveTool: WriteTool<{ id: number; active: boolean }> = {
  kind: "write",
  name: "set_machine_rule_active",
  title: "Take a machine rule off, or put it back",
  description: "Take one of the machines' rules off (it stays on record, inactive) or put a retired one back — by its id, as get_machine_board lists them (#id).",
  area: "machines",
  risk: "low",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, active: { type: "boolean", description: "false = take it off, true = put it back." } }, required: ["id", "active"], additionalProperties: false },
  async describe(i, ctx) {
    if (!(await isMachinePlanningOn())) return { error: OFF };
    if (!hasPerm(ctx.user, "machines.manage")) return { error: "Keeping the machines' rules needs the Machines — manage permission." };
    const r = await prisma.machineRule.findUnique({ where: { id: i.id }, include: { machine: { select: { code: true } } } });
    if (!r) return { error: `No rule #${i.id}.` };
    if (r.active === i.active) return { error: `Rule #${i.id} is ${r.active ? "on" : "off"} already.` };
    return {
      title: `${i.active ? "Put back" : "Take off"} rule #${i.id}`,
      summary: `${i.active ? "Put back" : "Take off"} the rule "${ruleSentence(r.machine.code, r)}".`,
      changes: [{ label: `#${i.id} ${ruleSentence(r.machine.code, r)}`, before: cell(r.active ? "on" : "off"), after: i.active ? "on" : "off" }],
      snapshot: { id: r.id, active: r.active },
    };
  },
  async execute(i) {
    const r = await setMachineRuleOn(formOf({ id: i.id, active: i.active }));
    return r.ok ? { ok: true, message: `Rule #${i.id} is ${i.active ? "on" : "off"}.`, undo: { tool: "set_machine_rule_active", input: { id: i.id, active: !i.active } } } : { ok: false, error: r.error };
  },
};

export const MACHINE_TOOLS = [
  getMachineBoardTool,
  previewMachinePlanTool,
  assignLineTool,
  unassignLineTool,
  moveLineTool,
  setLineRunningTool,
  planMachinesTool,
  clearMachineTool,
  resetMachinePlanTool,
  addMachineRuleTool,
  setMachineRuleActiveTool,
  restoreQueuesTool,
] as const;
