import "server-only";
import type { Machine } from "@prisma/client";
import { prisma } from "@/lib/db";
import { bayAccess, hasPerm } from "@/lib/server/auth";
import { isMachinePlanningOn } from "@/lib/server/data";
import { getDeptBoardLines, getMachineBoard, getOptimizerInputs } from "@/lib/server/machineBoard";
import { readQueueSnapshot, type QueueRowSnapshot } from "@/lib/server/machineQueues";
import { getAllMachineRules } from "@/lib/server/machineRules";
import {
  assignLineMachine, clearMachineQueue, moveLineRank, optimizeMachines, resetMachinePlan, restoreMachineQueues, setLineQty, setLineRunning, unassignLineMachine,
} from "@/app/worklist/machineActions";
import { createMachineRule, setMachineRuleOn } from "@/app/admin/machines/ruleActions";
import { optimizePlan } from "@/lib/domain/optimizePlan";
import { checkRule, machineVerdict, ruleSentence, RULE_EFFECTS, RULE_ITEMS, type MachineRuleLike } from "@/lib/domain/machineRules";
import { machineLinePermKey, mayScheduleLine, type BayAccess } from "@/lib/domain/permissions";
import { lineKey } from "@/lib/domain/machineBoard";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import type { MachineActionResult } from "@/app/worklist/machineActions";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The machines for the assistant: the board as the planner sees it, a dry run
// of ⚡ Plan, and every move the board itself makes — put a line on a machine,
// take it off, move it in the queue, start or pause it, plan the whole
// department, empty a machine, reset — plus the machines' rules that ⚡ Plan
// follows. Every queue change runs the board's own action as the person, under
// the board's own rule: the machines are shared, so a line is scheduled with
// ITS key (a panel's the LV stage's, a transformer part's the bay's), and a
// write over the whole bay acts on the lines the person's keys cover, leaving
// the other line's work where it is. Undone by putting the department's
// queues back exactly as they were — those same lines.

type BoardDept = "Cut" | "Welding" | "Painting" | "ShotBlast";
const DEPT = { type: "string", enum: ["Cut", "Welding", "Painting", "ShotBlast"], description: "The department: Cut (Fabrication — lasers, punch, bending, fins), Welding (bay partitions), Painting (lines), ShotBlast." } as const;
const OFF = "Machine planning is switched off for the plant (Settings) — the machine board is not in use.";
const NO_RIGHT = "You may schedule neither line on this department's machines — the owner ticks its worklist key (transformer parts) or the LV stage's key (panels) on Users & Permissions.";
const NO_LINE_RIGHT = "Scheduling this line needs its own key — the department's worklist key for a transformer part, the LV stage's key for a panel.";

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

type LineId = { bom: string; mo: string; item: string };
const sameLine = (r: LineId, l: LineId) => r.bom === l.bom && r.mo === l.mo && r.item === l.item;

/** What a change to one line relies on: where THAT line is now, machine by
 *  machine — not the rest of the department's queues. A line goes on at the
 *  back of a queue wherever the others stand, so a change to another line
 *  (another card approved first) leaves this one as good as when it was
 *  proposed; a change to this line itself (moved, resized, put on by hand)
 *  makes it out of date. Its place in a queue is left out: others moving
 *  round it do not change what this change does. */
function linesNow(rows: readonly QueueRowSnapshot[], lines: readonly LineId[]) {
  return rows
    .filter((r) => lines.some((l) => sameLine(r, l)))
    .map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, machineId: r.machineId, sheet: r.sheet, qty: r.qty, running: r.running, sheetDone: r.sheetDone }))
    .sort((a, b) => `${a.bom}|${a.mo}|${a.item}|${a.machineId}|${a.sheet}`.localeCompare(`${b.bom}|${b.mo}|${b.item}|${b.machineId}|${b.sheet}`));
}

/** What a move within one machine's queue relies on: that queue, in order. */
const machineQueue = (rows: readonly QueueRowSnapshot[], machineId: number) => rows.filter((r) => r.machineId === machineId);

// ------------------------------------------------------------------ board

interface DeptInput {
  dept: BoardDept;
}

export const getMachineBoardTool: ReadTool<DeptInput> = {
  kind: "read",
  name: "get_machine_board",
  title: "Reading the machine board",
  loaded: true,
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
    const inp = await getOptimizerInputs(i.dept, ctx.todayISO, planFor(bayAccess(ctx.user, i.dept)));
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
type BayCheck = { ok: false; error: string } | { ok: true; access: BayAccess };

/** A write over the bay — ⚡ Plan, reset, empty a machine, an undo: the board
 *  in use, and which lines the person may schedule on its machines. */
async function bayCheck(dept: string, ctx: ToolCtx): Promise<BayCheck> {
  if (!(await isMachinePlanningOn())) return { ok: false, error: OFF };
  const access = bayAccess(ctx.user, dept);
  if (!access.tr && !access.lv) return { ok: false, error: NO_RIGHT };
  return { ok: true, access };
}

/** One line on the bay's machines: the board in use, the line's own key, and
 *  the machine of that department by its code. */
async function lineEditCheck(i: { dept: string; machine: string; item: string }, ctx: ToolCtx): Promise<EditCheck> {
  if (!(await isMachinePlanningOn())) return { ok: false, error: OFF };
  const key = machineLinePermKey(i.dept, i.item);
  if (key === null) return { ok: false, error: `No panel goes on ${i.dept}'s machines.` };
  if (!hasPerm(ctx.user, key)) return { ok: false, error: NO_LINE_RIGHT };
  const m = await machineByCode(i.dept, i.machine);
  if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
  return { ok: true, machine: m };
}

/** What ⚡ Plan plans for the person: the lines their keys cover — or, for a
 *  look at the plan by someone who schedules neither, every line. */
const planFor = (access: BayAccess) => (access.tr || access.lv ? (item: string) => mayScheduleLine(access, item) : () => true);

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
    "Put ONE worklist line on a machine, at the back of its queue. With qty only those pieces go there (the line is split, the rest stays where it is); without qty the machine takes the rest of the line. The line must be one the department still owes (see get_machine_board). For more than one line use assign_lines_to_machines — one change for all of them.",
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
    const c = await lineEditCheck(i, ctx);
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
      snapshot: linesNow(before, [i]),
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

interface ManyInput {
  dept: BoardDept;
  lines: (Omit<LineInput, "dept"> & { qty?: number | null })[];
}

const ASSIGN_MANY_MAX = 80;
const lineLabel = (l: { bom: string; mo: string; item: string; sheet?: string }) => `${lineName(l.bom, l.mo, l.item)}${l.sheet ? ` (${l.sheet})` : ""}`;

/** Many lines onto the machines as ONE change: one card, one approval, one
 *  undo. Approved one by one, a distribution of single assignments refreshed
 *  the board after each and left it half done when one of them failed. */
export const assignLinesTool: WriteTool<ManyInput> = {
  kind: "write",
  name: "assign_lines_to_machines",
  title: "Put lines on machines",
  description:
    "Put several worklist lines on the machines in one change — one card, one approval, one undo. Each goes at the back of its machine's queue, in the order given (an idle machine starts on the first line it is given). With qty only those pieces go on that machine (split a line over machines with one entry per machine); without qty the machine takes the rest of the line. Use it for any distribution of more than one line; assign_line_to_machine is for a single line.",
  area: "machines",
  risk: (i) => (i.lines.length > 1 ? "high" : "low"),
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      lines: {
        type: "array",
        minItems: 1,
        maxItems: ASSIGN_MANY_MAX,
        items: {
          type: "object",
          properties: {
            bom: LINE_FIELDS.bom,
            mo: LINE_FIELDS.mo,
            item: LINE_FIELDS.item,
            sheet: LINE_FIELDS.sheet,
            machine: LINE_FIELDS.machine,
            qty: { type: ["integer", "null"], minimum: 1, maximum: 100000, description: "Pieces for this machine; leave out for the rest of the line." },
          },
          required: ["bom", "mo", "item", "machine"],
          additionalProperties: false,
        },
      },
    },
    required: ["dept", "lines"],
    additionalProperties: false,
  },
  parse(r) {
    const dept = r.dept as BoardDept;
    const lines = (r.lines as Record<string, unknown>[]).map((x) => {
      const l = parseLine({ ...x, dept });
      return { bom: l.bom, mo: l.mo, item: l.item, sheet: l.sheet, machine: l.machine, qty: (x.qty as number | null | undefined) ?? null };
    });
    const places = new Set<string>();
    const rests = new Map<string, string>();
    for (const l of lines) {
      const at = `${l.bom}|${l.mo}|${l.item}|${l.sheet}|${l.machine.toLowerCase()}`;
      if (places.has(at)) return `${lineLabel(l)} is listed twice for ${l.machine} — give it once.`;
      places.add(at);
      if (l.qty === null) {
        // a line's rest sits on one machine: a second would take it off the first
        const share = `${l.bom}|${l.mo}|${l.item}|${l.sheet}`;
        const other = rests.get(share);
        if (other) return `The rest of ${lineLabel(l)} goes on one machine only — ${other} and ${l.machine} both take it. Give the other a qty.`;
        rests.set(share, l.machine);
      }
    }
    return { dept, lines };
  },
  async describe(i, ctx) {
    if (!(await isMachinePlanningOn())) return { error: OFF };
    const machines = new Map<string, Machine>();
    for (const code of new Set(i.lines.map((l) => l.machine.toLowerCase()))) {
      const m = await machineByCode(i.dept, code);
      if (!m) return { error: `No machine ${code.toUpperCase()} in ${i.dept}.` };
      if (!m.active) return { error: `${m.code} is retired — bring it back in Tools → Machines first.` };
      machines.set(code, m);
    }
    const open = new Set((await getDeptBoardLines(i.dept, ctx.todayISO)).map((l) => lineKey(l.bom, l.mo, l.item)));
    for (const l of i.lines) {
      const key = machineLinePermKey(i.dept, l.item);
      if (key === null) return { error: `${lineLabel(l)}: no panel goes on ${i.dept}'s machines.` };
      if (!hasPerm(ctx.user, key)) return { error: `${lineLabel(l)}: ${NO_LINE_RIGHT}` };
      if (l.bom !== "MANUAL" && l.bom !== "RUN" && !open.has(lineKey(l.bom, l.mo, l.item))) {
        return { error: `${lineLabel(l)} is not an open line of ${i.dept} — read get_machine_board for the lines it owes.` };
      }
    }
    const before = await readQueueSnapshot(i.dept);
    const codeOf = await codes(i.dept);
    const per = new Map<string, number>();
    for (const l of i.lines) {
      const code = machines.get(l.machine.toLowerCase())!.code;
      per.set(code, (per.get(code) ?? 0) + 1);
    }
    return {
      title: `${i.lines.length} line(s) → ${per.size} machine(s) of ${i.dept}`,
      summary: `Put ${i.lines.length} line(s) on ${i.dept}'s machines — ${[...per].map(([code, n]) => `${code} ${n}`).join(", ")} — each at the back of its machine's queue, in this order. An idle machine starts on the first line it is given.`,
      changes: i.lines.map((l) => {
        const now = before.filter((r) => sameLine(r, l));
        return {
          label: lineLabel(l),
          before: now.length ? queueOf(now, codeOf).join("; ") : "not on a machine",
          after: `${machines.get(l.machine.toLowerCase())!.code}${l.qty ? ` ×${l.qty}` : " (the rest)"}`,
        };
      }),
      snapshot: linesNow(before, i.lines),
    };
  },
  async execute(i) {
    const machines = new Map<string, Machine>();
    for (const code of new Set(i.lines.map((l) => l.machine.toLowerCase()))) {
      const m = await machineByCode(i.dept, code);
      if (!m) return { ok: false, error: `No machine ${code.toUpperCase()} in ${i.dept}.` };
      machines.set(code, m);
    }
    const before = await readQueueSnapshot(i.dept);
    let placed = 0;
    for (const l of i.lines) {
      const m = machines.get(l.machine.toLowerCase())!;
      const r = await assignLineMachine(formOf({ dept: i.dept, bom: l.bom, mo: l.mo, item: l.item, sheet: l.sheet ?? "", machineId: m.id, qty: l.qty ?? "" }));
      if (!r.ok) {
        const why = `${lineLabel(l)} → ${m.code}: ${r.error ?? "refused"}`;
        // nothing done: nothing to undo; part done: the undo puts it all back
        if (placed === 0) return { ok: false, error: why };
        return { ok: true, message: `Put ${placed} of ${i.lines.length} line(s) on the machines — stopped at ${why}`, undo: restoreUndo(i.dept, before) };
      }
      placed += 1;
    }
    return { ok: true, message: `Put ${placed} line(s) on ${machines.size} machine(s) of ${i.dept}.`, undo: restoreUndo(i.dept, before) };
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
    const c = await lineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const row = before.find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === c.machine.id && r.sheet === (i.sheet ?? ""));
    if (!row) return { error: `${lineName(i.bom, i.mo, i.item)} is not on ${c.machine.code}.` };
    return {
      title: `Take ${lineName(i.bom, i.mo, i.item)} off ${c.machine.code}`,
      summary: `Take ${lineName(i.bom, i.mo, i.item)}${row.qty ? ` (×${row.qty})` : ""} off ${c.machine.code}${row.running ? " — it is running there now" : ""}.`,
      changes: queueChanges([row], `${c.machine.code} #${row.rank}`, "off the machine"),
      snapshot: linesNow(before, [i]),
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

interface ShareInput extends LineInput {
  qty: number | null;
}

const shareWord = (qty: number | null) => (qty === null ? "the rest of the line" : `${qty} pcs`);

/** The ✎ on a line's share: how many of its pieces ONE machine keeps. What a
 *  smaller share gives up waits for a machine; it is not handed to another. */
export const setLineShareTool: WriteTool<ShareInput> = {
  kind: "write",
  name: "set_line_share",
  title: "Resize a line's share on a machine",
  description:
    "Change how many pieces of a line ONE machine keeps (\"keep 12 of the 20 here\") — what it gives up waits for a machine, on none; qty null = this machine takes the rest of the line. The line must be on that machine already (see get_machine_board); to put it on one use assign_line_to_machine.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: { ...LINE_FIELDS, qty: { type: ["integer", "null"], minimum: 1, maximum: 100000, description: "Pieces this machine keeps; null for the rest of the line." } },
    required: ["dept", "bom", "mo", "item", "machine", "qty"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...parseLine(r), qty: r.qty as number | null }),
  async describe(i, ctx) {
    const c = await lineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const sheet = i.sheet ?? "";
    const row = before.find((r) => sameLine(r, i) && r.machineId === c.machine.id && r.sheet === sheet);
    if (!row) return { error: `${lineLabel(i)} is not on ${c.machine.code} — put it there with assign_line_to_machine.` };
    if (row.qty === i.qty) return { error: `${c.machine.code} keeps ${shareWord(i.qty)} of ${lineLabel(i)} already.` };
    if (i.qty === null) {
      // a line has one "rest" at most — the screen's picker moves it, this does not
      const rest = before.find((r) => sameLine(r, i) && r.sheet === sheet && r.machineId !== c.machine.id && r.qty === null);
      if (rest) {
        const other = (await codes(i.dept)).get(rest.machineId) ?? String(rest.machineId);
        return { error: `${other} takes the rest of ${lineLabel(i)}. To give it to ${c.machine.code} instead use assign_line_to_machine without qty — it takes it off ${other}.` };
      }
    }
    return {
      title: `${lineName(i.bom, i.mo, i.item)} on ${c.machine.code}: ${i.qty === null ? "the rest" : `×${i.qty}`}`,
      summary: `${c.machine.code} keeps ${shareWord(i.qty)} of ${lineLabel(i)} (now ${shareWord(row.qty)})${i.qty !== null && (row.qty === null || i.qty < row.qty) ? "; what it gives up waits for a machine" : ""}.`,
      changes: [{ label: `${c.machine.code} ${lineLabel(i)}`, before: row.qty === null ? "the rest" : `×${row.qty}`, after: i.qty === null ? "the rest" : `×${i.qty}` }],
      snapshot: linesNow(before, [i]),
    };
  },
  async execute(i) {
    const m = await machineByCode(i.dept, i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const r = await setLineQty(formOf({ dept: i.dept, bom: i.bom, mo: i.mo, item: i.item, sheet: i.sheet ?? "", machineId: m.id, qty: i.qty ?? "" }));
    return done(r, `${m.code} keeps ${shareWord(i.qty)} of ${lineLabel(i)}.`, i.dept, before);
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
    const c = await lineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const row = before.find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === c.machine.id && r.sheet === (i.sheet ?? ""));
    if (!row) return { error: `${lineName(i.bom, i.mo, i.item)} is not on ${c.machine.code}.` };
    return {
      title: `${lineName(i.bom, i.mo, i.item)} ${i.dir === "top" ? "to the top" : i.dir} on ${c.machine.code}`,
      summary: `Move ${lineName(i.bom, i.mo, i.item)} ${i.dir === "top" ? "to the top of" : `${i.dir} one place in`} ${c.machine.code}'s queue.`,
      changes: [{ label: `${c.machine.code} ${lineName(i.bom, i.mo, i.item)}`, before: `#${row.rank}`, after: i.dir === "top" ? "next" : i.dir === "up" ? `#${Math.max(1, row.rank - 1)}` : `#${row.rank + 1}` }],
      snapshot: machineQueue(before, c.machine.id),
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
    const c = await lineEditCheck(i, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const row = before.find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === c.machine.id && r.sheet === (i.sheet ?? ""));
    if (!row) return { error: `${lineName(i.bom, i.mo, i.item)} is not on ${c.machine.code}.` };
    if (row.running === i.running) return { error: `It is ${i.running ? "running" : "waiting"} already.` };
    return {
      title: `${i.running ? "Start" : "Pause"} ${lineName(i.bom, i.mo, i.item)} on ${c.machine.code}`,
      summary: `${i.running ? "Mark" : "Put"} ${lineName(i.bom, i.mo, i.item)} ${i.running ? "as running now on" : "back to waiting on"} ${c.machine.code}.`,
      changes: [{ label: `${c.machine.code} ${lineName(i.bom, i.mo, i.item)}`, before: row.running ? "running" : "waiting", after: i.running ? "running" : "waiting" }],
      snapshot: linesNow(before, [i]),
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
    "Run ⚡ Plan for a department: every waiting whole line the person schedules is taken off and their open lines are planned onto the machines again (what runs now stays, manual jobs and nest runs stay, and so does the other product line's work on shared machines), following the machines' rules. Look at preview_machine_plan first. The card lists each machine's new queue.",
  area: "machines",
  risk: "high",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  async describe(i, ctx) {
    const c = await bayCheck(i.dept, ctx);
    if (!c.ok) return { error: c.error };
    const inp = await getOptimizerInputs(i.dept, ctx.todayISO, planFor(c.access));
    if (inp.machines.every((m) => m.availableH <= 0)) return { error: "No machine of the department has its hours a day set (Tools → Machines)." };
    const plan = optimizePlan(inp.machines, inp.lines, inp.pins);
    if (plan.placements.length === 0) return { error: "Nothing to plan — every open line you schedule is running already." };
    const before = await readQueueSnapshot(i.dept);
    const codeOf = new Map(inp.machines.map((m) => [m.id, m.code]));
    // the waiting lines the plan replaces — the person's own lines alone
    const waitingNow = new Map<number, number>();
    for (const r of before) if (!r.running && mayScheduleLine(c.access, r.item)) waitingNow.set(r.machineId, (waitingNow.get(r.machineId) ?? 0) + 1);
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
    const c = await bayCheck(i.dept, ctx);
    if (!c.ok) return { error: c.error };
    const machine = await machineByCode(i.dept, i.machine);
    if (!machine) return { error: `No machine ${i.machine} in ${i.dept}.` };
    const before = await readQueueSnapshot(i.dept);
    const on = before.filter((r) => r.machineId === machine.id);
    const mine = on.filter((r) => mayScheduleLine(c.access, r.item));
    if (mine.length === 0) return { error: on.length ? `Only the other product line's work is on ${machine.code} — it is not yours to take off.` : `${machine.code} has nothing on it.` };
    const theirs = on.length - mine.length;
    return {
      title: `Empty ${machine.code}`,
      summary: `Take all ${mine.length} line(s) you schedule off ${machine.code}${mine.some((r) => r.running) ? ", the running ones too" : ""}${theirs ? ` — the other line's ${theirs} stay` : ""}.`,
      changes: queueOf(mine, new Map([[machine.id, machine.code]])).map((l) => ({ label: l, before: "on the machine", after: "off" })),
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
  description: "⟲ Reset: take every line the person schedules off every machine of the department, running ones included — ready to be planned again (the other product line's work on shared machines stays). The work itself is untouched.",
  area: "machines",
  risk: "destructive",
  schema: { type: "object", properties: { dept: DEPT }, required: ["dept"], additionalProperties: false },
  async describe(i, ctx) {
    const c = await bayCheck(i.dept, ctx);
    if (!c.ok) return { error: c.error };
    const before = await readQueueSnapshot(i.dept);
    const mine = before.filter((r) => mayScheduleLine(c.access, r.item));
    if (mine.length === 0) return { error: `Nothing you schedule is on ${i.dept}'s machines.` };
    const codeOf = await codes(i.dept);
    const per = new Map<number, number>();
    for (const r of mine) per.set(r.machineId, (per.get(r.machineId) ?? 0) + 1);
    const theirs = before.length - mine.length;
    return {
      title: `⟲ Reset ${i.dept}'s machines`,
      summary: `Take all ${mine.length} line(s) you schedule off ${per.size} machine(s) of ${i.dept}, running ones included${theirs ? ` — the other product line's ${theirs} stay` : ""}.`,
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
    const c = await bayCheck(i.dept, ctx);
    if (!c.ok) return { error: c.error };
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
  assignLinesTool,
  assignLineTool,
  unassignLineTool,
  setLineShareTool,
  moveLineTool,
  setLineRunningTool,
  planMachinesTool,
  clearMachineTool,
  resetMachinePlanTool,
  addMachineRuleTool,
  setMachineRuleActiveTool,
  restoreQueuesTool,
] as const;
