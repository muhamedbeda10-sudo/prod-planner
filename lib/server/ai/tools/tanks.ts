import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { resolveWorkerByEmpId, type WorkerDTO } from "@/lib/server/workers";
import { readTanks, restoreTanks, type TankSnapshot, type TankStage } from "@/lib/server/rowSnapshots";
import {
  assignTankWelder, deleteTanks, markTankRepaired, paintTanks, recordLeakTest, recordTankQa, sendTankBackToWelding, type TankActionResult,
} from "@/app/tanks/actions";
import { deptPermKey } from "@/lib/domain/permissions";
import { TANK_ITEM, TANK_STATUSES, blockedReason, type WorkerDept } from "@/lib/domain/tanks";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import type { AiChange } from "@/lib/domain/aiActions";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// Tanks piece by piece for the assistant: who welded one, the leak test, the
// repair loop, painting the tanks themselves, sending one back from painting,
// quality's verdict, and an admin taking tanks out of the records — each
// through the tank screens' own actions, as the person, by the serials on the
// steel and the badge numbers of the people who did the work. A step undone
// puts the tanks and their history back exactly as they were
// (lib/server/rowSnapshots.ts); painting is undone as the Daily log undoes it
// — its rows deleted, the tanks back to waiting for paint.

const SCREENS = ["barcode", "worklist.welding", "worklist.leak-test", "worklist.painting"];
const TRACKING_OFF = "Per-piece tank tracking is switched off (Settings) — tanks are recorded as quantities on the worklists.";
const MAX_TANKS = 100;
/** How far back a stage may be dated — older is far likelier a misread. */
const DAYS_BACK = 62;

const SERIAL = { type: "string", minLength: 3, maxLength: 40, description: "The tank's serial as on its steel / sticker." } as const;
const SERIALS = (max: number) => ({ type: "array", items: SERIAL, minItems: 1, maxItems: max, description: "The tanks' serials." }) as const;
const BADGE = (who: string) => ({ type: "string", minLength: 1, maxLength: 40, description: `The badge number of ${who} (Tools → Production workers).` }) as const;
const DATE = { type: "string", format: "date", description: "The day (default today)." } as const;

const cleanSerials = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()).filter(Boolean))];

/** The screens' rule for a stage of a tank: its worklist in sight and its key. */
function stageDenied(stage: TankStage, ctx: ToolCtx): string | null {
  const tab = { Welding: "worklist.welding", LeakTest: "worklist.leak-test", Painting: "worklist.painting", Quality: "barcode" }[stage];
  if (ctx.hidden.has(tab)) return "That screen is not opened for you, so the assistant cannot work on it for you.";
  const key = stage === "Quality" ? "quality.qa" : deptPermKey(stage);
  return hasPerm(ctx.user, key) ? null : `That needs the "${key}" permission — the owner ticks it on Users & Permissions.`;
}

async function trackingOff(): Promise<string | null> {
  return (await getSettings()).tankTracking ? null : TRACKING_OFF;
}

function dayProblem(iso: string | undefined, todayISO: string): string | null {
  if (iso === undefined) return null;
  if (iso > todayISO) return `${iso} has not come yet.`;
  if (iso < addDaysISO(todayISO, -DAYS_BACK)) return `${iso} is more than ${DAYS_BACK} days back — check the date.`;
  return null;
}

/** The tanks of these serials, every one of them — or which are missing. */
async function theTanks(serials: readonly string[]): Promise<TankSnapshot[] | { error: string }> {
  const tanks = await readTanks(serials);
  const found = new Set(tanks.map((t) => t.serial));
  const missing = serials.filter((s) => !found.has(s));
  return missing.length ? { error: `No tank carries ${missing.length === 1 ? "the serial" : "these serials"}: ${missing.join(", ")}.` } : tanks;
}

async function worker(badge: string, dept: WorkerDept, what: string): Promise<WorkerDTO | { error: string }> {
  const w = await resolveWorkerByEmpId(badge, dept);
  if (w.error) return { error: w.error };
  if (!w.worker) return { error: `Give the badge number of ${what}.` };
  return w.worker;
}

const restoreUndo = (stage: TankStage, before: TankSnapshot[]) => ({ tool: "restore_tanks", input: { stage, tanks: JSON.stringify(before) } });
const done = (r: TankActionResult, message: string, undo?: { tool: string; input: Record<string, unknown> }) =>
  r.ok ? { ok: true, message, ...(undo ? { undo } : {}) } : { ok: false, error: r.error ?? "The app refused it." };
const serialList = (ts: readonly { serial: string }[]) => (ts.length <= 6 ? ts.map((t) => t.serial).join(", ") : `${ts.slice(0, 5).map((t) => t.serial).join(", ")} and ${ts.length - 5} more`);

// ------------------------------------------------------------------ read

interface GetTanksInput {
  mo?: string;
  serials?: string[];
  status?: (typeof TANK_STATUSES)[number];
}

export const getTanksTool: ReadTool<GetTanksInput> = {
  kind: "read",
  name: "get_tanks",
  title: "Reading the tanks",
  description:
    "Tanks piece by piece: by serial, by MO, or by status — welded (waiting for the leak test), repair (sent back to welding), tested (passed, waiting for paint), painted. Each with who welded it (and the stamp), the leak test (who, when, the verdict and why), who painted it, and quality's verdict. With no filter: how many tanks stand in each status, and the leak-test and repair queues.",
  schema: {
    type: "object",
    properties: {
      mo: { type: "string", minLength: 1, maxLength: 80, description: "The order's MO." },
      serials: SERIALS(MAX_TANKS),
      status: { type: "string", enum: TANK_STATUSES, description: "Only tanks in this status." },
    },
    additionalProperties: false,
  },
  status: () => "Reading the tanks",
  async run(i, ctx) {
    if (SCREENS.every((s) => ctx.hidden.has(s))) return { ok: false, text: "No tank screen is opened for you, so the assistant cannot read the tanks for you." };
    const view = (t: Awaited<ReturnType<typeof prisma.tankUnit.findMany>>[number]) => ({
      serial: t.serial, mo: t.mo, bom: t.bom, status: t.status,
      welded: t.weldedAt.toISOString().slice(0, 10), weldedBy: t.weldedBy, ...(t.weldedStamp ? { stamp: t.weldedStamp } : {}),
      ...(t.testedAt ? { tested: t.testedAt.toISOString().slice(0, 10), testedBy: t.testedBy, test: t.testResult, ...(t.testNote ? { testNote: t.testNote } : {}) } : {}),
      ...(t.paintedAt ? { painted: t.paintedAt.toISOString().slice(0, 10), paintedBy: t.paintedBy } : {}),
      ...(t.qaResult ? { qa: t.qaResult, qaBy: t.qaBy, ...(t.qaNote ? { qaNote: t.qaNote } : {}) } : {}),
    });
    if (!i.mo && !i.serials && !i.status) {
      const [counts, leak, repair] = await Promise.all([
        prisma.tankUnit.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.tankUnit.findMany({ where: { status: "welded" }, orderBy: [{ weldedAt: "asc" }, { seq: "asc" }], take: 100 }),
        prisma.tankUnit.findMany({ where: { status: "repair" }, orderBy: [{ testedAt: "asc" }, { seq: "asc" }], take: 100 }),
      ]);
      return {
        ok: true,
        text: JSON.stringify({
          tracking: (await getSettings()).tankTracking,
          byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
          leakTestQueue: leak.map(view),
          repairQueue: repair.map(view),
        }),
      };
    }
    const rows = await prisma.tankUnit.findMany({
      where: { ...(i.mo ? { mo: i.mo.trim() } : {}), ...(i.serials ? { serial: { in: cleanSerials(i.serials) } } : {}), ...(i.status ? { status: i.status } : {}) },
      orderBy: [{ mo: "asc" }, { seq: "asc" }],
      take: 300,
    });
    return { ok: true, text: JSON.stringify({ tanks: rows.map(view), ...(rows.length === 300 ? { note: "the first 300 — narrow it down" } : {}) }) };
  },
};

// --------------------------------------------------------------- welding

interface WelderInput {
  serial: string;
  welder: string;
}

export const assignTankWelderTool: WriteTool<WelderInput> = {
  kind: "write",
  name: "assign_tank_welder",
  title: "Name a tank's welder",
  description: "Correct who welded ONE tank (a batch is recorded under one name; the tanks another welder made are corrected one by one) — the tank's stamp follows the welder. Undo puts it back.",
  area: "tracker",
  risk: "low",
  schema: { type: "object", properties: { serial: SERIAL, welder: BADGE("the welder") }, required: ["serial", "welder"], additionalProperties: false },
  parse: (r) => ({ serial: String(r.serial).trim().toUpperCase(), welder: String(r.welder).trim() }),
  async describe(i, ctx) {
    const denied = stageDenied("Welding", ctx) ?? (await trackingOff());
    if (denied) return { error: denied };
    const tanks = await theTanks([i.serial]);
    if ("error" in tanks) return tanks;
    const w = await worker(i.welder, "Welding", "the welder");
    if ("error" in w) return w;
    const t = tanks[0];
    if (t.weldedById === w.id) return { error: `${t.serial} is ${w.name}'s already.` };
    return {
      title: `${t.serial} welded by ${w.name}`,
      summary: `Record that ${w.name} welded tank ${t.serial}${w.stamp ? ` (stamp ${w.stamp})` : ""} — not ${t.weldedBy ?? "nobody named"}.`,
      changes: [{ label: `${t.serial} welder`, before: `${t.weldedBy ?? "—"}${t.weldedStamp ? ` (${t.weldedStamp})` : ""}`, after: `${w.name}${w.stamp ? ` (${w.stamp})` : ""}` }],
      snapshot: tanks,
    };
  },
  async execute(i) {
    const before = await readTanks([i.serial]);
    const w = await worker(i.welder, "Welding", "the welder");
    if ("error" in w) return { ok: false, error: w.error };
    const r = await assignTankWelder(formOf({ serial: i.serial, workerId: w.id }));
    return done(r, `${i.serial} is recorded as welded by ${w.name}.`, restoreUndo("Welding", before));
  },
};

interface RepairedInput {
  serial: string;
  welder: string;
  note?: string;
}

export const markTankRepairedTool: WriteTool<RepairedInput> = {
  kind: "write",
  name: "mark_tank_repaired",
  title: "Confirm a tank's repair",
  description: "The welder confirms a tank the leak test (or painting) sent back is fixed: it goes back to the leak-test queue for a re-test. Undo puts it back in the repair list.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: { serial: SERIAL, welder: BADGE("the welder who repaired it"), note: { type: "string", maxLength: 500, description: "What was fixed." } },
    required: ["serial", "welder"],
    additionalProperties: false,
  },
  parse: (r) => ({ serial: String(r.serial).trim().toUpperCase(), welder: String(r.welder).trim(), ...(String(r.note ?? "").trim() ? { note: String(r.note).trim() } : {}) }),
  async describe(i, ctx) {
    const denied = stageDenied("Welding", ctx) ?? (await trackingOff());
    if (denied) return { error: denied };
    const tanks = await theTanks([i.serial]);
    if ("error" in tanks) return tanks;
    const blocked = blockedReason("repair", tanks[0].status);
    if (blocked) return { error: `${i.serial}: ${blocked}` };
    const w = await worker(i.welder, "Welding", "the welder");
    if ("error" in w) return w;
    return {
      title: `${i.serial} repaired`,
      summary: `${w.name} repaired tank ${i.serial} (sent back: "${tanks[0].testNote ?? "—"}")${i.note ? ` — "${i.note}"` : ""}; it goes back to the leak test.`,
      changes: [{ label: i.serial, before: "repair", after: "waiting for the leak test" }],
      snapshot: tanks,
    };
  },
  async execute(i) {
    const before = await readTanks([i.serial]);
    const w = await worker(i.welder, "Welding", "the welder");
    if ("error" in w) return { ok: false, error: w.error };
    const r = await markTankRepaired(formOf({ serial: i.serial, workerId: w.id, note: i.note }));
    return done(r, `${i.serial} is repaired — back to the leak test.`, restoreUndo("Welding", before));
  },
};

// ------------------------------------------------------------- leak test

interface LeakInput {
  serials: string[];
  result: "pass" | "repair";
  tester: string;
  note?: string;
  date?: string;
}

export const recordLeakTestTool: WriteTool<LeakInput> = {
  kind: "write",
  name: "record_leak_test",
  title: "Record a leak test",
  description:
    "The leak test on one or more tanks, as the Leak test worklist records it: passed (they go on to painting) or repair (back to welding, with what is wrong), always with the tester's badge. Only tanks waiting for the test. Undo puts them back as they were.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      serials: SERIALS(MAX_TANKS),
      result: { type: "string", enum: ["pass", "repair"], description: "pass, or repair (failed — back to welding)." },
      tester: BADGE("who carried out the test"),
      note: { type: "string", maxLength: 500, description: "Required for repair: what is wrong." },
      date: DATE,
    },
    required: ["serials", "result", "tester"],
    additionalProperties: false,
  },
  parse(r) {
    const note = String(r.note ?? "").trim();
    if (r.result === "repair" && !note) return "Write what is wrong — welding needs to know what to fix.";
    return { serials: cleanSerials(r.serials as string[]), result: r.result as LeakInput["result"], tester: String(r.tester).trim(), ...(note ? { note } : {}), ...(r.date ? { date: r.date as string } : {}) };
  },
  async describe(i, ctx) {
    const denied = stageDenied("LeakTest", ctx) ?? (await trackingOff()) ?? dayProblem(i.date, ctx.todayISO);
    if (denied) return { error: denied };
    const tanks = await theTanks(i.serials);
    if ("error" in tanks) return tanks;
    for (const t of tanks) {
      const blocked = blockedReason("leak-test", t.status);
      if (blocked) return { error: `${t.serial}: ${blocked}` };
    }
    const w = await worker(i.tester, "LeakTest", "the tester");
    if ("error" in w) return w;
    const verdict = i.result === "pass" ? "passed" : "failed — back to welding";
    return {
      title: `Leak test: ${tanks.length} tank(s) ${i.result === "pass" ? "passed" : "to repair"}`,
      summary: `Record ${w.name}'s leak test on ${i.date ?? ctx.todayISO}: ${serialList(tanks)} ${verdict}${i.note ? ` ("${i.note}")` : ""}.`,
      changes: tanks.map((t): AiChange => ({ label: t.serial, before: "waiting for the leak test", after: i.result === "pass" ? "passed — to painting" : "repair — to welding" })),
      snapshot: tanks,
    };
  },
  async execute(i, ctx) {
    const before = await readTanks(i.serials);
    const w = await worker(i.tester, "LeakTest", "the tester");
    if ("error" in w) return { ok: false, error: w.error };
    const r = await recordLeakTest(formOf({ serials: i.serials.join(","), result: i.result, workerId: w.id, note: i.note, date: i.date ?? ctx.todayISO }));
    return done(r, `Leak test recorded on ${r.count ?? i.serials.length} tank(s).`, restoreUndo("LeakTest", before));
  },
};

// --------------------------------------------------------------- painting

interface PaintInput {
  serials: string[];
  painter: string;
  date?: string;
}

export const paintTanksTool: WriteTool<PaintInput> = {
  kind: "write",
  name: "paint_tanks",
  title: "Paint tanks",
  description:
    "Record tanks as painted, by their serials, and credit the painter — the only way a tank is painted while tanks are tracked; only tanks that passed the leak test. One Daily log row per MO (and its ODOO row). Undo deletes those rows and the tanks wait for paint again.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: { serials: SERIALS(MAX_TANKS), painter: BADGE("the painter"), date: DATE },
    required: ["serials", "painter"],
    additionalProperties: false,
  },
  parse: (r) => ({ serials: cleanSerials(r.serials as string[]), painter: String(r.painter).trim(), ...(r.date ? { date: r.date as string } : {}) }),
  async describe(i, ctx) {
    const denied = stageDenied("Painting", ctx) ?? (await trackingOff()) ?? dayProblem(i.date, ctx.todayISO);
    if (denied) return { error: denied };
    const tanks = await theTanks(i.serials);
    if ("error" in tanks) return tanks;
    for (const t of tanks) {
      const blocked = blockedReason("paint", t.status);
      if (blocked) return { error: `${t.serial}: ${blocked}` };
    }
    const w = await worker(i.painter, "Painting", "the painter");
    if ("error" in w) return w;
    // the physical chain has the last word, MO by MO (painted ≤ welded ≤ cut)
    const units = await prisma.tankUnit.findMany({ where: { serial: { in: i.serials } }, select: { serial: true, mo: true, bom: true } });
    const byMo = new Map<string, { bom: string; n: number }>();
    for (const u of units) byMo.set(u.mo, { bom: u.bom, n: (byMo.get(u.mo)?.n ?? 0) + 1 });
    for (const [mo, g] of byMo) {
      const chain = await checkOutputChain({ dept: "Painting", bom: g.bom, mo, item: TANK_ITEM, qty: g.n });
      if (chain) return { error: chain };
    }
    return {
      title: `Paint ${tanks.length} tank(s)`,
      summary: `Record ${serialList(tanks)} as painted by ${w.name} on ${i.date ?? ctx.todayISO} — ${byMo.size} Daily log row(s), one per MO (${[...byMo].map(([mo, g]) => `${mo} ×${g.n}`).join(", ")}).`,
      changes: tanks.map((t): AiChange => ({ label: t.serial, before: "passed the leak test", after: "painted" })),
      snapshot: tanks,
    };
  },
  async execute(i, ctx) {
    const w = await worker(i.painter, "Painting", "the painter");
    if ("error" in w) return { ok: false, error: w.error };
    const r = await paintTanks(formOf({ serials: i.serials.join(","), workerId: w.id, date: i.date ?? ctx.todayISO }));
    return done(r, `${r.count ?? i.serials.length} tank(s) are painted.`, r.ledgerIds?.length ? { tool: "delete_log_entries", input: { ids: r.ledgerIds } } : undefined);
  },
};

interface SendBackInput {
  serial: string;
  reason: string;
}

export const sendTankBackTool: WriteTool<SendBackInput> = {
  kind: "write",
  name: "send_tank_back_to_welding",
  title: "Send a tank back to welding",
  description: "Painting found a tank that is not sound: send THAT tank back to welding by its serial, with the reason — it goes to the repair list and through the leak test again once fixed. Undo puts it back as it was.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: { serial: SERIAL, reason: { type: "string", minLength: 1, maxLength: 500, description: "What is wrong — welding needs to know what to fix." } },
    required: ["serial", "reason"],
    additionalProperties: false,
  },
  parse(r) {
    const reason = String(r.reason).trim();
    return reason ? { serial: String(r.serial).trim().toUpperCase(), reason } : "Write the reason — welding needs to know what to fix.";
  },
  async describe(i, ctx) {
    const denied = stageDenied("Painting", ctx) ?? (await trackingOff());
    if (denied) return { error: denied };
    const tanks = await theTanks([i.serial]);
    if ("error" in tanks) return tanks;
    const t = tanks[0];
    if (t.status === "painted") return { error: `${t.serial} is painted already — talk to the admin.` };
    if (t.status === "repair") return { error: `${t.serial} is back with welding already.` };
    return {
      title: `${t.serial} back to welding`,
      summary: `Send tank ${t.serial} back to welding: "${i.reason}".`,
      changes: [{ label: t.serial, before: t.status === "tested" ? "passed the leak test" : "waiting for the leak test", after: "repair — to welding" }],
      snapshot: tanks,
    };
  },
  async execute(i) {
    const before = await readTanks([i.serial]);
    const r = await sendTankBackToWelding(formOf({ serial: i.serial, reason: i.reason }));
    return done(r, `${i.serial} is back with welding.`, restoreUndo("Painting", before));
  },
};

// ---------------------------------------------------------------- quality

interface QaInput {
  serial: string;
  result: "ok" | "not-ok";
  inspector?: string;
  note?: string;
}

export const recordTankQaTool: WriteTool<QaInput> = {
  kind: "write",
  name: "record_tank_qa",
  title: "Record quality's verdict on a tank",
  description: "Quality signs a tank off — OK, or not OK with what is wrong — as the scanned tank page does. A verdict can be given again later; every one stays in the tank's history. Undo takes this one back.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      serial: SERIAL,
      result: { type: "string", enum: ["ok", "not-ok"] },
      inspector: BADGE("the inspector, when it is not the person themselves"),
      note: { type: "string", maxLength: 500, description: "Required for not-ok: what is wrong." },
    },
    required: ["serial", "result"],
    additionalProperties: false,
  },
  parse(r) {
    const note = String(r.note ?? "").trim();
    if (r.result === "not-ok" && !note) return "Write what is wrong with it.";
    const inspector = String(r.inspector ?? "").trim();
    return { serial: String(r.serial).trim().toUpperCase(), result: r.result as QaInput["result"], ...(inspector ? { inspector } : {}), ...(note ? { note } : {}) };
  },
  async describe(i, ctx) {
    const denied = stageDenied("Quality", ctx);
    if (denied) return { error: denied };
    const tanks = await theTanks([i.serial]);
    if ("error" in tanks) return tanks;
    const w = i.inspector ? await worker(i.inspector, "Quality", "the inspector") : null;
    if (w && "error" in w) return w;
    const t = tanks[0];
    return {
      title: `QA ${t.serial}: ${i.result === "ok" ? "OK" : "not OK"}`,
      summary: `Record quality's verdict on tank ${t.serial}: ${i.result === "ok" ? "OK" : `not OK — "${i.note}"`}, by ${w ? w.name : ctx.user.name}.`,
      changes: [{ label: `${t.serial} QA`, before: t.qaResult ?? "—", after: i.result }],
      snapshot: tanks,
    };
  },
  async execute(i) {
    const before = await readTanks([i.serial]);
    const w = i.inspector ? await worker(i.inspector, "Quality", "the inspector") : null;
    if (w && "error" in w) return { ok: false, error: w.error };
    const r = await recordTankQa(formOf({ serial: i.serial, result: i.result, workerId: w?.id, note: i.note }));
    return done(r, `Quality's verdict on ${i.serial} is recorded.`, restoreUndo("Quality", before));
  },
};

// ---------------------------------------------------------------- removal

export const deleteTanksTool: WriteTool<{ serials: string[] }> = {
  kind: "write",
  name: "delete_tanks",
  title: "Delete tanks from the records",
  description:
    "An admin's removal of tanks recorded by mistake: each tank, its whole history and the quantity it put on the Daily log (welding and painting) — a log row shared with other tanks only loses this tank's piece. It cannot be undone, as the barcode tab says.",
  area: "tracker",
  risk: "destructive",
  schema: { type: "object", properties: { serials: SERIALS(MAX_TANKS) }, required: ["serials"], additionalProperties: false },
  parse: (r) => ({ serials: cleanSerials(r.serials as string[]) }),
  async describe(i, ctx) {
    if (ctx.hidden.has("barcode")) return { error: "That screen is not opened for you, so the assistant cannot work on it for you." };
    if (!ctx.user.isAdmin) return { error: "Only an admin deletes tanks from the records." };
    const tanks = await theTanks(i.serials);
    if ("error" in tanks) return tanks;
    return {
      title: `Delete ${tanks.length} tank(s)`,
      summary: `Delete ${serialList(tanks)} from the records — each tank, its history and its piece of the Daily log's welding and painting rows. It cannot be undone.`,
      changes: tanks.map((t): AiChange => ({ label: t.serial, before: t.status, after: "deleted" })),
      snapshot: tanks,
    };
  },
  async execute(i) {
    const r = await deleteTanks(formOf({ serials: i.serials.join(",") }));
    return done(r, `${r.count ?? i.serials.length} tank(s) are deleted.`);
  },
};

// ------------------------------------------------------------------- undo

const STAGES: TankStage[] = ["Welding", "LeakTest", "Painting", "Quality"];

function tanksState(text: string): TankSnapshot[] | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "The earlier tanks could not be read.";
  }
  const ok = Array.isArray(v) && v.length > 0 && v.every((t) => t && typeof t === "object" && Number.isInteger(t.id) && typeof t.serial === "string" && typeof t.status === "string" && typeof t.weldedAt === "string" && Array.isArray(t.events));
  return ok ? (v as TankSnapshot[]) : "The earlier tanks are not whole.";
}

/** The undo of a tank's step — never offered to the model. */
export const restoreTanksTool: WriteTool<{ stage: TankStage; tanks: string }> = {
  kind: "write",
  name: "restore_tanks",
  internal: true,
  title: "Put tanks back",
  description: "Put tanks and their history back exactly as they were (the undo of a step recorded on them).",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { stage: { type: "string", enum: STAGES }, tanks: { type: "string", minLength: 2, maxLength: 500_000 } },
    required: ["stage", "tanks"],
    additionalProperties: false,
  },
  parse(r) {
    const s = tanksState(r.tanks as string);
    return typeof s === "string" ? s : { stage: r.stage as TankStage, tanks: r.tanks as string };
  },
  async describe(i, ctx) {
    const denied = stageDenied(i.stage, ctx);
    if (denied) return { error: denied };
    const then = tanksState(i.tanks) as TankSnapshot[];
    const now = await readTanks(then.map((t) => t.serial));
    return {
      title: `Put ${then.length} tank(s) back`,
      summary: `Put ${serialList(then)} back as they were — the step recorded on them taken out of their history.`,
      changes: then.map((t): AiChange => ({ label: t.serial, before: now.find((n) => n.id === t.id)?.status ?? "deleted", after: t.status })),
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreTanks(i.stage, tanksState(i.tanks) as TankSnapshot[]);
    return r.ok ? { ok: true, message: "The tanks are back as they were." } : { ok: false, error: r.error };
  },
};

export const TANK_TOOLS = [
  getTanksTool,
  assignTankWelderTool,
  markTankRepairedTool,
  recordLeakTestTool,
  paintTanksTool,
  sendTankBackTool,
  recordTankQaTool,
  deleteTanksTool,
  restoreTanksTool,
] as const;
