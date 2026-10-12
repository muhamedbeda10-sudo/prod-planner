import "server-only";
import type { Machine } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { CAL_STAGES, getCalibration, type CalStage } from "@/lib/server/calibration";
import { applyCalibration, deleteFgMap, deleteLvStdTime, deleteStdTier, setStageCapacity, upsertFgMap, upsertLvStdTime, upsertStdTier } from "@/app/admin/standard-times/actions";
import { saveMachineItemTimes } from "@/app/admin/machine-times/actions";
import { saveShiftHours, setMachinePlanning, setTankTracking } from "@/app/admin/settings/actions";
import { readMachineTimes, readStdState, restoreMachineTimes, restoreStdState, type MachineTimeSnapshot, type StdKeys, type StdState } from "@/lib/server/rowSnapshots";
import { normFg } from "@/lib/domain/stdEngine";
import { DEFAULTS, ITEMS, deptLabel } from "@/lib/domain/constants";
import { DEFAULT_SHIFT_HOURS } from "@/lib/domain/shifts";
import { cell } from "@/lib/domain/aiActions";
import { answerOf, formOf, type ReadTool, type WriteTool } from "./types";

// The plant's set-up for the assistant: the standard times (the hours a KVA
// class's tank takes at each stage, the FG codes that point at a class, the
// LV panels' hours), each stage's capacity and the calibration that rescales
// them, the times per machine, and the plant's settings (the shift hours,
// the two master switches). Every figure the app plans with is built on
// these, so each change waits for an approval click and says what it moves.
//
// Through each screen's own action as the person: the standard times and the
// settings are an admin's, the times per machine are machines.manage's. Each
// is undone by putting the rows back exactly as they were — a row that was
// not there is removed again (lib/server/rowSnapshots.ts).

const STD_TABS = ["standard-times"] as const;
const TIMES_TABS = ["machine-times"] as const;
const SETTINGS_TABS = ["settings"] as const;
const NOT_ADMIN = "The standard times, the capacity and the plant's settings are an admin's — ask one.";
const NO_MACHINES = "The times per machine need the Machines — manage permission (Users & Permissions).";
const MAX_STATE = 200_000;

const HOURS = (what: string) => ({ type: "number", minimum: 0, maximum: 10000, description: `${what} man-hours per tank.` }) as const;
const STAGE = { type: "string", enum: [...CAL_STAGES], description: "Cut = Fabrication (laser + bending + fin folding), Welding, ShotBlast, Painting." } as const;
const STAGE_FIELD = { Cut: "cutMh", Welding: "weldMh", ShotBlast: "shbMh", Painting: "paintMh" } as const satisfies Record<CalStage, string>;
const TIER_LABELS = [["cutMh", "Fabrication"], ["weldMh", "Welding"], ["shbMh", "Shot Blast"], ["paintMh", "Painting"]] as const;
const LV_LABELS = [["cutH", "Cutting"], ["bendH", "Bending"], ["weldH", "Welding"], ["shbH", "Shot blast"], ["paintH", "Paint line"]] as const;
const LV_KINDS = ["USS", "MB", "FP"] as const;
const LV_FG_RE = /^[A-Z0-9][A-Z0-9-]{3,}$/;

const round2 = (n: number) => Math.round(n * 100) / 100;
const undoStd = (state: StdState) => ({ tool: "restore_standard_times", input: { state: JSON.stringify(state) } });

// ------------------------------------------------------------------ read

export const getStandardTimesTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "get_standard_times",
  title: "Reading the standard times",
  description:
    "The standard times as Admin → Standard times shows them: each KVA class's man-hours per tank at each stage, each stage's capacity (man-hours a working day), and the calibration — per stage, the hours the roster says were worked against the hours the output earned over the recent window, the factor that would rescale the stage, and whether it is ready to apply. The FG map and the LV panels' hours are in \"StdFgMap\" and \"LvStdTime\" (query_database).",
  schema: { type: "object", properties: {}, additionalProperties: false },
  tabs: STD_TABS,
  async run() {
    const [{ stages }, tiers, capacity, fgCount, lvCount] = await Promise.all([
      getCalibration(),
      prisma.stdTime.findMany({ orderBy: { kva: "asc" } }),
      prisma.stageCapacity.findMany(),
      prisma.stdFgMap.count(),
      prisma.lvStdTime.count(),
    ]);
    return {
      ok: true,
      text: JSON.stringify({
        classes: tiers.map((t) => ({ kva: t.kva, cutMh: t.cutMh, weldMh: t.weldMh, shbMh: t.shbMh, paintMh: t.paintMh })),
        capacityMhPerDay: Object.fromEntries(CAL_STAGES.map((d) => [d, capacity.find((c) => c.dept === d)?.mhPerDay ?? null])),
        calibration: stages.map((s) => ({
          stage: s.dept, days: s.days, actualH: round2(s.actualH), earnedH: round2(s.earnedH),
          efficiency: s.efficiency === null ? null : round2(s.efficiency), factor: s.factor === null ? null : Math.round(s.factor * 1000) / 1000, ready: s.ready, reason: s.reason,
        })),
        fgCodesMapped: fgCount,
        lvPanels: lvCount,
      }),
    };
  },
};

// ------------------------------------------------------------------ KVA classes

interface TierInput {
  kva: number;
  cutMh?: number;
  weldMh?: number;
  shbMh?: number;
  paintMh?: number;
}

type Tier = { cutMh: number; weldMh: number; shbMh: number; paintMh: number };

const tierText = (t: Tier | null) => (t ? TIER_LABELS.map(([k, l]) => `${l} ${t[k]}`).join(" · ") : "—");

async function plannedTier(i: TierInput): Promise<{ was: Tier | null; next: Tier } | { error: string }> {
  const row = await prisma.stdTime.findUnique({ where: { kva: i.kva } });
  const was = row ? { cutMh: row.cutMh, weldMh: row.weldMh, shbMh: row.shbMh, paintMh: row.paintMh } : null;
  const pick = (k: keyof Tier) => i[k] ?? was?.[k];
  const [cutMh, weldMh, shbMh, paintMh] = [pick("cutMh"), pick("weldMh"), pick("shbMh"), pick("paintMh")];
  if (cutMh === undefined || weldMh === undefined || shbMh === undefined || paintMh === undefined) return { error: `There is no ${i.kva} KVA class yet — give all four stages' hours to add it.` };
  const next = { cutMh, weldMh, shbMh, paintMh };
  if (cutMh + weldMh + shbMh + paintMh === 0) return { error: "A class of all zeros would price its tanks at nothing — delete the class instead." };
  return { was, next };
}

export const setStdClassTool: WriteTool<TierInput> = {
  kind: "write",
  name: "set_std_class",
  title: "Set a KVA class's standard hours",
  description: "Add a KVA class to the standard times, or change its man-hours per tank at any stage (only the stages given change). Every plan, load and ETA of that class's orders is priced with these.",
  area: "setup",
  risk: "high",
  tabs: STD_TABS,
  schema: {
    type: "object",
    properties: { kva: { type: "integer", minimum: 1, maximum: 1000000 }, cutMh: HOURS("Fabrication"), weldMh: HOURS("Welding"), shbMh: HOURS("Shot blast"), paintMh: HOURS("Painting") },
    required: ["kva"],
    additionalProperties: false,
  },
  parse: (r) => (["cutMh", "weldMh", "shbMh", "paintMh"].some((k) => r[k] !== undefined) ? (r as unknown as TierInput) : "Give the stage hours to set."),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const p = await plannedTier(i);
    if ("error" in p) return p;
    const changes = TIER_LABELS.filter(([k]) => p.was?.[k] !== p.next[k]).map(([k, l]) => ({ label: `${i.kva} KVA — ${l}`, before: cell(p.was?.[k] ?? null), after: cell(p.next[k]) }));
    if (changes.length === 0) return { error: `The ${i.kva} KVA class reads so already.` };
    return {
      title: `${p.was ? "Change" : "Add"} the ${i.kva} KVA class`,
      summary: `${p.was ? "Change" : "Add"} the ${i.kva} KVA class's standard hours per tank: ${tierText(p.next)} — the plans, loads and ETAs of its orders move with it.`,
      changes,
      snapshot: await readStdState({ tiers: [i.kva] }),
    };
  },
  async execute(i) {
    const p = await plannedTier(i);
    if ("error" in p) return { ok: false, error: p.error };
    const before = await readStdState({ tiers: [i.kva] });
    const r = await upsertStdTier(formOf({ kva: i.kva, ...p.next }));
    return r.ok ? { ok: true, message: `The ${i.kva} KVA class is set: ${tierText(p.next)}.`, undo: undoStd(before) } : { ok: false, error: r.error };
  },
};

export const deleteStdClassTool: WriteTool<{ kva: number }> = {
  kind: "write",
  name: "delete_std_class",
  title: "Delete a KVA class",
  description: "Delete a KVA class from the standard times. Orders and FG codes that pointed at it are priced by the nearest class left. The last class cannot go.",
  area: "setup",
  risk: "destructive",
  tabs: STD_TABS,
  schema: { type: "object", properties: { kva: { type: "integer", minimum: 1 } }, required: ["kva"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const state = await readStdState({ tiers: [i.kva] });
    const was = state.tiers[0].row;
    if (!was) return { error: `There is no ${i.kva} KVA class.` };
    if ((await prisma.stdTime.count({ where: { kva: { not: i.kva } } })) === 0) return { error: "The last class cannot be deleted — every figure in the app would go to zero." };
    const fgs = await prisma.stdFgMap.count({ where: { kva: i.kva } });
    return {
      title: `Delete the ${i.kva} KVA class`,
      summary: `Delete the ${i.kva} KVA class (${tierText(was)})${fgs ? ` — ${fgs} FG code(s) mapped to it fall back to the nearest class` : ""}.`,
      changes: [{ label: `${i.kva} KVA`, before: tierText(was), after: "deleted" }],
      snapshot: state,
    };
  },
  async execute(i) {
    const before = await readStdState({ tiers: [i.kva] });
    const r = await deleteStdTier(formOf({ kva: i.kva }));
    return r.ok ? { ok: true, message: `The ${i.kva} KVA class is deleted.`, undo: undoStd(before) } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ capacity

export const setStageCapacityTool: WriteTool<{ dept: CalStage; mhPerDay: number }> = {
  kind: "write",
  name: "set_stage_capacity",
  title: "Set a stage's capacity",
  description: "Set a stage's available capacity — man-hours on a working day — the figure the plan's required hours are measured against.",
  area: "setup",
  risk: "high",
  tabs: STD_TABS,
  schema: { type: "object", properties: { dept: STAGE, mhPerDay: { type: "number", minimum: 0, maximum: 100000 } }, required: ["dept", "mhPerDay"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const state = await readStdState({ capacity: [i.dept] });
    const was = state.capacity[0].mhPerDay;
    if (was === i.mhPerDay) return { error: `${deptLabel(i.dept)}'s capacity is ${i.mhPerDay} already.` };
    return {
      title: `${deptLabel(i.dept)} capacity → ${i.mhPerDay} mh/day`,
      summary: `Set ${deptLabel(i.dept)}'s capacity to ${i.mhPerDay} man-hours a working day.`,
      changes: [{ label: `${deptLabel(i.dept)} capacity (mh/day)`, before: cell(was), after: cell(i.mhPerDay) }],
      snapshot: state,
    };
  },
  async execute(i) {
    const before = await readStdState({ capacity: [i.dept] });
    const r = await setStageCapacity(formOf({ dept: i.dept, mhPerDay: i.mhPerDay }));
    return r.ok ? { ok: true, message: `${deptLabel(i.dept)}'s capacity is ${i.mhPerDay} mh/day.`, undo: undoStd(before) } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ FG map

interface MapInput {
  codes: { fg: string; kva: number }[];
}

function mapParse(r: Record<string, unknown>): MapInput | string {
  const codes = (r.codes as MapInput["codes"]).map((c) => ({ fg: normFg(c.fg), kva: c.kva }));
  if (codes.some((c) => !c.fg)) return "An FG code is empty.";
  if (new Set(codes.map((c) => c.fg)).size !== codes.length) return "An FG code is named twice.";
  return { codes };
}

export const mapFgCodesTool: WriteTool<MapInput> = {
  kind: "write",
  name: "map_fg_codes",
  title: "Map FG codes to KVA classes",
  description: "Point FG codes at a KVA class (the sheet's product table) — the FG map outranks an order's own KVA when its tanks are priced. Codes are kept upper-case, letters and digits only.",
  area: "setup",
  risk: "high",
  tabs: STD_TABS,
  schema: {
    type: "object",
    properties: {
      codes: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "object", properties: { fg: { type: "string", minLength: 1, maxLength: 80 }, kva: { type: "integer", minimum: 1 } }, required: ["fg", "kva"], additionalProperties: false },
      },
    },
    required: ["codes"],
    additionalProperties: false,
  },
  parse: mapParse,
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const classes = new Set((await prisma.stdTime.findMany({ select: { kva: true } })).map((t) => t.kva));
    const missing = i.codes.find((c) => !classes.has(c.kva));
    if (missing) return { error: `No ${missing.kva} KVA class exists — add the class first (set_std_class).` };
    const state = await readStdState({ fgMap: i.codes.map((c) => c.fg) });
    const changing = i.codes.filter((c) => state.fgMap.find((f) => f.fg === c.fg)?.kva !== c.kva);
    if (changing.length === 0) return { error: "Every one of those codes points there already." };
    return {
      title: `Map ${changing.length} FG code(s)`,
      summary: `Point ${changing.length} FG code(s) at their KVA class — their orders are priced with it.`,
      changes: changing.map((c) => ({ label: c.fg, before: cell(state.fgMap.find((f) => f.fg === c.fg)?.kva ?? null), after: `${c.kva} KVA` })),
      snapshot: state,
    };
  },
  async execute(i) {
    const before = await readStdState({ fgMap: i.codes.map((c) => c.fg) });
    let done = 0;
    for (const c of i.codes) {
      const r = await answerOf(() => upsertFgMap(formOf({ fg: c.fg, kva: c.kva })));
      if (!r.ok) {
        if (done === 0) return { ok: false, error: r.error ?? "Refused." };
        return { ok: true, message: `Mapped ${done} of ${i.codes.length} — stopped at ${c.fg}: ${r.error ?? "refused"}.`, undo: undoStd(before) };
      }
      done++;
    }
    return { ok: true, message: `${done} FG code(s) mapped.`, undo: undoStd(before) };
  },
};

export const unmapFgCodesTool: WriteTool<{ fgs: string[] }> = {
  kind: "write",
  name: "unmap_fg_codes",
  title: "Take FG codes off the map",
  description: "Take FG codes off the FG map — their orders are priced by their own KVA again.",
  area: "setup",
  risk: "destructive",
  tabs: STD_TABS,
  schema: { type: "object", properties: { fgs: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 80 } } }, required: ["fgs"], additionalProperties: false },
  parse: (r) => ({ fgs: [...new Set((r.fgs as string[]).map(normFg).filter(Boolean))] }),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const state = await readStdState({ fgMap: i.fgs });
    const mapped = state.fgMap.filter((f) => f.kva !== null);
    if (mapped.length === 0) return { error: "None of those codes is on the FG map." };
    return {
      title: `Unmap ${mapped.length} FG code(s)`,
      summary: `Take ${mapped.length} FG code(s) off the FG map — their orders are priced by their own KVA.`,
      changes: mapped.map((f) => ({ label: f.fg, before: `${f.kva} KVA`, after: "not mapped" })),
      snapshot: state,
    };
  },
  async execute(i) {
    const before = await readStdState({ fgMap: i.fgs });
    let done = 0;
    for (const fg of before.fgMap.filter((f) => f.kva !== null).map((f) => f.fg)) {
      const r = await answerOf(() => deleteFgMap(formOf({ fg })));
      if (!r.ok) {
        if (done === 0) return { ok: false, error: r.error ?? "Refused." };
        return { ok: true, message: `Unmapped ${done} — stopped at ${fg}: ${r.error ?? "refused"}.`, undo: undoStd(before) };
      }
      done++;
    }
    return { ok: true, message: `${done} FG code(s) taken off the map.`, undo: undoStd(before) };
  },
};

// ------------------------------------------------------------------ calibration

export const applyCalibrationTool: WriteTool<{ dept: CalStage }> = {
  kind: "write",
  name: "apply_calibration",
  title: "Apply a stage's calibration",
  description: "Rescale ONE stage's standard hours across every KVA class by the calibration factor (the hours the roster says were worked ÷ the hours the output earned), as the Calibration panel's Apply does. Only when the stage's calibration is ready — read it with get_standard_times.",
  area: "setup",
  risk: "high",
  tabs: STD_TABS,
  schema: { type: "object", properties: { dept: STAGE }, required: ["dept"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const { stages } = await getCalibration();
    const cal = stages.find((s) => s.dept === i.dept);
    if (!cal?.ready || cal.factor === null) return { error: `${deptLabel(i.dept)}'s calibration is not ready to apply${cal?.reason ? `: ${cal.reason}` : ""}.` };
    const tiers = await prisma.stdTime.findMany({ orderBy: { kva: "asc" } });
    const field = STAGE_FIELD[i.dept];
    return {
      title: `Calibrate ${deptLabel(i.dept)} × ${Math.round(cal.factor * 1000) / 1000}`,
      summary: `Rescale ${deptLabel(i.dept)}'s standard hours in all ${tiers.length} KVA classes by ${Math.round(cal.factor * 1000) / 1000} — from ${cal.days} recorded day(s): ${round2(cal.actualH)} h worked against ${round2(cal.earnedH)} h earned.`,
      changes: tiers.map((t) => ({ label: `${t.kva} KVA — ${deptLabel(i.dept)}`, before: cell(t[field]), after: cell(round2(t[field] * cal.factor!)) })),
      snapshot: { factor: cal.factor, tiers: (await readStdState({ tiers: tiers.map((t) => t.kva) })).tiers },
    };
  },
  async execute(i) {
    const before = await readStdState({ tiers: (await prisma.stdTime.findMany({ select: { kva: true } })).map((t) => t.kva) });
    const r = await applyCalibration(formOf({ dept: i.dept }));
    return r.ok ? { ok: true, message: `${deptLabel(i.dept)}'s standard hours are calibrated.`, undo: undoStd(before) } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ LV panels

interface LvInput {
  fg: string;
  description?: string | null;
  kind?: (typeof LV_KINDS)[number];
  cutH?: number;
  bendH?: number;
  weldH?: number;
  shbH?: number;
  paintH?: number;
}

type LvRow = NonNullable<StdState["lv"][number]["row"]>;
const lvText = (r: LvRow | null) => (r ? `${r.kind} · ${LV_LABELS.map(([k, l]) => `${l} ${r[k]}`).join(" · ")}` : "—");
const LV_HOURS = (what: string) => ({ type: "number", minimum: 0, maximum: 1000, description: `${what} hours per panel.` }) as const;

async function plannedLv(i: LvInput): Promise<{ was: LvRow | null; next: LvRow } | { error: string }> {
  const state = await readStdState({ lv: [i.fg] });
  const was = state.lv[0].row;
  const hours = {} as Record<(typeof LV_LABELS)[number][0], number>;
  for (const [k, l] of LV_LABELS) {
    const v = i[k] ?? was?.[k];
    if (v === undefined) return { error: `${i.fg} is not on the LV sheet yet — give all five stages' hours (${l} is missing).` };
    hours[k] = v;
  }
  if (Object.values(hours).every((v) => v === 0)) return { error: "A panel of all zeros would earn nothing — delete it instead." };
  const description = i.description === undefined ? was?.description ?? null : i.description?.trim() || null;
  return { was, next: { description, kind: i.kind ?? was?.kind ?? "USS", ...hours, totalH: was?.totalH ?? null } };
}

export const setLvStdTimeTool: WriteTool<LvInput> = {
  kind: "write",
  name: "set_lv_std_time",
  title: "Set an LV panel's standard hours",
  description: "Add an LV panel to the timings sheet's LV tab, or change its standard hours per unit at any stage (cutting, bending, welding, shot blast, paint line), its description or its kind (USS, MB meter box, FP feeder pillar). The FG code as the sheet writes it, e.g. FG-SUSA-8569105.",
  area: "setup",
  risk: "high",
  tabs: STD_TABS,
  schema: {
    type: "object",
    properties: {
      fg: { type: "string", minLength: 4, maxLength: 60 },
      description: { type: ["string", "null"], maxLength: 200 },
      kind: { type: "string", enum: [...LV_KINDS] },
      cutH: LV_HOURS("Cutting / punching"),
      bendH: LV_HOURS("Bending"),
      weldH: LV_HOURS("Welding"),
      shbH: LV_HOURS("Shot blast"),
      paintH: LV_HOURS("Paint line"),
    },
    required: ["fg"],
    additionalProperties: false,
  },
  parse(r) {
    const fg = String(r.fg).trim().toUpperCase();
    if (!LV_FG_RE.test(fg)) return "Give the panel's FG code as the sheet writes it (FG-SUSA-8569105).";
    if (["description", "kind", "cutH", "bendH", "weldH", "shbH", "paintH"].every((k) => r[k] === undefined)) return "Say what to set on the panel.";
    return { ...(r as unknown as LvInput), fg };
  },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const p = await plannedLv(i);
    if ("error" in p) return p;
    if (p.was && lvText(p.was) === lvText(p.next) && p.was.description === p.next.description) return { error: `${i.fg} reads so already.` };
    return {
      title: `${p.was ? "Change" : "Add"} LV panel ${i.fg}`,
      summary: `${p.was ? "Change" : "Add"} ${i.fg}'s standard hours per panel: ${lvText(p.next)}${p.next.description ? ` (${p.next.description})` : ""}.`,
      changes: [{ label: i.fg, before: lvText(p.was), after: lvText(p.next) }],
      snapshot: await readStdState({ lv: [i.fg] }),
    };
  },
  async execute(i) {
    const p = await plannedLv(i);
    if ("error" in p) return { ok: false, error: p.error };
    const before = await readStdState({ lv: [i.fg] });
    const { cutH, bendH, weldH, shbH, paintH, kind, description } = p.next;
    const r = await upsertLvStdTime(formOf({ fg: i.fg, description: description ?? "", kind, cutH, bendH, weldH, shbH, paintH }));
    return r.ok ? { ok: true, message: `${i.fg} is set: ${lvText(p.next)}.`, undo: undoStd(before) } : { ok: false, error: r.error };
  },
};

export const deleteLvStdTimeTool: WriteTool<{ fg: string }> = {
  kind: "write",
  name: "delete_lv_std_time",
  title: "Delete an LV panel's standard hours",
  description: "Take an LV panel off the timings sheet's LV tab — its orders earn no standard hours until it is back.",
  area: "setup",
  risk: "destructive",
  tabs: STD_TABS,
  schema: { type: "object", properties: { fg: { type: "string", minLength: 4, maxLength: 60 } }, required: ["fg"], additionalProperties: false },
  parse: (r) => ({ fg: String(r.fg).trim().toUpperCase() }),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const state = await readStdState({ lv: [i.fg] });
    const was = state.lv[0].row;
    if (!was) return { error: `${i.fg} is not on the LV sheet.` };
    return { title: `Delete LV panel ${i.fg}`, summary: `Take ${i.fg} (${lvText(was)}) off the LV standard times.`, changes: [{ label: i.fg, before: lvText(was), after: "deleted" }], snapshot: state };
  },
  async execute(i) {
    const before = await readStdState({ lv: [i.fg] });
    const r = await deleteLvStdTime(formOf({ fg: i.fg }));
    return r.ok ? { ok: true, message: `${i.fg} is off the LV sheet.`, undo: undoStd(before) } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ undo of the standard times

/** The keys a snapshot covers — what the undo reads now to compare. */
const keysOf = (s: StdState): StdKeys => ({ tiers: s.tiers.map((t) => t.kva), capacity: s.capacity.map((c) => c.dept), fgMap: s.fgMap.map((f) => f.fg), lv: s.lv.map((l) => l.fg) });

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A standard-times snapshot out of its JSON, checked whole — or null. */
export function readStdStateText(text: string): StdState | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const s = v as Partial<StdState> | null;
  if (!s || !Array.isArray(s.tiers) || !Array.isArray(s.capacity) || !Array.isArray(s.fgMap) || !Array.isArray(s.lv)) return null;
  const tierOk = (t: StdState["tiers"][number]) => Number.isInteger(t?.kva) && (t.row === null || (t.row && ["cutMh", "weldMh", "shbMh", "paintMh"].every((k) => isNum((t.row as Record<string, unknown>)[k]))));
  const capOk = (c: StdState["capacity"][number]) => typeof c?.dept === "string" && (CAL_STAGES as readonly string[]).includes(c.dept) && (c.mhPerDay === null || isNum(c.mhPerDay));
  const fgOk = (f: StdState["fgMap"][number]) => typeof f?.fg === "string" && f.fg !== "" && (f.kva === null || Number.isInteger(f.kva));
  const lvOk = (l: StdState["lv"][number]) =>
    typeof l?.fg === "string" && l.fg !== "" &&
    (l.row === null || (!!l.row && typeof l.row.kind === "string" && (l.row.description === null || typeof l.row.description === "string") && (l.row.totalH === null || isNum(l.row.totalH)) && LV_LABELS.every(([k]) => isNum(l.row![k]))));
  if (!s.tiers.every(tierOk) || !s.capacity.every(capOk) || !s.fgMap.every(fgOk) || !s.lv.every(lvOk)) return null;
  return { tiers: s.tiers, capacity: s.capacity, fgMap: s.fgMap, lv: s.lv };
}

function stdChanges(now: StdState, then: StdState) {
  return [
    ...then.tiers.map((t) => ({ label: `${t.kva} KVA`, before: tierText(now.tiers.find((x) => x.kva === t.kva)?.row ?? null), after: t.row ? tierText(t.row) : "no class" })),
    ...then.capacity.map((c) => ({ label: `${deptLabel(c.dept)} capacity`, before: cell(now.capacity.find((x) => x.dept === c.dept)?.mhPerDay ?? null), after: cell(c.mhPerDay) })),
    ...then.fgMap.map((f) => ({ label: f.fg, before: cell(now.fgMap.find((x) => x.fg === f.fg)?.kva ?? null), after: f.kva === null ? "not mapped" : `${f.kva} KVA` })),
    ...then.lv.map((l) => ({ label: l.fg, before: lvText(now.lv.find((x) => x.fg === l.fg)?.row ?? null), after: l.row ? lvText(l.row) : "not on the sheet" })),
  ];
}

/** The undo of every standard-times change above — never offered to the model. */
export const restoreStandardTimesTool: WriteTool<{ state: string }> = {
  kind: "write",
  name: "restore_standard_times",
  internal: true,
  title: "Put the standard times back",
  description: "Put standard-times rows back exactly as they were (the undo of a standard-times change).",
  area: "setup",
  risk: "low",
  tabs: STD_TABS,
  schema: { type: "object", properties: { state: { type: "string", minLength: 2, maxLength: MAX_STATE } }, required: ["state"], additionalProperties: false },
  parse: (r) => (readStdStateText(String(r.state)) ? { state: String(r.state) } : "The standard times to put back cannot be read."),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const then = readStdStateText(i.state)!;
    const now = await readStdState(keysOf(then));
    return { title: "Put the standard times back", summary: "Put the standard times back as they were before the change.", changes: stdChanges(now, then), snapshot: now };
  },
  async execute(i) {
    const r = await restoreStdState(readStdStateText(i.state)!);
    return r.ok ? { ok: true, message: "The standard times are back as they were." } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ times per machine

interface TimesInput {
  machine: string;
  times: { item: string; hoursPerPc: number | null }[];
}

async function machineByCode(code: string): Promise<Machine | null> {
  return prisma.machine.findFirst({ where: { code: { equals: code.trim(), mode: "insensitive" } } });
}

const timeText = (h: number | null) => (h === null ? "the estimate" : `${h} h/pc`);

export const setMachineTimesTool: WriteTool<TimesInput> = {
  kind: "write",
  name: "set_machine_times",
  title: "Set a machine's time per piece",
  description: "Set the planner's own time per piece on one machine, per item (CF, TC, TN, CB, AR, MB) — it outranks the standard-times estimate when the machine's queue is priced and ⚡ Plan schedules it. hoursPerPc null clears it (the machine goes back on the estimate for that item).",
  area: "setup",
  risk: "high",
  tabs: TIMES_TABS,
  schema: {
    type: "object",
    properties: {
      machine: { type: "string", minLength: 1, maxLength: 40, description: "The machine's code, e.g. B4-10." },
      times: {
        type: "array",
        minItems: 1,
        maxItems: ITEMS.length,
        items: {
          type: "object",
          properties: { item: { type: "string", enum: [...ITEMS] }, hoursPerPc: { type: ["number", "null"], minimum: 0.001, maximum: 500 } },
          required: ["item", "hoursPerPc"],
          additionalProperties: false,
        },
      },
    },
    required: ["machine", "times"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as TimesInput;
    if (new Set(i.times.map((t) => t.item)).size !== i.times.length) return "An item is named twice.";
    return { machine: i.machine, times: i.times.map((t) => ({ item: t.item, hoursPerPc: t.hoursPerPc === null ? null : Math.round(t.hoursPerPc * 1000) / 1000 })) };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "machines.manage")) return { error: NO_MACHINES };
    const m = await machineByCode(i.machine);
    if (!m) return { error: `No machine ${i.machine} on the list.` };
    const now = await readMachineTimes(m.id, i.times.map((t) => t.item));
    const changing = i.times.filter((t) => now.find((n) => n.item === t.item)?.hoursPerPc !== t.hoursPerPc);
    if (changing.length === 0) return { error: `${m.code}'s times read so already.` };
    return {
      title: `${m.code}: time per piece`,
      summary: `Set ${m.code}'s own time per piece for ${changing.map((t) => t.item).join(", ")} — its queue is priced and planned with it.`,
      changes: changing.map((t) => ({ label: `${m.code} ${t.item}`, before: timeText(now.find((n) => n.item === t.item)?.hoursPerPc ?? null), after: timeText(t.hoursPerPc) })),
      snapshot: now,
    };
  },
  async execute(i) {
    const m = await machineByCode(i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} on the list.` };
    const before = await readMachineTimes(m.id, i.times.map((t) => t.item));
    const fd = new FormData();
    for (const t of i.times) fd.set(`t:${m.id}:${t.item}`, t.hoursPerPc === null ? "" : String(t.hoursPerPc));
    const r = await saveMachineItemTimes(fd);
    return r.ok ? { ok: true, message: `${m.code}'s times are saved.`, undo: { tool: "restore_machine_times", input: { rows: JSON.stringify(before) } } } : { ok: false, error: r.error };
  },
};

/** A machine-times snapshot out of its JSON, checked whole — or null. */
export function readMachineTimesText(text: string): MachineTimeSnapshot[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v) || v.length === 0) return null;
    const ok = v.every((r) => r && typeof r === "object" && Number.isInteger(r.machineId) && (ITEMS as readonly string[]).includes(r.item) && (r.hoursPerPc === null || isNum(r.hoursPerPc)) && (r.setBy === null || typeof r.setBy === "string"));
    return ok ? (v as MachineTimeSnapshot[]) : null;
  } catch {
    return null;
  }
}

/** The undo of set_machine_times — never offered to the model. */
export const restoreMachineTimesTool: WriteTool<{ rows: string }> = {
  kind: "write",
  name: "restore_machine_times",
  internal: true,
  title: "Put a machine's times back",
  description: "Put a machine's times per piece back exactly as they were (the undo of set_machine_times).",
  area: "setup",
  risk: "low",
  tabs: TIMES_TABS,
  schema: { type: "object", properties: { rows: { type: "string", minLength: 2, maxLength: 20000 } }, required: ["rows"], additionalProperties: false },
  parse: (r) => (readMachineTimesText(String(r.rows)) ? { rows: String(r.rows) } : "The times to put back cannot be read."),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "machines.manage")) return { error: NO_MACHINES };
    const then = readMachineTimesText(i.rows)!;
    const machineId = then[0].machineId;
    const m = await prisma.machine.findUnique({ where: { id: machineId }, select: { code: true } });
    if (!m || then.some((r) => r.machineId !== machineId)) return { error: "That machine is not on the list any more." };
    const now = await readMachineTimes(machineId, then.map((r) => r.item));
    return {
      title: `Put ${m.code}'s times back`,
      summary: `Put ${m.code}'s times per piece back as they were.`,
      changes: then.map((r) => ({ label: `${m.code} ${r.item}`, before: timeText(now.find((n) => n.item === r.item)?.hoursPerPc ?? null), after: timeText(r.hoursPerPc) })),
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreMachineTimes(readMachineTimesText(i.rows)!);
    return r.ok ? { ok: true, message: "The machine's times are back as they were." } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ settings

async function settingsNow() {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  return {
    tankTracking: s?.tankTracking ?? DEFAULTS.tankTracking,
    machinePlanning: s?.machinePlanning ?? DEFAULTS.machinePlanning,
    shortH: s?.shiftShortH ?? DEFAULT_SHIFT_HOURS.short,
    longH: s?.shiftLongH ?? DEFAULT_SHIFT_HOURS.long,
    overtimeH: s?.overtimeH ?? DEFAULT_SHIFT_HOURS.overtime,
  };
}

interface ShiftHoursInput {
  shortH?: number;
  longH?: number;
  overtimeH?: number;
}

const SHIFT_H = (what: string) => ({ type: "number", minimum: 0, maximum: 24, description: what }) as const;
const SHIFT_LABELS = [["shortH", "The short shift (S9)"], ["longH", "The long shift (S11)"], ["overtimeH", "The +OT button"]] as const;

export const setShiftHoursTool: WriteTool<ShiftHoursInput> = {
  kind: "write",
  name: "set_shift_hours",
  title: "Set the shift hours",
  description: "Set the hours the plant's two shifts are worth and what the roster's +OT button adds (Settings) — every man-hour the app counts is measured with them, the days already recorded included.",
  area: "setup",
  risk: "high",
  tabs: SETTINGS_TABS,
  schema: {
    type: "object",
    properties: { shortH: SHIFT_H("Hours of the short shift (S9)."), longH: SHIFT_H("Hours of the long shift (S11)."), overtimeH: SHIFT_H("Hours the +OT button adds.") },
    additionalProperties: false,
  },
  parse: (r) => (Object.keys(r).length ? (r as ShiftHoursInput) : "Say which hours to set."),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const s = await settingsNow();
    const next = { shortH: round2(i.shortH ?? s.shortH), longH: round2(i.longH ?? s.longH), overtimeH: round2(i.overtimeH ?? s.overtimeH) };
    if (next.shortH <= 0 || next.longH <= 0) return { error: "A shift has to be longer than nothing." };
    const changes = SHIFT_LABELS.filter(([k]) => s[k] !== next[k]).map(([k, l]) => ({ label: l, before: `${s[k]} h`, after: `${next[k]} h` }));
    if (changes.length === 0) return { error: "The shift hours read so already." };
    return {
      title: "Shift hours",
      summary: `Set the shift hours: ${changes.map((c) => `${c.label} ${c.before} → ${c.after}`).join("; ")} — every man-hour figure is recounted with them.`,
      changes,
      snapshot: { shortH: s.shortH, longH: s.longH, overtimeH: s.overtimeH },
    };
  },
  async execute(i) {
    const s = await settingsNow();
    const next = { shortH: i.shortH ?? s.shortH, longH: i.longH ?? s.longH, overtimeH: i.overtimeH ?? s.overtimeH };
    const r = await saveShiftHours(formOf({ shiftShortH: next.shortH, shiftLongH: next.longH, overtimeH: next.overtimeH }));
    return r.ok
      ? { ok: true, message: `The shifts are ${round2(next.shortH)} h and ${round2(next.longH)} h, +OT ${round2(next.overtimeH)} h.`, undo: { tool: "set_shift_hours", input: { shortH: s.shortH, longH: s.longH, overtimeH: s.overtimeH } } }
      : { ok: false, error: r.error };
  },
};

interface SwitchesInput {
  tankTracking?: boolean;
  machinePlanning?: boolean;
}

export const setPlantSwitchesTool: WriteTool<SwitchesInput> = {
  kind: "write",
  name: "set_plant_switches",
  title: "Turn a plant switch on or off",
  description:
    "Turn the plant's master switches on or off (Settings): tankTracking — tanks tracked piece by piece (serials, the leak-test stage, painting by selection, the barcode tab); machinePlanning — work planned onto machines (the machine board, the Machine column, the Floor view). Turning one off loses nothing: what was recorded comes back when it is on again.",
  area: "setup",
  risk: "high",
  tabs: SETTINGS_TABS,
  schema: { type: "object", properties: { tankTracking: { type: "boolean" }, machinePlanning: { type: "boolean" } }, additionalProperties: false },
  parse: (r) => (Object.keys(r).length ? (r as SwitchesInput) : "Say which switch to turn."),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: NOT_ADMIN };
    const s = await settingsNow();
    const changes = ([["tankTracking", "Tank tracking by piece"], ["machinePlanning", "Planning by machine"]] as const)
      .filter(([k]) => i[k] !== undefined && i[k] !== s[k])
      .map(([k, l]) => ({ label: l, before: s[k] ? "on" : "off", after: i[k] ? "on" : "off" }));
    if (changes.length === 0) return { error: "The switches are so already." };
    return {
      title: changes.map((c) => `${c.label} ${c.after}`).join(", "),
      summary: `Turn ${changes.map((c) => `${c.label.toLowerCase()} ${c.after}`).join(" and ")} — every screen it touches changes for everyone.`,
      changes,
      snapshot: { tankTracking: s.tankTracking, machinePlanning: s.machinePlanning },
    };
  },
  async execute(i) {
    const s = await settingsNow();
    if (i.tankTracking !== undefined && i.tankTracking !== s.tankTracking) {
      const r = await setTankTracking(formOf({ on: String(i.tankTracking) }));
      if (!r.ok) return { ok: false, error: r.error };
    }
    if (i.machinePlanning !== undefined && i.machinePlanning !== s.machinePlanning) {
      const r = await setMachinePlanning(formOf({ on: String(i.machinePlanning) }));
      if (!r.ok) return { ok: false, error: r.error };
    }
    return { ok: true, message: "The switches are set.", undo: { tool: "set_plant_switches", input: { tankTracking: s.tankTracking, machinePlanning: s.machinePlanning } } };
  },
};

export const SETUP_TOOLS = [
  getStandardTimesTool,
  setStdClassTool,
  deleteStdClassTool,
  setStageCapacityTool,
  mapFgCodesTool,
  unmapFgCodesTool,
  applyCalibrationTool,
  setLvStdTimeTool,
  deleteLvStdTimeTool,
  restoreStandardTimesTool,
  setMachineTimesTool,
  restoreMachineTimesTool,
  setShiftHoursTool,
  setPlantSwitchesTool,
] as const;
