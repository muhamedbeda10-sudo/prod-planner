import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's tools for the plant's set-up (standard times, capacity,
// calibration, times per machine, settings) and for Users & Permissions:
// who may, what the card says, the screen's own action with the fields its
// form posts, and the undo — against stubbed actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      stdTime: { findUnique: fn(), findMany: fn(), count: fn() },
      stdFgMap: { count: fn() },
      machine: { findFirst: fn(), findUnique: fn() },
      settings: { findUnique: fn() },
      user: { findFirst: fn(), findMany: fn(), findUnique: fn() },
    },
    calibration: fn(),
    snap: {
      readStdState: fn(), restoreStdState: fn(), readMachineTimes: fn(), restoreMachineTimes: fn(), readUserAccess: fn(), restoreUserAccess: fn(),
      readShiftState: fn(), restoreShiftState: fn(),
    },
    std: { applyCalibration: fn(), deleteFgMap: fn(), deleteLvStdTime: fn(), deleteStdTier: fn(), setStageCapacity: fn(), upsertFgMap: fn(), upsertLvStdTime: fn(), upsertStdTier: fn() },
    times: { saveMachineItemTimes: fn() },
    settings: { saveShiftHours: fn(), setMachinePlanning: fn(), setTankTracking: fn() },
    users: { createUser: fn(), deleteUser: fn(), setUserActive: fn(), updateUserPerms: fn(), resetUserPassword: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/calibration", () => ({ CAL_STAGES: ["Cut", "Welding", "ShotBlast", "Painting"], getCalibration: h.calibration }));
vi.mock("@/lib/server/rowSnapshots", () => h.snap);
vi.mock("@/app/admin/standard-times/actions", () => h.std);
vi.mock("@/app/admin/machine-times/actions", () => h.times);
vi.mock("@/app/admin/settings/actions", () => h.settings);
vi.mock("@/app/admin/users/actions", () => h.users);

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { applyCalibrationTool, restoreStandardTimesTool, setMachineTimesTool, setShiftHoursTool, setStdClassTool } from "@/lib/server/ai/tools/setup";
import { createUserTool, listUsersTool, setUserActiveTool, updateUserAccessTool } from "@/lib/server/ai/tools/users";
import { callDenied, checkToolInput, toolsFor } from "@/lib/server/ai/tools";
import { ACCESS_PERM_KEYS } from "@/lib/domain/permissions";

const user = (o: Partial<User> = {}) => ({ id: 1, name: "Sara", isAdmin: false, isOwner: false, perms: "", hiddenTabs: "", ...o }) as User;
const ctxOf = (u: User): ToolCtx => ({ user: u, hidden: new Set(), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 1, automationId: null });
const admin = ctxOf(user({ isAdmin: true }));
// the owner as the app sees them: every access right
const ownerUser = user({ id: 2, name: "Mohamed", isOwner: true, isAdmin: true, perms: ACCESS_PERM_KEYS.join(",") });
const owner = ctxOf(ownerUser);
const fdOf = (m: ReturnType<typeof vi.fn>, call = 0) => m.mock.calls[call][0] as FormData;
const parsed = <I,>(tool: Parameters<typeof checkToolInput<I>>[0], raw: unknown): I => {
  const c = checkToolInput<I>(tool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};
const tier = (kva: number, row: Record<string, number> | null) => ({ tiers: [{ kva, row }], capacity: [], fgMap: [], lv: [] });

beforeEach(() => {
  vi.clearAllMocks();
  for (const group of [h.std, h.times, h.settings, h.users]) for (const f of Object.values(group)) f.mockResolvedValue({ ok: true });
  h.snap.restoreStdState.mockResolvedValue({ ok: true });
});

describe("the standard times", () => {
  it("are an admin's; a new class needs all four stages; a change merges into the one there", async () => {
    const input = parsed(setStdClassTool, { kva: 1250, weldMh: 30 });
    expect(await setStdClassTool.describe(input, ctxOf(user()))).toEqual({ error: expect.stringContaining("admin's") });
    h.prisma.stdTime.findUnique.mockResolvedValue(null);
    expect(await setStdClassTool.describe(input, admin)).toEqual({ error: expect.stringContaining("give all four stages") });
    h.prisma.stdTime.findUnique.mockResolvedValue({ kva: 1250, cutMh: 20, weldMh: 25, shbMh: 2, paintMh: 6 });
    const before = tier(1250, { cutMh: 20, weldMh: 25, shbMh: 2, paintMh: 6 });
    h.snap.readStdState.mockResolvedValue(before);
    expect(await setStdClassTool.describe(input, admin)).toMatchObject({ changes: [{ label: "1250 KVA — Welding", before: "25", after: "30" }], snapshot: before });
    const out = await setStdClassTool.execute(input, admin);
    expect(Object.fromEntries(fdOf(h.std.upsertStdTier).entries())).toEqual({ kva: "1250", cutMh: "20", weldMh: "30", shbMh: "2", paintMh: "6" });
    expect(out.undo).toEqual({ tool: "restore_standard_times", input: { state: JSON.stringify(before) } });
    // and the undo writes the rows back exactly
    await restoreStandardTimesTool.execute(parsed(restoreStandardTimesTool, out.undo!.input), admin);
    expect(h.snap.restoreStdState).toHaveBeenCalledWith(before);
  });

  it("the undo refuses a snapshot that is not whole", () => {
    expect(checkToolInput(restoreStandardTimesTool, { state: JSON.stringify({ tiers: [{ kva: "x", row: null }], capacity: [], fgMap: [], lv: [] }) }).ok).toBe(false);
    expect(checkToolInput(restoreStandardTimesTool, { state: JSON.stringify({ tiers: [], capacity: [{ dept: "Canteen", mhPerDay: 3 }], fgMap: [], lv: [] }) }).ok).toBe(false);
    expect(checkToolInput(restoreStandardTimesTool, { state: JSON.stringify(tier(100, null)) }).ok).toBe(true);
  });

  it("a calibration is applied only when it is ready, with every class's new hours on the card", async () => {
    h.calibration.mockResolvedValue({ rows: [], stages: [{ dept: "Welding", ready: false, factor: null, reason: "only 3 days recorded", days: 3, actualH: 1, earnedH: 1, efficiency: null }] });
    expect(await applyCalibrationTool.describe({ dept: "Welding" }, admin)).toEqual({ error: "Welding's calibration is not ready to apply: only 3 days recorded." });
    h.calibration.mockResolvedValue({ rows: [], stages: [{ dept: "Welding", ready: true, factor: 1.2, reason: null, days: 9, actualH: 1200, earnedH: 1000, efficiency: 0.83 }] });
    h.prisma.stdTime.findMany.mockResolvedValue([{ kva: 100, cutMh: 5, weldMh: 10, shbMh: 1, paintMh: 2 }, { kva: 200, cutMh: 6, weldMh: 12.5, shbMh: 1, paintMh: 2 }]);
    h.snap.readStdState.mockResolvedValue({ tiers: [], capacity: [], fgMap: [], lv: [] });
    expect(await applyCalibrationTool.describe({ dept: "Welding" }, admin)).toMatchObject({
      title: "Calibrate Welding × 1.2",
      changes: [{ label: "100 KVA — Welding", before: "10", after: "12" }, { label: "200 KVA — Welding", before: "12.5", after: "15" }],
    });
  });
});

describe("the times per machine", () => {
  it("post the screen's own grid fields and are undone by the times as they were", async () => {
    const input = parsed(setMachineTimesTool, { machine: "b4-10", times: [{ item: "TN", hoursPerPc: 0.75 }, { item: "CF", hoursPerPc: null }] });
    expect(await setMachineTimesTool.describe(input, ctxOf(user()))).toEqual({ error: expect.stringContaining("Machines — manage") });
    const planner = ctxOf(user({ perms: "machines.manage" }));
    h.prisma.machine.findFirst.mockResolvedValue({ id: 4, code: "B4-10" });
    const before = [{ machineId: 4, item: "CF", hoursPerPc: 0.5, setBy: "Ali" }, { machineId: 4, item: "TN", hoursPerPc: null, setBy: null }];
    h.snap.readMachineTimes.mockResolvedValue(before);
    expect(await setMachineTimesTool.describe(input, planner)).toMatchObject({ changes: [{ label: "B4-10 TN", before: "the estimate", after: "0.75 h/pc" }, { label: "B4-10 CF", before: "0.5 h/pc", after: "the estimate" }] });
    const out = await setMachineTimesTool.execute(input, planner);
    expect(Object.fromEntries(fdOf(h.times.saveMachineItemTimes).entries())).toEqual({ "t:4:TN": "0.75", "t:4:CF": "" });
    expect(out.undo).toEqual({ tool: "restore_machine_times", input: { rows: JSON.stringify(before) } });
  });
});

describe("the shift hours", () => {
  it("are undone by the hours they were", async () => {
    h.prisma.settings.findUnique.mockResolvedValue({ shiftShortH: 9, shiftLongH: 11, overtimeH: 3, tankTracking: false, machinePlanning: false });
    const input = parsed(setShiftHoursTool, { longH: 12 });
    expect(await setShiftHoursTool.describe(input, admin)).toMatchObject({ changes: [{ label: "The night shift (S11)", before: "11 h", after: "12 h" }] });
    const out = await setShiftHoursTool.execute(input, admin);
    expect(Object.fromEntries(fdOf(h.settings.saveShiftHours).entries())).toEqual({ shiftShortH: "9", shiftLongH: "12", overtimeH: "3" });
    expect(out.undo).toEqual({ tool: "set_shift_hours", input: { shortH: 9, longH: 11, overtimeH: 3 } });
  });
});

// ------------------------------------------------------------------ users

const account = (o: Record<string, unknown> = {}) => ({
  id: 7, name: "Ahmed", email: "ahmed@atc.com", isOwner: false, isAdmin: false, active: true, perms: "welding.edit,tracker.edit", hiddenTabs: "simulate",
  aiAccess: null, updatedAt: new Date("2026-10-01T00:00:00Z"), ...o,
});

describe("users and permissions", () => {
  it("are the owner's alone, and never in an automation or the morning review", () => {
    const anAdmin = user({ isAdmin: true, perms: ACCESS_PERM_KEYS.join(",") });
    const names = (u: User, unattended = false) => toolsFor(u, { hidden: new Set(), actionsPaused: false, unattended }).map((t) => t.name);
    expect(names(anAdmin)).not.toContain("list_users");
    expect(names(anAdmin)).not.toContain("update_user_access");
    expect(names(ownerUser)).toEqual(expect.arrayContaining(["list_users", "update_user_access", "create_user", "set_user_active"]));
    expect(names(ownerUser, true)).not.toContain("update_user_access");
    expect(names(ownerUser, true)).not.toContain("list_users");
    // an internal undo is still refused to anyone but the owner
    expect(callDenied(anAdmin, new Set(), updateUserAccessTool, {})).toBe("Only the owner manages users and permissions.");
  });

  it("lists the accounts for the owner only", async () => {
    expect(await listUsersTool.run({}, admin)).toEqual({ ok: false, text: "Only the owner manages users and permissions." });
    h.prisma.user.findMany.mockResolvedValue([account()]);
    const r = await listUsersTool.run({}, owner);
    expect(JSON.parse(r.text).users[0]).toMatchObject({ email: "ahmed@atc.com", permissions: ["welding.edit", "tracker.status", "tracker.components", "tracker.qty"], hiddenScreens: ["simulate"], assistant: "off" });
  });

  it("changes a person's keys and screens on the screen's own form, keeps their standing, and is undone exactly", async () => {
    h.prisma.user.findFirst.mockResolvedValue(account({ isAdmin: true }));
    const snapshot = { id: 7, isAdmin: true, perms: "welding.edit,tracker.edit", hiddenTabs: "simulate", active: true, ai: null };
    h.snap.readUserAccess.mockResolvedValue(snapshot);
    const input = parsed(updateUserAccessTool, { user: "ahmed@atc.com", grant: ["painting.edit"], revoke: ["tracker.qty"], showScreens: ["simulate"], aiEnabled: true, aiMonthlyUsd: 15 });
    expect(await updateUserAccessTool.describe(input, admin)).toEqual({ error: "Only the owner manages users and permissions." });
    const p = await updateUserAccessTool.describe(input, owner);
    expect(p).toMatchObject({
      changes: [
        { label: "Ahmed — Painting — record", before: "no", after: "yes" },
        { label: "Ahmed — Order quantity — edit", before: "yes", after: "no" },
        { label: "Ahmed — screen Floor / Simulator", before: "hidden", after: "shown" },
        { label: "Ahmed — AI assistant", before: "off", after: "on, $15 a month" },
      ],
    });
    const out = await updateUserAccessTool.execute(input, owner);
    const fd = fdOf(h.users.updateUserPerms);
    expect(fd.get("isAdmin")).toBe("on");
    expect(fd.get("aiKeys")).toBe("1");
    expect(fd.getAll("perms").sort()).toEqual(["painting.edit", "tracker.components", "tracker.status", "welding.edit"]);
    expect(fd.getAll("tabs")).toContain("simulate");
    expect([fd.get("aiForm"), fd.get("aiEnabled"), fd.get("aiUsd")]).toEqual(["1", "on", "15"]);
    expect(out.undo).toEqual({ tool: "restore_user_access", input: { access: JSON.stringify(snapshot) } });
  });

  it("never moves the owner's own standing", async () => {
    h.prisma.user.findFirst.mockResolvedValue(account({ isOwner: true, isAdmin: true }));
    expect(await updateUserAccessTool.describe(parsed(updateUserAccessTool, { user: "ahmed@atc.com", admin: false }), owner)).toEqual({ error: "The owner's own standing and assistant do not change." });
    expect(await setUserActiveTool.describe({ user: "ahmed@atc.com", active: false }, owner)).toEqual({ error: "The owner's account cannot be deactivated." });
  });

  it("makes an account with a password nobody knows, never one from the chat, and takes it back while untouched", async () => {
    expect(createUserTool.schema.properties).not.toHaveProperty("password");
    h.prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 31 });
    const input = parsed(createUserTool, { email: " Mona@ATC.com ", name: "Mona", permissions: ["odoo.edit"], hiddenScreens: ["settings"] });
    expect(input.email).toBe("mona@atc.com");
    expect(await createUserTool.describe(input, owner)).toMatchObject({ title: "New account: Mona" });
    h.prisma.user.findUnique.mockResolvedValueOnce({ id: 31 });
    const out = await createUserTool.execute(input, owner);
    const fd = fdOf(h.users.createUser);
    expect(String(fd.get("password")).length).toBeGreaterThanOrEqual(24);
    expect(out.message).not.toContain(String(fd.get("password")));
    expect(fd.getAll("perms")).toEqual(["odoo.edit"]);
    expect(fd.getAll("tabs")).not.toContain("settings");
    expect(out.undo).toEqual({ tool: "delete_new_user", input: { id: 31 } });
  });
});
