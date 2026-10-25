import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting an account from Users & Permissions (app/admin/users/actions.ts):
// refused while chat messages, the assistant's changes or automation runs
// name the person — the cascade would take other people's threads and the
// assistant's log with it — so the account is deactivated instead.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      user: { findUnique: fn(), delete: fn() },
      chatMessage: { count: fn() },
      aiAction: { count: fn() },
      automationRun: { count: fn() },
      taskAssignee: { count: fn() },
    },
    requireOwner: fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requireOwner: h.requireOwner, hashPassword: (s: string) => `hashed:${s}` }));

import { deleteUser } from "@/app/admin/users/actions";

const form = (id: number) => { const fd = new FormData(); fd.set("id", String(id)); return fd; };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireOwner.mockResolvedValue({ user: { id: 1, name: "Mohamed", isOwner: true } });
  h.prisma.user.findUnique.mockResolvedValue({ id: 7, name: "Sara", isOwner: false });
  for (const t of [h.prisma.chatMessage, h.prisma.aiAction, h.prisma.automationRun, h.prisma.taskAssignee]) t.count.mockResolvedValue(0);
});

describe("deleteUser", () => {
  it("refuses while chat messages, assistant changes or automation runs name the person, with the counts", async () => {
    h.prisma.chatMessage.count.mockResolvedValue(5);
    h.prisma.aiAction.count.mockResolvedValue(2);
    expect(await deleteUser(form(7))).toEqual({
      ok: false,
      error: "They are on 5 chat message(s), 2 assistant change(s), 0 automation run(s) and 0 task(s) — deactivate the account instead of deleting it, so that history keeps its person.",
    });
    expect(h.prisma.chatMessage.count).toHaveBeenCalledWith({ where: { OR: [{ fromId: 7 }, { toId: 7 }] } });
    expect(h.prisma.automationRun.count).toHaveBeenCalledWith({ where: { automation: { ownerId: 7 } } });

    h.prisma.chatMessage.count.mockResolvedValue(0);
    h.prisma.aiAction.count.mockResolvedValue(0);
    h.prisma.automationRun.count.mockResolvedValue(1);
    expect(await deleteUser(form(7))).toMatchObject({ ok: false, error: expect.stringContaining("1 automation run(s)") });

    // a person still assigned to a task would leave it without its assignee
    h.prisma.automationRun.count.mockResolvedValue(0);
    h.prisma.taskAssignee.count.mockResolvedValue(3);
    expect(await deleteUser(form(7))).toMatchObject({ ok: false, error: expect.stringContaining("3 task(s)") });
    expect(h.prisma.taskAssignee.count).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(h.prisma.user.delete).not.toHaveBeenCalled();
  });

  it("deletes an account nothing names", async () => {
    expect(await deleteUser(form(7))).toEqual({ ok: true });
    expect(h.prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  it("still keeps the owner's and its own account, before any counting", async () => {
    h.prisma.user.findUnique.mockResolvedValue({ id: 1, name: "Mohamed", isOwner: true });
    expect(await deleteUser(form(1))).toEqual({ ok: false, error: "The owner's account cannot be deleted." });
    expect(h.prisma.chatMessage.count).not.toHaveBeenCalled();
    expect(h.prisma.user.delete).not.toHaveBeenCalled();
  });
});
