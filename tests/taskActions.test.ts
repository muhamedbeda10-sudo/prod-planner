import { beforeEach, describe, expect, it, vi } from "vitest";

// Tasks (app/tasks/actions.ts): who may give one, one each or one shared, how
// many an hour; and on a task, who may make which move from which state, a
// move made from a state that changed meanwhile refused, and the news each
// move sends — to everyone on the task but the one who made it.

const h = vi.hoisted(() => ({
  prisma: {
    user: { findMany: vi.fn() },
    masterOrder: { findUnique: vi.fn() },
    task: { count: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    taskRepeat: { count: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    taskTemplate: { count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    taskUpdate: { count: vi.fn(), create: vi.fn() },
    aiInboxItem: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  me: null as null | { id: number; name: string; isOwner: boolean },
  allowed: true,
  deliver: vi.fn(),
  store: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: async () => h.me,
  requirePerm: async () => (h.allowed && h.me ? { user: h.me } : { error: "You do not have permission for this action — ask the admin." }),
  hasPerm: () => h.allowed,
}));
vi.mock("@/lib/server/actor", () => ({ currentActor: () => undefined }));
vi.mock("@/lib/server/inbox", () => ({ deliverToInbox: h.deliver }));
vi.mock("@/lib/server/events", () => ({ emitEvent: h.emit }));
vi.mock("@/lib/server/automations/store", () => ({ offDays: async () => (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5 }));
vi.mock("@/lib/server/uploads", () => ({
  filesOf: (fd: FormData) => fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0),
  storeUploads: h.store,
  storedFilesOf: () => [],
}));

import { createTask, deleteTaskRepeat, postTaskUpdate, setTaskChecklist, setTaskRepeatEnabled, tickTaskStep } from "@/app/tasks/actions";

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

const OWNER = { id: 1, name: "Test Owner", isOwner: true };
const SARA = { id: 9, name: "Sara", isOwner: false };
const ALI = { id: 10, name: "Ali", isOwner: false };

const task = (o: Partial<{ status: string; createdById: number | null; assignees: number[] }> = {}) => ({
  id: 5, title: "Clean bay 2", details: "", priority: "normal", dueDate: null, createdByName: "Test Owner",
  status: o.status ?? "in_progress", createdById: o.createdById === undefined ? OWNER.id : o.createdById,
  assignees: (o.assignees ?? [SARA.id]).map((userId) => ({ userId })),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.me = OWNER;
  h.allowed = true;
  h.prisma.user.findMany.mockResolvedValue([{ id: SARA.id }, { id: ALI.id }]);
  h.prisma.task.count.mockResolvedValue(0);
  let next = 40;
  h.prisma.task.create.mockImplementation(async ({ data }: { data: { assignees: { create: { userId: number }[] } } }) => ({ ...task(), id: ++next, assignees: data.assignees.create }));
  h.prisma.task.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.taskUpdate.count.mockResolvedValue(0);
  h.prisma.taskUpdate.create.mockResolvedValue({});
  h.prisma.aiInboxItem.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(h.prisma) : Promise.all(arg as Promise<unknown>[])));
  h.store.mockResolvedValue({ ok: true, files: [] });
  h.deliver.mockResolvedValue([]);
  h.prisma.taskRepeat.count.mockResolvedValue(0);
  h.prisma.taskRepeat.create.mockResolvedValue({ id: 77 });
  h.prisma.taskTemplate.create.mockResolvedValue({ id: 5 });
  h.prisma.taskTemplate.count.mockResolvedValue(0);
  h.prisma.taskRepeat.deleteMany.mockResolvedValue({ count: 1 });
});

describe("createTask", () => {
  const give = { title: "Clean bay 2", details: "Sweep it", people: "9,10" };

  it("needs the key for giving tasks", async () => {
    h.allowed = false;
    expect(await createTask(form(give))).toMatchObject({ ok: false });
    expect(h.prisma.task.create).not.toHaveBeenCalled();
  });

  it("gives several people one task each, made together, and tells each of them", async () => {
    const r = await createTask(form(give));
    expect(r).toEqual({ ok: true, ids: [41, 42] });
    const made = h.prisma.task.create.mock.calls.map((c) => c[0].data);
    expect(made.map((d) => d.assignees.create)).toEqual([[{ userId: 9 }], [{ userId: 10 }]]);
    expect(made[0].batchId).toBeTruthy();
    expect(made[0].batchId).toBe(made[1].batchId);
    expect(made[0].shared).toBe(false);
    const told = h.deliver.mock.calls.flatMap((c) => c[0]);
    expect(told.map((d: { userId: number }) => d.userId).sort((a: number, b: number) => a - b)).toEqual([9, 10]);
    expect(told[0]).toMatchObject({ kind: "task", fromName: "Test Owner", title: "New task: Clean bay 2" });
  });

  it("gives them one shared task when asked", async () => {
    expect(await createTask(form({ ...give, shared: "1", priority: "urgent" }))).toEqual({ ok: true, ids: [41] });
    const d = h.prisma.task.create.mock.calls[0][0].data;
    expect(d).toMatchObject({ shared: true, batchId: null, priority: "urgent" });
    expect(d.assignees.create).toEqual([{ userId: 9 }, { userId: 10 }]);
  });

  it("refuses an inactive person, a bad due day, an unknown order and a burst", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 9 }]);
    expect(await createTask(form(give))).toEqual({ ok: false, error: "One of them is not an active user." });
    h.prisma.user.findMany.mockResolvedValue([{ id: 9 }, { id: 10 }]);
    expect(await createTask(form({ ...give, due: "2026-02-30" }))).toEqual({ ok: false, error: "The due day is not a date." });
    h.prisma.masterOrder.findUnique.mockResolvedValue(null);
    expect(await createTask(form({ ...give, mo: "MO/1" }))).toMatchObject({ ok: false, error: expect.stringContaining("not on the Orders Registry") });
    h.prisma.task.count.mockResolvedValue(59);
    expect(await createTask(form(give))).toMatchObject({ ok: false, error: expect.stringContaining("60 tasks in an hour") });
    expect(h.prisma.task.create).not.toHaveBeenCalled();
  });
});

describe("postTaskUpdate", () => {
  it("lets its doer mark it done for review, and tells the giver", async () => {
    h.me = SARA;
    h.prisma.task.findUnique.mockResolvedValue(task());
    expect(await postTaskUpdate(form({ id: "5", move: "submit", body: "All clear" }))).toEqual({ ok: true, status: "submitted" });
    expect(h.prisma.task.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 5, status: "in_progress" }, data: { status: "submitted" } });
    expect(h.prisma.taskUpdate.create.mock.calls[0][0].data).toMatchObject({ taskId: 5, authorId: 9, authorName: "Sara", kind: "submit", body: "All clear", via: "app" });
    const told = h.deliver.mock.calls[0][0];
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ userId: OWNER.id, kind: "task", taskId: 5, title: "Done — to review: Clean bay 2" });
    // an event for "on event" automations — reaching only the task's people
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "task.done", subject: "Task #5", participants: [OWNER.id, SARA.id] }));
  });

  it("refuses anyone not on the task, and the doer's review of their own work", async () => {
    h.me = ALI;
    h.prisma.task.findUnique.mockResolvedValue(task());
    expect(await postTaskUpdate(form({ id: "5", move: "note", body: "hi" }))).toMatchObject({ ok: false, error: expect.stringContaining("not yours") });
    h.me = SARA;
    h.prisma.task.findUnique.mockResolvedValue(task({ status: "submitted" }));
    expect(await postTaskUpdate(form({ id: "5", move: "approve" }))).toMatchObject({ ok: false, error: expect.stringContaining("Only the one who gave") });
    expect(h.prisma.task.updateMany).not.toHaveBeenCalled();
  });

  it("asks the giver to say what to fix when returning it", async () => {
    h.prisma.task.findUnique.mockResolvedValue(task({ status: "submitted" }));
    expect(await postTaskUpdate(form({ id: "5", move: "return" }))).toMatchObject({ ok: false, error: expect.stringContaining("Say why") });
    expect(await postTaskUpdate(form({ id: "5", move: "return", body: "The corner" }))).toEqual({ ok: true, status: "returned" });
    expect(h.deliver.mock.calls[0][0][0]).toMatchObject({ userId: SARA.id, title: "Returned for rework: Clean bay 2" });
  });

  it("loses to a move someone made meanwhile", async () => {
    h.prisma.task.findUnique.mockResolvedValue(task({ status: "submitted" }));
    h.prisma.task.updateMany.mockResolvedValue({ count: 0 });
    expect(await postTaskUpdate(form({ id: "5", move: "approve" }))).toMatchObject({ ok: false, error: expect.stringContaining("changed meanwhile") });
    expect(h.prisma.taskUpdate.create).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("closes a task its giver gave only themselves when they mark it done", async () => {
    h.prisma.task.findUnique.mockResolvedValue(task({ assignees: [OWNER.id] }));
    expect(await postTaskUpdate(form({ id: "5", move: "submit" }))).toEqual({ ok: true, status: "done" });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("lets the owner stand in for a giver whose account is gone", async () => {
    h.prisma.task.findUnique.mockResolvedValue(task({ status: "submitted", createdById: null }));
    expect(await postTaskUpdate(form({ id: "5", move: "approve" }))).toEqual({ ok: true, status: "done" });
  });
});

describe("Tasks 2.0 — giving with steps and repeating", () => {
  const give = { title: "Clean bay 2", people: "9" };
  beforeEach(() => {
    h.prisma.user.findMany.mockResolvedValue([{ id: SARA.id, name: "Sara" }]);
    h.prisma.taskRepeat.delete.mockResolvedValue({});
  });

  it("gives the checklist's steps, unticked", async () => {
    await createTask(form({ ...give, checklist: JSON.stringify(["Sweep", " ", "Photo of the result"]) }));
    expect(h.prisma.task.create.mock.calls[0][0].data.checklist).toEqual([
      { id: "s1", text: "Sweep", done: false, by: null, at: null },
      { id: "s2", text: "Photo of the result", done: false, by: null, at: null },
    ]);
  });

  it("keeps a repeating one, gives the first now and books the next working day", async () => {
    const r = await createTask(form({ ...give, repeat: JSON.stringify({ every: "week", weekdays: [0], dueDays: 1 }) }));
    expect(r).toMatchObject({ ok: true, repeatId: 77 });
    const kept = h.prisma.taskRepeat.create.mock.calls[0][0].data;
    expect(kept).toMatchObject({ ownerId: OWNER.id, title: "Clean bay 2", every: "week", weekdays: [0], dueDays: 1, people: [9] });
    expect(new Date(kept.nextOn).getUTCDay()).toBe(0);
    expect(h.prisma.task.create.mock.calls[0][0].data.repeatId).toBe(77);
  });

  it("refuses a repeat it cannot read, and too many repeating ones", async () => {
    expect(await createTask(form({ ...give, repeat: JSON.stringify({ every: "week", weekdays: [] }) }))).toMatchObject({ ok: false, error: "Choose the days of the week it comes on." });
    h.prisma.taskRepeat.count.mockResolvedValue(30);
    expect(await createTask(form({ ...give, repeat: JSON.stringify({ every: "day" }) }))).toMatchObject({ ok: false, error: expect.stringContaining("30 repeating") });
    expect(h.prisma.task.create).not.toHaveBeenCalled();
  });

  it("checks its people before keeping anything, and takes the repeating one back when giving fails", async () => {
    h.prisma.user.findMany.mockResolvedValue([]);
    expect(await createTask(form({ ...give, repeat: JSON.stringify({ every: "day" }), templateName: "Daily" }))).toMatchObject({ ok: false, error: "One of them is not an active user." });
    expect(h.prisma.taskRepeat.create).not.toHaveBeenCalled();
    expect(h.prisma.taskTemplate.create).not.toHaveBeenCalled();
    expect(h.store).not.toHaveBeenCalled();

    h.prisma.user.findMany.mockResolvedValue([{ id: SARA.id, name: "Sara" }]);
    h.prisma.task.create.mockRejectedValueOnce(new Error("database gone"));
    await expect(createTask(form({ ...give, repeat: JSON.stringify({ every: "day" }), templateName: "Daily" }))).rejects.toThrow("database gone");
    expect(h.prisma.taskRepeat.deleteMany).toHaveBeenCalledWith({ where: { id: 77, ownerId: OWNER.id } });
    expect(h.prisma.taskTemplate.create).not.toHaveBeenCalled();
  });

  it("gives it without keeping a template — templates went with the tab's form", async () => {
    expect(await createTask(form({ ...give, checklist: "Sweep\nMop", templateName: "Bay clean" }))).toMatchObject({ ok: true });
    expect(h.prisma.taskTemplate.create).not.toHaveBeenCalled();
  });
});

describe("ticking a task's steps", () => {
  const withSteps = (o: Partial<{ status: string; done: boolean[] }> = {}) => ({
    ...task({ status: o.status ?? "in_progress" }), updatedAt: new Date("2026-10-26T08:00:00Z"),
    checklist: ["Sweep", "Photo"].map((text, i) => ({ id: `s${i + 1}`, text, done: o.done?.[i] ?? false })),
  });

  it("lets its doer tick a step — over the checklist as it was read", async () => {
    h.me = SARA;
    h.prisma.task.findUnique.mockResolvedValue(withSteps());
    expect(await tickTaskStep(form({ id: "5", item: "s1", done: "true" }))).toEqual({ ok: true });
    const call = h.prisma.task.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 5, updatedAt: new Date("2026-10-26T08:00:00Z") });
    expect(call.data.checklist[0]).toMatchObject({ id: "s1", done: true, by: "Sara" });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("tells the giver when the last step is ticked", async () => {
    h.me = SARA;
    h.prisma.task.findUnique.mockResolvedValue(withSteps({ done: [true, false] }));
    await tickTaskStep(form({ id: "5", item: "s2", done: "true" }));
    expect(h.deliver.mock.calls[0][0]).toEqual([expect.objectContaining({ userId: OWNER.id, body: "Ticked “Photo” — every step is ticked." })]);
  });

  it("refuses someone not on it, a closed task, and a tick that lost to another", async () => {
    h.me = ALI;
    h.prisma.task.findUnique.mockResolvedValue(withSteps());
    expect(await tickTaskStep(form({ id: "5", item: "s1", done: "true" }))).toMatchObject({ ok: false, error: "This task is not yours." });
    h.me = SARA;
    h.prisma.task.findUnique.mockResolvedValue(withSteps({ status: "done" }));
    expect(await tickTaskStep(form({ id: "5", item: "s1", done: "true" }))).toMatchObject({ ok: false, error: expect.stringContaining("closed") });
    h.prisma.task.findUnique.mockResolvedValue(withSteps());
    h.prisma.task.updateMany.mockResolvedValue({ count: 0 });
    expect(await tickTaskStep(form({ id: "5", item: "s1", done: "true" }))).toMatchObject({ ok: false, error: expect.stringContaining("meanwhile") });
  });

  it("lets only the giver change the steps — ticked ones stay ticked", async () => {
    h.prisma.task.findUnique.mockResolvedValue(withSteps({ done: [true, false] }));
    h.me = SARA;
    expect(await setTaskChecklist(form({ id: "5", checklist: JSON.stringify([{ id: "s1", text: "Sweep" }]) }))).toMatchObject({ ok: false });
    h.me = OWNER;
    expect(await setTaskChecklist(form({ id: "5", checklist: JSON.stringify([{ id: "s1", text: "Sweep" }, { text: "Mop" }]) }))).toEqual({ ok: true });
    const next = h.prisma.task.updateMany.mock.calls[0][0].data.checklist;
    expect(next.map((x: { text: string; done: boolean }) => [x.text, x.done])).toEqual([["Sweep", true], ["Mop", false]]);
  });
});

describe("a repeating task's switches", () => {
  it("are its giver's only", async () => {
    h.prisma.taskRepeat.findFirst.mockResolvedValue(null);
    expect(await setTaskRepeatEnabled(form({ id: "77", enabled: "false" }))).toMatchObject({ ok: false });
    h.prisma.taskRepeat.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteTaskRepeat(form({ id: "77" }))).toMatchObject({ ok: false });
    expect(h.prisma.taskRepeat.deleteMany).toHaveBeenCalledWith({ where: { id: 77, ownerId: OWNER.id } });
  });

  it("turned back on, books its next day from today", async () => {
    h.prisma.taskRepeat.findFirst.mockResolvedValue({ id: 77, ownerId: OWNER.id, every: "day", weekdays: [], monthDay: null, dueDays: 0, lastGivenOn: null });
    expect(await setTaskRepeatEnabled(form({ id: "77", enabled: "true" }))).toEqual({ ok: true });
    expect(h.prisma.taskRepeat.update.mock.calls[0][0].data).toMatchObject({ enabled: true, lastError: null, nextOn: expect.any(Date) });
  });
});
