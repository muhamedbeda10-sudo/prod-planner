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
vi.mock("@/lib/server/uploads", () => ({
  filesOf: (fd: FormData) => fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0),
  storeUploads: h.store,
  storedFilesOf: () => [],
}));

import { createTask, postTaskUpdate } from "@/app/tasks/actions";

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
