import { beforeEach, describe, expect, it, vi } from "vitest";

// What the minute tick does for tasks (lib/server/tasks.ts): repeating tasks
// given once a day as their giver, the due-today reminder, and a task late
// for days going up to the app's owner — each claimed first, so two ticks
// never do it twice.

const h = vi.hoisted(() => ({
  prisma: {
    user: { findMany: vi.fn() },
    task: { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    taskRepeat: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
  allowed: true,
  deliver: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ effectiveUser: (u: unknown) => u, hasPerm: () => h.allowed }));
vi.mock("@/lib/server/inbox", () => ({ deliverToInbox: h.deliver }));
vi.mock("@/lib/server/events", () => ({ emitEvent: h.emit }));
vi.mock("@/lib/server/uploads", () => ({ storedFilesOf: () => [] }));
vi.mock("@/lib/server/automations/store", () => ({ offDays: async () => (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5 }));

import { escalateLateTasks, giveRepeatingTasks, remindDueToday } from "@/lib/server/tasks";

const now = new Date("2026-10-26T05:00:00Z"); // Monday 08:00 Cairo
const SARA = { id: 9, name: "Sara", active: true, isOwner: false };
const repeat = (o: Record<string, unknown> = {}) => ({
  id: 77, ownerId: SARA.id, owner: SARA, title: "Check the compressor", details: "", checklist: [{ id: "s1", text: "Oil level", done: true }], priority: "normal",
  people: [10], shared: false, mo: null, every: "day", weekdays: [], monthDay: null, dueDays: 1, nextOn: new Date("2026-10-26T00:00:00Z"), enabled: true, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.allowed = true;
  h.prisma.user.findMany.mockResolvedValue([{ id: 10, name: "Ali" }]);
  h.prisma.task.count.mockResolvedValue(0);
  h.prisma.task.create.mockImplementation(async ({ data }: { data: Record<string, unknown> & { assignees: { create: { userId: number }[] } } }) => ({ ...data, id: 500, assignees: data.assignees.create }));
  h.prisma.task.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.taskRepeat.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.taskRepeat.update.mockResolvedValue({});
  h.prisma.$transaction.mockImplementation(async (arg: Promise<unknown>[]) => Promise.all(arg));
  h.deliver.mockResolvedValue([]);
});

describe("repeating tasks", () => {
  it("gives today's as its giver — steps unticked, due in working days — and books the next day first", async () => {
    h.prisma.taskRepeat.findMany.mockResolvedValue([repeat()]);
    expect(await giveRepeatingTasks(now)).toBe(1);
    expect(h.prisma.taskRepeat.updateMany.mock.calls[0][0]).toEqual({ where: { id: 77, nextOn: new Date("2026-10-26T00:00:00Z") }, data: { nextOn: new Date("2026-10-27T00:00:00Z") } });
    const made = h.prisma.task.create.mock.calls[0][0].data;
    expect(made).toMatchObject({ title: "Check the compressor", createdById: SARA.id, via: "repeat", repeatId: 77, dueDate: new Date("2026-10-27T00:00:00Z") });
    expect(made.checklist).toEqual([{ id: "s1", text: "Oil level", done: false, by: null, at: null }]);
    expect(h.prisma.taskRepeat.update.mock.calls.at(-1)![0].data).toMatchObject({ lastError: null });
  });

  it("gives nothing when another tick booked it first", async () => {
    h.prisma.taskRepeat.findMany.mockResolvedValue([repeat()]);
    h.prisma.taskRepeat.updateMany.mockResolvedValue({ count: 0 });
    expect(await giveRepeatingTasks(now)).toBe(0);
    expect(h.prisma.task.create).not.toHaveBeenCalled();
  });

  it("stops, and tells its giver, when they may no longer give tasks or one of its people left", async () => {
    h.prisma.taskRepeat.findMany.mockResolvedValue([repeat()]);
    h.allowed = false;
    await giveRepeatingTasks(now);
    expect(h.prisma.taskRepeat.update.mock.calls[0][0].data).toMatchObject({ enabled: false, lastError: "you may no longer give tasks." });
    expect(h.deliver.mock.calls[0][0][0]).toMatchObject({ userId: SARA.id, title: "Repeating task stopped: Check the compressor" });

    vi.clearAllMocks();
    h.allowed = true;
    h.prisma.taskRepeat.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.taskRepeat.findMany.mockResolvedValue([repeat()]);
    h.prisma.user.findMany.mockResolvedValue([]);
    h.prisma.task.count.mockResolvedValue(0);
    await giveRepeatingTasks(now);
    expect(h.prisma.taskRepeat.update.mock.calls[0][0].data).toMatchObject({ enabled: false, lastError: expect.stringContaining("no longer an active user") });
  });
});

describe("the due-today reminder", () => {
  it("tells its people — not its giver — once", async () => {
    const t = { id: 5, title: "Paint jig", dueDate: new Date("2026-10-26T00:00:00Z"), priority: "normal", details: "", createdById: 1, createdByName: "Owner", assignees: [{ userId: 9 }] };
    // one given this morning is not reminded — its people just heard of it
    h.prisma.task.findMany.mockResolvedValue([{ ...t, id: 4, createdAt: new Date("2026-10-26T04:30:00Z") }, { ...t, createdAt: new Date("2026-10-20T08:00:00Z") }]);
    expect(await remindDueToday(now)).toBe(1);
    expect(h.prisma.task.findMany.mock.calls[0][0].where).toMatchObject({ dueSoonSentAt: null, dueDate: new Date("2026-10-26T00:00:00Z") });
    expect(h.deliver.mock.calls[0][0]).toEqual([expect.objectContaining({ userId: 9, kind: "task", title: "Due today: Paint jig" })]);
  });
});

describe("a task late for days", () => {
  const late = { id: 6, title: "Order bolts", status: "open", dueDate: new Date("2026-10-22T00:00:00Z"), createdById: 3, createdByName: "Hassan", assignees: [{ user: { id: 9, name: "Sara" } }] };

  it("goes up to the app's owner once — not to an owner who is on it or gave it", async () => {
    h.prisma.task.findMany.mockResolvedValue([late]);
    h.prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 3 }]);
    expect(await escalateLateTasks(now)).toBe(1);
    expect(h.prisma.task.updateMany.mock.calls[0][0]).toEqual({ where: { id: 6, escalatedAt: null }, data: { escalatedAt: now } });
    expect(h.deliver.mock.calls[0][0]).toEqual([expect.objectContaining({ userId: 1, title: "Late task: Order bolts", body: expect.stringContaining("given by **Hassan** to **Sara**") })]);
    // only the last fortnight's: an old backlog never floods the owner
    expect(h.prisma.task.findMany.mock.calls[0][0].where.dueDate).toEqual({ lte: new Date("2026-10-24T00:00:00Z"), gte: new Date("2026-10-12T00:00:00Z") });
  });

  it("keeps a task someone gave only themselves to them, and writes names and titles as text", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    h.prisma.task.findMany.mockResolvedValue([{ ...late, createdById: 9 }, { ...late, id: 7, title: "Fix **this** [now](/x)" }]);
    await escalateLateTasks(now);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0][0][0].body).toContain("“Fix \\*\\*this\\*\\* \\[now\\](/x)”");
  });

  it("waits while it is late by less than the days", async () => {
    h.prisma.task.findMany.mockResolvedValue([{ ...late, dueDate: new Date("2026-10-25T00:00:00Z") }]);
    h.prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    expect(await escalateLateTasks(now)).toBe(0);
    expect(h.deliver).not.toHaveBeenCalled();
  });
});
